// Tab-search fallback for the background research agent. When the keyless
// DuckDuckGo fetch is throttled (202/429 — its "prove you're a real browser"
// wall), a plain fetch can never clear it. But the extension HAS a real browser:
// the same isolated tab the renderer and browse session lease (researchTab.ts).
// Navigating a genuine tab to the results page executes DDG's challenge like any
// browser would, sends no chrome-extension Origin, and renders real result rows
// we can scrape from the live DOM.
//
// Service-worker-side (the offscreen host can't touch tabs); reached from the
// research WebSearch tool via the research.searchTab broker round-trip.

import { acquireTab, exec, navigateAndWait, type TabLease } from './researchTab'
import type { SearchResultRow } from './webFetch'

export interface SearchOutcome {
  results?: SearchResultRow[]
  error?: string
}

/** Run one search in the isolated tab and scrape the rendered results. */
export async function searchInTab(query: string, maxResults = 8): Promise<SearchOutcome> {
  let lease: TabLease
  try {
    lease = await acquireTab()
  } catch (err) {
    return { error: `tab search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    // The no-JS HTML endpoint: a real navigation renders full result rows with
    // inline snippets, and its markup is stabler to scrape than the SPA SERP.
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    await navigateAndWait(lease.tabId, url)
    const [res] = await exec(lease.tabId, injScrapeDuckDuckGo)
    const scraped = (res?.result as { rows?: SearchResultRow[]; challenged?: boolean } | undefined) ?? {}
    if (scraped.challenged && !scraped.rows?.length) {
      return { error: 'tab search hit a CAPTCHA/challenge page' }
    }
    return { results: (scraped.rows ?? []).slice(0, Math.min(maxResults, 20)) }
  } catch (err) {
    return { error: `tab search failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    lease.release()
  }
}

// ---- Injected page-world function (self-contained; no imports/closures) ----

/**
 * Scrape DuckDuckGo result rows from the LIVE rendered DOM. Mirrors the pure
 * parseDuckDuckGoHtml/parseDuckDuckGoLite in webFetch.ts, but must be fully
 * self-contained (executeScript serializes it, sharing no scope). Handles both
 * the html (`.result__a`) and lite (`a.result-link`) layouts, and reports whether
 * the page looks like a challenge wall so the caller can distinguish "no results"
 * from "blocked".
 */
function injScrapeDuckDuckGo(): { rows: { title: string; url: string; snippet: string }[]; challenged: boolean } {
  const unwrap = (href: string): string => {
    try {
      const abs = href.startsWith('//') ? `https:${href}` : href
      const u = new URL(abs, 'https://duckduckgo.com')
      const uddg = u.searchParams.get('uddg')
      return uddg ? decodeURIComponent(uddg) : abs
    } catch {
      return href
    }
  }
  const rows: { title: string; url: string; snippet: string }[] = []

  // html endpoint layout.
  document.querySelectorAll('.result, .web-result').forEach((r) => {
    const a = r.querySelector('a.result__a') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (!href || href.indexOf('duckduckgo.com/y.js') !== -1) return
    const title = (a.textContent || '').trim()
    const url = unwrap(href)
    const snippet = ((r.querySelector('.result__snippet') as HTMLElement | null)?.textContent || '').trim()
    if (title && url) rows.push({ title, url, snippet })
  })

  // lite endpoint layout (fallback, in case DDG served the lite page).
  if (rows.length === 0) {
    document.querySelectorAll('a.result-link').forEach((a) => {
      const href = (a as HTMLAnchorElement).getAttribute('href') || ''
      const title = (a.textContent || '').trim()
      const url = unwrap(href)
      const row = a.closest('tr')
      const snip = row?.nextElementSibling?.querySelector('.result-snippet')
      const snippet = (snip?.textContent || '').trim()
      if (title && url) rows.push({ title, url, snippet })
    })
  }

  // A challenge/anomaly page has a form/body that mentions it and no results.
  const bodyText = (document.body?.innerText || '').toLowerCase()
  const challenged =
    rows.length === 0 &&
    (bodyText.includes('unusual traffic') ||
      bodyText.includes('are you a robot') ||
      bodyText.includes('anomaly') ||
      !!document.querySelector('form[action*="challenge"], #anomaly-modal'))

  return { rows, challenged }
}
