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

/**
 * The janitor alarm — how an idle window actually gets closed.
 *
 * Teardown CANNOT be a setTimeout. This module runs in the MV3 service worker,
 * which Chrome evicts after ~30s idle, and a released lease is followed by
 * exactly the silence that triggers that eviction: the research heartbeat that
 * had been keeping the worker alive (offscreen.ts, every 20s) stops when the
 * task ends. Measured in a real browser against this exact algorithm, over
 * three create/release cycles, the 60s timer fired ZERO times — each window
 * instead survived until the *next* cold worker boot happened to run the orphan
 * sweep, which is why finished research left minimized windows lying around.
 * An alarm is the only timer that outlives the worker: Chrome persists it and
 * wakes the worker to deliver it.
 *
 * Armed only while there is something to clean up, and disarmed the moment
 * there isn't, so an idle install is never woken on a timer it doesn't need.
 * 0.5 is Chrome's floor for a repeating alarm.
 */
export const JANITOR_ALARM = 'research-tab-janitor'
const JANITOR_PERIOD_MINUTES = 0.5

/** Survives a service-worker restart, so orphaned windows can be swept. A LIST:
 *  a single id could only ever remember the newest window, so every window the
 *  worker lost track of before writing it (see ensureTab) leaked permanently. */
const ORPHAN_KEY = 'researchRenderWindowIds'
/** The pre-list key, still swept so an in-place update strands nothing. */
const LEGACY_ORPHAN_KEY = 'researchRenderWindowId'

/**
 * Set synchronously the instant sweepOrphanWindows is called (before its first
 * await) and resolved once the sweep finishes. background.ts calls
 * sweepOrphanWindows unconditionally at SW startup, before any message
 * listener can fire, so this is always set by the time a message-triggered
 * ensureTab() could possibly run. Gating ensureTab's orphan write on it
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

/** Outstanding leases. Tearing the window down is only ever safe at zero. */
let leaseCount = 0
/** When the last lease was released — the clock the idle teardown runs on.
 *  `undefined` while a lease is held (or before one ever was). */
let idleSince: number | undefined
/**
 * The in-flight teardown, set SYNCHRONOUSLY before teardown's first await.
 * acquireTab awaits it before claiming a lease, and every teardown entry point
 * checks `leaseCount` synchronously — so whichever of the two commits first is
 * decided without an interleaving, and a janitor tick can never close a window
 * out from under a lease that was being handed out at the same moment.
 */
let tearingDown: Promise<void> | undefined

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
    // Never claim a lease over a teardown that is already committed — see
    // `tearingDown`. It resolves quickly (one windows.remove) and only ever
    // runs when no lease was outstanding.
    if (tearingDown) await tearingDown.catch(() => {})
    leaseCount++
    idleSince = undefined
    let released = false
    const release = () => {
      if (released) return
      released = true
      leaseCount--
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
  // Remember it across a service-worker restart BEFORE anything below can
  // throw. This write used to sit after the tab-id check, so a window whose
  // `tabs` came back empty was created and then abandoned by the throw with
  // its id recorded nowhere: the idle teardown could not reach it (module
  // state dies with the worker) and the sweep did not know it existed. The
  // next acquireTab() then found no cached tab and opened ANOTHER window —
  // which is how these accumulate rather than merely linger.
  if (sweepGate) await sweepGate
  await trackOrphan(win.id)
  // From here on the window is recoverable, so the janitor has something to do.
  armJanitor()
  renderTabId = win.tabs?.[0]?.id
  if (renderTabId === undefined) {
    // Don't leave a window we cannot use sitting there invisibly.
    await closeWindow(win.id)
    renderWindowId = undefined
    throw new Error('could not open a research tab')
  }
  return renderTabId
}

/** Tolerates the pre-list shape (a bare number) so an in-place update reads. */
function readIds(raw: unknown): number[] {
  if (typeof raw === 'number') return [raw]
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : []
}

/** Record a window id so a LATER worker can close it even if this one is
 *  evicted before it gets the chance — which is the normal case, not the
 *  exceptional one (see JANITOR_ALARM). */
async function trackOrphan(id: number): Promise<void> {
  try {
    const got = await chrome.storage.session.get(ORPHAN_KEY)
    const ids = readIds(got[ORPHAN_KEY])
    if (!ids.includes(id)) ids.push(id)
    await chrome.storage.session.set({ [ORPHAN_KEY]: ids })
  } catch {
    /* Storage unavailable — the in-memory teardown path still holds this id. */
  }
}

async function untrackOrphan(id: number): Promise<void> {
  try {
    const got = await chrome.storage.session.get(ORPHAN_KEY)
    const ids = readIds(got[ORPHAN_KEY]).filter((n) => n !== id)
    if (ids.length) await chrome.storage.session.set({ [ORPHAN_KEY]: ids })
    else await chrome.storage.session.remove(ORPHAN_KEY)
  } catch {
    /* Nothing to untrack. */
  }
}

/** Close one window and stop tracking it. Never throws — a window that is
 *  already gone is the success case, not an error. */
async function closeWindow(id: number): Promise<void> {
  await chrome.windows.remove(id).catch(() => {})
  await untrackOrphan(id)
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

function armJanitor(): void {
  try {
    chrome.alarms.create(JANITOR_ALARM, { periodInMinutes: JANITOR_PERIOD_MINUTES })
  } catch {
    /* No alarms API (a test realm) — the direct teardown paths still work. */
  }
}

function disarmJanitor(): void {
  try {
    void chrome.alarms.clear(JANITOR_ALARM)
  } catch {
    /* As above. */
  }
}

/** Start the window's idle clock. The janitor closes it once it has gone
 *  IDLE_TEARDOWN_MS without a lease. */
function scheduleTeardown(): void {
  if (leaseCount > 0) return
  idleSince = Date.now()
  armJanitor()
}

/**
 * One janitor tick — the alarm's whole job. Closes the research window once it
 * has gone IDLE_TEARDOWN_MS without a lease, then disarms itself.
 *
 * Deliberately correct on a worker that has never heard of the window: after an
 * eviction this module's state is empty, and the persisted orphan list is the
 * only surviving record that a window exists at all, so an empty-state tick
 * sweeps that list rather than assuming there is nothing to do.
 */
export async function runJanitorTick(): Promise<void> {
  if (leaseCount > 0) return
  // A window this worker knows about gets its full idle grace; one it only
  // knows about through the orphan list is already stranded, so it goes now.
  if (renderWindowId !== undefined && idleSince !== undefined && Date.now() - idleSince < IDLE_TEARDOWN_MS) return
  await teardown()
  if (leaseCount === 0) disarmJanitor()
}

/**
 * Close the research window right now, if nothing is using it.
 *
 * Called the moment a research task ends, from the service worker's own message
 * handler — i.e. while the worker is provably alive, which is the one thing a
 * timer scheduled for later cannot count on. This is what makes a finished task
 * clean up *gracefully* instead of leaving the window for a later janitor tick
 * (or, before this existed, for the next cold boot's crash-recovery sweep). A
 * window that still has an outstanding lease — another task mid-fetch — is left
 * alone for the janitor.
 */
export async function teardownNow(): Promise<void> {
  if (leaseCount > 0) return
  await teardown()
  if (leaseCount === 0) disarmJanitor()
}

/** Close the window and forget it, including anything the orphan list still
 *  holds. Idempotent and concurrency-safe via `tearingDown`. */
function teardown(): Promise<void> {
  if (tearingDown) return tearingDown
  const id = renderWindowId
  renderWindowId = undefined
  renderTabId = undefined
  idleSince = undefined
  const run = (async () => {
    if (id !== undefined) await closeWindow(id)
    await sweepOrphanWindows()
  })()
  tearingDown = run.catch(() => {})
  return tearingDown.finally(() => {
    tearingDown = undefined
  })
}

/**
 * Close research windows stranded by a service-worker restart. MV3 can kill the
 * worker at any time, which drops the module-scope tab handle and leaves the
 * (minimized, invisible) window open forever. Call once on SW startup — and
 * again from teardown, since after an eviction this list is the only thing that
 * remembers a window at all.
 */
export function sweepOrphanWindows(): Promise<void> {
  let release!: () => void
  sweepGate = new Promise((r) => {
    release = r
  })
  return (async () => {
    try {
      const got = await chrome.storage.session.get([ORPHAN_KEY, LEGACY_ORPHAN_KEY])
      // Never close the window a lease is currently using: teardown callers
      // check leaseCount synchronously, but a startup sweep races nothing at
      // all and this keeps that true if a caller is ever added.
      const ids = [...readIds(got[ORPHAN_KEY]), ...readIds(got[LEGACY_ORPHAN_KEY])].filter(
        (id) => id !== renderWindowId,
      )
      if (!ids.length) return
      await chrome.storage.session.remove([ORPHAN_KEY, LEGACY_ORPHAN_KEY])
      // Sequential, not Promise.all: a handful of ids at most, and a failure on
      // one must not skip the rest.
      for (const id of ids) await chrome.windows.remove(id).catch(() => {})
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
