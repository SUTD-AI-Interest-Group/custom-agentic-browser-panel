import { runAgentTurn } from './agent'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
import type { ProviderConfig } from '../data/settings'
import type { ResearchSource } from '../data/researchTasks'

const RESEARCH_SYSTEM = `You are a research agent running in the background. Answer the user's question by:
1. Planning sub-questions. 2. WebSearch for each. 3. FetchUrl the most relevant results and read them.
4. Optionally ExtractDataText for structured facts. 5. Synthesize a well-structured Markdown report.
Cite every claim inline as [n] and end with a "Sources" list of [n] Title — URL for each URL you actually read.
Be efficient: at most ~8 searches and ~12 fetches. If a source fails, move on.`

/** Run one background research task to completion. Headless: no tabs, no user data. */
export async function runResearch(opts: {
  taskId: string
  question: string
  provider: ProviderConfig
  modelId: string
  onStep: (s: string) => void
  signal: AbortSignal
}): Promise<{ report: string; sources: ResearchSource[] }> {
  const model = createModel(opts.provider, opts.modelId)
  const tools = createResearchTools({ selected: { provider: opts.provider, modelId: opts.modelId } })
  const sources: ResearchSource[] = []
  const seenSteps = new Set<string>()
  const result = await runAgentTurn({
    model,
    system: RESEARCH_SYSTEM,
    history: [{ role: 'user', content: opts.question }],
    tools,
    abortSignal: opts.signal,
    onUpdate: (parts) => {
      const last = parts[parts.length - 1]
      // The last part stays 'tool' across several onUpdate emissions (running ->
      // done/error), so gate on toolCallId to log each call once, not per emission.
      if (last?.type === 'tool' && !seenSteps.has(last.toolCallId)) {
        seenSteps.add(last.toolCallId)
        opts.onStep(`${last.toolName}: ${JSON.stringify(last.input).slice(0, 120)}`)
      }
      // Collect sources from successful FetchUrl results.
      for (const p of parts) {
        if (p.type === 'tool' && p.toolName === 'FetchUrl' && p.state === 'done' && p.output && typeof p.output === 'object') {
          const o = p.output as { url?: string; title?: string; error?: string }
          if (o.url && !o.error && !sources.some((s) => s.url === o.url)) sources.push({ url: o.url, title: o.title ?? o.url })
        }
      }
    },
  })
  const report = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
  return { report, sources }
}
