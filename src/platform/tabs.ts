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

// ---------------------------------------------------------------------------
// Closing tabs, and the one level of undo behind it
//
// Closing is the only destructive thing the agent can do to a window, so the
// tabs it removes are stashed first. This is deliberately simpler than
// chrome.sessions (which would restore per-tab history but needs another
// permission): a URL, a title and a position are enough to put a window back
// the way it looked, and "reopen what you just closed" is the only undo anyone
// actually asks for. The stash holds the most recent batch only and is cleared
// once consumed, so a second reopen cannot resurrect a batch twice.
// ---------------------------------------------------------------------------

const CLOSED_STASH_KEY = 'closedTabs:last'

/** Beyond this, a stash is more of a liability than an undo. Comfortably above
 *  tabIndex's 100-tab read limit, so a normal cleanup is always fully undoable. */
const MAX_STASH = 300

export interface StashedTab {
  url: string
  title: string
  windowId: number
  index: number
  pinned: boolean
}

export interface ClosedStash {
  at: number
  tabs: StashedTab[]
}

export async function readClosedStash(): Promise<ClosedStash | null> {
  const got = await chrome.storage.local.get(CLOSED_STASH_KEY)
  const stash = got[CLOSED_STASH_KEY] as ClosedStash | undefined
  return stash?.tabs?.length ? stash : null
}

export async function clearClosedStash(): Promise<void> {
  await chrome.storage.local.remove(CLOSED_STASH_KEY)
}

/**
 * Close `tabIds`, stashing them first so reopenClosedTabs can put them back.
 * The caller is responsible for having run planClosure over the ids — this
 * function does no vetting, it only records and removes.
 */
export async function closeTabs(
  tabIds: number[],
): Promise<{ closed: StashedTab[]; recoverable: number; error?: string }> {
  if (tabIds.length === 0) return { closed: [], recoverable: 0 }
  const stashed: StashedTab[] = []
  // Ids chrome.tabs.get actually confirmed exist — a tab closed for real in
  // the human-reaction-time gap between the approval card and the user's
  // click is skipped here, and must be kept out of the remove() call below
  // too: chrome.tabs.remove() aborts (or partially applies) its WHOLE batch
  // on the first id it can't find, so one stale id must never be allowed to
  // take the still-valid ones down with it.
  const validIds: number[] = []
  for (const id of tabIds.slice(0, MAX_STASH)) {
    const tab = await chrome.tabs.get(id).catch(() => undefined)
    if (!tab) continue
    validIds.push(id)
    stashed.push({
      url: tab.url ?? '',
      title: tab.title ?? '(untitled)',
      windowId: tab.windowId,
      index: tab.index,
      pinned: tab.pinned ?? false,
    })
  }
  if (validIds.length === 0) return { closed: [], recoverable: 0 }
  try {
    // Stash BEFORE removing: a crash between the two should cost the undo, not
    // leave a stash describing tabs that are still open.
    await chrome.storage.local.set({ [CLOSED_STASH_KEY]: { at: Date.now(), tabs: stashed } })
    await chrome.tabs.remove(validIds)
    // `recoverable` can trail the closed count past MAX_STASH. Reported rather
    // than hidden, so the model never promises an undo that cannot deliver.
    return { closed: stashed, recoverable: stashed.length }
  } catch (err) {
    return { closed: [], recoverable: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Reopen the most recently closed batch, restoring each tab's window and
 * position where those still exist. A window that has since closed sends its
 * tabs to the current window rather than dropping them.
 */
export async function reopenClosedTabs(): Promise<{ reopened: number; error?: string }> {
  const stash = await readClosedStash()
  if (!stash) return { reopened: 0, error: 'Nothing was closed recently, so there is nothing to reopen.' }
  // Recreate in ascending (window, index) order: chrome.tabs.create inserts
  // each tab at its requested index, so restoring a higher index before a
  // lower one in the same window pushes the earlier tab rightward and
  // scrambles their relative order — the stash array itself is just whatever
  // order the model named the tabs in, which need not already be sorted.
  const ordered = [...stash.tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)
  let reopened = 0
  for (const t of ordered) {
    if (!t.url) continue
    // Restore into the original window when it is still around; otherwise let
    // Chrome place the tab in the current one.
    const windowStillOpen = await chrome.windows.get(t.windowId).then(
      () => true,
      () => false,
    )
    try {
      await chrome.tabs.create({
        url: t.url,
        index: t.index,
        pinned: t.pinned,
        active: false,
        ...(windowStillOpen ? { windowId: t.windowId } : {}),
      })
      reopened++
    } catch {
      // A URL Chrome refuses to open (an expired blob, say) skips quietly —
      // one bad entry must not cost the rest of the batch.
    }
  }
  await clearClosedStash()
  return { reopened }
}

/**
 * User-initiated jump to a page of a PDF (the ShotCard "open page" button —
 * no approval gate, the human clicked). Finds the tab already viewing this PDF
 * (any window, fragment ignored), retargets it to `#page=N`, and RELOADS it —
 * Chrome's PDF viewer only parses `#page=N` at document load, so a fragment-only
 * update alone moves the URL bar but not the page. Brings the tab to the
 * foreground; opens a fresh tab when the PDF is no longer open anywhere.
 */
export async function openPdfAtPage(url: string, page: number): Promise<void> {
  const base = url.split('#')[0]
  const jumpUrl = `${base}#page=${page}`
  try {
    const tabs = await chrome.tabs.query({})
    const existing = tabs.find((t) => (t.url ?? '').split('#')[0] === base)
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { url: jumpUrl, active: true })
      await chrome.tabs.reload(existing.id)
      if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true })
      return
    }
    await chrome.tabs.create({ url: jumpUrl })
  } catch {
    // Best-effort: a vanished window or a restricted URL just leaves things as they are.
  }
}
