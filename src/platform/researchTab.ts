// The isolated tab the background research agent looks at the web through.
// Service-worker-side (the offscreen host cannot touch tabs), and shared by both
// consumers: the one-shot renderer (researchRender.ts) and the interactive browse
// session (researchBrowse.ts).
//
// One window, one page at a time. Callers take a LEASE rather than calling in
// ad-hoc, because a browse session holds the tab across many separate messages —
// without a lease a concurrent FetchUrl escalation would navigate the page out
// from under a session mid-click.
//
// Isolation: the window is INCOGNITO when the extension is allowed there, so the
// research agent never rides the user's logged-in cookies (it falls back to a
// normal background window otherwise). Everything the agent may do to the page is
// bounded by src/tools/browsePolicy.ts — there is no human at the gate here.
//
// Redirects: Chrome follows an HTTP redirect transparently and there is no
// webNavigation/webRequest permission that would let us inspect a hop before
// it completes, so a URL that passed isFetchableUrl pre-navigation can still
// land the tab somewhere blocked (a public URL 302ing to link-local metadata,
// a LAN admin panel, localhost, …). navigateAndWait re-validates WHERE the tab
// actually landed after every navigation — the same shape as webFetch.ts's
// fetchReadable post-redirect recheck — so this is closed once for every
// caller instead of patched per call site.

import { isFetchableUrl } from './webFetch'

const NAV_TIMEOUT_MS = 30_000
const IDLE_TEARDOWN_MS = 60_000

/** Survives a service-worker restart, so an orphaned window can be swept. */
const ORPHAN_KEY = 'researchRenderWindowId'

/**
 * Set synchronously the instant sweepOrphanWindow is called (before its first
 * await) and resolved once the sweep finishes. background.ts calls
 * sweepOrphanWindow unconditionally at SW startup, before any message
 * listener can fire, so this is always set by the time a message-triggered
 * ensureTab() could possibly run. Gating ensureTab's ORPHAN_KEY write on it
 * closes the TOCTOU where a fast-retrying acquireTab() (e.g. the offscreen
 * host immediately retrying a browse `open` after its old session died across
 * a SW restart — the exact case this sweep exists to clean up after) could
 * write a fresh window id before the sweep's read-then-remove of the STALE id
 * has finished, causing the sweep to remove the live window a brand-new lease
 * just handed out.
 */
let sweepGate: Promise<void> | undefined

let renderWindowId: number | undefined
let renderTabId: number | undefined
let usingIncognito = false
let idleTimer: ReturnType<typeof setTimeout> | undefined

// Leases are serialized through a promise chain: each acquirer waits for the
// previous lease's release() before it gets the tab.
let chain: Promise<void> = Promise.resolve()

/** Exclusive hold on the research tab. Release it, always, in a `finally`. */
export interface TabLease {
  tabId: number
  release(): void
}

/**
 * Take the research tab. Resolves once every earlier lease has been released,
 * creating the isolated window if it does not exist yet.
 *
 * The caller MUST release: a lease that is never released stalls every later
 * render and browse for the life of the service worker. Long-lived holders
 * (browse sessions) are expected to arm their own TTL watchdog.
 */
export function acquireTab(): Promise<TabLease> {
  let unlock!: () => void
  const gate = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const previous = chain
  // The NEXT acquirer waits on this lease's gate, not on our setup work.
  chain = previous.then(() => gate)

  return previous.then(async () => {
    if (idleTimer) clearTimeout(idleTimer)
    let released = false
    const release = () => {
      if (released) return
      released = true
      scheduleTeardown()
      unlock()
    }
    try {
      return { tabId: await ensureTab(), release }
    } catch (err) {
      // Never strand the queue behind a lease we failed to hand out.
      release()
      throw err
    }
  })
}

/** Ensure the isolated tab exists; (re)create its window if it went away. */
async function ensureTab(): Promise<number> {
  if (renderTabId !== undefined) {
    try {
      await chrome.tabs.get(renderTabId)
      return renderTabId
    } catch {
      renderTabId = undefined
      renderWindowId = undefined
    }
  }
  // Prefer an isolated incognito window (clean cookie jar); fall back to a normal
  // background window when the extension is not allowed in incognito. When that
  // permission is off, `windows.create({incognito:true})` does not reliably
  // reject — on some Chrome builds it RESOLVES with null instead — so a bare
  // try/catch isn't enough; treat a null/idless window as "incognito unavailable"
  // and fall through, or `win.id` throws "reading 'id' of null".
  //
  // The window parks on `research-tab.html` rather than the default new-tab
  // page. captureVisibleTab cannot screenshot a minimized window, so this one is
  // briefly restored to normal for every capture (see renderInTab below) — which
  // is exactly when users notice it. A blank incognito window flickering into
  // view with nothing in it reads as something having gone wrong; a page that
  // says what it is does not.
  const parked = chrome.runtime.getURL('research-tab.html')
  let win: chrome.windows.Window | undefined
  try {
    win = await chrome.windows.create({ url: parked, incognito: true, focused: false, state: 'minimized' })
    usingIncognito = true
  } catch {
    win = undefined
  }
  if (!win || win.id === undefined) {
    win = await chrome.windows.create({ url: parked, focused: false, state: 'minimized' })
    usingIncognito = false
  }
  if (!win || win.id === undefined) throw new Error('could not open a research window')
  renderWindowId = win.id
  renderTabId = win.tabs?.[0]?.id
  if (renderTabId === undefined) throw new Error('could not open a research tab')
  // Remember it across a service-worker restart so sweepOrphanWindow can close it.
  if (renderWindowId !== undefined) {
    if (sweepGate) await sweepGate
    await chrome.storage.session.set({ [ORPHAN_KEY]: renderWindowId }).catch(() => {})
  }
  return renderTabId
}

/** Result of a guarded navigation: where the tab actually landed, and whether
 *  that landing is blocked. */
export interface NavigateOutcome {
  /** The tab's URL once loading settled — the post-redirect, landed URL. */
  url: string
  /** Set when `url` fails isFetchableUrl even though the requested url passed
   *  it pre-navigation. The navigation has already happened by this point (that
   *  part can't be undone) — this is the signal every caller MUST check before
   *  reading or observing the page, so the landed content never reaches the
   *  model or the research notebook. */
  blockedReason?: string
}

/**
 * Navigate the research tab and wait for the load to complete (bounded), then
 * re-validate WHERE it actually landed (see the module-level Redirects note).
 * Never throws for a blocked landing — callers must check `blockedReason`.
 */
export async function navigateAndWait(tabId: number, url: string): Promise<NavigateOutcome> {
  await chrome.tabs.update(tabId, { url })
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(finish, NAV_TIMEOUT_MS)
    // Guard against a load that completed before the listener attached.
    void chrome.tabs
      .get(tabId)
      .then((t) => t.status === 'complete' && finish())
      .catch(() => finish())
  })
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  // Deliberately OPTIMISTIC, not fail-closed, when this lookup itself fails:
  // falling back to the REQUESTED `url` (not refusing outright) means a
  // transient chrome.tabs.get hiccup doesn't spuriously refuse a perfectly
  // good render. This is safe ONLY because every caller of navigateAndWait
  // pairs this fast-path check with an independent, atomic url+content
  // capture downstream — readReadableText (researchRender.ts) and observe()
  // (researchBrowse.ts) — via chrome.scripting.executeScript, a DIFFERENT
  // API that is unaffected by chrome.tabs.get failing and that captures
  // location.href in the SAME synchronous execution as the content it reads.
  // That downstream check is what actually catches a redirect this fallback
  // optimistically waved through. If it is ever removed, weakened, or
  // bypassed, THIS fallback becomes a live TOCTOU hole — the two must be
  // read and changed together, never one without the other.
  const landed = tab?.url ?? url
  const guard = isFetchableUrl(landed)
  return guard.ok ? { url: landed } : { url: landed, blockedReason: guard.reason }
}

/** Run a self-contained function inside the research tab's page world. */
export function exec<T>(tabId: number, func: () => T) {
  return chrome.scripting.executeScript({ target: { tabId }, func })
}

function scheduleTeardown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(teardown, IDLE_TEARDOWN_MS)
}

function teardown(): void {
  const id = renderWindowId
  renderWindowId = undefined
  renderTabId = undefined
  if (id === undefined) return
  chrome.windows.remove(id).catch(() => {})
  chrome.storage.session.remove(ORPHAN_KEY).catch(() => {})
}

/**
 * Close a research window stranded by a service-worker restart. MV3 can kill the
 * worker at any time, which drops the module-scope tab handle and leaves the
 * (minimized, invisible) window open forever. Call once on SW startup.
 */
export function sweepOrphanWindow(): Promise<void> {
  let release!: () => void
  sweepGate = new Promise((r) => {
    release = r
  })
  return (async () => {
    try {
      const got = await chrome.storage.session.get(ORPHAN_KEY)
      const id = got[ORPHAN_KEY] as number | undefined
      if (id === undefined) return
      await chrome.storage.session.remove(ORPHAN_KEY)
      await chrome.windows.remove(id).catch(() => {})
    } catch {
      /* nothing to sweep */
    } finally {
      release()
    }
  })()
}

/** For diagnostics/telemetry: whether the research tab has an isolated cookie jar. */
export function renderIsIsolated(): boolean {
  return usingIncognito
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
