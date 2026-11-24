import { showingTabsIn } from '../platform/splitView'

export interface TabInfo {
  tabId: number
  title: string
  url: string
  favIconUrl?: string
}

export const toTabInfo = (t: chrome.tabs.Tab): TabInfo => ({
  tabId: t.id as number,
  title: t.title ?? '(untitled)',
  url: t.url ?? '',
  favIconUrl: t.favIconUrl,
})

/** What the per-step agent-state block knows about the screen (src/agent/agentState.ts). */
export interface ScreenState {
  onScreen: TabInfo[]
  boundTab: TabInfo | null
  boundOnScreen: boolean
}

/** What is on screen right now, and whether the tab a chat's page tools are pinned to is among it. */
export async function readScreen(boundTabId: number | undefined): Promise<ScreenState> {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const showing = focused?.windowId === undefined ? [] : await showingTabsIn(focused.windowId)
  const listed = showing.filter((t) => t.id !== undefined).map(toTabInfo)
  // showingTabsIn collapses to the active tab on Chrome < 140; fall back to
  // the focused tab so a pre-split browser still reports one page rather than
  // none, which would read as "nothing on screen".
  const onScreen = listed.length > 0 ? listed : focused?.id !== undefined ? [toTabInfo(focused)] : []
  const boundOnScreen = boundTabId === undefined || onScreen.some((t) => t.tabId === boundTabId)
  // Resolved only when the bound tab is NOT on screen — that is the only case
  // the block reports, so the common path costs no extra tabs call at all.
  let boundTab: TabInfo | null = null
  if (boundTabId !== undefined && !boundOnScreen) {
    const t = await chrome.tabs.get(boundTabId).catch(() => undefined)
    boundTab = t?.id !== undefined ? toTabInfo(t) : null
  }
  return { onScreen, boundTab, boundOnScreen }
}

/**
 * Overlapping async reads into one slot. Reads overlap whenever a tab event lands during another
 * read (the chain-start read, or two events in a row), and they can finish out of order: only the
 * newest read STARTED may write, so a slow older one never lands over a newer one. A failed read
 * writes nothing.
 */
export function latestReads<T>(write: (value: T) => void) {
  let seq = 0
  let newest: Promise<void> = Promise.resolve()
  return {
    start(read: () => Promise<T>): Promise<void> {
      const mine = ++seq
      newest = read().then(
        (value) => {
          if (mine === seq) write(value)
        },
        () => {},
      )
      return newest
    },
    /** Resolves once the newest read started so far has landed — following any started meanwhile. */
    async settled(): Promise<void> {
      let awaited: Promise<void>
      do {
        awaited = newest
        await awaited
      } while (awaited !== newest)
    },
  }
}
