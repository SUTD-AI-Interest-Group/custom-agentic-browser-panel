import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ProviderConfig } from '../data/settings'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { instrumentToolset, type Trace } from '../agent/observability'
import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'
import { searchAcademic, searchImages, harvestImages, type ImageResult } from '../platform/researchSources'
import { summarizeNotebook, type NotebookHandle } from '../agent/notebook'
import { runBrowseSession, type BrowseBroker } from '../agent/browseAgent'
import type { UIPart } from '../agent/agent'
import type { ApprovalGate } from './tools'

export type { BrowseBroker } from '../agent/browseAgent'

/**
 * Escalation broker: render a hard URL (JS-heavy / paywalled / PDF / needs a
 * screenshot) in a real controlled tab via the service worker, since the
 * offscreen research host cannot touch tabs itself. Injected by the controller;
 * absent = headless-only (the fast path still works, hard pages just fail).
 */
export interface RenderBroker {
  render(
    url: string,
    want: 'text' | 'screenshot' | 'both',
  ): Promise<{ text?: string; title?: string; finalUrl?: string; screenshotDataUrl?: string; error?: string }>
}

/** A headless fetch whose text is this short is likely a JS-rendered shell — a
 *  candidate for tab escalation when a broker is available. */
const THIN_TEXT = 400

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
}): ToolSet {
  const { notebook, renderBroker, browseBroker, browseBudget } = deps
  const tools: ToolSet = {
    WebSearch: tool({
      description: 'Search the web (DuckDuckGo) and return ranked {title,url,snippet} results.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Default 8, max 20'),
      }),
      execute: async ({ query, maxResults = 8 }, { abortSignal }) => {
        const r = await searchDuckDuckGo(query, maxResults, abortSignal)
        if ('error' in r) return r
        return r.results.length ? { results: r.results } : { results: [], note: 'No results parsed; try a different query.' }
      },
    }),

    FetchUrl: tool({
      description:
        'Fetch a public web page and return its readable text. Automatically renders JS/paywalled/PDF pages in a real tab when the plain fetch comes back empty. Pass render:true to force a rendered read (e.g. for a page you know is a SPA).',
      inputSchema: z.object({
        url: z.string().describe('http(s) URL to read'),
        render: z.boolean().optional().describe('Force a real-tab render instead of a plain fetch'),
      }),
      execute: async ({ url, render }, { abortSignal }) => {
        // Forced render (a SPA the model already knows about).
        if (render && renderBroker) {
          const rr = await renderBroker.render(url, 'text')
          if (!rr.error && rr.text) {
            const finalUrl = rr.finalUrl || url
            notebook.addSource({ url: finalUrl, title: rr.title, fetchedVia: 'tab' })
            return { url: finalUrl, title: rr.title ?? finalUrl, text: rr.text, rendered: true }
          }
          // fall through to a plain fetch if the render failed
        }
        const r = await fetchReadable(url, abortSignal)
        const thin = !('error' in r) && r.text.trim().length < THIN_TEXT
        if (renderBroker && ('error' in r || thin)) {
          const rr = await renderBroker.render(url, 'text')
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
        'Search academic literature (OpenAlex) for papers on a topic. Returns {title, abstract, authors, year, url, pdfUrl}. Use for scholarly/technical questions; record facts with Notebook.write citing the paper url.',
      inputSchema: z.object({
        query: z.string().describe('Search query (topic, method, author…)'),
        maxResults: z.number().optional().describe('Default 8, max 25'),
      }),
      execute: async ({ query, maxResults = 8 }, { abortSignal }) => {
        const r = await searchAcademic(query, maxResults, abortSignal)
        if ('error' in r) return r
        return r.results.length ? { results: r.results } : { results: [], note: 'No papers found; try different terms.' }
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
        const added = recordImages(notebook, r.results, query)
        return { found: r.results.length, added, images: r.results.map(briefImage) }
      },
    }),

    HarvestImages: tool({
      description:
        'Collect the meaningful <img> assets (charts, figures, photos) from a page you found useful, so relevant ones can be embedded in the report. Returns the images found on that page.',
      inputSchema: z.object({ url: z.string().describe('The page URL to harvest images from') }),
      execute: async ({ url }, { abortSignal }) => {
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

    'Notebook.write': tool({
      description:
        'Record one or more findings in the research notebook. THIS is how facts are saved — a finding needs a claim, the exact source URL you read it from, and a short verbatim quote that supports it.',
      inputSchema: z.object({
        findings: z
          .array(
            z.object({
              claim: z.string().describe('A single factual claim, in your own words'),
              sourceUrl: z.string().describe('The exact URL you read this from (must be a page you fetched)'),
              quote: z.string().optional().describe('A short verbatim quote from the source supporting the claim'),
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

    'Notebook.read': tool({
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
          signal: deps.signal ?? abortSignal ?? new AbortController().signal,
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
 * Gated, foreground-only tool: asks the user for permission, then hands the
 * question to the background (offscreen) research host via `research.
 * ensureAndStart`. The task runs to completion even if the panel closes; the
 * result lands in `researchTasks` storage and a system notification fires.
 */
export function createStartResearchTool(requestApproval: ApprovalGate, conversationId: string): ToolSet {
  return {
    StartResearch: tool({
      description:
        'Launch a background research task (web search + read + synthesize a cited report). It runs even if the side panel is closed and notifies on completion. Asks permission first.',
      inputSchema: z.object({ question: z.string().describe('The research question to investigate.') }),
      execute: async ({ question }) => {
        const approved = await requestApproval({ toolName: 'StartResearch', summary: 'Run background research', reason: question })
        if (!approved) return { denied: true, message: 'The user denied permission for this tool call.' }
        const taskId = `r-${Date.now()}-${Math.floor(performance.now())}`
        // Tag the task with the launching conversation so its dock bar / report
        // card surface only in that chat (not globally in every conversation).
        chrome.runtime.sendMessage({ type: 'research.ensureAndStart', taskId, question, conversationId })
        return {
          started: true,
          taskId,
          note: 'Research is now running in the background and will appear in the panel with a notification when done. Do NOT research or answer the question yourself — reply with one short sentence telling the user it is underway, then end your turn.',
        }
      },
    }),
  }
}
