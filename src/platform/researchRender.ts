// One-shot render for the hybrid-escalation broker. The offscreen research agent
// cannot touch tabs, so when a page is JS-heavy / paywalled and the plain fetch
// comes back empty, it asks the SW (via research.renderPage) to render the URL in
// a REAL, isolated tab and return the readable text (+ optional shot).
//
// This is the *passive* half of the research browser: navigate, settle, read, done.
// The active half — clicking, paginating, site-searching — is researchBrowse.ts.
// Both lease the same isolated tab from researchTab.ts, so a render can never
// navigate the page out from under a live browse session.
//
// Boundaries (there is no human at the point-of-no-return gate here, so these are
// hard): the caller pre-checks the URL with isFetchableUrl (SSRF), and
// navigateAndWait (researchTab.ts) re-checks WHERE the tab actually landed
// after following any redirects — a public URL can 302 to a private/loopback
// target, so the pre-navigation check alone is not enough. A render is
// read-only + safe settling only (navigate to the requested URL, scroll to trigger
// lazy content) — never a form submit, cross-origin navigation, or auth.
//
// TOCTOU: navigateAndWait's check happens at load-complete, but this function
// then scrolls and sleeps (SETTLE_MS) before reading anything — a delayed
// `location.href = ...` (a `setTimeout` fired from the page's own JS) can
// redirect the tab to a blocked target inside that window, AFTER the check
// already passed. A second `chrome.tabs.get` immediately before the read
// would only shrink that window, not close it — the same bug reappears at
// the next site the tab is sampled from. The actual fix: readReadableText
// captures `location.href` in the SAME synchronous page-world execution that
// extracts the content, so the url it validates is never stale relative to
// what it's guarding — there is no window between "check" and "read" because
// they are the same call.
//
// PDFs never reach this broker: FetchUrl routes them to the pdf.js extractor
// (platform/pdf.ts) before escalation — Chrome's plugin viewer has no DOM text,
// so a rendered read could never help there.

import { isFetchableUrl } from './webFetch'
import { acquireTab, exec, navigateAndWait, sleep, type TabLease } from './researchTab'

export interface RenderOutcome {
  text?: string
  title?: string
  finalUrl?: string
  error?: string
}

const SETTLE_MS = 900
const MAX_TEXT = 20_000

/**
 * Render one URL in the isolated tab and return its readable text.
 *
 * Text only, deliberately — a screenshot mode was removed rather than fixed:
 * `chrome.tabs.captureVisibleTab` captures whatever is visually COMPOSITED on
 * screen, same-origin AND cross-origin iframes alike (the Same-Origin Policy
 * governs DOM/JS access, not painting), while every url guard in this file
 * only ever inspects the TOP frame's `location.href`. A page can sit on a
 * permanently-safe, never-redirecting url while embedding
 * `<iframe src="http://169.254.169.254/latest/meta-data/iam/security-credentials/">`
 * — many internal services send no X-Frame-Options — and that iframe's
 * content would render straight into the screenshot with nothing here ever
 * checking its src. No race, no redirect, no TOCTOU needed. The text path is
 * unaffected (ordinary SOP already blocks cross-origin iframe DOM/text
 * access), which is why this was a screenshot-only blocker — but since
 * nothing in this codebase ever called for a screenshot (both FetchUrl call
 * sites in src/tools/research.ts only ever asked for text), deleting the
 * capability beat leaving a warning comment someone could skip past.
 */
export async function renderPage(url: string): Promise<RenderOutcome> {
  // Defense in depth — the SW message handler already guards, re-check here.
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { error: `refused to render (${guard.reason})` }

  let lease: TabLease
  try {
    lease = await acquireTab()
  } catch (err) {
    return { error: `render failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const nav = await navigateAndWait(lease.tabId, url)
    // Fast path only — NOT the real guarantee (see the module header's TOCTOU
    // note). Page JS can still redirect the tab during the scroll/settle
    // window below, after this check already passed; this just skips that
    // work for a load that was already bad at the time it completed.
    if (nav.blockedReason) return { error: `refused: redirected to a blocked target (${nav.blockedReason})` }
    // Safe, non-committing settle: scroll to bottom to trigger lazy content.
    await exec(lease.tabId, injScrollToBottom).catch(() => {})
    await sleep(SETTLE_MS)
    // The real guarantee: readReadableText validates the url it actually read
    // FROM, captured atomically with the content itself — never a url sampled
    // before or after the fact.
    const read = await readReadableText(lease.tabId)
    if (read.blockedReason) return { error: `refused: redirected to a blocked target (${read.blockedReason})` }
    return { text: read.text, title: read.title, finalUrl: read.url }
  } catch (err) {
    return { error: `render failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    lease.release()
  }
}

/**
 * Reduce the tab's LIVE (rendered) DOM to readable text — and validate WHERE
 * that content actually came from, ATOMICALLY with reading it. Shared with the
 * browse session, which re-reads the page after each interaction.
 *
 * A caller-side check-then-read (sample the tab's url via chrome.tabs.get,
 * THEN separately read its content) is inherently racy: page JS can redirect
 * the tab in the gap between the two calls. injExtractReadable below captures
 * `location.href` in the SAME synchronous page-world execution that extracts
 * the content, so the url validated here can never be stale relative to what
 * it's guarding — there is no window between "check" and "read" because they
 * are the same call. A blocked landing returns empty title/text and
 * `blockedReason` set; content is never handed back for a blocked url.
 */
export async function readReadableText(
  tabId: number,
): Promise<{ title: string; text: string; url: string; blockedReason?: string }> {
  const [res] = await exec(tabId, injExtractReadable)
  const out = (res?.result as { title?: string; text?: string; url?: string } | undefined) ?? {}
  const url = out.url ?? ''
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { title: '', text: '', url, blockedReason: guard.reason }
  return { title: out.title ?? '', text: (out.text ?? '').slice(0, MAX_TEXT), url }
}

// ---- Injected page-world functions (self-contained; no imports/closures) ----

/** Scroll to the bottom to trigger lazy-loaded content. Read-only side effect. */
function injScrollToBottom(): void {
  try {
    window.scrollTo(0, document.body.scrollHeight)
  } catch {
    /* ignore */
  }
}

/** Reduce the LIVE (rendered) DOM to readable text — operating on a CLONE so the
 *  page is never mutated. Mirrors platform/webFetch.extractReadableText.
 *  Returns `location.href` alongside the content, captured in this SAME
 *  synchronous execution — see readReadableText's doc comment for why that
 *  atomicity is load-bearing. */
function injExtractReadable(): { title: string; text: string; url: string } {
  const title = (document.title || '').trim()
  const url = location.href
  const pick = document.querySelector('main') || document.querySelector('article') || document.body
  if (!pick) return { title, text: '', url }
  const root = pick.cloneNode(true) as HTMLElement
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg').forEach((n) => n.remove())
  root
    .querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,br,tr,td,th,blockquote,pre')
    .forEach((el) => el.after(document.createTextNode('\n')))
  const text = (root.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, 20000), url }
}

export { renderIsIsolated } from './researchTab'
