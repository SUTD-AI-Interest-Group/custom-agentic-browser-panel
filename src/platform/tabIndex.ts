// The agent's semantic view of every open tab.
//
// Listing tabs is cheap but thin: sixty titles and URLs tell a model very little
// about which one held the pricing table. Reading sixty pages is the opposite
// problem — accurate and unaffordable. The gist probe sits between the two: one
// tiny injection per tab yields ~180 characters of what the page says it is
// about, so sixty tabs cost roughly 10k characters in a single tool call and the
// chat model can do the clustering itself. There is no second LLM pass and no
// cache to invalidate; the index is rebuilt whenever it is asked for.
//
// The load-bearing rule is that a DISCARDED tab is never probed. Chrome discards
// idle tabs to reclaim memory, and chrome.scripting.executeScript WAKES one —
// so a naive probe across a sixty-tab window would reload every sleeping tab at
// once, spiking RAM and visibly thrashing the browser. Those tabs come back
// title-and-URL-only with a stated reason, so the model can see that the tab
// exists and that it was asleep, and ask the user to wake it if it matters.

import { TAB_GROUP_ID_NONE, type TabFacts } from '../tools/tabPolicy'

/** How much of a page's self-description is worth carrying per tab. */
export const GIST_CHARS = 180

/** Beyond this many tabs, stop probing — the cost ceiling for one call. */
export const TAB_GIST_LIMIT = 100

/** Parallel injections in flight. Enough to be quick, few enough not to jank. */
export const PROBE_CONCURRENCY = 8

/** One tab as the model sees it in gist mode. */
export interface TabRecord extends TabFacts {
  url: string
  /** Page self-description, or '' when the tab was not probed. */
  gist: string
  audible: boolean
  discarded: boolean
  /** A new-tab page or about:blank — a "dead" tab with nothing in it. */
  blank: boolean
  group?: { id: number; title: string; color: string }
  /** Chrome 121+ only; omitted below that rather than faked. */
  lastAccessed?: number
  /** Present when no gist was taken, explaining why. */
  skipped?: string
}

export interface TabIndex {
  tabs: TabRecord[]
  /** Clusters of tabs pointing at the same normalized URL. */
  duplicates: { url: string; tabIds: number[] }[]
  /** Tabs beyond TAB_GIST_LIMIT that were listed but never probed. */
  probeLimitHit: boolean
}

/** URL schemes and hosts that cannot be scripted, whatever their state. */
const UNSCRIPTABLE = /^(chrome|edge|brave|about|devtools|view-source|file|data|blob|chrome-extension|moz-extension):/i

/** Chrome blocks injection into its own store, on any of its hostnames. */
const WEB_STORE = /^(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i

/** A tab with nothing in it. */
const BLANK = /^(about:blank|about:newtab|chrome:\/\/newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)\/?$/i

export function isBlankUrl(url: string): boolean {
  return !url || BLANK.test(url)
}

/** Can a gist be extracted from this URL at all, ignoring tab state? */
export function isProbeableUrl(url: string): boolean {
  if (!url || isBlankUrl(url)) return false
  if (UNSCRIPTABLE.test(url)) return false
  try {
    const u = new URL(url)
    if (WEB_STORE.test(`${u.host}${u.pathname}`)) return false
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Just enough of a tab to decide whether to probe it. */
export interface ProbeCandidate {
  tabId: number
  url: string
  discarded: boolean
}

export interface ProbePlan {
  probe: number[]
  skip: { tabId: number; reason: string }[]
  limitHit: boolean
}

/**
 * Decide which tabs to inject into, BEFORE touching any of them. Keeping this
 * pure is what makes the discarded-tab rule testable — the expensive mistake
 * (waking sixty sleeping tabs) is one this function exists to prevent.
 */
export function planTabProbe(candidates: ProbeCandidate[], limit = TAB_GIST_LIMIT): ProbePlan {
  const probe: number[] = []
  const skip: { tabId: number; reason: string }[] = []
  let limitHit = false

  for (const c of candidates) {
    if (c.discarded) {
      skip.push({ tabId: c.tabId, reason: 'Tab is asleep (discarded by Chrome); reading it would reload it.' })
      continue
    }
    if (isBlankUrl(c.url)) {
      skip.push({ tabId: c.tabId, reason: 'Blank tab — nothing to read.' })
      continue
    }
    if (!isProbeableUrl(c.url)) {
      skip.push({ tabId: c.tabId, reason: 'Browser-internal page; extensions cannot read it.' })
      continue
    }
    if (probe.length >= limit) {
      limitHit = true
      skip.push({ tabId: c.tabId, reason: `Past the ${limit}-tab read limit for one call.` })
      continue
    }
    probe.push(c.tabId)
  }

  return { probe, skip, limitHit }
}

/** Collapse whitespace and clamp a raw page description to the gist budget. */
export function clampGist(raw: string, max = GIST_CHARS): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  // Prefer a word boundary so the tail is not a severed word.
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Tracking parameters that make two URLs for the same page look different. */
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|msclkid|mc_[a-z]+|ref|ref_src|source|igshid|si)$/i

/**
 * Reduce a URL to what identifies the *page*, so two tabs on the same thing
 * cluster together: scheme and `www.` dropped, host lowercased, fragment
 * dropped, tracking parameters stripped, remaining query sorted, trailing
 * slash removed.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.host.toLowerCase().replace(/^www\./, '')
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${query}`
  } catch {
    return url.trim().toLowerCase()
  }
}

/**
 * Cluster tabs that point at the same page. Doing this in code rather than
 * asking the model to eyeball sixty URLs is both cheaper and more reliable —
 * tracking parameters defeat eyeballing more often than not.
 */
export function findDuplicates(tabs: { tabId: number; url: string }[]): { url: string; tabIds: number[] }[] {
  const byKey = new Map<string, { url: string; tabIds: number[] }>()
  for (const t of tabs) {
    if (isBlankUrl(t.url) || !t.url) continue
    const key = normalizeUrl(t.url)
    const hit = byKey.get(key)
    if (hit) hit.tabIds.push(t.tabId)
    else byKey.set(key, { url: t.url, tabIds: [t.tabId] })
  }
  return [...byKey.values()].filter((c) => c.tabIds.length > 1)
}

/** Cap for a URL surviving into the model-facing index as-is, matching the
 *  spirit of clampGist's budget: a single tab must not be able to blow up the
 *  "~10k characters for 60 tabs" cost model this module exists to guarantee. */
const URL_DISPLAY_CHARS = 500

/** Truncate a long string for display — no attempt to preserve meaning past the cut. */
function clampUrl(url: string, max = URL_DISPLAY_CHARS): string {
  return url.length > max ? `${url.slice(0, max)}…` : url
}

/** Best-effort host for display; falls back to a truncated raw URL for odd
 *  schemes (a data: URL has no real .host, and can otherwise be enormous). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || clampUrl(url)
  } catch {
    return clampUrl(url)
  }
}

// ---------------------------------------------------------------------------
// Chrome shell
// ---------------------------------------------------------------------------

// Runs inside the target page. Must be fully self-contained — it is serialized
// and injected into an isolated world with no closures and no imports.
function extractGist() {
  const pick = (sel: string, attr: string) => {
    const el = document.querySelector(sel)
    return el?.getAttribute(attr)?.trim() ?? ''
  }
  const og = pick('meta[property="og:description"]', 'content')
  const meta = pick('meta[name="description"]', 'content')
  const h1 = document.querySelector('h1')?.textContent?.trim() ?? ''
  const body = document.body?.innerText?.trim().slice(0, 400) ?? ''
  // Priority: what the page says about itself, then its headline, then its opening.
  return { gist: og || meta || h1 || body }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await work(items[i])
    }
  })
  await Promise.all(runners)
  return out
}

/**
 * The cheap half of the index: current facts about every tab, with no page
 * injection at all. This is what the mutation tools plan against — grouping and
 * closing need to know window, pin and group state, not what a page says, and
 * re-reading it immediately before acting is what keeps the approval card honest
 * when tabs have moved since the model last looked.
 */
export async function listTabFacts(): Promise<(TabFacts & { url: string })[]> {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((t) => t.id !== undefined)
    .map((t) => ({
      tabId: t.id!,
      windowId: t.windowId,
      title: t.title ?? '(untitled)',
      // hostOf() gets the FULL url (correct parsing needs the whole string);
      // only the value that lands in the record is capped for display.
      host: hostOf(t.url ?? ''),
      url: clampUrl(t.url ?? ''),
      pinned: t.pinned ?? false,
      active: t.active ?? false,
      groupId: t.groupId ?? TAB_GROUP_ID_NONE,
    }))
}

/**
 * Build the semantic index of every open tab: one Chrome query for tabs, one for
 * groups, then a bounded-concurrency gist probe over the tabs that planTabProbe
 * cleared. A single tab's failure becomes a `skipped` reason on that record, never
 * a failed batch.
 */
export async function buildTabIndex(): Promise<TabIndex> {
  const raw = await chrome.tabs.query({})
  const tabs = raw.filter((t) => t.id !== undefined)

  // Group metadata, when the tabGroups permission is present. A failure here
  // must not sink the whole index — the gist is the valuable part.
  const groups = new Map<number, { id: number; title: string; color: string }>()
  try {
    for (const g of await chrome.tabGroups.query({})) {
      groups.set(g.id, { id: g.id, title: g.title ?? '', color: g.color })
    }
  } catch {
    // No tabGroups permission, or the API is unavailable — records omit `group`.
  }

  const plan = planTabProbe(
    tabs.map((t) => ({ tabId: t.id!, url: t.url ?? '', discarded: t.discarded ?? false })),
  )
  const skipReason = new Map(plan.skip.map((s) => [s.tabId, s.reason]))

  const gists = new Map<number, string>()
  await mapLimit(plan.probe, PROBE_CONCURRENCY, async (tabId) => {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extractGist })
      const gist = clampGist(res?.result?.gist ?? '')
      if (gist) gists.set(tabId, gist)
      else skipReason.set(tabId, 'Page had no description to read.')
    } catch {
      skipReason.set(tabId, 'Page could not be read (it may still be loading, or it blocks extensions).')
    }
  })

  const records: TabRecord[] = tabs.map((t) => {
    const url = t.url ?? ''
    const groupId = t.groupId ?? TAB_GROUP_ID_NONE
    const group = groups.get(groupId)
    const skipped = skipReason.get(t.id!)
    const lastAccessed = (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed
    return {
      tabId: t.id!,
      windowId: t.windowId,
      title: t.title ?? '(untitled)',
      // hostOf() gets the FULL url (correct parsing needs the whole string);
      // only the record's own `url` field is capped for display.
      host: hostOf(url),
      url: clampUrl(url),
      gist: gists.get(t.id!) ?? '',
      pinned: t.pinned ?? false,
      active: t.active ?? false,
      audible: t.audible ?? false,
      discarded: t.discarded ?? false,
      blank: isBlankUrl(url),
      groupId,
      ...(group ? { group } : {}),
      ...(typeof lastAccessed === 'number' ? { lastAccessed } : {}),
      ...(skipped ? { skipped } : {}),
    }
  })

  return {
    tabs: records,
    // Dedup on the FULL urls (tabs, not records) — clustering on the
    // display-clamped url could make two distinct long URLs collide on a
    // shared truncated prefix.
    duplicates: findDuplicates(tabs.map((t) => ({ tabId: t.id!, url: t.url ?? '' }))),
    probeLimitHit: plan.limitHit,
  }
}
