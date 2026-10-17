import { useEffect, useState, type ReactNode } from 'react'
import type { ProviderConfig } from '../data/settings'
import { discoverWebMcp, type WebMcpSnapshot } from '../platform/webmcp'
import { createModel } from '../agent/provider'
import { generateWebMcpSuggestions, type WebMcpSuggestion } from '../agent/webmcpSuggestions'
import './webmcp.css'

export function WebMcpWelcome({ tabId, url, selected, onChoose, children }: {
  tabId?: number
  url?: string
  selected: { provider: ProviderConfig; modelId: string } | null
  onChoose: (prompt: string) => void
  children: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<WebMcpSnapshot | null>(null)
  const [suggestions, setSuggestions] = useState<WebMcpSuggestion[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    setSnapshot(null)
    if (tabId === undefined) return
    let cancelled = false
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const next = await discoverWebMcp(tabId)
        if (!cancelled) setSnapshot(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
      } catch { if (!cancelled) setSnapshot(null) }
      finally { busy = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [tabId, url])

  // Stable serialized provider config avoids regenerating on composer keystrokes.
  const providerKey = JSON.stringify(selected)
  useEffect(() => {
    setSuggestions([])
    setStatus('loading')
    if (!snapshot?.tools.length || !providerKey || providerKey === 'null') return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const config = JSON.parse(providerKey) as NonNullable<typeof selected>
      void Promise.resolve().then(() => generateWebMcpSuggestions(createModel(config.provider, config.modelId), snapshot, controller.signal))
        .then(items => { if (!controller.signal.aborted) { setSuggestions(items); setStatus(items.length ? 'ready' : 'failed') } })
        .catch(() => { if (!controller.signal.aborted) setStatus('failed') })
    }, 600)
    return () => { clearTimeout(timer); controller.abort() }
  }, [snapshot, providerKey])

  if (!snapshot?.tools.length || (url && snapshot.url !== url)) return <>{children}</>
  return <section className="webmcp-welcome" aria-label="Page actions">
    <span className="webmcp-label">WebMCP connected</span>
    <h2>What can we do here?</h2>
    <p className="webmcp-intro">This page shares {snapshot.tools.length} actions with Lychee.</p>
    <details className="webmcp-actions" open>
      <summary>Available actions <span>{snapshot.tools.length}</span></summary>
      <ul>{snapshot.tools.map((action, index) => <li key={`${action.name}:${index}`}>
        <button type="button" onClick={() => onChoose(`Help me use the WebMCP action "${action.name}" on this page. Ask me for any missing details before running it.`)}>
          <strong>{action.name.replace(/[_-]+/g, ' ')}</strong>
          <span>{action.description || 'A page-provided action'}</span>
        </button>
      </li>)}</ul>
    </details>
    <div className="webmcp-examples" aria-live="polite">
      <h3>Try asking Lychee</h3>
      {!selected ? <p>Choose a chat model to get ideas for this page.</p>
        : status === 'loading' ? <p>Thinking of a few useful ideas…</p>
        : status === 'failed' ? <p>Ideas are unavailable right now. Choose an action above to get started.</p>
        : suggestions.map(item => <button type="button" key={item.prompt} onClick={() => onChoose(`${item.prompt}\n\nUse the page’s WebMCP actions: ${item.toolNames.join(', ')}.`)}>{item.prompt}<span aria-hidden="true">↗</span></button>)}
    </div>
    <p className="webmcp-disclosure">Ideas use your chat model and share this site’s origin and action descriptions. Selecting an idea fills your message. Actions need your confirmation.</p>
  </section>
}
