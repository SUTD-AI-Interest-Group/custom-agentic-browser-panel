import { useEffect, useRef, useState } from 'react'
import { getMcpArtifact } from '../data/mcpArtifacts'
import { getMcpManager } from '../mcp/manager'
import { handleAppMessage, type AppBridgeHost } from '../mcp/appBridge'

/**
 * An interactive MCP App rendered in the chat. The app's HTML runs inside the
 * manifest-sandboxed page (sandbox.html — unique origin, no chrome.*, the one
 * place MV3 lets app-supplied scripts execute), which relays the app's
 * JSON-RPC messages up here. This card owns the protocol via handleAppMessage
 * (src/mcp/appBridge.ts): init context, size changes, link opens — and tool
 * calls, which go through the SAME approval/policy gate as the agent's own MCP
 * calls, scoped to the app's own server (see registerMcpAppToolCaller).
 *
 * External-URL apps (a text/uri-list template) iframe the https URL directly,
 * with a plain link fallback for sites that refuse framing.
 */

/** Shape the tool layer puts on a result's `app` field (src/mcp/tools.ts). */
export interface McpAppRef {
  server: string
  tool: string
  template: string
  /** Cached template HTML in the artifact store — survives reload/offline. */
  artifactId?: string
  /** text/uri-list template: render this URL directly instead of sandboxed HTML. */
  externalUrl?: string
}

/**
 * The approval-gated tool caller, registered by Chat on mount. A module-level
 * registry rather than prop-drilling through the 4k-line transcript tree; the
 * panel has exactly one Chat. Calls made before registration (never in
 * practice) reject.
 */
let appToolCaller: ((server: string, tool: string, args: unknown) => Promise<unknown>) | null = null
export function registerMcpAppToolCaller(
  fn: (server: string, tool: string, args: unknown) => Promise<unknown>,
): void {
  appToolCaller = fn
}

const MIN_H = 120
const MAX_H = 800
const DEFAULT_H = 320

export default function McpAppCard({
  app,
  toolInput,
  toolOutput,
}: {
  app: McpAppRef
  toolInput: unknown
  toolOutput: unknown
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(DEFAULT_H)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)

  // The app HTML: cached artifact first (survives reload and disconnects),
  // else a live template read from the server.
  useEffect(() => {
    if (app.externalUrl) return
    let alive = true
    const load = async () => {
      if (app.artifactId) {
        const a = await getMcpArtifact(app.artifactId).catch(() => null)
        if (a?.text) return a.text
      }
      const r = await getMcpManager().readResource(app.server, app.template)
      const c = (r.contents?.[0] ?? {}) as { text?: unknown }
      if (typeof c.text !== 'string') throw new Error('The app template had no HTML.')
      return c.text
    }
    load()
      .then((h) => alive && setHtml(h))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [app.server, app.template, app.artifactId, app.externalUrl])

  // Mount the app into the sandbox and relay its JSON-RPC.
  useEffect(() => {
    if (!html || app.externalUrl) return
    const frame = frameRef.current
    if (!frame) return

    const host: AppBridgeHost = {
      callTool: (name, args) => {
        if (!appToolCaller) return Promise.reject(new Error('Tool calls are unavailable.'))
        // Scoped to the app's OWN server by construction — the app names only
        // a tool; the server is fixed to the one that produced this card.
        return appToolCaller(app.server, name, args)
      },
      openLink: (url) => void chrome.tabs.create({ url }),
      onSizeChange: (h) => setHeight(Math.max(MIN_H, Math.min(MAX_H, Math.round(h)))),
      getContext: () => ({
        theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        toolInput,
        toolOutput,
      }),
    }

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return
      const data = e.data as { type?: string; payload?: unknown } | undefined
      if (data?.type !== 'mcp-app:rpc') return
      void handleAppMessage(data.payload, host).then((response) => {
        if (response) frame.contentWindow?.postMessage({ type: 'mcp-app:rpc-response', payload: response }, '*')
      })
    }
    window.addEventListener('message', onMessage)

    const send = () => frame.contentWindow?.postMessage({ type: 'mcp-app:load', html }, '*')
    // If the sandbox page has already loaded, post now; otherwise on load.
    frame.addEventListener('load', send)
    send()
    return () => {
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', send)
    }
  }, [html, app.server, app.externalUrl, toolInput, toolOutput])

  if (app.externalUrl) {
    return (
      <figure className="mcp-app-card" style={{ height }}>
        <iframe
          className="mcp-app-frame"
          src={app.externalUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title={`${app.server} app`}
        />
        <figcaption className="mcp-content-meta">
          <span className="mcp-content-title">App from {app.server}</span>
          <a className="mcp-content-download" href={app.externalUrl} target="_blank" rel="noreferrer">
            Open in a tab
          </a>
        </figcaption>
      </figure>
    )
  }

  if (error) return <div className="shot-card-missing">Could not load the app: {error}</div>
  if (!html) return <div className="mcp-app-loading">Loading app…</div>

  return (
    <figure className="mcp-app-card" style={{ height }}>
      <iframe
        ref={frameRef}
        className="mcp-app-frame"
        src={chrome.runtime.getURL('sandbox.html')}
        title={`${app.server} · ${app.tool} app`}
      />
      <figcaption className="mcp-content-meta">
        <span className="mcp-content-title">
          App from {app.server} · {app.tool}
        </span>
      </figcaption>
    </figure>
  )
}
