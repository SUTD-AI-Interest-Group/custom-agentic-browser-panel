import { runAgentTurn, type UIPart } from './agent'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
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
Be efficient: at most ~8 searches and ~12 fetches. If a source fails, move on.`

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
  const tools = createResearchTools({ selected: { provider: opts.provider, modelId: opts.modelId } })
  const sources: ResearchSource[] = []
  let lastSig = ''
  const result = await runAgentTurn({
    model,
    system: RESEARCH_SYSTEM,
    history: [{ role: 'user', content: opts.question }],
    tools,
    abortSignal: opts.signal,
    onUpdate: (parts) => {
      // Derive one step per tool call, with live status + (once available) result.
      const steps: ResearchStep[] = parts
        .filter((p): p is Extract<UIPart, { type: 'tool' }> => p.type === 'tool')
        .map((p) => ({
          tool: p.toolName,
          summary: `${p.toolName}: ${compact(p.input).slice(0, 120)}`,
          detail: stepDetail(p),
          status: p.state === 'done' ? 'done' : p.state === 'error' ? 'error' : 'running',
        }))
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
    },
  })
  const report = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
  return { report, sources }
}
