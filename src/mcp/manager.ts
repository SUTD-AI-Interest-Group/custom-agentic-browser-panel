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
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Settings } from '../data/settings'
import { classifyEntry, mcpSettings, serverEnabled, type McpServerEntry, type McpUpdateSettings } from './config'
import { ChromeOAuthProvider, clearAuth } from './auth'
import { elicitationQueue, collectInputs } from './elicitation'
import { TASKS_EXTENSION, parseTask, saveTask, listSavedTasks, expiredTask, taskPollDelay, terminalTask, type SavedTask } from './tasks'
import { ModernMcpClient, LegacyServerError, type SubscriptionState } from './modern'

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
export interface McpUpdateNotice { uri: string; receivedAt: number }

export interface McpServerRuntime {
  name: string
  status: McpStatus
  protocol?: '2026-07-28' | 'legacy'
  taskScope?: string
  updateScope?: string
  subscriptionState?: SubscriptionState
  updates?: McpUpdateNotice[]
  error?: string
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

interface ServerSlot {
  entry: McpServerEntry
  status: McpStatus
  error?: string
  client?: Client | ModernMcpClient
  taskScope?: string
  updateScope?: string
  authChallenge?: { scope?: string; resourceMetadataUrl?: URL }
  pendingModern?: ModernMcpClient
  updatesConfig?: McpUpdateSettings
  subscriptionState?: SubscriptionState
  updates: McpUpdateNotice[]
  catalogTimer?: ReturnType<typeof setTimeout>
  catalogEpoch?: number
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
    { name: 'lychee-ai', version: '0.5.0' },
    { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  )
}

export class McpManager {
  private taskOperations = new Set<string>()
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
      protocol: s.client instanceof ModernMcpClient ? '2026-07-28' : s.client ? 'legacy' : undefined,
      taskScope: s.taskScope,
      updateScope: s.updateScope,
      subscriptionState: s.subscriptionState,
      updates: s.updates,
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
      const updateConfig = mcp.updates?.[name]
      const updatesChanged = JSON.stringify(slot.updatesConfig) !== JSON.stringify(updateConfig)
      slot.updatesConfig = updateConfig ? { ...updateConfig, resourceUris: updateConfig.resourceUris?.slice() } : undefined
      if (updatesChanged && slot.client instanceof ModernMcpClient && serverEnabled(mcp, name) && JSON.stringify(slot.entry) === JSON.stringify(entry)) this.startSubscriptions(slot)
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
      if (slot.status === 'disabled' || slot.status === 'unsupported') slot.status = 'connecting'
      if (changed) this.teardown(name, slot)
      if (urlChanged) await clearAuth(name).catch(() => {})
      if (!slot.client && !slot.connectPromise) {
        void this.ensureConnected(name).catch(() => {})
      }
    }
    this.notify()
  }

  private emptySlot(entry: McpServerEntry): ServerSlot {
    return { entry, status: 'connecting', attempts: 0, gen: 0, tools: [], resources: [], prompts: [], updates: [] }
  }

  private teardown(name: string, slot: ServerSlot) {
    // Invalidate any connect() still in flight (see ServerSlot.gen).
    slot.gen += 1
    slot.taskScope = undefined
    slot.updateScope = undefined
    slot.authChallenge = undefined
    void slot.pendingModern?.close()
    slot.pendingModern = undefined
    if (slot.catalogTimer) clearTimeout(slot.catalogTimer)
    slot.catalogTimer = undefined
    slot.updates = []
    slot.tools = []; slot.resources = []; slot.prompts = []
    slot.subscriptionState = 'off'
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
      const pending = this.connect(name, slot).finally(() => {
        if (slot.connectPromise === pending) slot.connectPromise = undefined
      })
      slot.connectPromise = pending
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
    const authProvider = new ChromeOAuthProvider(name, url.toString(), { clientMetadataUrl: slot.entry.oauthClientMetadataUrl })

    const attempt = async (kind: 'http' | 'sse') => {
      const client = newClient()
      const transport =
        kind === 'http'
          ? new StreamableHTTPClientTransport(url, { requestInit, authProvider, fetch: authProvider.fetch })
          : new SSEClientTransport(url, { requestInit, authProvider, fetch: authProvider.fetch })
      try {
        await client.connect(transport)
        return { client, transport }
      } catch (err) { await client.close().catch(() => {}); throw err }
    }

    try {
      let connected: { client: Client | ModernMcpClient; transport?: StreamableHTTPClientTransport | SSEClientTransport }
      // Pin credentials for this client. A token changing under an open listen
      // must not silently transfer the user's subscription consent to an account.
      let token = (await authProvider.tokens())?.access_token
      if (stale()) return
      let refreshing: Promise<void> | undefined
      const modern = new ModernMcpClient(url, {
        headers, token: async () => token,
        elicit: (params, signal) => elicitationQueue.ask(name, params, signal),
        onTask: async (raw, params, options) => {
          if (stale() || !slot.taskScope) throw Error('MCP connection changed before task persistence.')
          const task = parseTask(raw)
          const record: SavedTask = { ...task, id: JSON.stringify([name, slot.taskScope, task.taskId]), server: name,
            scope: slot.taskScope, tool: String(params.name), conversationId: options.conversationId, nextPollAt: Date.now() + taskPollDelay(task) }
          try { await saveTask(record) } catch {
            throw Error(`The server started task ${task.taskId}, but local persistence failed. Do not repeat the original tool call; recover the task on the server.`)
          }
          return { resultType: 'complete', content: [{ type: 'text', text: `Task started on ${name}: ${task.taskId}. It continues on the server. Tell the user it is running and wait for them to request results. The MCP tasks panel tracks progress. Do not busy-poll or repeat the original tool call.` }], structuredContent: { taskId: task.taskId, taskRecordId: record.id, status: task.status } }
        },
        refreshToken: async (signal) => {
          if (!refreshing) refreshing = (async () => {
            if (stale() || headers && Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) throw new UnauthorizedError()
            const stored = await authProvider.tokens()
            // Refresh only our own session. A different stored token may be a
            // different account; it must reconnect with fresh subscription consent.
            if (!stored?.refresh_token || stored.access_token !== token) throw new UnauthorizedError()
            if (await auth(authProvider, { serverUrl: url, fetchFn: (input, init) => authProvider.fetch(input, { ...init, signal }) }) !== 'AUTHORIZED') throw new UnauthorizedError()
            if (stale()) throw new UnauthorizedError()
            token = (await authProvider.tokens())?.access_token
          })().finally(() => { refreshing = undefined })
          await refreshing
        },
        onAuthRequired: (challenge) => {
          if (stale()) return
          slot.authChallenge = challenge
          modern.stopSubscriptions()
          slot.updates = []; slot.tools = []; slot.resources = []; slot.prompts = []
          this.schedulePersistCatalogCache()
          slot.subscriptionState = 'error'
          slot.status = 'needs-auth'; slot.error = 'This server requires authorization.'
          this.notify()
        },
      })
      slot.pendingModern = modern
      try {
        await modern.discover()
        const identity = JSON.stringify([url.toString(), Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), token ?? null])
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
        if (!stale()) slot.updateScope = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')
        const taskIdentity = JSON.stringify([url.toString(), Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), await authProvider.sessionIdentity() ?? null])
        const taskDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskIdentity))
        if (!stale()) slot.taskScope = Array.from(new Uint8Array(taskDigest), x => x.toString(16).padStart(2, '0')).join('')
        connected = { client: modern }
      } catch (err) {
        await modern.close()
        // A network/auth failure or a recognized modern error is NOT permission
        // to downgrade. Only the protocol's legacy HTTP probe statuses qualify.
        if (!(err instanceof LegacyServerError)) throw err
        if (stale()) return
        try {
          connected = await attempt('http')
        } catch (legacyError) {
          if (!(legacyError instanceof StreamableHTTPError) || ![400, 404, 405].includes(legacyError.code ?? 0)) throw legacyError
          if (stale()) return
          connected = await attempt('sse')
        }
      }
      if (slot.pendingModern === modern) slot.pendingModern = undefined
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

      // Legacy SDK notifications retain their existing semantics. Modern
      // servers send nothing until the user opts in to subscriptions/listen.
      if (!(connected.client instanceof ModernMcpClient)) {
        const refetch = () => this.scheduleCatalogRefresh(slot)
        connected.client.setNotificationHandler(ToolListChangedNotificationSchema, refetch)
        connected.client.setNotificationHandler(ResourceListChangedNotificationSchema, refetch)
        connected.client.setNotificationHandler(PromptListChangedNotificationSchema, refetch)
      }
      await this.listCatalog(name, slot)
      if (!stale()) this.startSubscriptions(slot)
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

  private scheduleCatalogRefresh(slot: ServerSlot): void {
    if (slot.catalogTimer) return
    slot.catalogTimer = setTimeout(() => {
      slot.catalogTimer = undefined
      const name = [...this.slots].find(([, value]) => value === slot)?.[0]
      if (name) void this.listCatalog(name, slot).catch(() => {})
    }, 250)
  }

  private startSubscriptions(slot: ServerSlot): void {
    if (!(slot.client instanceof ModernMcpClient)) return
    slot.client.stopSubscriptions()
    slot.subscriptionState = 'off'
    slot.updates = []
    if (!slot.updatesConfig?.enabled || !slot.updateScope || slot.updatesConfig.scope !== slot.updateScope) return
    const client = slot.client
    client.listen({
      toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true,
      resourceSubscriptions: slot.updatesConfig.resourceUris,
    }, (method, params) => {
      if (slot.client !== client) return
      client.invalidateCache()
      if (method === 'notifications/resources/updated' && typeof params.uri === 'string') {
        // Store metadata only. The notification does not authorize reading the
        // resource or starting a model turn, and repeated URI updates coalesce.
        slot.updates = [...slot.updates.filter(x => x.uri !== params.uri), { uri: params.uri, receivedAt: Date.now() }].slice(-100)
        this.notify()
      } else this.scheduleCatalogRefresh(slot)
    }, state => {
      if (slot.client !== client) return
      slot.subscriptionState = state
      // No replay in 2026-07-28: repair missed catalog changes after every ack.
      if (state === 'listening') { client.invalidateCache(); this.scheduleCatalogRefresh(slot) }
      this.notify()
    })
  }

  dismissUpdates(name: string): void {
    const slot = this.slots.get(name)
    if (slot) { slot.updates = []; this.notify() }
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

  private async catalogPages<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
    const items: T[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await fetchPage(cursor)
      items.push(...result.items)
      if (items.length > 10_000) throw new Error('MCP catalog exceeds limits.')
      if (result.nextCursor === undefined) return items
      if (!result.nextCursor || cursors.has(result.nextCursor)) throw new Error('Invalid MCP pagination cursor.')
      cursor = result.nextCursor; cursors.add(cursor)
    }
    throw new Error('MCP catalog pagination limit exceeded.')
  }

  private async listCatalog(name: string, slot: ServerSlot): Promise<void> {
    const client = slot.client
    if (!client) return
    const epoch = slot.catalogEpoch = (slot.catalogEpoch ?? 0) + 1
    const caps = client.getServerCapabilities() ?? {}
    const [tools, resources, prompts] = await Promise.all([
      caps.tools
        ? this.catalogPages(async cursor => {
            const r = client instanceof ModernMcpClient ? await client.listTools() : await client.listTools({ cursor })
            return { items: r.tools, nextCursor: 'nextCursor' in r ? r.nextCursor as string | undefined : undefined }
          }).then((items) =>
            items.map(
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
        ? this.catalogPages(async cursor => {
            const r = client instanceof ModernMcpClient ? await client.listResources() : await client.listResources({ cursor })
            return { items: r.resources, nextCursor: 'nextCursor' in r ? r.nextCursor as string | undefined : undefined }
          }).then((items) =>
            items.map(
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
        ? this.catalogPages(async cursor => {
            const r = client instanceof ModernMcpClient ? await client.listPrompts() : await client.listPrompts({ cursor })
            return { items: r.prompts, nextCursor: 'nextCursor' in r ? r.nextCursor as string | undefined : undefined }
          }).then((items) =>
            items.map(
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
    if (slot.client !== client || slot.catalogEpoch !== epoch) return
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
    opts?: { signal?: AbortSignal; timeoutMs?: number; conversationId?: string },
  ) {
    await this.ensureConnected(server)
    const client = this.slots.get(server)?.client
    if (!client) throw new Error(`Not connected to "${server}".`)
    return client.callTool({ name: tool, arguments: args }, undefined, {
      signal: opts?.signal,
      conversationId: opts?.conversationId,
      timeout: opts?.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
  }

  async modernClient(server: string, extension?: string): Promise<{ client: ModernMcpClient; scope: string }> {
    await this.ensureConnected(server)
    const slot = this.slots.get(server)
    if (!(slot?.client instanceof ModernMcpClient) || !slot.taskScope || slot.status !== 'connected') throw Error('This operation requires a connected modern MCP server.')
    if (extension && !slot.client.supportsExtension(extension)) throw Error('The MCP server does not advertise this extension.')
    return { client: slot.client, scope: slot.taskScope }
  }

  isTaskBusy(id: string): boolean { return this.taskOperations.has(id) }

  async taskOperation(id: string, action: 'get' | 'cancel' | 'respond', signal?: AbortSignal) {
    if (this.taskOperations.has(id)) throw Error('A task operation is already in progress.')
    this.taskOperations.add(id)
    try {
      const record = (await listSavedTasks()).find(t => t.id === id)
      if (!record) throw Error('Unknown task.')
      if (expiredTask(record)) throw Error('This task has expired on the server.')
      const { client, scope } = await this.modernClient(record.server, TASKS_EXTENSION)
      const check = () => {
        if (this.slots.get(record.server)?.status !== 'connected' || scope !== record.scope || this.slots.get(record.server)?.client !== client || this.slots.get(record.server)?.taskScope !== scope) throw Error('Task belongs to a different server or credential session. It cannot be resumed with this connection.')
      }
      check()
      if (action === 'cancel') {
        await client.request('tasks/cancel', { taskId: record.taskId }, { signal }); check()
        // Acknowledgement is not a terminal state; fetch the server's actual status.
      }
      let result = await client.request('tasks/get', { taskId: record.taskId }, { signal }); check()
      let task = parseTask(result, record.taskId, true)
      if (action === 'respond') {
        if (task.status !== 'input_required') throw Error('This task is no longer waiting for input.')
        const controller = new AbortController()
        const abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
        const unsubscribe = this.subscribe(() => { try { check() } catch { controller.abort() } })
        try {
          const inputResponses = await collectInputs(result.inputRequests, (params, inputSignal) => elicitationQueue.ask(record.server, params, inputSignal), controller.signal)
          check()
          await client.request('tasks/update', { taskId: record.taskId, inputResponses }, { signal: controller.signal }); check()
        } finally { unsubscribe(); signal?.removeEventListener('abort', abort) }
        result = await client.request('tasks/get', { taskId: record.taskId }, { signal }); check()
        task = parseTask(result, record.taskId, true)
      }
      if (terminalTask(record) && task.status !== record.status) throw Error('Server changed a terminal task state.')
      await saveTask({ ...record, ...task, nextPollAt: Date.now() + taskPollDelay(task) })
      return result
    } finally { this.taskOperations.delete(id) }
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
    const challenge = slot.authChallenge
    this.teardown(name, slot)
    slot.authChallenge = challenge
    const serverUrl = new URL(slot.entry.url as string)
    const provider = new ChromeOAuthProvider(name, serverUrl.toString(), { interactive: true, clientMetadataUrl: slot.entry.oauthClientMetadataUrl })
    try {
      if (slot.authChallenge?.scope) {
        const previous = await provider.tokens()
        const scope = [...new Set(`${previous?.scope ?? ''} ${slot.authChallenge.scope}`.split(/\s+/).filter(Boolean))].join(' ')
        slot.authChallenge = { ...slot.authChallenge, scope }
        // A refresh cannot grant additional scopes. Force an explicit consent
        // flow, retaining the issuer-bound client registration but not tokens.
        await provider.invalidateCredentials('tokens')
      }
      // 'AUTHORIZED': existing/refreshed tokens suffice — no popup was needed.
      // 'REDIRECT': our provider ran launchWebAuthFlow (awaited, so it has
      // completed by now) and captured the code; a second auth() call
      // exchanges it for tokens, which the provider persists.
      const result = await auth(provider, { serverUrl, fetchFn: provider.fetch, ...slot.authChallenge })
      if (result === 'REDIRECT') {
        const code = provider.takeAuthorizationCode()
        if (!code) throw new Error('Authorization was not completed.')
        await auth(provider, { serverUrl, authorizationCode: code, fetchFn: provider.fetch, ...slot.authChallenge })
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
    if (slot) {
      this.teardown(name, slot)
      slot.tools = []; slot.resources = []; slot.prompts = []
      slot.status = 'needs-auth'
      slot.error = undefined
      this.notify()
    }
    await clearAuth(name)
    this.schedulePersistCatalogCache()
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
    for (const name of Object.keys(cached)) {
      if (!this.slots.has(name)) this.slots.set(name, { ...this.emptySlot({}), status: 'error' })
    }
    // Pre-upgrade snapshots are name-keyed, not account-bound. Their content
    // cannot safely be exposed before a live, authenticated catalog refresh.
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
