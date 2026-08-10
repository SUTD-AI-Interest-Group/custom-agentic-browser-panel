import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ProviderConfig } from '../data/settings'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { instrumentToolset, type Trace } from '../agent/observability'
import { searchDuckDuckGo, fetchReadable, isFetchableUrl, PDF_CONTENT, type SearchResultRow } from '../platform/webFetch'
import { looksLikePdfUrl, assemblePagesText } from '../platform/pdfText'
import { loadPdf } from '../platform/pdf'
import { searchAcademic, searchImages, harvestImages, type ImageResult } from '../platform/researchSources'
import { summarizeNotebook, type NotebookHandle } from '../agent/notebook'
import { runBrowseSession, type BrowseBroker } from '../agent/browseAgent'
import { scopeAllows } from './browsePolicy'
import type { UIPart } from '../agent/agent'

export type { BrowseBroker } from '../agent/browseAgent'

/**
 * Escalation broker: render a hard URL (JS-heavy / paywalled) in a real
 * controlled tab via the service worker, since the offscreen research host
 * cannot touch tabs itself. Injected by the controller; absent = headless-only
 * (the fast path still works, hard pages just fail). Text only — see
 * researchRender.ts's module header for why a screenshot mode was removed
 * rather than fixed.
 */
export interface RenderBroker {
  render(url: string): Promise<{ text?: string; title?: string; finalUrl?: string; error?: string }>
}

/**
 * Search broker: run a web search in a real controlled tab via the service
 * worker. The keyless DuckDuckGo fetch is often throttled (202/429) because it
 * looks like a bot; a genuine tab clears that wall. Injected by the controller;
 * absent = keyless-only (searches just fail when throttled).
 */
export interface SearchBroker {
  search(query: string, maxResults: number): Promise<{ results: SearchResultRow[] } | { error: string }>
}

/** A headless fetch whose text is this short is likely a JS-rendered shell — a
 *  candidate for tab escalation when a broker is available. */
const THIN_TEXT = 400

/** Merge whichever abort signals are actually defined into one — used so a page
 *  walk can be cut short by EITHER the task-level signal (a real Stop) OR the AI
 *  SDK's own per-call abortSignal (resilient()'s 900s per-attempt timeout),
 *  instead of only ever honoring one of them. Degrades gracefully where
 *  AbortSignal.any is unavailable, matching the pattern already used by
 *  research.ts's withAttemptTimeout / resilience.ts's defaultAttemptSignal. */
function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => !!s)
  if (defined.length === 0) return new AbortController().signal
  if (defined.length === 1) return defined[0]
  try {
    if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) return AbortSignal.any(defined)
  } catch {
    /* fall through */
  }
  return defined[0]
}

/** Page walks are the expensive tool; cap how many one task may spend. */
export interface BrowseBudget {
  remaining: number
}

// Session ids only need to be unique within the offscreen host's lifetime.
let browseSeq = 0

/** Record a batch of found images into the notebook (deduped); returns how many
 *  were new. Caption falls back to the title; provenance carries through. */
function recordImages(notebook: NotebookHandle, images: ImageResult[], relevanceNote?: string): number {
  let n = 0
  for (const img of images) {
    const added = notebook.addImage({
      url: img.url,
      sourceUrl: img.sourcePageUrl,
      caption: img.caption || img.title,
      license: img.license,
      author: img.author,
      dims: img.dims,
      relevanceNote,
    })
    if (added) n++
  }
  return n
}

/** A compact view of an image for a tool result (the model doesn't need all fields). */
function briefImage(img: ImageResult) {
  return { url: img.url, caption: img.caption || img.title, license: img.license, source: img.sourcePageUrl }
}

/**
 * Filter a batch of `{url}`-bearing rows down to the source scope, plus a note
 * when the filter removed everything the backend found.
 *
 * A snippet/title/abstract alone is enough to hallucinate from, so an
 * out-of-scope row must not reach the model at all — narrowing the outgoing
 * QUERY (WebSearch's `site:` operator) is only ever a hint the engine may
 * ignore, so this filter is what actually enforces the scope, every time.
 *
 * Shared by WebSearch/SearchAcademic/SearchImages: each hits a FIXED, trusted
 * backend (lite.duckduckgo.com / api.openalex.org / commons.wikimedia.org +
 * api.openverse.org — never a model-chosen host), but each ROW's own url can
 * point anywhere. That's a different shape from FetchUrl/HarvestImages/
 * BrowseSite, which take a model-chosen url directly and so are refused
 * pre-network instead (see each's own `scopeAllows` check below) — there is
 * nothing to filter there, the call itself either is or isn't in scope.
 *
 * An unexplained empty array reads as "nothing exists" when the truth is "the
 * scope excluded what was found" — the same "state it, don't silently drop
 * it" rule the pre-network refusals follow, so this attaches a `note` rather
 * than returning a bare `{results: []}`.
 */
function withScope<T extends { url: string }>(rows: T[], sites: string[], noun: string): { results: T[]; note?: string } {
  if (!sites.length) return { results: rows }
  const results = rows.filter((row) => scopeAllows(row.url, sites))
  return results.length
    ? { results }
    : { results, note: `Every ${noun} was outside this task's source scope (${sites.join(', ')}); try a different query.` }
}

// FetchUrl's text budget for a PDF, matching extractReadableText's HTML cap.
const PDF_TEXT_BUDGET = 20_000

/**
 * FetchUrl's PDF path: extract text with pdf.js instead of scraping DOM text —
 * Chrome's PDF viewer has no DOM, so the rendered-tab escalation can never help
 * here. SSRF-guarded like fetchReadable: the input URL is checked before the
 * fetch, and the final (redirect-followed) URL is re-checked before any content
 * is returned. Cookie-less, like every research fetch.
 */
async function fetchPdfReadable(url: string, notebook: NotebookHandle, signal?: AbortSignal) {
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { error: `refused to fetch (${guard.reason})` }
  try {
    const { info, pages } = await loadPdf(url, { credentials: 'omit', signal })
    const finalGuard = isFetchableUrl(info.url)
    if (!finalGuard.ok) return { error: `refused: redirected to a blocked target (${finalGuard.reason})` }
    const { blocks, omittedPages } = assemblePagesText(pages, pages.map((p) => p.page), PDF_TEXT_BUDGET)
    const text = blocks.map((b) => `[page ${b.page}]\n${b.text}`).join('\n\n')
    notebook.addSource({ url: info.url, title: info.title, fetchedVia: 'headless' })
    const cut = omittedPages.length > 0 || info.pageCount > info.extractedPages
    return {
      url: info.url,
      title: info.title,
      text,
      pdf: true,
      pageCount: info.pageCount,
      ...(cut
        ? { truncated: true, note: `PDF text truncated to the first ${blocks.length} of ${info.pageCount} pages.` }
        : {}),
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read-only, web-egress-only tools for the BACKGROUND research agent. Ungated by
 * design — there is no user present in the offscreen sandbox, and these tools
 * touch no tabs, cookies, or user data. Findings/sources/images flow into the
 * shared `notebook` (the controller persists it). Wired ONLY into the offscreen
 * research agent, never the foreground chat.
 */
export function createResearchTools(deps: {
  selected: { provider: ProviderConfig; modelId: string } | null
  /** The shared research notebook — tools record sources/findings/images here. */
  notebook: NotebookHandle
  /** Optional tab-escalation broker for hard pages (Phase 4). */
  renderBroker?: RenderBroker
  /** Optional interactive-tab broker; absent = no BrowseSite tool. */
  browseBroker?: BrowseBroker
  /** Optional tab-search broker; absent = keyless search only (fails when throttled). */
  searchBroker?: SearchBroker
  /** Page-walk budget, shared across the task's gather rounds. */
  browseBudget?: BrowseBudget
  /** The task id, so browse sessions are namespaced per task. */
  taskId?: string
  /** Streams a page walk's inner steps up to the sheet, nested under its call. */
  onBrowseStep?: (toolCallId: string, parts: UIPart[]) => void
  /** Optional Langfuse trace for the research task; when set, tools become spans. */
  trace?: Trace
  /** Cancellation for the whole task. */
  signal?: AbortSignal
  /**
   * Source scope from the launch card: registrable hosts (see scopeAllows,
   * browsePolicy.ts). Empty/absent = unrestricted — today's default behavior,
   * and every existing caller that doesn't pass this gets it unchanged.
   *
   * Two enforcement shapes, by tool input shape (see withScope's doc comment
   * for the full reasoning): WebSearch/SearchAcademic/SearchImages take a
   * QUERY against a fixed backend, so their result ROWS are filtered after the
   * fact (WebSearch also narrows the outgoing query as a hint); FetchUrl,
   * HarvestImages and BrowseSite take a model-chosen URL directly, so THAT
   * call is refused outright before any network work.
   */
  sites?: string[]
}): ToolSet {
  const { notebook, renderBroker, browseBroker, searchBroker, browseBudget, sites = [] } = deps
  const tools: ToolSet = {
    WebSearch: tool({
      description: 'Search the web (DuckDuckGo) and return ranked {title,url,snippet} results.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Default 8, max 20'),
      }),
      execute: async ({ query, maxResults = 8 }, { abortSignal }) => {
        // `site:` narrows the query for up to 3 scoped hosts (an OR chain past
        // that gets unwieldy) — it's only a hint the engine may ignore; withScope
        // below is what actually enforces it (see that function's own doc
        // comment for the full "why", shared with SearchAcademic/SearchImages).
        const scopedQuery =
          sites.length > 0 && sites.length <= 3 ? `${query} (${sites.map((s) => `site:${s}`).join(' OR ')})` : query

        const r = await searchDuckDuckGo(scopedQuery, maxResults, abortSignal)
        if (!('error' in r) && r.results.length) return withScope(r.results, sites, 'result')
        // The keyless endpoint was throttled or parsed nothing. If a tab broker is
        // available, retry the search in a REAL browser tab — that clears the bot
        // wall a plain fetch can't. This is what turns "search failed after
        // retries" into actual results.
        if (searchBroker) {
          const t = await searchBroker.search(scopedQuery, maxResults)
          if (!('error' in t) && t.results.length) return { ...withScope(t.results, sites, 'result'), via: 'tab' }
          // Both paths failed — surface the more informative error.
          if ('error' in r) return { error: r.error, note: 'error' in t ? `tab fallback also failed: ${t.error}` : undefined }
          return { results: [], note: 'No results from the web search or the tab fallback; try a different query.' }
        }
        if ('error' in r) return r
        return { results: [], note: 'No results parsed; try a different query.' }
      },
    }),

    FetchUrl: tool({
      description:
        'Fetch a public web page and return its readable text. PDFs are parsed directly (per-page text, [page N] markers). Automatically renders JS/paywalled pages in a real tab when the plain fetch comes back empty. Pass render:true to force a rendered read (e.g. for a page you know is a SPA).',
      inputSchema: z.object({
        url: z.string().describe('http(s) URL to read'),
        render: z.boolean().optional().describe('Force a real-tab render instead of a plain fetch'),
      }),
      execute: async ({ url, render }, { abortSignal }) => {
        if (!scopeAllows(url, sites)) {
          // Stated, not silent: a blocked read must appear in the step log so the
          // report's gaps are explicable.
          return { error: `Out of scope. This research is restricted to: ${sites.join(', ')}` }
        }
        // A PDF has no DOM to render or scrape — go straight to the pdf.js
        // extractor (even under render:true; a tab render can never help).
        if (looksLikePdfUrl(url)) return await fetchPdfReadable(url, notebook, abortSignal)
        // Forced render (a SPA the model already knows about).
        if (render && renderBroker) {
          const rr = await renderBroker.render(url)
          if (!rr.error && rr.text) {
            const finalUrl = rr.finalUrl || url
            notebook.addSource({ url: finalUrl, title: rr.title, fetchedVia: 'tab' })
            return { url: finalUrl, title: rr.title ?? finalUrl, text: rr.text, rendered: true }
          }
          // fall through to a plain fetch if the render failed
        }
        const r = await fetchReadable(url, abortSignal)
        // A PDF served from an extension-less URL (arxiv.org/pdf/…) only reveals
        // itself by content-type — the sentinel routes it to the extractor.
        if ('error' in r && r.error === PDF_CONTENT) return await fetchPdfReadable(url, notebook, abortSignal)
        const thin = !('error' in r) && r.text.trim().length < THIN_TEXT
        if (renderBroker && ('error' in r || thin)) {
          const rr = await renderBroker.render(url)
          const min = 'error' in r ? 1 : r.text.trim().length
          if (!rr.error && rr.text && rr.text.trim().length >= min) {
            const finalUrl = rr.finalUrl || url
            notebook.addSource({ url: finalUrl, title: rr.title, fetchedVia: 'tab' })
            return { url: finalUrl, title: rr.title ?? finalUrl, text: rr.text, rendered: true }
          }
        }
        // A page that refuses a plain fetch (403 / bot wall / non-HTML) is not a
        // dead end — it is exactly what the real browser tab is for. Say so, or
        // the model just runs another WebSearch and the source is lost.
        if ('error' in r) {
          return browseBroker
            ? {
                ...r,
                hint: `A plain fetch of this page was refused (${r.error}). Call BrowseSite({url, objective}) to open it in a real browser tab and read it there.`,
              }
            : r
        }
        notebook.addSource({ url: r.url, title: r.title, fetchedVia: 'headless' })
        return r
      },
    }),

    ExtractDataText: tool({
      description: 'Extract structured JSON (to a JSON schema) from a block of text you already fetched.',
      inputSchema: z.object({
        text: z.string(),
        instruction: z.string(),
        schema: z.record(z.any()),
      }),
      execute: async ({ text, instruction, schema }, { abortSignal }) => {
        if (!deps.selected) return { error: 'No model configured.' }
        const model = createModel(deps.selected.provider, deps.selected.modelId)
        const prompt = `${instruction}\n\nText:\n${text.slice(0, 40_000)}`
        try {
          return { data: await extractStructured(model, prompt, schema as Record<string, unknown>, abortSignal, deps.trace) }
        } catch (err) {
          return { error: `Could not extract structured data (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),

    SearchAcademic: tool({
      description:
        'Search academic literature (OpenAlex) for papers on a topic. Returns {title, abstract, authors, year, url, pdfUrl}. Use for scholarly/technical questions; record facts with WriteNotebook citing the paper url.',
      inputSchema: z.object({
        query: z.string().describe('Search query (topic, method, author…)'),
        maxResults: z.number().optional().describe('Default 8, max 25'),
      }),
      execute: async ({ query, maxResults = 8 }, { abortSignal }) => {
        const r = await searchAcademic(query, maxResults, abortSignal)
        if ('error' in r) return r
        // OpenAlex itself is a fixed, trusted backend (the model never chooses
        // ITS host), but each paper's own url/pdfUrl points at an arbitrary
        // publisher — the same reachable-from-anywhere shape WebSearch's
        // results have, so the same filter applies (see withScope).
        return r.results.length ? withScope(r.results, sites, 'paper') : { results: [], note: 'No papers found; try different terms.' }
      },
    }),

    SearchImages: tool({
      description:
        'Search for relevant, attributed images (Wikimedia Commons + Openverse). Adds the results to the notebook so they can be embedded in the report with source + license. Returns the candidates it found.',
      inputSchema: z.object({
        query: z.string().describe('What the image should depict'),
        maxResults: z.number().optional().describe('Default 6, max 20'),
      }),
      execute: async ({ query, maxResults = 6 }, { abortSignal }) => {
        const r = await searchImages(query, maxResults, abortSignal)
        if ('error' in r) return r
        // Filter BEFORE recording: an out-of-scope image must never reach the
        // notebook, since notebook.images is what synthesize()'s imageBlock
        // embeds straight into the final report.
        const { results: inScope, note } = withScope(r.results, sites, 'image')
        const added = recordImages(notebook, inScope, query)
        return { found: inScope.length, added, images: inScope.map(briefImage), ...(note ? { note } : {}) }
      },
    }),

    HarvestImages: tool({
      description:
        'Collect the meaningful <img> assets (charts, figures, photos) from a page you found useful, so relevant ones can be embedded in the report. Returns the images found on that page.',
      inputSchema: z.object({ url: z.string().describe('The page URL to harvest images from') }),
      execute: async ({ url }, { abortSignal }) => {
        if (!scopeAllows(url, sites)) {
          // Stated, not silent: a blocked read must appear in the step log so
          // the report's gaps are explicable. Same treatment as FetchUrl —
          // this tool takes an arbitrary model-chosen url and fetches it
          // directly, so it needs the identical pre-network refusal.
          return { error: `Out of scope. This research is restricted to: ${sites.join(', ')}` }
        }
        const r = await harvestImages(url, abortSignal)
        if ('error' in r) return r
        const added = recordImages(notebook, r.results)
        return { found: r.results.length, added, images: r.results.map(briefImage) }
      },
    }),

    ExtractTable: tool({
      description:
        'Extract tabular/structured data from a block of text you fetched. Give an instruction describing the columns; returns an array of row objects.',
      inputSchema: z.object({
        text: z.string(),
        instruction: z.string().describe('What table/rows to extract and which columns'),
      }),
      execute: async ({ text, instruction }, { abortSignal }) => {
        if (!deps.selected) return { error: 'No model configured.' }
        const model = createModel(deps.selected.provider, deps.selected.modelId)
        const schema = {
          type: 'object',
          properties: { rows: { type: 'array', items: { type: 'object' } } },
          required: ['rows'],
        }
        const prompt = `${instruction}\n\nReturn the rows as an array of objects.\n\nText:\n${text.slice(0, 40_000)}`
        try {
          return { data: await extractStructured(model, prompt, schema, abortSignal, deps.trace) }
        } catch (err) {
          return { error: `Could not extract table (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),

    // Named WriteNotebook/ReadNotebook, not Notebook.write/.read: a provider
    // validates tool names against ^[a-zA-Z0-9_-]{1,64}$ and 400s the WHOLE
    // request over a dot, so one dotted name takes every other tool down with it
    // (src/tools/toolNames.test.ts locks this down).
    WriteNotebook: tool({
      description:
        'Record one or more findings in the research notebook. THIS is how facts are saved — a finding needs a claim, the exact source URL you read it from, and a short verbatim quote that supports it.',
      inputSchema: z.object({
        findings: z
          .array(
            z.object({
              // Capped: an unbounded claim/quote lets summarizeNotebook's output
              // (fed uncapped-in-bytes into Synthesize) grow large enough to blow
              // a smaller model's context window, which classifyError now treats
              // as a permanent, non-retryable 400 — capping here reduces how often
              // that's even reached.
              claim: z.string().max(500).describe('A single factual claim, in your own words'),
              sourceUrl: z.string().describe('The exact URL you read this from (must be a page you fetched)'),
              quote: z.string().max(500).optional().describe('A short verbatim quote from the source supporting the claim'),
              confidence: z.enum(['high', 'med', 'low']).optional(),
            }),
          )
          .describe('The findings to record'),
      }),
      execute: async ({ findings }) => {
        let n = 0
        for (const f of findings) {
          notebook.addFinding({ claim: f.claim, sourceUrl: f.sourceUrl, quote: f.quote, confidence: f.confidence })
          n++
        }
        return { recorded: n }
      },
    }),

    ReadNotebook: tool({
      description:
        'Read a compact summary of the research notebook so far: plan, per-sub-question coverage, findings, and numbered sources.',
      inputSchema: z.object({}),
      execute: async () => ({ notebook: summarizeNotebook(notebook.get(), { maxFindings: 60 }) }),
    }),
  }

  // Only offered when the controller supplied a tab broker (the SW side). Absent
  // in a headless-only host, where there is no tab to browse in.
  if (browseBroker) {
    tools.BrowseSite = tool({
      description:
        'Open a page in a REAL browser tab and browse it autonomously to meet an objective — clicking links, expanding sections, paginating, and using the site\'s own search box. Use this when FetchUrl is refused (403/bot wall), when the content you need is behind navigation rather than at a URL you can guess, or when a site\'s own index beats a web search. It reads the pages it visits and records what it finds in the notebook itself. It is logged-out and cannot log in, buy, or submit anything but a search.',
      inputSchema: z.object({
        url: z.string().describe('The page to start from'),
        objective: z
          .string()
          .describe('Specifically what to find there, e.g. "the 2024 pricing table" or "the methodology section of the linked paper"'),
      }),
      execute: async ({ url, objective }, { toolCallId, abortSignal }) => {
        if (!scopeAllows(url, sites)) {
          // Stated, not silent: a blocked read must appear in the step log so the
          // report's gaps are explicable. Checked ahead of the model-config and
          // budget checks below too, so a refused call never spends either.
          //
          // Known limitation: this gates only the session's OWN start url. Once a
          // session is open, its interior link-following (GoToUrl / clicking an
          // <a href>) is policy-checked by isSafeResearchAction (browsePolicy.ts),
          // which allows cross-origin navigation by design ("surfing is the
          // point") and is not scope-aware — threading `sites` through the
          // offscreen->SW browse round-trip into that gate is a separate,
          // larger change than this task's file list covers.
          return { error: `Out of scope. This research is restricted to: ${sites.join(', ')}` }
        }
        if (!deps.selected) return { error: 'No model configured.' }
        if (browseBudget && browseBudget.remaining <= 0) {
          return {
            error: 'The page-walk budget for this task is used up. Rely on WebSearch/FetchUrl and what is already in the notebook.',
          }
        }
        if (browseBudget) browseBudget.remaining--

        const outcome = await runBrowseSession({
          sessionId: `${deps.taskId ?? 'research'}:browse:${++browseSeq}`,
          url,
          objective,
          broker: browseBroker,
          model: createModel(deps.selected.provider, deps.selected.modelId),
          notebook,
          // Either the task-level signal (a real Stop) OR the per-call abortSignal
          // (resilient()'s 900s per-attempt timeout) must be able to end a page
          // walk early — preferring only deps.signal (which is always defined)
          // made the per-attempt timeout dead code and let a hung page walk
          // outlive its own retry attempt, holding the shared tab lease.
          signal: mergeAbortSignals(deps.signal, abortSignal),
          trace: deps.trace,
          onStep: (parts) => deps.onBrowseStep?.(toolCallId, parts),
        })
        return {
          visited: outcome.visited,
          findingsRecorded: outcome.findingsAdded,
          stopped: outcome.stoppedBecause,
          summary: outcome.digest,
        }
      },
    })
  }

  if (deps.trace) instrumentToolset(tools, deps.trace)
  return tools
}

/**
 * Ungated, foreground-only tool: the model can PROPOSE research but can no
 * longer start it. It returns a proposal that the panel renders as a chip; the
 * human gate is the launch card the chip opens, which shows the question, allows
 * editing it, and scopes its sources.
 *
 * Deliberately ungated (like ToolSearch/GetTool): proposing touches no page, no
 * network and no data. This strengthens rather than erodes the approval
 * invariant — the old card was a yes/no on a question the user never saw.
 */
export function createProposeResearchTool(): ToolSet {
  return {
    ProposeResearch: tool({
      description:
        'Propose a background research task to the user. This does NOT start anything — the user ' +
        'sees an editable launch card and decides. Use it when a question needs far more reading ' +
        'than this turn can do. Say one short sentence about why, then end your turn.',
      inputSchema: z.object({ question: z.string().describe('The research question to propose.') }),
      execute: async ({ question }) => ({
        proposed: true,
        question,
        note: 'Shown to the user as a proposal chip. It has NOT started. Do not claim it is running, and do not research the question yourself.',
      }),
    }),
  }
}
