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

import { serializeRegistry, snapshotPage, type IndexedElement } from './domIndex'
import { clickElement, navigateTab, pressKey, scrollPage, typeIntoElement, waitForStable } from './pageActions'
import { readReadableText } from './researchRender'
import { acquireTab, navigateAndWait, type TabLease } from './researchTab'
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
  await navigateAndWait(session.lease.tabId, url)
  const observation = await observe(session)
  return { ok: true, message: `opened ${observation.url}`, observation }
}

/** Run one action, then re-observe the page it produced. */
async function actInSession(sessionId: string, action: BrowseAction): Promise<BrowseResult> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, message: 'no open browse session — call open first' }
  bumpTtl(sessionId, session)

  // Resolve the target against the registry the model was last shown, so the
  // policy judges the element the model actually meant.
  const target =
    'index' in action && action.index !== undefined
      ? session.elements.find((e) => e.index === action.index)
      : undefined

  const verdict = isSafeResearchAction(action, target)
  if (!verdict.ok) {
    // Refused BEFORE touching the page. Re-observe anyway so the model gets a
    // fresh registry with its refusal, rather than a dead end.
    return { ok: false, message: verdict.reason, observation: await observe(session) }
  }

  const { tabId } = session.lease
  const result = await dispatch(tabId, action)
  // Let the page settle (SPA route change, filtered list, expanded section).
  await waitForStable(tabId, { quietMs: 400, timeoutMs: 6_000 })
  const observation = await observe(session)
  return { ok: result.ok, message: result.message, observation }
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
  bumpTtl(sessionId, session)
  const { title, text } = await readReadableText(session.lease.tabId)
  const tab = await chrome.tabs.get(session.lease.tabId).catch(() => undefined)
  return { ok: true, message: `read ${tab?.url ?? title}`, text, url: tab?.url, title }
}

/** Snapshot the page: numbered interactive elements + a text excerpt. */
async function observe(session: Session): Promise<BrowseObservation> {
  const snap = await snapshotPage(session.lease.tabId)
  session.elements = snap.elements
  const { text } = await readReadableText(session.lease.tabId)
  const excerpt = text.slice(0, EXCERPT_CHARS)
  return {
    url: snap.url,
    title: snap.title,
    elements: serializeRegistry(snap.elements),
    excerpt,
    // Tell the model there is more, so it knows `read` is worth calling.
    more: text.length > excerpt.length,
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

/** Close every open session — used when a research task is cancelled. */
export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id)
}

function armTtl(sessionId: string) {
  return setTimeout(() => closeSession(sessionId), SESSION_TTL_MS)
}

function bumpTtl(sessionId: string, session: Session): void {
  clearTimeout(session.ttl)
  session.ttl = armTtl(sessionId)
}
