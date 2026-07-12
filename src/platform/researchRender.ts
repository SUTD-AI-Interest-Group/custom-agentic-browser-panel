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
// hard): the caller pre-checks the URL with isFetchableUrl (SSRF); a render is
// read-only + safe settling only (navigate to the requested URL, scroll to trigger
// lazy content) — never a form submit, cross-origin navigation, or auth.
//
// Known caveat: PDFs render in Chrome's plugin viewer (no DOM text), so text
// extraction is thin for them — a dedicated PDF path (pdf.js) is future work.

import { isFetchableUrl } from './webFetch'
import { acquireTab, captureBestEffort, exec, navigateAndWait, sleep, type TabLease } from './researchTab'

export interface RenderOutcome {
  text?: string
  title?: string
  finalUrl?: string
  screenshotDataUrl?: string
  error?: string
}

const SETTLE_MS = 900
const MAX_TEXT = 20_000

/** Render one URL in the isolated tab and return its readable text (+ shot). */
export async function renderPage(url: string, want: 'text' | 'screenshot' | 'both'): Promise<RenderOutcome> {
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
    await navigateAndWait(lease.tabId, url)
    // Safe, non-committing settle: scroll to bottom to trigger lazy content.
    await exec(lease.tabId, injScrollToBottom).catch(() => {})
    await sleep(SETTLE_MS)
    const { title, text } = await readReadableText(lease.tabId)
    const screenshotDataUrl = want === 'text' ? undefined : await captureBestEffort()
    const tab = await chrome.tabs.get(lease.tabId).catch(() => undefined)
    return { text, title, finalUrl: tab?.url ?? url, screenshotDataUrl }
  } catch (err) {
    return { error: `render failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    lease.release()
  }
}

/**
 * Reduce the tab's LIVE (rendered) DOM to readable text. Shared with the browse
 * session, which re-reads the page after each interaction.
 */
export async function readReadableText(tabId: number): Promise<{ title: string; text: string }> {
  const [res] = await exec(tabId, injExtractReadable)
  const out = (res?.result as { title?: string; text?: string } | undefined) ?? {}
  return { title: out.title ?? '', text: (out.text ?? '').slice(0, MAX_TEXT) }
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
 *  page is never mutated. Mirrors platform/webFetch.extractReadableText. */
function injExtractReadable(): { title: string; text: string } {
  const title = (document.title || '').trim()
  const pick = document.querySelector('main') || document.querySelector('article') || document.body
  if (!pick) return { title, text: '' }
  const root = pick.cloneNode(true) as HTMLElement
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg').forEach((n) => n.remove())
  root
    .querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,br,tr,td,th,blockquote,pre')
    .forEach((el) => el.after(document.createTextNode('\n')))
  const text = (root.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, 20000) }
}

export { renderIsIsolated } from './researchTab'
