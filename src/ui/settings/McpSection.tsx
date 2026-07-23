import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../../data/settings'
import {
  classifyEntry,
  mcpSettings,
  mergeServers,
  parseMcpJson,
  serializeMcpJson,
  serverEnabled,
  type McpServerEntry,
  type McpSettings,
} from '../../mcp/config'
import { getMcpManager } from '../../mcp/manager'

/**
 * General-tab section for MCP servers: the server list (status, enable,
 * remove), a small add form, and the consolidated JSON file — editable,
 * importable, copyable. The `servers` object IS the standard `mcpServers`
 * file, so the editor and the copy button are pure serialization.
 *
 * Live connection status comes straight from the panel's McpManager (this
 * section subscribes); before a server ever connects, rows show
 * config-derived states (disabled / stdio-unsupported / not connected yet).
 */
export default function McpSection({
  draft,
  commit,
}: {
  draft: Settings
  commit: (next: Settings) => void
}) {
  const mcp = mcpSettings(draft)
  const names = Object.keys(mcp.servers)

  // Live status: re-render on every manager state change.
  const [, setTick] = useState(0)
  useEffect(() => getMcpManager().subscribe(() => setTick((n) => n + 1)), [])
  const status = Object.fromEntries(
    getMcpManager()
      .runtime()
      .map((r) => [r.name, { state: r.status, error: r.error }]),
  )
  const [authError, setAuthError] = useState<string | null>(null)

  function authorize(name: string) {
    setAuthError(null)
    getMcpManager()
      .authorize(name)
      .catch((err) => setAuthError(`${name}: ${err instanceof Error ? err.message : String(err)}`))
  }

  const patch = (next: McpSettings) => commit({ ...draft, mcp: next })

  function setServers(servers: Record<string, McpServerEntry>) {
    patch({ ...mcp, servers })
  }

  function removeServer(name: string) {
    const servers = { ...mcp.servers }
    delete servers[name]
    const serverState = { ...mcp.serverState }
    delete serverState[name]
    const policies = { ...mcp.policies }
    delete policies[name]
    patch({ servers, serverState, policies })
  }

  function setEnabled(name: string, enabled: boolean) {
    patch({ ...mcp, serverState: { ...mcp.serverState, [name]: { enabled } } })
  }

  return (
    <section className="settings-section-block">
      <div className="settings-section-head">
        <h2>MCP servers</h2>
      </div>
      <p className="hint">
        Connect Model Context Protocol servers to give the agent their tools, resources and
        prompts. Tool calls still ask for your approval.
      </p>

      {names.length === 0 && <p className="hint">No servers configured — add one below or import your JSON.</p>}

      {names.map((name) => (
        <ServerRow
          key={name}
          name={name}
          entry={mcp.servers[name]}
          enabled={serverEnabled(mcp, name)}
          live={status[name]}
          onToggle={(on) => setEnabled(name, on)}
          onRemove={() => removeServer(name)}
          onAuthorize={() => authorize(name)}
        />
      ))}
      {authError && <p className="mcp-error">{authError}</p>}

      <AddServerForm
        existing={new Set(names)}
        onAdd={(name, entry) => setServers({ ...mcp.servers, [name]: entry })}
      />

      <JsonEditor servers={mcp.servers} onReplace={setServers} onMerge={(imported) => setServers(mergeServers(mcp.servers, imported))} />
    </section>
  )
}

/** Human copy for a row's status dot, config-derived when the manager has no entry. */
function statusInfo(
  entry: McpServerEntry,
  enabled: boolean,
  live?: { state: string; error?: string },
): { cls: string; label: string; detail?: string } {
  if (classifyEntry(entry) === 'stdio')
    return {
      cls: 'unsupported',
      label: 'Not runnable in a browser',
      detail: 'stdio servers need a local process. Point a local HTTP bridge (e.g. mcp-proxy) at it and use its URL instead.',
    }
  if (!enabled) return { cls: 'disabled', label: 'Disabled' }
  switch (live?.state) {
    case 'connected':
      return { cls: 'connected', label: 'Connected' }
    case 'connecting':
      return { cls: 'connecting', label: 'Connecting…' }
    case 'needs-auth':
      return { cls: 'needs-auth', label: 'Needs authorization' }
    case 'error':
      return { cls: 'error', label: 'Connection failed', detail: live.error }
    default:
      return { cls: 'idle', label: 'Not connected yet' }
  }
}

function ServerRow({
  name,
  entry,
  enabled,
  live,
  onToggle,
  onRemove,
  onAuthorize,
}: {
  name: string
  entry: McpServerEntry
  enabled: boolean
  live?: { state: string; error?: string }
  onToggle: (on: boolean) => void
  onRemove: () => void
  onAuthorize?: () => void
}) {
  const kind = classifyEntry(entry)
  const s = statusInfo(entry, enabled, live)
  const stdio = kind === 'stdio'
  return (
    <div className={`mcp-server-row ${stdio ? 'stdio' : ''}`}>
      <span className={`mcp-dot ${s.cls}`} title={s.label} />
      <div className="mcp-server-main">
        <div className="mcp-server-title">
          <span className="mcp-server-name">{name}</span>
          <span className="mcp-badge">{stdio ? 'stdio' : 'http'}</span>
        </div>
        <div className="mcp-server-sub">
          {stdio ? `${entry.command}${entry.args?.length ? ' ' + entry.args.join(' ') : ''}` : entry.url}
        </div>
        <div className="mcp-server-status">{s.label}{s.detail ? ` — ${s.detail}` : ''}</div>
      </div>
      {s.cls === 'needs-auth' && onAuthorize && (
        <button className="btn ghost small" onClick={onAuthorize}>
          Authorize
        </button>
      )}
      {!stdio && (
        <label className="switch-toggle" title={enabled ? 'Disable' : 'Enable'}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span className="track" />
          <span className="thumb" />
        </label>
      )}
      <button className="icon-btn danger" title="Remove server" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

function AddServerForm({
  existing,
  onAdd,
}: {
  existing: Set<string>
  onAdd: (name: string, entry: McpServerEntry) => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [error, setError] = useState<string | null>(null)

  function add() {
    const n = name.trim()
    if (!n) return setError('Give the server a name.')
    if (existing.has(n)) return setError(`A server named "${n}" already exists.`)
    const entry: McpServerEntry = { url: url.trim() }
    if (classifyEntry(entry) !== 'http') return setError('The URL must be an http(s) address.')
    if (headers.trim()) {
      try {
        const h = JSON.parse(headers)
        if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new Error('not an object')
        entry.headers = h as Record<string, string>
      } catch {
        return setError('Headers must be a JSON object, e.g. { "Authorization": "Bearer …" }.')
      }
    }
    onAdd(n, entry)
    setName('')
    setUrl('')
    setHeaders('')
    setError(null)
  }

  return (
    <div className="mcp-add-form">
      <div className="field-row">
        <label className="field">
          Name
          <input value={name} placeholder="linear" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field grow">
          URL
          <input
            value={url}
            placeholder="https://mcp.linear.app/mcp"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        Headers (optional JSON, e.g. an API key)
        <input
          value={headers}
          placeholder='{ "Authorization": "Bearer sk-…" }'
          onChange={(e) => setHeaders(e.target.value)}
        />
      </label>
      <div className="mcp-add-actions">
        <button className="btn ghost small" onClick={add}>
          Add server
        </button>
        {error && <span className="mcp-error">{error}</span>}
      </div>
    </div>
  )
}

/**
 * The consolidated JSON file: edit in place (Save replaces the server map),
 * import a file (merge by name), or copy the standard file to the clipboard.
 * The textarea tracks the stored config until the user edits; Save is disabled
 * while the text does not parse.
 */
function JsonEditor({
  servers,
  onReplace,
  onMerge,
}: {
  servers: Record<string, McpServerEntry>
  onReplace: (servers: Record<string, McpServerEntry>) => void
  onMerge: (imported: Record<string, McpServerEntry>) => void
}) {
  const canonical = serializeMcpJson(servers)
  const [text, setText] = useState(canonical)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Follow external changes (add form, remove, import) until the user edits.
  useEffect(() => {
    if (!dirty) setText(canonical)
  }, [canonical, dirty])

  const parsed = dirty ? parseMcpJson(text) : null
  const parseError = parsed && 'error' in parsed ? parsed.error : null
  const entryErrors = parsed && !('error' in parsed) ? parsed.invalid : []

  function save() {
    if (!parsed || 'error' in parsed) return
    onReplace(parsed.servers)
    setDirty(false)
    setNotice(
      entryErrors.length
        ? `Saved. Skipped invalid entr${entryErrors.length > 1 ? 'ies' : 'y'}: ${entryErrors.map((e) => e.name).join(', ')}.`
        : 'Saved.',
    )
  }

  async function importFile(file: File) {
    const r = parseMcpJson(await file.text())
    if ('error' in r) {
      setNotice(`Import failed: ${r.error}`)
      return
    }
    onMerge(r.servers)
    setDirty(false)
    const added = Object.keys(r.servers).length
    setNotice(
      `Imported ${added} server${added === 1 ? '' : 's'}.` +
        (r.invalid.length ? ` Skipped: ${r.invalid.map((e) => `${e.name} (${e.error})`).join('; ')}` : ''),
    )
  }

  async function copy() {
    await navigator.clipboard.writeText(canonical)
    setNotice('Copied to clipboard.')
  }

  return (
    <div className="disclosure-host">
      <div className="mcp-json-actions">
        <button className="btn ghost small" onClick={() => fileRef.current?.click()}>
          Import JSON…
        </button>
        <button className="btn ghost small" onClick={() => void copy()}>
          Copy JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importFile(f)
            e.target.value = ''
          }}
        />
      </div>
      <details className="mcp-json-details">
        <summary>Edit JSON</summary>
        <textarea
          className="mcp-json-editor"
          rows={10}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setDirty(true)
            setNotice(null)
          }}
        />
        {parseError && <p className="mcp-error">{parseError}</p>}
        {!parseError &&
          entryErrors.map((e) => (
            <p className="mcp-error" key={e.name}>
              {e.name}: {e.error}
            </p>
          ))}
        <div className="mcp-add-actions">
          <button className="btn ghost small" disabled={!dirty || !!parseError} onClick={save}>
            Save
          </button>
          {dirty && (
            <button
              className="link-btn"
              onClick={() => {
                setText(canonical)
                setDirty(false)
              }}
            >
              Discard edits
            </button>
          )}
        </div>
      </details>
      {notice && <p className="hint">{notice}</p>}
    </div>
  )
}
