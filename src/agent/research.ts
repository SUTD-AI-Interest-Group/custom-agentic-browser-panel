import { runAgentTurn, type UIPart } from './agent'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
import type { ModelMessage } from 'ai'
import type { ProviderConfig } from '../data/settings'
import type { ResearchSource, ResearchStep } from '../data/researchTasks'

/** Compact one-line stringify for a step summary. */
function compact(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Pretty, size-bounded stringify for the expandable step detail — caps how much
 *  streamed page text lands in chrome.storage. */
function preview(value: unknown, max: number): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s
}

/** Build the expandable detail for one tool call: its input, then its result. */
function stepDetail(p: Extract<UIPart, { type: 'tool' }>): string {
  const input = `Input:\n${preview(p.input, 600)}`
  const result =
    p.state === 'done'
      ? `Result:\n${preview(p.output, 2000)}`
      : p.state === 'error'
        ? 'Result: (the tool call failed)'
        : '(running…)'
  return `${input}\n\n${result}`
}

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
  onSteps: (steps: ResearchStep[]) => void
  signal: AbortSignal
}): Promise<{ report: string; sources: ResearchSource[] }> {
  const model = createModel(opts.provider, opts.modelId)
  const sources: ResearchSource[] = []
  // Grows across cycles so a continued research task sees its own prior work
  // (and its Checkpoint hand-off) instead of restarting.
  const history: ModelMessage[] = [{ role: 'user', content: opts.question }]

  // One ResearchStep per tool call (main's expandable-steps model). priorSteps
  // accumulates completed cycles' steps so an auto-continue doesn't erase them.
  const priorSteps: ResearchStep[] = []
  const stepsOf = (parts: UIPart[]): ResearchStep[] =>
    parts
      .filter((p): p is Extract<UIPart, { type: 'tool' }> => p.type === 'tool')
      .map((p) => ({
        tool: p.toolName,
        summary: `${p.toolName}: ${compact(p.input).slice(0, 120)}`,
        detail: stepDetail(p),
        status: p.state === 'done' ? 'done' : p.state === 'error' ? 'error' : 'running',
      }))

  let lastSig = ''
  const onUpdate = (parts: UIPart[]) => {
    const steps = [...priorSteps, ...stepsOf(parts)]
    // Emit only when a step appears or flips status (running -> done/error), so
    // the sheet updates without a storage write on every stream chunk.
    const sig = steps.map((s) => `${s.tool}:${s.status}`).join('|')
    if (sig !== lastSig) {
      lastSig = sig
      opts.onSteps(steps)
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
    // Carry this cycle's steps forward so the next cycle's steps append to them.
    priorSteps.push(...stepsOf(result.parts))
    // Stop when the model finished, or we've exhausted the auto-continue budget.
    if (finalCycle || result.stop.reason === 'completed') break
  }
  return { report, sources }
}
