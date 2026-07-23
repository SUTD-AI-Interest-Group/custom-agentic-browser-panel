// Pure MCP configuration logic: the standard `mcpServers` JSON shape, its
// parse/serialize/merge operations, the enabled/policy sidecars, and tool-name
// mangling. No Chrome or AI-SDK imports — this is the unit-tested core the
// settings UI and the runtime (manager/tools) build on.
//
// The storage shape IS the interchange format: `McpSettings.servers` holds the
// `mcpServers` object byte-for-byte as other MCP clients (Claude Desktop,
// Cursor, VS Code) write it, so import/edit/copy are pure serialization.
// Extension-private state (enabled flags, policies) lives in sidecar maps keyed
// by server name and never appears in the exported JSON; OAuth tokens live
// under separate `chrome.storage.local` keys (see src/mcp/auth.ts), so a copied
// config never leaks credentials.

import type { ToolPolicy } from '../data/settings'

/**
 * One entry of the standard `mcpServers` map. Remote servers carry `url`
 * (+ optional `headers`/`type`); stdio servers carry `command`/`args`/`env`.
 * The index signature preserves fields this extension does not understand, so
 * an imported config round-trips verbatim through edit/copy.
 */
export interface McpServerEntry {
  url?: string
  /** Transport hint some clients write: "http", "sse", "stdio". Informational. */
  type?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  [k: string]: unknown
}

/** Per-server policy sidecar: a default for all its tools + per-tool overrides. */
export interface McpServerPolicy {
  default?: ToolPolicy
  tools?: Record<string, ToolPolicy>
}

/** The `mcp` field of Settings. `servers` is exactly the standard JSON object. */
export interface McpSettings {
  servers: Record<string, McpServerEntry>
  /** Sidecar: absent → enabled. Never exported. */
  serverState?: Record<string, { enabled?: boolean }>
  /** Sidecar: per-server tool policies. Never exported. */
  policies?: Record<string, McpServerPolicy>
}

/**
 * What kind of server an entry describes. `stdio` entries are preserved but not
 * runnable in a browser (no process spawning) — the UI greys them out with a
 * local-HTTP-bridge hint. `invalid` entries (both url and command, neither, or
 * an unusable url) are rejected at import with a per-entry error.
 */
export function classifyEntry(e: McpServerEntry): 'http' | 'stdio' | 'invalid' {
  const hasUrl = typeof e.url === 'string' && e.url.length > 0
  const hasCommand = typeof e.command === 'string' && e.command.length > 0
  if (hasUrl === hasCommand) return 'invalid'
  if (hasCommand) return 'stdio'
  try {
    const u = new URL(e.url as string)
    return u.protocol === 'http:' || u.protocol === 'https:' ? 'http' : 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * Parse a config the user uploaded or typed. Accepts the standard wrapped shape
 * `{ "mcpServers": { ... } }` or a bare server map. Malformed JSON / non-object
 * input is a top-level error; per-entry problems land in `invalid` without
 * blocking the valid entries, so one bad server never fails a whole import.
 */
export function parseMcpJson(
  text: string,
): { servers: Record<string, McpServerEntry>; invalid: { name: string; error: string }[] } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Expected a JSON object — either { "mcpServers": { … } } or a server map.' }
  }
  const obj = raw as Record<string, unknown>
  const map = (typeof obj.mcpServers === 'object' && obj.mcpServers !== null && !Array.isArray(obj.mcpServers)
    ? obj.mcpServers
    : obj) as Record<string, unknown>
  const servers: Record<string, McpServerEntry> = {}
  const invalid: { name: string; error: string }[] = []
  for (const [name, entry] of Object.entries(map)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid.push({ name, error: 'Entry must be an object.' })
      continue
    }
    const e = entry as McpServerEntry
    if (classifyEntry(e) === 'invalid') {
      invalid.push({ name, error: 'Needs either an http(s) `url` or a `command` (not both).' })
      continue
    }
    servers[name] = e
  }
  return { servers, invalid }
}

/** The one-click-copy / export text: exactly the standard file, pretty-printed. */
export function serializeMcpJson(servers: Record<string, McpServerEntry>): string {
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

/** Merge imported servers in by name: overwrite same-named, keep the rest. */
export function mergeServers(
  current: Record<string, McpServerEntry>,
  imported: Record<string, McpServerEntry>,
): Record<string, McpServerEntry> {
  return { ...current, ...imported }
}

/** Effective mcp settings, filling the empty shape for installs without any. */
export function mcpSettings(settings: { mcp?: McpSettings }): McpSettings {
  return settings.mcp ?? { servers: {} }
}

/** Whether a server is enabled: sidecar flag, absent → true. */
export function serverEnabled(mcp: McpSettings | undefined, name: string): boolean {
  return mcp?.serverState?.[name]?.enabled !== false
}

/**
 * An MCP tool's effective policy: per-tool override → server default → `ask`.
 * The same two-level resolution as provider/model reasoning effort.
 */
export function mcpToolPolicy(mcp: McpSettings | undefined, server: string, tool: string): ToolPolicy {
  const p = mcp?.policies?.[server]
  return p?.tools?.[tool] ?? p?.default ?? 'ask'
}

// Provider tool-name rules (OpenAI is the strictest): ^[a-zA-Z0-9_-]{1,64}$.
const NAME_MAX = 64

/**
 * The ToolSet key for one MCP tool: `mcp_<server>_<tool>`, sanitized to the
 * provider-safe charset, capped at 64 chars, deduped against `taken` with a
 * numeric suffix. The adapter closes over the real server/tool names, so this
 * never needs to be parsed back.
 */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  const base = `mcp_${sanitize(server)}_${sanitize(tool)}`.slice(0, NAME_MAX)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `_${i}`
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}
