// The host side of the MCP Apps postMessage protocol, kept pure and
// transport-agnostic: McpAppCard feeds it messages from the sandbox iframe and
// posts back whatever it returns. The app inside the iframe speaks JSON-RPC:
//
//   ui/initialize          request  → the host context (theme + tool result)
//   tools/call             request  → routed to AppBridgeHost.callTool — the
//                                     host implementation is scoped to the
//                                     app's own server and goes through the
//                                     SAME policy + approval gate as any other
//                                     MCP call; the bridge grants nothing.
//   ui/size-changed        notify   → AppBridgeHost.onSizeChange (card height)
//   ui/open-link           request  → AppBridgeHost.openLink, http(s) only
//
// Anything malformed is ignored; an unknown method with an id gets a proper
// JSON-RPC method-not-found so a well-behaved app can degrade.

export interface AppBridgeHost {
  /** Call a tool on the app's OWN server. Scoping + approval live in the host. */
  callTool(name: string, args: unknown): Promise<unknown>
  /** Open an http(s) link in a new tab. */
  openLink(url: string): void
  /** The app asked for this height (px) — resize its card. */
  onSizeChange(height: number): void
  /** Context handed to the app on ui/initialize. */
  getContext(): { theme: 'light' | 'dark'; toolInput: unknown; toolOutput: unknown }
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const respond = (id: number | string, result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
})
const fail = (id: number | string, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

/**
 * Handle one message from the app iframe. Returns the response to post back,
 * or null when none is due (notifications, malformed input).
 */
export async function handleAppMessage(msg: unknown, host: AppBridgeHost): Promise<JsonRpcResponse | null> {
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return null
  const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined
  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>

  switch (m.method) {
    case 'ui/initialize': {
      if (id === undefined) return null
      return respond(id, { context: host.getContext() })
    }
    case 'tools/call': {
      if (id === undefined) return null
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) return fail(id, -32602, 'tools/call needs a tool name.')
      try {
        return respond(id, await host.callTool(name, params.arguments ?? {}))
      } catch (err) {
        return fail(id, -32000, err instanceof Error ? err.message : String(err))
      }
    }
    case 'ui/size-changed': {
      const height = typeof params.height === 'number' ? params.height : NaN
      if (Number.isFinite(height) && height > 0) host.onSizeChange(height)
      return null
    }
    case 'ui/open-link': {
      const url = typeof params.url === 'string' ? params.url : ''
      const ok = /^https?:\/\//i.test(url)
      if (ok) host.openLink(url)
      if (id === undefined) return null
      return ok ? respond(id, {}) : fail(id, -32602, 'Only http(s) links can be opened.')
    }
    default:
      // A request deserves an error; a stray notification is just ignored.
      return id === undefined ? null : fail(id, -32601, `Unknown method: ${m.method}`)
  }
}
