import type { McpUpdateSettings } from '../../mcp/config'
import { getMcpManager } from '../../mcp/manager'

/** Local sidecar only: toggling a stream never grants permission to run tools. */
export default function McpUpdates({ name, value, onChange }: {
  name: string
  value?: McpUpdateSettings
  onChange: (value: McpUpdateSettings) => void
}) {
  const runtime = getMcpManager().runtime().find(x => x.name === name)
  const modern = runtime?.protocol === '2026-07-28'
  const enabled = value?.enabled === true && value.scope === runtime?.updateScope
  const selected = value?.scope === runtime?.updateScope ? value?.resourceUris ?? [] : []
  const resources = new Map((runtime?.resources ?? []).map(x => [x.uri, x.name || x.uri]))
  for (const uri of selected) if (!resources.has(uri)) resources.set(uri, uri)
  return <details>
    <summary>Update subscriptions {runtime?.subscriptionState === 'listening' ? '· listening' : ''}</summary>
    <p className="hint">MCP 2026-07-28 can stream catalog changes and selected resource updates directly to this browser while the side panel is open. Updates never run tools or start an agent turn.</p>
    {runtime?.protocol === 'legacy' && <p className="hint">This server uses legacy MCP. Core update subscriptions require MCP 2026-07-28.</p>}
    <label>
      <input type="checkbox" checked={enabled} disabled={!modern || runtime?.status !== 'connected'} onChange={e => onChange({ ...value, resourceUris: selected, enabled: e.target.checked, scope: runtime?.updateScope })} />
      Listen for server updates
    </label>
    {enabled && <>
      <p className="hint">Stream: {runtime?.subscriptionState ?? 'off'}. Catalog changes refresh automatically; selected resource changes appear in the update inbox for you to review.</p>
      {[...resources].slice(0, 100).map(([uri, label]) => <label key={uri} style={{ display: 'block' }}>
        <input type="checkbox" checked={selected.includes(uri)} disabled={!modern} onChange={e => onChange({ ...value, resourceUris: e.target.checked ? [...new Set([...selected, uri])].slice(0, 100) : selected.filter(x => x !== uri) })} />
        {label}
      </label>)}
      {!resources.size && <p className="hint">No subscribable resources are listed. A server must expose a resource and support resource subscriptions to send its updates.</p>}
    </>}
  </details>
}
