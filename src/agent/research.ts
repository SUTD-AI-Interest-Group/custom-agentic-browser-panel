import { runAgentTurn, type UIPart } from './agent'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
import type { ModelMessage } from 'ai'
import type { ProviderConfig } from '../data/settings'
import type { ResearchSource } from '../data/researchTasks'

const RESEARCH_SYSTEM = `You are a research agent running in the background. Answer the user's question by:
1. Planning sub-questions. 2. WebSearch for each. 3. FetchUrl the most relevant results and read them.
4. Optionally ExtractDataText for structured facts. 5. Synthesize a well-structured Markdown report.
Cite every claim inline as [n] and end with a "Sources" list of [n] Title — URL for each URL you actually read.
Be efficient: at most ~8 searches and ~12 fetches. If a source fails, move on.
A long task may span multiple step budgets: if you are told you are near the step limit and are not done, call Checkpoint to hand off; the task resumes automatically with a fresh budget.`

// Headless (no user to click Continue), so instead of prompting, the research
// loop auto-continues up to this many extra cycles when the model checkpoints or
// hits the step budget, then forces a final report on the last cycle.
const RESEARCH_MAX_AUTO_CONTINUES = 5
const FINAL_CYCLE_NUDGE =
  'This is your FINAL research cycle — stop searching and write your complete, cited Markdown report now from what you have gathered. Do NOT call Checkpoint.'

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
  const sources: ResearchSource[] = []
  const seenSteps = new Set<string>()
  // Grows across cycles so a continued research task sees its own prior work
  // (and its Checkpoint hand-off) instead of restarting.
  const history: ModelMessage[] = [{ role: 'user', content: opts.question }]

  const onUpdate = (parts: UIPart[]) => {
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
  }

  // The report is the model's final synthesized text; the last non-empty cycle
  // (a natural completion, or the forced final cycle) wins.
  let report = ''
  for (let cycle = 0; ; cycle++) {
    const finalCycle = cycle >= RESEARCH_MAX_AUTO_CONTINUES
    const result = await runAgentTurn({
      model,
      system: RESEARCH_SYSTEM,
      history: [...history],
      tools: createResearchTools({ selected: { provider: opts.provider, modelId: opts.modelId } }),
      abortSignal: opts.signal,
      onUpdate,
      // On the last allowed cycle, force a report instead of another checkpoint.
      wrapUpNudge: finalCycle ? FINAL_CYCLE_NUDGE : undefined,
    })
    history.push(...result.responseMessages)
    const text = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
    if (text.trim()) report = text
    // Stop when the model finished, or we've exhausted the auto-continue budget.
    if (finalCycle || result.stop.reason === 'completed') break
    opts.onStep(`↻ continuing research (cycle ${cycle + 2})`)
  }
  return { report, sources }
}
