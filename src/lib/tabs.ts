// Tab access helpers. Page content is extracted with
// chrome.scripting.executeScript function injection, so no content script
// bundle is needed.

export interface TabSummary {
  tabId: number
  title: string
  url: string
  active: boolean
}

export interface TabContent {
  tabId: number
  title: string
  url: string
  description: string
  selection: string
  /** Visible text of the page, truncated. */
  text: string
  truncated: boolean
  error?: string
}

const MAX_TEXT_CHARS = 25_000

export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

export async function listOpenTabs(): Promise<TabSummary[]> {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((t) => t.id !== undefined)
    .map((t) => ({
      tabId: t.id!,
      title: t.title ?? '(untitled)',
      url: t.url ?? '',
      active: t.active ?? false,
    }))
}

// Runs inside the target page. Must be self-contained (it is serialized).
function extractPageContent() {
  const meta = document.querySelector('meta[name="description"]')
  const text = document.body?.innerText ?? ''
  return {
    title: document.title,
    url: location.href,
    description: meta?.getAttribute('content') ?? '',
    selection: window.getSelection()?.toString() ?? '',
    text,
  }
}

export async function readTabContent(tabId: number): Promise<TabContent> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const base = {
    tabId,
    title: tab?.title ?? '(unknown)',
    url: tab?.url ?? '',
    description: '',
    selection: '',
    text: '',
    truncated: false,
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
    })
    const page = result?.result
    if (!page) return { ...base, error: 'No content could be extracted.' }
    const truncated = page.text.length > MAX_TEXT_CHARS
    return {
      ...base,
      title: page.title || base.title,
      url: page.url || base.url,
      description: page.description,
      selection: page.selection.slice(0, 2000),
      text: truncated ? page.text.slice(0, MAX_TEXT_CHARS) : page.text,
      truncated,
    }
  } catch (err) {
    // chrome:// pages, the Web Store, and some PDFs cannot be scripted.
    return {
      ...base,
      error: `Cannot read this tab (${err instanceof Error ? err.message : String(err)}). It may be a browser-internal page.`,
    }
  }
}
