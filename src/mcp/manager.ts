// The MCP connection layer: one SDK Client per enabled remote server, living in
// the SIDE-PANEL context (the same world as the agent loop and the settings UI).
// Deliberately not the MV3 service worker — its lifetime would kill SSE streams
// mid-turn — and not the research host (MCP is foreground-only by design).
// Everything here dies with the panel, which is the teardown story.
//
// Catalogs (tools/resources/prompts) are cached in memory and snapshotted to
// chrome.storage.local, so the Permissions matrix and ToolSearch disclosure can
// show a server's tools while it is disconnected; the first real call connects
// on demand. The pure config/policy logic lives in src/mcp/config.ts.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Settings } from '../data/settings'
import { classifyEntry, mcpSettings, serverEnabled, type McpServerEntry } from './config'
import { ChromeOAuthProvider, clearAuth } from './auth'

/** Connection state of one configured server, driving the settings status dot. */
export type McpStatus = 'connected' | 'connecting' | 'needs-auth' | 'error' | 'disabled' | 'unsupported'

export interface McpToolInfo {
  name: string
  description: string
  /** The tool's JSON Schema input, passed to the AI SDK as-is. */
  inputSchema: unknown
  /** MCP `_meta` (e.g. MCP Apps output templates). */
  meta?: Record<string, unknown>
}

export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptArgInfo {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments: McpPromptArgInfo[]
}

/** Everything the UI / tool layer needs to know about one server. */
export interface McpServerRuntime {
  name: string
  status: McpStatus
  error?: string
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

interface ServerSlot {
  entry: McpServerEntry
  status: McpStatus
  error?: string
  client?: Client
  transport?: StreamableHTTPClientTransport | SSEClientTransport
  connectPromise?: Promise<void>
  /** Reconnect backoff bookkeeping (reset on success). */
  attempts: number
  retryTimer?: ReturnType<typeof setTimeout>
  /**
   * Teardown generation. A connect() in flight cannot be cancelled, so
   * teardown() bumps this instead; the connect captures the value it started
   * under and discards its own result if the slot was torn down (disabled,
   * removed, reconfigured) while it awaited — otherwise a slow handshake
   * would silently resurrect a connection the user just turned off.
   */
  gen: number
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

const CATALOG_KEY = 'mcpCatalog'
/** Per-request ceiling for tool calls / resource reads (the SDK default). */
const REQUEST_TIMEOUT_MS = 60_000
/** Reconnect backoff: 1s·2ⁿ capped at 60s; only while the server stays enabled. */
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000
/**
 * How long persistCatalogCache() writes are held before actually landing. Each
 * write re-serializes and stores EVERY connected server's catalog (a single
 * `mcpCatalog` key holds the whole map — chrome.storage.local has no partial
 * update for one nested field), so a refresh() that connects several servers
 * at once, or a burst of listChanged notifications from one chatty server,
 * would otherwise pay one full O(all servers) write per server instead of one
 * for the whole batch. 250ms is comfortably longer than the handful of
 * microtask ticks between near-simultaneous catalog fetches settling, and
 * comfortably shorter than anything a human would notice as "the cache is
 * stale" — this is a display cache (see the header comment), never the source
 * of truth for a live connection's catalog.
 */
const PERSIST_DEBOUNCE_MS = 250

interface PersistedCatalog {
  [server: string]: { tools: McpToolInfo[]; resources: McpResourceInfo[]; prompts: McpPromptInfo[] }
}

/**
 * Every Client this manager creates. The validator override is load-bearing:
 * the SDK's default (Ajv) compiles JSON Schemas with `new Function`, which an
 * MV3 extension page's CSP (`script-src 'self'`, no unsafe-eval, ever) rejects
 * the moment listTools() pre-compiles tool output validators — the connection
 * dies with "Evaluating a string as JavaScript violates …". The CfWorker
 * validator interprets schemas without code generation, built for exactly
 * these eval-banned runtimes.
 */
function newClient(): Client {
  return new Client(
    { name: 'lychee-ai', version: '0.1.0' },
    { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  )
}

export class McpManager {
  private slots = new Map<string, ServerSlot>()
  private listeners = new Set<() => void>()
  private cacheLoaded = false
  /** Pending debounced persistCatalogCache() write, if any — see schedulePersistCatalogCache(). */
  private persistTimer?: ReturnType<typeof setTimeout>

  /** Live snapshot for the UI and the tool layer, config order preserved. */
  runtime(): McpServerRuntime[] {
    return [...this.slots.entries()].map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error,
      tools: s.tools,
      resources: s.resources,
      prompts: s.prompts,
    }))
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify() {
    for (const cb of this.listeners) cb()
  }

  /**
   * Reconcile connections with the current settings: connect newly enabled
   * servers, drop removed/disabled ones, reconnect changed entries. Cheap to
   * call on every settings save.
   */
  async refresh(settings: Settings): Promise<void> {
    if (!this.cacheLoaded) await this.loadCatalogCache().catch(() => {})
    const mcp = mcpSettings(settings)
    const wanted = new Map<string, McpServerEntry>()
    for (const [name, entry] of Object.entries(mcp.servers)) {
      const kind = classifyEntry(entry)
      const slot = this.slots.get(name) ?? this.emptySlot(entry)
      this.slots.set(name, slot)
      if (kind !== 'http') {
        this.teardown(name, slot)
        slot.status = 'unsupported'
        slot.entry = entry
        continue
      }
      if (!serverEnabled(mcp, name)) {
        this.teardown(name, slot)
        slot.status = 'disabled'
        slot.entry = entry
        continue
      }
      wanted.set(name, entry)
    }
    // Remove slots whose config entry is gone entirely. A name leaving the
    // config is a trust-severing act (the user explicitly deleted it, or
    // replaced the whole server map) — its OAuth tokens must not linger to be
    // silently inherited by whatever server gets configured under that same
    // name next (single-row remove, a JSON editor Save/import that drops it,
    // …: everything funnels through this one reconciliation). See "MCP OAuth
    // token scoping" in src/mcp/auth.ts.
    for (const [name, slot] of this.slots) {
      if (!(name in mcp.servers)) {
        this.teardown(name, slot)
        this.slots.delete(name)
        void clearAuth(name).catch(() => {})
      }
    }
    for (const [name, entry] of wanted) {
      const slot = this.slots.get(name) as ServerSlot
      const changed = JSON.stringify(slot.entry) !== JSON.stringify(entry)
      // A bearer token is only ever valid for the URL that issued it, so a
      // name repointed at a different URL must not reconnect carrying the
      // old one. `slot.entry.url` must be a genuine previously-seen string,
      // not the `{}` placeholder loadCatalogCache() seeds for a slot the
      // manager has never actually populated yet (see its comment) — treating
      // that placeholder as "changed" would purge auth on every server's very
      // first connection each session, forcing re-auth on every panel open.
      const urlChanged = changed && typeof slot.entry.url === 'string' && slot.entry.url !== entry.url
      slot.entry = entry
      if (changed) this.teardown(name, slot)
      if (urlChanged) await clearAuth(name).catch(() => {})
      if (!slot.client && !slot.connectPromise) {
        void this.ensureConnected(name).catch(() => {})
      }
    }
    this.notify()
  }

  private emptySlot(entry: McpServerEntry): ServerSlot {
    return { entry, status: 'connecting', attempts: 0, gen: 0, tools: [], resources: [], prompts: [] }
  }

  private teardown(name: string, slot: ServerSlot) {
    // Invalidate any connect() still in flight (see ServerSlot.gen).
    slot.gen += 1
    if (slot.retryTimer) clearTimeout(slot.retryTimer)
    slot.retryTimer = undefined
    slot.connectPromise = undefined
    slot.attempts = 0
    const client = slot.client
    slot.client = undefined
    slot.transport = undefined
    if (client) void client.close().catch(() => {})
  }

  /** Connect if not already connected. Concurrent callers share one attempt. */
  ensureConnected(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) return Promise.reject(new Error(`No MCP server named "${name}" is configured.`))
    if (slot.status === 'unsupported' || slot.status === 'disabled')
      return Promise.reject(new Error(`The MCP server "${name}" is ${slot.status}.`))
    if (slot.client) return Promise.resolve()
    if (!slot.connectPromise) {
      slot.connectPromise = this.connect(name, slot).finally(() => {
        slot.connectPromise = undefined
      })
    }
    return slot.connectPromise
  }

  private async connect(name: string, slot: ServerSlot): Promise<void> {
    // Captured before the first await: if teardown() runs while this coroutine
    // is suspended (user disabled/removed/reconfigured the server), the slot's
    // gen moves on and everything below must discard its work.
    const gen = slot.gen
    const stale = () => this.slots.get(name) !== slot || slot.gen !== gen
    slot.status = 'connecting'
    slot.error = undefined
    this.notify()
    const url = new URL(slot.entry.url as string)
    const headers = slot.entry.headers
    const requestInit: RequestInit | undefined = headers ? { headers } : undefined
    const authProvider = new ChromeOAuthProvider(name, url.toString())

    const attempt = async (kind: 'http' | 'sse') => {
      const client = newClient()
      const transport =
        kind === 'http'
          ? new StreamableHTTPClientTransport(url, { requestInit, authProvider })
          : new SSEClientTransport(url, { requestInit, authProvider })
      await client.connect(transport)
      return { client, transport }
    }

    try {
      let connected
      try {
        connected = await attempt('http')
      } catch (err) {
        // Auth demands are not a transport mismatch — surface them, don't fall back.
        if (err instanceof UnauthorizedError) throw err
        // The standard compatibility dance: a server predating streamable HTTP
        // rejects the POST (404/405/…) — retry over the legacy SSE transport.
        connected = await attempt('sse')
      }
      if (stale()) {
        // The user turned this server off (or changed it) mid-handshake: the
        // connection must not be installed, or a "Disabled" server would keep
        // serving tool calls. Close what we just opened and walk away.
        void connected.client.close().catch(() => {})
        return
      }
      slot.client = connected.client
      slot.transport = connected.transport
      slot.attempts = 0
      slot.status = 'connected'
      slot.error = undefined

      // A dropped connection flips the slot back and schedules a retry — unless
      // the drop was our own teardown (slot.client already cleared/replaced).
      connected.client.onclose = () => {
        if (slot.client !== connected.client) return
        slot.client = undefined
        slot.transport = undefined
        slot.status = 'error'
        slot.error = 'Connection closed.'
        this.scheduleReconnect(name, slot)
        this.notify()
      }

      // Live catalog refresh on listChanged notifications.
      const refetch = () => void this.listCatalog(name, slot).catch(() => {})
      connected.client.setNotificationHandler(ToolListChangedNotificationSchema, refetch)
      connected.client.setNotificationHandler(ResourceListChangedNotificationSchema, refetch)
      connected.client.setNotificationHandler(PromptListChangedNotificationSchema, refetch)

      await this.listCatalog(name, slot)
      this.notify()
    } catch (err) {
      // A slot torn down mid-connect owns its status ('disabled', a fresh
      // 'connecting', …) — don't stamp this dead attempt's failure over it or
      // schedule a retry it no longer wants.
      if (stale()) throw err
      // A catalog-fetch failure (listCatalog, above) lands here too, AFTER
      // slot.client/transport were already installed by a successful
      // handshake — without this, the slot is left internally inconsistent
      // (a live client, but status:'error'), and both ensureConnected's
      // `if (slot.client) return` guard and scheduleReconnect's `!slot.client`
      // guard below then permanently no-op: the server's tools vanish from
      // the model's catalog forever, with no auto-recovery. Close and clear
      // whatever this attempt installed so those guards can do their job.
      if (slot.client) {
        const client = slot.client
        slot.client = undefined
        slot.transport = undefined
        void client.close().catch(() => {})
      }
      if (err instanceof UnauthorizedError) {
        slot.status = 'needs-auth'
        slot.error = 'This server requires authorization.'
      } else {
        slot.status = 'error'
        slot.error = err instanceof Error ? err.message : String(err)
        this.scheduleReconnect(name, slot)
      }
      this.notify()
      throw err
    }
  }

  private scheduleReconnect(name: string, slot: ServerSlot) {
    if (slot.retryTimer) return
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** slot.attempts)
    slot.attempts += 1
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = undefined
      // Only retry if still wanted (not torn down / disabled meanwhile).
      if (!slot.client && slot.status === 'error') void this.ensureConnected(name).catch(() => {})
    }, delay)
  }

  private async listCatalog(name: string, slot: ServerSlot): Promise<void> {
    const client = slot.client
    if (!client) return
    const caps = client.getServerCapabilities() ?? {}
    const [tools, resources, prompts] = await Promise.all([
      caps.tools
        ? client.listTools().then((r) =>
            r.tools.map(
              (t): McpToolInfo => ({
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.inputSchema,
                meta: (t as { _meta?: Record<string, unknown> })._meta,
              }),
            ),
          )
        : Promise.resolve([]),
      caps.resources
        ? client.listResources().then((r) =>
            r.resources.map(
              (x): McpResourceInfo => ({
                uri: x.uri,
                name: x.name,
                description: x.description,
                mimeType: x.mimeType,
              }),
            ),
          )
        : Promise.resolve([]),
      caps.prompts
        ? client.listPrompts().then((r) =>
            r.prompts.map(
              (p): McpPromptInfo => ({
                name: p.name,
                description: p.description,
                arguments: (p.arguments ?? []).map((a) => ({
                  name: a.name,
                  description: a.description,
                  required: a.required,
                })),
              }),
            ),
          )
        : Promise.resolve([]),
    ])
    // Torn down (or reconnected) while listing — this catalog belongs to a
    // connection that no longer exists; keep the slot's own state.
    if (slot.client !== client) return
    slot.tools = tools
    slot.resources = resources
    slot.prompts = prompts
    this.notify()
    this.schedulePersistCatalogCache()
  }

  /**
   * Debounce persistCatalogCache(): a refresh() that connects several servers
   * at once, or a burst of listChanged notifications, calls this once per
   * server whose catalog just changed — without coalescing, each of those
   * would independently re-serialize and write EVERY server's catalog (see
   * PERSIST_DEBOUNCE_MS). A pending timer means a write is already queued, so
   * later calls in the same window just ride it; persistCatalogCache() always
   * snapshots the CURRENT state of every slot when it actually runs, so the
   * eventual single write still reflects every change that piled up, not just
   * the first or last one.
   *
   * Best-effort like the write it schedules: a timer still pending when the
   * panel itself closes is lost along with the rest of that JS context — no
   * worse than the previous fire-and-forget write, which could equally be
   * interrupted mid-flight by the same event, since this is a display cache
   * (see the header comment), never the source of truth for a live catalog.
   */
  private schedulePersistCatalogCache(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persistCatalogCache().catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Call one tool. The AbortSignal comes from the turn (Stop cancels mid-flight). */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ) {
    await this.ensureConnected(server)
    const client = this.slots.get(server)?.client
    if (!client) throw new Error(`Not connected to "${server}".`)
    return client.callTool({ name: tool, arguments: args }, undefined, {
      signal: opts?.signal,
      timeout: opts?.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
  }

  async readResource(server: string, uri: string, opts?: { signal?: AbortSignal }) {
    await this.ensureConnected(server)
    const client = this.slots.get(server)?.client
    if (!client) throw new Error(`Not connected to "${server}".`)
    return client.readResource({ uri }, { signal: opts?.signal, timeout: REQUEST_TIMEOUT_MS })
  }

  async getPrompt(server: string, name: string, args?: Record<string, string>) {
    await this.ensureConnected(server)
    const client = this.slots.get(server)?.client
    if (!client) throw new Error(`Not connected to "${server}".`)
    return client.getPrompt({ name, arguments: args }, { timeout: REQUEST_TIMEOUT_MS })
  }

  /**
   * Run the interactive OAuth flow for a server. MUST be called from a user
   * click (Authorize button / card action): it opens the browser's auth popup
   * via chrome.identity, exchanges the code, then reconnects.
   *
   * This deliberately does NOT run the popup through a client.connect(): a
   * transport-driven flow launches the popup from inside the initialize
   * request's send(), so the request's 60s timer keeps ticking while the user
   * logs in and the whole authorization dies with "MCP error -32001: Request
   * timed out". The SDK's auth() orchestrator runs the same discovery →
   * registration → PKCE → exchange sequence with no MCP request in flight.
   */
  async authorize(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) throw new Error(`No MCP server named "${name}" is configured.`)
    this.teardown(name, slot)
    const serverUrl = new URL(slot.entry.url as string)
    const provider = new ChromeOAuthProvider(name, serverUrl.toString(), { interactive: true })
    try {
      // 'AUTHORIZED': existing/refreshed tokens suffice — no popup was needed.
      // 'REDIRECT': our provider ran launchWebAuthFlow (awaited, so it has
      // completed by now) and captured the code; a second auth() call
      // exchanges it for tokens, which the provider persists.
      const result = await auth(provider, { serverUrl })
      if (result === 'REDIRECT') {
        const code = provider.takeAuthorizationCode()
        if (!code) throw new Error('Authorization was not completed.')
        await auth(provider, { serverUrl, authorizationCode: code })
      }
    } catch (err) {
      slot.status = 'needs-auth'
      slot.error = err instanceof Error ? err.message : String(err)
      this.notify()
      throw err
    }
    // Tokens are stored; connect for real.
    await this.ensureConnected(name)
  }

  /** Forget a server's tokens/registration and drop to needs-auth. */
  async signOut(name: string): Promise<void> {
    const slot = this.slots.get(name)
    await clearAuth(name)
    if (slot) {
      this.teardown(name, slot)
      slot.status = 'needs-auth'
      slot.error = undefined
      this.notify()
    }
  }

  disconnectAll(): void {
    for (const [name, slot] of this.slots) this.teardown(name, slot)
    this.notify()
  }

  // ---- catalog cache: keep tools visible while disconnected ----

  private async loadCatalogCache(): Promise<void> {
    this.cacheLoaded = true
    const data = await chrome.storage.local.get(CATALOG_KEY)
    const cached = data[CATALOG_KEY] as PersistedCatalog | undefined
    if (!cached) return
    for (const [name, c] of Object.entries(cached)) {
      const slot = this.slots.get(name)
      if (slot && slot.tools.length === 0) {
        slot.tools = c.tools ?? []
        slot.resources = c.resources ?? []
        slot.prompts = c.prompts ?? []
      } else if (!slot) {
        // Seed a slot so Permissions rows show cached tools before refresh()
        // classifies it; refresh() will fix status/entry immediately after.
        this.slots.set(name, {
          ...this.emptySlot({}),
          status: 'error',
          tools: c.tools ?? [],
          resources: c.resources ?? [],
          prompts: c.prompts ?? [],
        })
      }
    }
  }

  private async persistCatalogCache(): Promise<void> {
    const out: PersistedCatalog = {}
    for (const [name, s] of this.slots) {
      out[name] = { tools: s.tools, resources: s.resources, prompts: s.prompts }
    }
    await chrome.storage.local.set({ [CATALOG_KEY]: out })
  }
}

let managerSingleton: McpManager | null = null

/** The panel-wide manager instance. Created lazily on first use. */
export function getMcpManager(): McpManager {
  if (!managerSingleton) managerSingleton = new McpManager()
  return managerSingleton
}
