import { discoverWebMcp } from './webmcp'

export function installWebMcpBadge(isPanelOpen: (windowId: number) => boolean) {
  const generations = new Map<number, number>()
  const refresh = async (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined) return
    const generation = (generations.get(tab.id) ?? 0) + 1
    generations.set(tab.id, generation)
    let count = 0
    if (/^https?:/.test(tab.url ?? '')) {
      try { count = (await discoverWebMcp(tab.id, true)).tools.length } catch { /* Unsupported page. */ }
    }
    const live = await chrome.tabs.get(tab.id).catch(() => null)
    if (!live || live.url !== tab.url || generations.get(tab.id) !== generation) return
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b83860' })
    await chrome.action.setBadgeText({ tabId: tab.id, text: count && !isPanelOpen(live.windowId) ? String(Math.min(count, 99)) : '' })
    await chrome.action.setTitle({ tabId: tab.id, title: count ? `Lychee AI — ${count} WebMCP actions available` : 'Open Lychee AI' })
  }
  const refreshWindow = async (windowId?: number) => {
    const tabs = await chrome.tabs.query(windowId === undefined ? {} : { windowId })
    await Promise.allSettled(tabs.map(refresh))
  }
  chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === 'loading' || change.url) {
      generations.set(id, (generations.get(id) ?? 0) + 1)
      void chrome.action.setBadgeText({ tabId: id, text: '' }).catch(() => {})
    }
    if (change.status === 'complete' || change.url) void refresh(tab).catch(() => {})
  })
  chrome.tabs.onRemoved.addListener(id => generations.delete(id))
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs.get(tabId).then(refresh).catch(() => {})
  })
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'webmcp.changed' || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab) return
    void refresh(sender.tab).catch(() => {})
  })
  void refreshWindow()
  return refreshWindow
}
