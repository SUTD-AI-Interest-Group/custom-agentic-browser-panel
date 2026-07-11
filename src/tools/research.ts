import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ProviderConfig } from '../data/settings'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { instrumentToolset, type Trace } from '../agent/observability'
import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'
import type { ApprovalGate } from './tools'

/**
 * Read-only, web-egress-only tools for the BACKGROUND research agent. Ungated by
 * design — there is no user present in the offscreen sandbox, and these tools
 * touch no tabs, cookies, or user data. They are wired into the model ONLY inside
 * the offscreen research agent (Task 10), never the foreground chat.
 */
export function createResearchTools(deps: {
  selected: { provider: ProviderConfig; modelId: string } | null
  /** Optional Langfuse trace for the research task; when set, tools become spans. */
  trace?: Trace
}): ToolSet {
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
      description: 'Fetch a public web page and return its readable text (for reading a search result).',
      inputSchema: z.object({ url: z.string().describe('http(s) URL to read') }),
      execute: async ({ url }, { abortSignal }) => fetchReadable(url, abortSignal),
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
