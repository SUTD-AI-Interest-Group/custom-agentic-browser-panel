import { useEffect, useSyncExternalStore } from 'react'
import type { WebMcpClient } from '../platform/webMcp'

export default function SiteTools({ client, hidden }: { client: WebMcpClient; hidden?: boolean }) {
  const catalog = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot)
  useEffect(() => {
    if (!hidden) return client.watch()
  }, [client, hidden])
  if (hidden) return null
  const count = catalog.tools.length
  return (
    <details className="site-tools">
      <summary>
        <span>Site actions</span>
        <span className="site-tools-status">{catalog.status === 'ready' ? `${count} available` : catalog.status === 'loading' ? 'Checking…' : catalog.status === 'unsupported' ? 'Not supported' : 'Unavailable'}</span>
      </summary>
      <div className="site-tools-body">
        {catalog.binding && <div className="site-tools-origin">{catalog.binding.origin}</div>}
        {catalog.status === 'ready' ? (
          <>
            <p>{count ? 'Ask Lychee to use one of these actions. Each call needs your approval.' : 'This page exposes no supported top-level WebMCP actions.'}</p>
            {count > 0 && <ul>{catalog.tools.map((tool) => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description || 'No description supplied.'}</p></li>)}</ul>}
            <p className="site-tools-note">Provided by this website. Descriptions are untrusted. Embedded-frame actions are excluded.</p>
          </>
        ) : <p>{catalog.message}</p>}
        <button type="button" className="link-btn" onClick={() => void client.refresh()}>Refresh site actions</button>
      </div>
    </details>
  )
}
