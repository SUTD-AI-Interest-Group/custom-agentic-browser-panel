import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const request = useRef<AbortController | null>(null)
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
    const changed = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
      if (message?.type === 'webmcp.changed' && sender.tab?.id === tabId) void refresh()
    }
    const focus = () => void refresh()
    chrome.runtime.onMessage.addListener(changed)
    window.addEventListener('focus', focus)
    return () => { cancelled = true; chrome.runtime.onMessage.removeListener(changed); window.removeEventListener('focus', focus) }
  }, [tabId, url])

  // Invalidate pending work when its inputs change. Only a click starts
  // inference; tool refreshes, navigation and provider changes never do.
  const providerKey = useMemo(() => JSON.stringify(selected), [selected?.provider, selected?.modelId])
  useEffect(() => {
    request.current?.abort()
    setSuggestions([])
    setStatus('idle')
    return () => request.current?.abort()
  }, [snapshot, providerKey, tabId, url])

  const suggest = async () => {
    if (!selected || !snapshot?.tools.length) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setSuggestions([])
    setStatus('loading')
    try {
      const items = await generateWebMcpSuggestions(createModel(selected.provider, selected.modelId), snapshot, controller.signal)
      if (!controller.signal.aborted) { setSuggestions(items); setStatus(items.length ? 'ready' : 'failed') }
    } catch { if (!controller.signal.aborted) setStatus('failed') }
  }

  if (!snapshot?.tools.length || (url && snapshot.url !== url)) return <>{children}</>
  return <section className="webmcp-welcome" aria-label="Page actions">

    <details className="webmcp-actions" open>
      <summary>Page actions <span>{snapshot.tools.length}</span></summary>
      <ul>{snapshot.tools.map((action, index) => <li key={`${action.name}:${index}`}>
        <button type="button" onClick={() => onChoose(`Help me use the WebMCP action "${action.name}" on this page. Ask me for any missing details before running it.`)}>
          <strong>{action.name.replace(/[_-]+/g, ' ')}</strong>
          <span>{action.description || 'A page-provided action'}</span>
        </button>
      </li>)}</ul>
    </details>
    <div className="webmcp-examples" aria-live="polite">
      {status === 'loading' ? <p role="status">Suggesting prompts…</p> :
        <button type="button" disabled={!selected} title="Uses your selected model and shares this site's origin and action descriptions." onClick={() => void suggest()}>Suggest prompts</button>}
      {status === 'failed' && <p role="alert">Could not generate suggestions.</p>}
      {suggestions.map(item => <button type="button" key={item.prompt} onClick={() => onChoose(`${item.prompt}\n\nUse the page’s WebMCP actions: ${item.toolNames.join(', ')}.`)}>{item.prompt}<span aria-hidden="true">↗</span></button>)}
    </div>
  </section>
}
