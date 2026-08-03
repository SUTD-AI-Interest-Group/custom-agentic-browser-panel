// The host side of the MCP Apps bridge protocol (ext-apps spec 2026-01-26),
// kept pure and transport-agnostic: McpAppCard feeds it messages from the
// sandbox iframe and posts back every message it returns. The app inside the
// iframe speaks JSON-RPC per the official SDK (@modelcontextprotocol/ext-apps):
//
//   ui/initialize                     request → the handshake result the app's
//                                     SDK validates: protocolVersion, hostInfo,
//                                     hostCapabilities, hostContext. Getting
//                                     this shape wrong makes every real app
//                                     render a zod validation error instead of
//                                     its UI.
//   ui/notifications/initialized     notify  → the app is ready; the host now
//                                     delivers ui/notifications/tool-input and
//                                     ui/notifications/tool-result — this is
//                                     how a long-running widget (start a job,
//                                     poll, display when done) gets its data.
//   tools/call                        request → AppBridgeHost.callTool. The
//                                     host implementation is scoped to the
//                                     app's own server and goes through the
//                                     SAME policy + approval gate as any other
//                                     MCP call; the bridge grants nothing.
//   resources/read                    request → AppBridgeHost.readResource
//                                     (same server scoping).
//   ui/notifications/size-changed    notify  → card resize.
//   ui/open-link                      request → http(s) links only.
//   ui/message                        request → text handed to the host (it
//                                     lands in the composer as a draft — the
//                                     user reviews; apps never speak as them).
//   ui/request-display-mode           request → this host only does 'inline'.
//   ui/update-model-context, ping     request → acknowledged.
//   notifications/message             notify  → app-side logging, ignored.
//
// Anything malformed is ignored; an unknown request gets a proper JSON-RPC
// method-not-found so a well-behaved app can degrade.

/** The MCP Apps spec revision this host implements. */
export const APP_PROTOCOL_VERSION = '2026-01-26'

export interface AppBridgeHost {
  /** Call a tool on the app's OWN server. Scoping + approval live in the host. */
  callTool(name: string, args: unknown): Promise<unknown>
  /** Read a resource from the app's OWN server (e.g. a ui:// asset). */
  readResource(uri: string): Promise<unknown>
  /** Open an http(s) link in a new tab. */
  openLink(url: string): void
  /** The app asked for this content size (px) — resize its card. */
  onSizeChange(width: number | undefined, height: number): void
  /** Text the app wants to say in the chat; the host drafts it for the user. */
  onUserMessage(text: string): void
  /** Context for the handshake and the post-initialized notifications. */
  context(): {
    theme: 'light' | 'dark'
    toolName: string
    toolInput: unknown
    /** The producing tool call's result, MCP-shaped (content + structuredContent). */
    toolResult: { content?: unknown[]; structuredContent?: unknown }
  }
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  result?: unknown
  error?: { code: number; message: string }
  params?: unknown
}

const respond = (id: number | string, result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result })
const fail = (id: number | string, code: number, message: string): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})
const notify = (method: string, params: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', method, params })

/**
 * Handle one message from the app iframe. Returns every message the host
 * should post back — a response, follow-up notifications, or nothing
 * (notifications, malformed input).
 */
export async function handleAppMessage(msg: unknown, host: AppBridgeHost): Promise<JsonRpcMessage[]> {
  if (typeof msg !== 'object' || msg === null) return []
  const m = msg as Record<string, unknown>
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return []
  const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined
  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>

  switch (m.method) {
    case 'ui/initialize': {
      if (id === undefined) return []
      const ctx = host.context()
      // Echo the app's requested revision when it names one — the SDK treats a
      // mismatch as an incompatibility even when the shapes line up.
      const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : APP_PROTOCOL_VERSION
      return [
        respond(id, {
          protocolVersion: version,
          // Hardcoded rather than read from the manifest because this module is
          // pure (no chrome.*). It exists so a human debugging an app widget can
          // tell which build they're arguing with, which only works if it is
          // bumped alongside manifest.json on every release.
          hostInfo: { name: 'lychee-ai', version: '0.3.0' },
          hostCapabilities: {
            openLinks: {},
            serverTools: { listChanged: false },
            serverResources: { listChanged: false },
          },
          hostContext: {
            theme: ctx.theme,
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            platform: 'web',
            locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
            toolInfo: { tool: { name: ctx.toolName } },
          },
        }),
      ]
    }
    case 'ui/notifications/initialized': {
      // The app is ready: deliver the producing call's input and result. This
      // pair is what lets a job-style widget resume showing "generating…" and
      // then poll its own tools for completion.
      const ctx = host.context()
      return [
        notify('ui/notifications/tool-input', { arguments: ctx.toolInput ?? {} }),
        notify('ui/notifications/tool-result', {
          content: ctx.toolResult.content ?? [],
          ...(ctx.toolResult.structuredContent !== undefined
            ? { structuredContent: ctx.toolResult.structuredContent }
            : {}),
        }),
      ]
    }
    case 'tools/call': {
      if (id === undefined) return []
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) return [fail(id, -32602, 'tools/call needs a tool name.')]
      try {
        return [respond(id, await host.callTool(name, params.arguments ?? {}))]
      } catch (err) {
        return [fail(id, -32000, err instanceof Error ? err.message : String(err))]
      }
    }
    case 'resources/read': {
      if (id === undefined) return []
      const uri = typeof params.uri === 'string' ? params.uri : ''
      if (!uri) return [fail(id, -32602, 'resources/read needs a uri.')]
      try {
        return [respond(id, await host.readResource(uri))]
      } catch (err) {
        return [fail(id, -32000, err instanceof Error ? err.message : String(err))]
      }
    }
    case 'ui/notifications/size-changed': {
      const height = typeof params.height === 'number' ? params.height : NaN
      const width = typeof params.width === 'number' ? params.width : undefined
      if (Number.isFinite(height) && height > 0) host.onSizeChange(width, height)
      return []
    }
    case 'ui/open-link': {
      const url = typeof params.url === 'string' ? params.url : ''
      const ok = /^https?:\/\//i.test(url)
      if (ok) host.openLink(url)
      if (id === undefined) return []
      return [ok ? respond(id, {}) : fail(id, -32602, 'Only http(s) links can be opened.')]
    }
    case 'ui/message': {
      const content = params.content as { type?: string; text?: string } | undefined
      if (content?.type === 'text' && typeof content.text === 'string') host.onUserMessage(content.text)
      return id === undefined ? [] : [respond(id, {})]
    }
    case 'ui/request-display-mode': {
      // Chat cards are inline-only in this host; grant what actually exists.
      return id === undefined ? [] : [respond(id, { mode: 'inline' })]
    }
    case 'ui/update-model-context':
    case 'ping': {
      return id === undefined ? [] : [respond(id, {})]
    }
    case 'notifications/message':
      return []
    default:
      // A request deserves an error; a stray notification is just ignored.
      return id === undefined ? [] : [fail(id, -32601, `Unknown method: ${m.method}`)]
  }
}
