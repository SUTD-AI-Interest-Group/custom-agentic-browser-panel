import { useEffect, useState } from 'react'

/** Injected in the isolated world. One listener for the visible panel, with no
 * periodic scripts. The token makes late teardown harmless after a tab switch. */
function observeSelection(token: string, remove = false) {
  const scope = window as unknown as { __lycheeSelection?: { token: string; stop: () => void } }
  if (remove) {
    if (scope.__lycheeSelection?.token === token) { scope.__lycheeSelection.stop(); delete scope.__lycheeSelection }
    return
  }
  scope.__lycheeSelection?.stop()
  let timer: ReturnType<typeof setTimeout> | undefined
  let previous: string | undefined
  const report = () => {
    const text = (window.getSelection()?.toString() ?? '').trim()
    if (text === previous) return
    previous = text
    void chrome.runtime.sendMessage({ type: 'lychee.selection', token, text }).catch(() => {})
  }
  const changed = () => { clearTimeout(timer); timer = setTimeout(report, 100) }
  document.addEventListener('selectionchange', changed)
  scope.__lycheeSelection = { token, stop: () => { clearTimeout(timer); document.removeEventListener('selectionchange', changed) } }
  report()
}

export function usePageSelection(enabled: boolean) {
  const [selection, setSelection] = useState<{ text: string; tabId: number } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true, generation = 0
    let current: { tabId: number; token: string } | undefined
    const remove = (watch: typeof current) => {
      if (watch) void chrome.scripting.executeScript({ target: { tabId: watch.tabId }, func: observeSelection, args: [watch.token, true] }).catch(() => {})
    }
    const refresh = async () => {
      const version = ++generation
      remove(current)
      current = undefined
      setSelection(null)
      if (document.visibilityState !== 'visible') return
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!alive || version !== generation || tab?.id === undefined) return
        const watch = { tabId: tab.id, token: crypto.randomUUID() }
        current = watch
        await chrome.scripting.executeScript({ target: { tabId: watch.tabId }, func: observeSelection, args: [watch.token] })
        if (!alive || version !== generation) remove(watch)
      } catch { /* Restricted pages have no selectable context. */ }
    }
    const receive = (message: { type?: string; token?: string; text?: unknown }, sender: chrome.runtime.MessageSender) => {
      if (!alive || !current || message?.type !== 'lychee.selection' || message.token !== current.token ||
          sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id !== current.tabId || typeof message.text !== 'string') return
      const { text } = message, tabId = current.tabId
      setSelection(previous => text ? previous?.text === text && previous.tabId === tabId ? previous : { text, tabId } : null)
    }
    const activated = () => void refresh()
    const updated = (id: number, change: chrome.tabs.TabChangeInfo) => {
      if (id === current?.tabId && (change.status === 'complete' || change.url)) void refresh()
    }
    chrome.runtime.onMessage.addListener(receive)
    chrome.tabs.onActivated.addListener(activated)
    chrome.tabs.onUpdated.addListener(updated)
    document.addEventListener('visibilitychange', activated)
    void refresh()
    return () => {
      alive = false; generation++; remove(current)
      chrome.runtime.onMessage.removeListener(receive)
      chrome.tabs.onActivated.removeListener(activated)
      chrome.tabs.onUpdated.removeListener(updated)
      document.removeEventListener('visibilitychange', activated)
    }
  }, [enabled])
  return [enabled ? selection : null, setSelection] as const
}
