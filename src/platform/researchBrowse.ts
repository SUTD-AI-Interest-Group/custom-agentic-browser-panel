// The ACTIVE half of the research browser: a stateful, interactive session over
// the isolated research tab. Service-worker-side; driven step-by-step by the
// browse sub-agent in the offscreen host (src/agent/browseAgent.ts) over the
// research.browse message pair.
//
// A session leases the research tab for its whole life (researchTab.acquireTab),
// so a concurrent FetchUrl render escalation cannot navigate the page out from
// under it mid-click. Because a lease that is never released would stall every
// later render, each session arms a TTL watchdog: if the offscreen host dies or
// its loop hangs, the session self-closes and the tab goes back to the pool.
//
// SAFETY: every action is checked by the pure policy in src/tools/browsePolicy.ts
// BEFORE the page is touched. There is no human at the gate here — the agent runs
// while the user may well be asleep — so a refusal is returned to the model as a
// normal result (it can then try another route) and the page is left alone.
//
// That pre-check only ever sees the REQUESTED target though (a click's el.href,
// an explicit navigate's url) — it cannot see where a redirect actually lands,
// and Chrome follows one transparently with no permission to intercept it. Two
// dispatched action kinds can end in a navigation without going through
// navigateAndWait's own landed-URL guard: `click` on an <a href>, and the
// `navigate` action (both via pageActions.ts, neither of which waits for/
// re-validates where the tab ends up).
//
// TOCTOU: a separate "check the tab's url, THEN separately read its content"
// step is racy regardless of how little happens in between — page JS can
// redirect the tab in that gap (a delayed `location.href =`), and the earlier
// check would have already passed. So there is no separate landed-URL check
// here at all: observe() below validates the url returned BY snapshotPage
// (domIndex.ts) and readReadableText (researchRender.ts) themselves — each
// captures `location.href` in the SAME synchronous page-world execution that
// harvests its content, so the url validated is never stale relative to what
// it's guarding. Neither the element registry nor the text is ever exposed —
// nor kept in `session.elements` — for a page that turns out to be blocked.

import { serializeRegistry, snapshotPage, type IndexedElement } from './domIndex'
import { clickElement, navigateTab, pressKey, scrollPage, typeIntoElement, waitForStable } from './pageActions'
import { readReadableText } from './researchRender'
import { acquireTab, navigateAndWait, type TabLease } from './researchTab'
import { isFetchableUrl } from './webFetch'
import { isSafeResearchAction, type BrowseAction } from '../tools/browsePolicy'
import type { BrowseObservation, BrowseOp, BrowseResult } from '../data/researchTasks'

/** A session cannot hold the shared tab longer than this, whatever the caller does. */
const SESSION_TTL_MS = 240_000
/** Each observation carries only an excerpt; the model calls `read` for the full text. */
const EXCERPT_CHARS = 1_500

interface Session {
  lease: TabLease
  /** The latest snapshot's registry — an action's index is resolved against this. */
  elements: IndexedElement[]
  ttl: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, Session>()

/** Chrome's wording for "the tab/window this call targeted no longer exists" —
 *  what a dead research tab (SW eviction, the user closing the minimized
 *  window, a crash) surfaces as, from either chrome.tabs.* or a rejected
 *  chrome.scripting.executeScript. Recognizing it here lets handleBrowseOp
 *  release a dead session's lease immediately instead of leaving the one
 *  shared research tab locked for every other consumer until the TTL fires. */
function looksLikeMissingTab(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /no tab with id|no window with id|the tab was closed|invalid tab id/i.test(msg)
}

/** Handle one browse op from the offscreen sub-agent. Never throws. */
export async function handleBrowseOp(sessionId: string, op: BrowseOp): Promise<BrowseResult> {
  try {
    switch (op.kind) {
      case 'open':
        return await openSession(sessionId, op.url)
      case 'act':
        return await actInSession(sessionId, op.action)
      case 'read':
        return await readSession(sessionId)
      case 'close':
        closeSession(sessionId)
        return { ok: true, message: 'browse session closed' }
    }
  } catch (err) {
    // The underlying tab/window died mid-session — release the lease NOW
    // rather than leaving the shared research tab locked for every other
    // consumer (another task's browse session, a FetchUrl render escalation,
    // the WebSearch tab fallback) until SESSION_TTL_MS elapses. closeSession
    // is idempotent, so a session that's already gone is a harmless no-op.
    if (looksLikeMissingTab(err)) closeSession(sessionId)
    return { ok: false, message: 'the browse session failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Open (or re-point) a session at `url` and return the first observation. */
async function openSession(sessionId: string, url: string): Promise<BrowseResult> {
  // Opening is a navigation, so it goes through the same SSRF-guarded policy.
  const verdict = isSafeResearchAction({ kind: 'navigate', url })
  if (!verdict.ok) return { ok: false, message: verdict.reason }

  let session = sessions.get(sessionId)
  if (!session) {
    const lease = await acquireTab()
    session = { lease, elements: [], ttl: armTtl(sessionId) }
    sessions.set(sessionId, session)
  }
  const nav = await navigateAndWait(session.lease.tabId, url)
  // Fast path only — NOT the real guarantee (see the module header's TOCTOU
  // note and observe() below). Page JS can still redirect between this check
  // and the observe() call; observe()'s own atomic checks are what actually
  // close that window.
  if (nav.blockedReason) {
    return { ok: false, message: `refused to open: redirected to a blocked target (${nav.blockedReason})` }
  }
  const obs = await observe(session)
  if (!obs.ok) return { ok: false, message: `refused to open: ${obs.reason}` }
  return { ok: true, message: `opened ${obs.observation.url}`, observation: obs.observation }
}

/** Run one action, then re-observe the page it produced. */
async function actInSession(sessionId: string, action: BrowseAction): Promise<BrowseResult> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, message: 'no open browse session — call open first' }

  // Resolve the target against the registry the model was last shown, so the
  // policy judges the element the model actually meant.
  const target =
    'index' in action && action.index !== undefined
      ? session.elements.find((e) => e.index === action.index)
      : undefined

  const verdict = isSafeResearchAction(action, target)
  if (!verdict.ok) {
    // Refused BEFORE touching the page. Re-observe anyway so the model gets a
    // fresh registry with its refusal, rather than a dead end. bumpTtl only
    // AFTER observe() resolves (see below) — not at entry — so a session
    // retrying against an already-dead tab can't extend its hold on the one
    // shared resource indefinitely instead of being caught by handleBrowseOp's
    // dead-tab detection.
    const obs = await observe(session)
    bumpTtl(sessionId, session)
    return obs.ok
      ? { ok: false, message: verdict.reason, observation: obs.observation }
      : { ok: false, message: verdict.reason }
  }

  const { tabId } = session.lease
  const result = await dispatch(tabId, action)
  // Let the page settle (SPA route change, filtered list, expanded section).
  await waitForStable(tabId, { quietMs: 400, timeoutMs: 6_000 })

  // Any dispatched action can end in a navigation the pre-check above only
  // half-saw (a click's el.href, or an explicit navigate's url, before any
  // redirect) — observe()'s own atomic checks (not a separate chrome.tabs.get
  // sampled here) are what catch a redirect to a blocked target before
  // anything is read off the page.
  const obs = await observe(session)
  bumpTtl(sessionId, session)
  if (!obs.ok) return { ok: false, message: `refused to continue: ${obs.reason}` }
  return { ok: result.ok, message: result.message, observation: obs.observation }
}

/** Dispatch an already-approved action to the page. */
async function dispatch(tabId: number, action: BrowseAction) {
  switch (action.kind) {
    case 'click':
      return clickElement(tabId, action.index)
    case 'type':
      return typeIntoElement(tabId, action.index, action.text, true)
    case 'press':
      return pressKey(tabId, action.keys)
    case 'scroll':
      return scrollPage(tabId, { direction: action.direction, index: action.index })
    case 'navigate':
      return navigateTab(tabId, action.url)
    case 'back': {
      await chrome.tabs.goBack(tabId).catch(() => {})
      return { ok: true, message: 'went back' }
    }
  }
}

/** Full readable text of the current page — the payload the model is usually after. */
async function readSession(sessionId: string): Promise<BrowseResult> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, message: 'no open browse session — call open first' }
  // readReadableText validates the url it actually read FROM, captured
  // atomically with the content — see its doc comment (researchRender.ts) and
  // the module header's TOCTOU note. No separate chrome.tabs.get here: that
  // would just re-open the exact race this design closes.
  const read = await readReadableText(session.lease.tabId)
  // Only bump once the round trip actually reached the page — see actInSession.
  bumpTtl(sessionId, session)
  if (read.blockedReason) {
    return { ok: false, message: `refused to read: the tab is on a blocked target (${read.blockedReason})` }
  }
  return { ok: true, message: `read ${read.url || read.title}`, text: read.text, url: read.url, title: read.title }
}

/** observe()'s result: a real observation, or a reason it refused to produce
 *  one. Kept local to this module — the browse protocol's BrowseObservation
 *  type (src/data/researchTasks.ts) never needs a "blocked" variant, since a
 *  blocked observe() never becomes an observation the model sees at all (see
 *  every caller below). */
type ObserveOutcome = { ok: true; observation: BrowseObservation } | { ok: false; reason: string }

/**
 * Snapshot the page: numbered interactive elements + a text excerpt.
 *
 * Both snapshotPage (domIndex.ts) and readReadableText (researchRender.ts)
 * capture their content and `location.href` in the SAME synchronous
 * page-world execution — so the url checked here is atomic with the content
 * it guards, unlike a chrome.tabs.get sampled separately before or after
 * (the TOCTOU a redirect mid-navigation, mid-settle, or mid-round-trip could
 * otherwise slip through — see the module header). Neither the element
 * registry nor the text — nor `session.elements` — is ever populated from a
 * page that turns out to be blocked. The two captures are still two separate
 * round trips, though, so a page bouncing between two different (both safe)
 * urls between them is caught by comparing the two atomically-captured urls
 * — see the comment at that check below.
 */
async function observe(session: Session): Promise<ObserveOutcome> {
  const snap = await snapshotPage(session.lease.tabId)
  const snapGuard = isFetchableUrl(snap.url)
  if (!snapGuard.ok) {
    return { ok: false, reason: `the tab landed on a blocked target (${snapGuard.reason})` }
  }
  const read = await readReadableText(session.lease.tabId)
  if (read.blockedReason) {
    // The page moved again between the two injections above — snap.url was
    // fine a moment ago, but readReadableText's own atomic check just caught
    // a further redirect. Discard the (now-stale) elements too, not just the text.
    return { ok: false, reason: `the tab landed on a blocked target (${read.blockedReason})` }
  }
  // Each capture is individually atomic (its own url is captured in the SAME
  // synchronous execution as its own content), but the two round trips are
  // NOT atomic relative to EACH OTHER — this can never leak BLOCKED content
  // (each half independently refuses that on its own), but a page bouncing
  // between two ordinary PUBLIC urls (neither ever blocked) can still have
  // elements captured from one and text from the other. That is a
  // correctness bug, not an SSRF bypass: a report citing page-A while
  // quoting page-B, or a session.elements registry for a page the model
  // isn't being shown. Refuse and let the model retry rather than return a
  // mixed-provenance observation. Combining both extractions into a single
  // injected function (domIndex.ts's snapshotPage) would close this
  // structurally, but that file is out of scope here — compare-and-refuse is
  // the cheapest correct fix available from this side.
  if (read.url !== snap.url) {
    return { ok: false, reason: `the page moved during observation (elements from ${snap.url}, text from ${read.url}) — retry` }
  }
  session.elements = snap.elements
  const excerpt = read.text.slice(0, EXCERPT_CHARS)
  return {
    ok: true,
    observation: {
      url: snap.url,
      title: snap.title,
      elements: serializeRegistry(snap.elements),
      excerpt,
      // Tell the model there is more, so it knows `read` is worth calling.
      more: read.text.length > excerpt.length,
    },
  }
}

/** Release the tab and forget the session. Idempotent. */
export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  clearTimeout(session.ttl)
  session.lease.release()
}

/** Close only the sessions belonging to one task — used when THAT task is cancelled.
 *  Sessions are keyed `${taskId}:browse:${n}` (see src/tools/research.ts), so a prefix
 *  match scopes the teardown to the cancelled task and leaves any other task's
 *  concurrently-running browse session (and its unsaved page walk) untouched. */
export function closeSessionsForTask(taskId: string): void {
  const prefix = `${taskId}:`
  for (const id of [...sessions.keys()]) {
    if (id.startsWith(prefix)) closeSession(id)
  }
}

function armTtl(sessionId: string) {
  return setTimeout(() => closeSession(sessionId), SESSION_TTL_MS)
}

function bumpTtl(sessionId: string, session: Session): void {
  clearTimeout(session.ttl)
  session.ttl = armTtl(sessionId)
}
