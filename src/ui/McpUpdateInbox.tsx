import { useEffect, useState } from 'react'
import { getMcpManager } from '../mcp/manager'

/** Notification metadata is untrusted text. No raw HTML, automatic reads or turns. */
export default function McpUpdateInbox() {
  const [, render] = useState(0)
  useEffect(() => getMcpManager().subscribe(() => render(x => x + 1)), [])
  const servers = getMcpManager().runtime().filter(x => x.updates?.length)
  const count = servers.reduce((sum, x) => sum + (x.updates?.length ?? 0), 0)
  if (!count) return null
  return <details className="mcp-update-inbox">
    <summary>MCP resource updates · {count}</summary>
    <p className="hint">These resources changed. Ask the agent to read one when you’re ready. Updates don’t contain the new resource data and don’t authorize actions.</p>
    {servers.map(server => <div key={server.name}>
      <strong>{server.name}</strong>
      <ul>{server.updates?.map(update => <li key={update.uri}>{update.uri.slice(0, 2048)}</li>)}</ul>
      <button className="link-btn" onClick={() => getMcpManager().dismissUpdates(server.name)}>Dismiss updates</button>
    </div>)}
  </details>
}
