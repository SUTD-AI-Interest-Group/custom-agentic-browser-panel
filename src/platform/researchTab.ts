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

const NAV_TIMEOUT_MS = 30_000
const IDLE_TEARDOWN_MS = 60_000

/** Survives a service-worker restart, so an orphaned window can be swept. */
const ORPHAN_KEY = 'researchRenderWindowId'

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
  let win: chrome.windows.Window | undefined
  try {
    win = await chrome.windows.create({ incognito: true, focused: false, state: 'minimized' })
    usingIncognito = true
  } catch {
    win = undefined
  }
  if (!win || win.id === undefined) {
    win = await chrome.windows.create({ focused: false, state: 'minimized' })
    usingIncognito = false
  }
  if (!win || win.id === undefined) throw new Error('could not open a research window')
  renderWindowId = win.id
  renderTabId = win.tabs?.[0]?.id
  if (renderTabId === undefined) throw new Error('could not open a research tab')
  // Remember it across a service-worker restart so sweepOrphanWindow can close it.
  if (renderWindowId !== undefined) {
    await chrome.storage.session.set({ [ORPHAN_KEY]: renderWindowId }).catch(() => {})
  }
  return renderTabId
}

/** Navigate the research tab and wait for the load to complete (bounded). */
export async function navigateAndWait(tabId: number, url: string): Promise<void> {
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
}

/**
 * captureVisibleTab needs the window un-minimized, so briefly normalize it (still
 * unfocused) and re-minimize after. Best-effort by nature — returns undefined
 * rather than failing the caller.
 */
export async function captureBestEffort(): Promise<string | undefined> {
  if (renderWindowId === undefined) return undefined
  try {
    await chrome.windows.update(renderWindowId, { state: 'normal', focused: false })
    await sleep(150)
    const shot = await chrome.tabs.captureVisibleTab(renderWindowId, { format: 'png' })
    await chrome.windows.update(renderWindowId, { state: 'minimized' }).catch(() => {})
    return shot
  } catch {
    return undefined
  }
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
export async function sweepOrphanWindow(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(ORPHAN_KEY)
    const id = got[ORPHAN_KEY] as number | undefined
    if (id === undefined) return
    await chrome.storage.session.remove(ORPHAN_KEY)
    await chrome.windows.remove(id).catch(() => {})
  } catch {
    /* nothing to sweep */
  }
}

/** For diagnostics/telemetry: whether the research tab has an isolated cookie jar. */
export function renderIsIsolated(): boolean {
  return usingIncognito
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
