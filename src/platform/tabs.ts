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

export interface TabDom {
  tabId: number
  title: string
  url: string
  /** Cleaned HTML of the page (noise nodes/attributes stripped), truncated. */
  dom: string
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

// Runs inside the target page. Must be self-contained (it is serialized).
// Returns a cleaned HTML view: structural markup and semantic attributes are
// kept; scripts/styles/embedded assets and framework noise are dropped so the
// model sees the page skeleton without burning context on cruft.
function extractPageDom() {
  // Nodes that carry no structural meaning for the model.
  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE', 'IFRAME', 'LINK', 'META',
  ])
  // Attributes worth keeping: they convey structure, semantics, or targets.
  const KEEP_ATTRS = new Set([
    'href', 'src', 'alt', 'title', 'id', 'class', 'role', 'name', 'type',
    'value', 'placeholder', 'for', 'action', 'method', 'rel', 'target',
  ])
  const clone = document.documentElement.cloneNode(true) as HTMLElement
  const walk = (node: Element) => {
    // Iterate a static copy so removals during traversal are safe.
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove()
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      if (DROP_TAGS.has(el.tagName)) {
        el.remove()
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        // Keep the allowlist plus any aria-* accessibility attribute.
        if (!KEEP_ATTRS.has(name) && !name.startsWith('aria-')) el.removeAttribute(attr.name)
      }
      walk(el)
    }
  }
  walk(clone)
  const html = clone.outerHTML
    .replace(/\n\s*\n/g, '\n') // drop blank lines
    .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces/tabs
  return { title: document.title, url: location.href, dom: html }
}

/** Read a cleaned HTML view of a tab's DOM, truncated to `maxChars`. */
export async function readTabDom(tabId: number, maxChars: number): Promise<TabDom> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const base = {
    tabId,
    title: tab?.title ?? '(unknown)',
    url: tab?.url ?? '',
    dom: '',
    truncated: false,
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageDom,
    })
    const page = result?.result
    if (!page) return { ...base, error: 'No DOM could be extracted.' }
    const truncated = page.dom.length > maxChars
    return {
      ...base,
      title: page.title || base.title,
      url: page.url || base.url,
      dom: truncated ? page.dom.slice(0, maxChars) : page.dom,
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

export type NavigateAction = 'activate' | 'goto' | 'open'

export interface NavigateResult {
  tabId: number
  url: string
  title: string
  error?: string
}

/**
 * Drive tab navigation on the user's behalf:
 * - `activate`: bring an existing tab (by `tabId`) to the foreground.
 * - `goto`: load `url` in `tabId` (defaults to the active tab).
 * - `open`: open a new tab at `url`.
 */
export async function navigateTab(
  action: NavigateAction,
  opts: { tabId?: number; url?: string },
): Promise<NavigateResult> {
  const fail = (error: string): NavigateResult => ({ tabId: -1, url: '', title: '', error })
  try {
    if (action === 'open') {
      if (!opts.url) return fail('open requires a url.')
      const tab = await chrome.tabs.create({ url: opts.url })
      return { tabId: tab.id ?? -1, url: tab.pendingUrl ?? tab.url ?? opts.url, title: tab.title ?? '' }
    }

    if (action === 'goto') {
      if (!opts.url) return fail('goto requires a url.')
      const targetId = opts.tabId ?? (await getActiveTab())?.id
      if (targetId === undefined) return fail('No target tab to navigate.')
      const tab = await chrome.tabs.update(targetId, { url: opts.url })
      if (!tab) return fail(`No tab with id ${targetId}.`)
      return { tabId: tab.id ?? targetId, url: tab.pendingUrl ?? tab.url ?? opts.url, title: tab.title ?? '' }
    }

    // activate
    if (opts.tabId === undefined) return fail('activate requires a tabId.')
    const tab = await chrome.tabs.update(opts.tabId, { active: true })
    if (!tab) return fail(`No tab with id ${opts.tabId}.`)
    // Also focus the window the tab lives in, so switching works across windows.
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
    return { tabId: tab.id ?? opts.tabId, url: tab.url ?? '', title: tab.title ?? '' }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
