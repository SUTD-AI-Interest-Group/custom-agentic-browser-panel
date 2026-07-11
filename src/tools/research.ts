import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ProviderConfig } from '../data/settings'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { instrumentToolset, type Trace } from '../agent/observability'
import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'
import { summarizeNotebook, type NotebookHandle } from '../agent/notebook'
import type { ApprovalGate } from './tools'

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
  /** Optional Langfuse trace for the research task; when set, tools become spans. */
  trace?: Trace
}): ToolSet {
  const { notebook, renderBroker } = deps
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
        if ('error' in r) return r
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
