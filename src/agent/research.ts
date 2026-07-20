import { generateText, type LanguageModel } from 'ai'
import { runAgentTurn, type UIPart } from './agent'
import { createModel } from './provider'
import { getObserver, type Trace } from './observability'
import { extractStructured } from './extract'
import {
  createNotebook,
  summarizeNotebook,
  openGaps,
  isFullyCovered,
  type NotebookHandle,
  type ResearchNotebook,
  type ResearchPlan,
} from './notebook'
import { createResearchTools, type BrowseBroker, type RenderBroker, type SearchBroker } from '../tools/research'
import { withResilience, ResearchDeadlineError } from './resilience'
import type { ObservabilityConfig, ProviderConfig } from '../data/settings'
import { MAX_RESEARCH_DURATION_MS, type ResearchSource, type ResearchStep, type ResearchVerification } from '../data/researchTasks'

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

/** First line of the model's thinking, for the collapsed row. */
function firstLine(text: string, max = 140): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// The research loop is a phased state machine over a structured notebook:
//   Scope&Plan → (Gather → Reflect)* → Synthesize → Verify.
// Each gather round starts FRESH (question + notebook summary + current focus)
// rather than growing one ever-larger message history — the notebook is the
// long-horizon memory, which keeps context bounded on big topics.
const MAX_GATHER_ROUNDS = 5

// Page walks (BrowseSite) are the most expensive thing the agent can do — a whole
// nested agent loop against a live tab. Bound how many one task may spend, across
// all its gather rounds.
const MAX_BROWSE_SESSIONS = 6

// When the 24h cap is reached mid-run we still make ONE best-effort attempt to write
// the report from whatever the notebook holds, bounded by this timeout, so a long run
// that never fully converged is finalized as a partial report rather than lost.
const FINALIZE_TIMEOUT_MS = 120_000

/** A minimal sink for the live step log: append a step, or replace the last one
 *  in place (used to flip a "running" phase step to its "done" state). */
interface StepSink {
  push(step: ResearchStep): void
  replaceTail(step: ResearchStep): void
}

const GATHER_SYSTEM = `You are the GATHER phase of a background research agent. Your job THIS round is to close the open sub-questions you are given — nothing else.
- Use WebSearch to find sources, then FetchUrl to read the most relevant ones (FetchUrl auto-renders JS/paywalled pages when needed). For scholarly/technical topics also use SearchAcademic (peer-reviewed papers).
- When FetchUrl is REFUSED (403, bot wall, login wall), do NOT just search again — that loses the source. Call BrowseSite({url, objective}) to open the page in a real browser tab and read it there. Also use BrowseSite when what you need is behind navigation rather than at a guessable URL (a docs site's own search, a table behind a tab, results behind pagination). It browses the site autonomously and records what it finds.
- For every substantive fact you will rely on, call Notebook.write with the claim, the exact source URL you read it from, and a short verbatim quote. This is how findings are recorded — text you type outside a Notebook.write is NOT saved.
- When a visual would strengthen the report, use SearchImages (attributed, licensed images) or HarvestImages(url) on a useful page to collect charts/figures/photos; the best ones get embedded later. Use ExtractTable to pull structured data from a page's text.
- Prefer primary/official/reference sources. Searching repeatedly for the same thing is a dead end — if two searches have not produced a readable source, read the best candidate with BrowseSite instead.
- Think out loud briefly before each tool call: say what you are looking for and why. The user watches this log.
- Be efficient. When you have covered the focus sub-questions, stop — do NOT write the report here (a later phase does that).`

/** Run one background research task to completion. Headless: no user, no user data. */
export async function runResearch(opts: {
  taskId: string
  question: string
  provider: ProviderConfig
  modelId: string
  /** The launching chat, so the research trace joins that Langfuse session. */
  conversationId?: string
  /** Observability config forwarded from the SW (offscreen has no chrome.storage). */
  observability?: ObservabilityConfig
  /** Escalate a hard URL to a real controlled tab via the SW broker (Phase 4). */
  renderBroker?: RenderBroker
  /** Drive a real tab interactively (BrowseSite). Absent = no page walks. */
  browseBroker?: BrowseBroker
  /** Run a search in a real tab when the keyless fetch is throttled. */
  searchBroker?: SearchBroker
  /** Emits the live step log + notebook snapshot for the sheet. */
  onUpdate: (steps: ResearchStep[], notebook: ResearchNotebook) => void
  signal: AbortSignal
  /** Absolute 24h deadline (epoch-ms). After it, the run finalizes a partial report.
   *  Defaults to now + 24h for a fresh task. */
  deadlineAt?: number
  /** A persisted notebook to resume from (Chrome restart / eviction recovery), so a
   *  resumed task keeps its findings instead of starting over. */
  resumeNotebook?: ResearchNotebook
  /** Called when a phase enters the resilient waiting state (transient failure). */
  onPause?: (info: { reason: string; attempt: number; nextRetryAt: number }) => void
  /** Called when a previously-paused phase resumes progress. */
  onResume?: () => void
}): Promise<{
  report: string
  sources: ResearchSource[]
  notebook: ResearchNotebook
  verification?: ResearchVerification
  /** True when the report was cut short by the 24h cap rather than converging. */
  partial?: boolean
}> {
  const model = createModel(opts.provider, opts.modelId)
  const selected = { provider: opts.provider, modelId: opts.modelId }
  const deadlineAt = opts.deadlineAt ?? Date.now() + MAX_RESEARCH_DURATION_MS
  const pastDeadline = () => Date.now() >= deadlineAt

  /**
   * Run a phase resiliently: a transient failure pauses + backs off + retries until
   * the phase succeeds, the task is aborted (→ propagates), or the deadline passes
   * (→ ResearchDeadlineError). Reasons flow out to the paused card via onPause.
   */
  const resilient = <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    withResilience(fn, {
      signal: opts.signal,
      deadlineAt,
      onPause: opts.onPause,
      onResume: opts.onResume,
    })

  // Observability: one research-task trace; phases become generations, tools spans.
  const observer = getObserver(opts.observability)
  const trace = observer.enabled
    ? observer.startTrace({
        name: 'research-task',
        sessionId: opts.conversationId,
        tags: ['research'],
        input: opts.question,
        metadata: { taskId: opts.taskId },
      })
    : undefined

  // ---- Live step log + notebook, emitted to the sheet on meaningful change. ----
  const allSteps: ResearchStep[] = []
  let lastSig = ''
  const emit = () => {
    const nb = notebook.get()
    // summary.length is in the signature so a STREAMING thought row keeps
    // redrawing as its text arrives — tool+status alone would freeze it at its
    // first token until the next tool call landed.
    const sig =
      allSteps.map((s) => `${s.tool}:${s.status}:${s.summary.length}`).join('|') +
      `#${nb.findings.length}/${nb.sources.length}/${nb.images.length}/${Object.keys(nb.coverage).length}`
    if (sig === lastSig) return
    lastSig = sig
    opts.onUpdate([...allSteps], nb)
  }
  const pushStep = (step: ResearchStep) => {
    allSteps.push(step)
    emit()
  }
  const stepSink: StepSink = {
    push: pushStep,
    replaceTail: (step) => {
      if (allSteps.length) allSteps[allSteps.length - 1] = step
      else allSteps.push(step)
      lastSig = '' // force a re-emit after an in-place status flip
      emit()
    },
  }

  // Resume from the persisted notebook when recovering a stranded task; findings,
  // sources, coverage and plan all carry over, so the gather loop continues closing
  // gaps rather than starting from scratch.
  const notebook: NotebookHandle = createNotebook(opts.resumeNotebook, emit)
  const resuming = !!opts.resumeNotebook && opts.resumeNotebook.findings.length > 0

  // A BrowseSite call runs a whole nested agent loop against a live tab. Its inner
  // steps are kept per tool-call id and spliced in under their BrowseSite row, so
  // the user can watch the page walk instead of staring at one opaque row for a
  // minute. Keyed by call id, not a single list, so two walks in one round don't
  // overwrite each other.
  const innerByCall = new Map<string, ResearchStep[]>()

  /**
   * Turn one turn's parts into log rows. The model's TEXT parts are its reasoning
   * — the log used to drop them, which is why the sheet showed a wall of anonymous
   * searches with no visible thinking. They are rows now, in call order.
   */
  const stepsOf = (parts: UIPart[], depth = 0): ResearchStep[] =>
    parts.flatMap((p): ResearchStep[] => {
      if (p.type === 'text' || p.type === 'reasoning') {
        const text = p.text.trim()
        if (!text) return []
        return [{ tool: 'Thinking', summary: firstLine(text), detail: text, status: 'done', kind: 'thought', depth }]
      }
      const step: ResearchStep = {
        tool: p.toolName,
        summary: `${p.toolName}: ${compact(p.input).slice(0, 120)}`,
        detail: stepDetail(p),
        status: p.state === 'done' ? 'done' : p.state === 'error' ? 'error' : 'running',
        kind: 'tool',
        depth,
      }
      return [step, ...(innerByCall.get(p.toolCallId) ?? [])]
    })

  /** Streams a page walk's inner steps into the log, nested under its call. */
  const onBrowseStep = (toolCallId: string, parts: UIPart[]) => {
    innerByCall.set(toolCallId, stepsOf(parts, 1))
    rebuildRound()
  }

  // Set by each gather round so onBrowseStep (which fires from inside a tool
  // execute, between the round's own updates) can redraw the round's rows.
  let rebuildRound: () => void = () => {}

  try {
    // ---- Phase 1: Scope & Plan ------------------------------------------------
    // A resumed task already has a plan in its notebook — don't re-plan, just note
    // the continuation so the live log shows why the step count restarted.
    const existingPlan = notebook.get().plan
    if (resuming && existingPlan.subQuestions.length > 0) {
      pushStep({
        kind: 'phase',
        tool: 'Resumed',
        summary: `Resumed — continuing from ${notebook.get().findings.length} finding${notebook.get().findings.length === 1 ? '' : 's'}`,
        detail: `Recovered after an interruption. Sub-questions:\n${existingPlan.subQuestions.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`,
        status: 'done',
      })
    } else {
      const plan = await resilient((signal) => planResearch(opts.question, model, signal, trace))
      notebook.setPlan(plan)
      pushStep({
        kind: 'phase',
        tool: 'Plan',
        summary: `Planned ${plan.subQuestions.length} sub-question${plan.subQuestions.length === 1 ? '' : 's'}`,
        detail: `Sub-questions:\n${plan.subQuestions.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}\n\nOutline: ${plan.outline.join(' · ')}`,
        status: 'done',
      })
    }

    // ---- Phase 2: Gather ↔ Reflect loop --------------------------------------
    // Page walks are budgeted across the whole task, not per round — one gnarly
    // site can legitimately eat several, and a later round should feel that.
    const browseBudget = { remaining: MAX_BROWSE_SESSIONS }

    for (let round = 0; round < MAX_GATHER_ROUNDS; round++) {
      // The 24h cap stops *gathering* — whatever is in the notebook is then written
      // up as a partial report below, not discarded.
      if (opts.signal.aborted || pastDeadline()) break
      const gaps = openGaps(notebook.get())
      if (gaps.length === 0) break

      const focus = gaps.slice(0, 3) // deepen a few at a time
      const tools = createResearchTools({
        selected,
        trace,
        notebook,
        renderBroker: opts.renderBroker,
        browseBroker: opts.browseBroker,
        searchBroker: opts.searchBroker,
        browseBudget,
        taskId: opts.taskId,
        onBrowseStep,
        signal: opts.signal,
      })
      const roundStart = allSteps.length
      let roundParts: UIPart[] = []
      // Rebuilding (not appending) keeps the round's rows in sync as tool results
      // land, and lets a nested browse step redraw the round from inside a tool.
      rebuildRound = () => {
        allSteps.length = roundStart
        allSteps.push(...stepsOf(roundParts))
        emit()
      }
      const onTurnUpdate = (parts: UIPart[]) => {
        roundParts = parts
        rebuildRound()
      }

      let result: Awaited<ReturnType<typeof runAgentTurn>>
      try {
        result = await resilient((signal) => {
          // Each attempt restarts this round's visible rows and re-reads the notebook
          // for the "already known" list — findings recorded via Notebook.write persist
          // across a retry, so a re-run continues rather than duplicating work.
          allSteps.length = roundStart
          roundParts = []
          emit()
          const gatherPrompt =
            `Research question: ${opts.question}\n\n` +
            `Focus THIS round on these open sub-questions:\n${focus.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}\n\n` +
            `What is already known (do not re-fetch these):\n${summarizeNotebook(notebook.get())}`
          return runAgentTurn({
            model,
            system: GATHER_SYSTEM,
            history: [{ role: 'user', content: gatherPrompt }],
            tools,
            abortSignal: signal,
            onUpdate: onTurnUpdate,
            trace,
          })
        })
      } catch (err) {
        rebuildRound = () => {}
        if (err instanceof ResearchDeadlineError) break // out of time → finalize below
        throw err
      }
      // Freeze this round's steps at their final state.
      roundParts = result.parts
      rebuildRound()
      rebuildRound = () => {} // the round is over; a late browse callback must not redraw it

      if (opts.signal.aborted || pastDeadline()) break

      // Reflect: assess coverage of the focus sub-questions; may end the loop.
      let reflection: Reflection
      try {
        reflection = await resilient((signal) => reflect(opts.question, focus, notebook.get(), model, signal, trace))
      } catch (err) {
        if (err instanceof ResearchDeadlineError) break
        throw err
      }
      reflection.assessments.forEach((a, i) => {
        // Map back to the exact plan wording (focus ⊂ plan.subQuestions) by
        // position — the model often paraphrases, which would otherwise create a
        // coverage key that never matches a plan sub-question and never converges.
        const key = focus[i] ?? a.subQuestion
        notebook.setCoverage(key, { supported: a.supported, gap: a.gap })
      })
      const covered = notebook.get().plan.subQuestions.filter((q) => notebook.get().coverage[q]?.supported).length
      pushStep({
        kind: 'phase',
        tool: 'Reflect',
        summary: `Coverage: ${covered}/${notebook.get().plan.subQuestions.length} sub-questions`,
        detail: reflection.assessments
          .map((a) => `${a.supported ? '✓' : '·'} ${a.subQuestion}${a.gap ? ` — gap: ${a.gap}` : ''}`)
          .join('\n'),
        status: 'done',
      })
      if (reflection.done || isFullyCovered(notebook.get())) break
    }

    // ---- Phase 3: Synthesize (+ Phase 4: Verify when there is time) -----------
    // `partial` is set when the 24h cap was reached: gather stopped early and we
    // finalize whatever the notebook holds. Within the deadline we synthesize
    // resiliently and verify; out of time we make ONE bounded best-effort attempt,
    // then fall back to a notebook-only writeup so the run always yields something.
    let draft: string | undefined
    let verification: ResearchVerification | undefined
    let partial = pastDeadline()
    pushStep({
      kind: 'phase',
      tool: 'Synthesize',
      summary: partial ? 'Finalizing a partial report…' : 'Writing the report…',
      detail: '',
      status: 'running',
    })
    if (!partial) {
      try {
        draft = await resilient((signal) => synthesize(opts.question, notebook.get(), model, signal, trace))
        stepSink.replaceTail({ kind: 'phase', tool: 'Synthesize', summary: 'Report drafted', detail: '', status: 'done' })
        const verified = await verifyReport(draft, notebook, model, opts.signal, trace, stepSink)
        draft = verified.report
        verification = verified.verification
      } catch (err) {
        if (!(err instanceof ResearchDeadlineError)) throw err
        partial = true // ran out of time mid-synthesis → best-effort finalize below
      }
    }
    if (partial) {
      try {
        draft = await synthesize(opts.question, notebook.get(), model, withAttemptTimeout(opts.signal, FINALIZE_TIMEOUT_MS), trace)
      } catch {
        draft = draft ?? fallbackReport(opts.question, notebook.get())
      }
      stepSink.replaceTail({ kind: 'phase', tool: 'Synthesize', summary: 'Partial report finalized', detail: '', status: 'done' })
    }

    const report = draft ?? fallbackReport(opts.question, notebook.get())
    const nb = notebook.get()
    const sources: ResearchSource[] = nb.sources.map((s) => ({ title: s.title, url: s.url }))
    trace?.end({ output: report, metadata: { sources: sources.length, findings: nb.findings.length, partial } })
    await observer.flush()
    return { report, sources, notebook: nb, verification, partial }
  } catch (err) {
    trace?.end({ metadata: { error: err instanceof Error ? err.message : String(err) } })
    await observer.flush()
    throw err
  }
}

/** Merge the task signal with a one-shot timeout for a single best-effort attempt,
 *  degrading to the bare signal where AbortSignal.any/timeout is unavailable. */
function withAttemptTimeout(signal: AbortSignal, ms: number): AbortSignal {
  try {
    if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal && 'timeout' in AbortSignal) {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)])
    }
  } catch {
    /* fall through */
  }
  return signal
}

/**
 * A minimal report assembled directly from the notebook — used only when the 24h cap
 * is reached AND the model can't be reached to write a proper synthesis, so a long
 * run still yields its gathered findings rather than nothing.
 */
function fallbackReport(question: string, nb: ResearchNotebook): string {
  const findingLines = nb.findings.length
    ? nb.findings.slice(0, 200).map((f) => `- ${f.claim}${f.sourceN ? ` [[${f.sourceN}]]` : ''}`)
    : ['- No findings were recorded before the limit was reached.']
  const sourceLines = nb.sources.map((s) => `[[${s.n}]] ${s.title || s.url} — ${s.url}`)
  return [
    `# ${question}`,
    '',
    '> **Partial report** — research reached its 24-hour limit before it could be written up in full. The findings gathered so far are listed below.',
    '',
    '## Findings',
    ...findingLines,
    ...(sourceLines.length ? ['', '## Sources', ...sourceLines] : []),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Phase helpers. Plan/Reflect are structured (extractStructured) so they work
// against any OpenAI-compatible endpoint; Synthesize/Verify use free-text
// generation. All are trace-recorded when observability is on.
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    subQuestions: { type: 'array', items: { type: 'string' }, description: '3–6 concrete sub-questions that together answer the question' },
    outline: { type: 'array', items: { type: 'string' }, description: 'Section headings for the final report, in order' },
    searches: { type: 'number', description: 'Rough number of web searches this will take' },
    fetches: { type: 'number', description: 'Rough number of pages to read' },
  },
  required: ['subQuestions', 'outline'],
} as const

async function planResearch(
  question: string,
  model: LanguageModel,
  signal: AbortSignal,
  trace?: Trace,
): Promise<ResearchPlan> {
  const prompt = `Break this research question into a concrete plan.\n\nQuestion: ${question}\n\nReturn 3–6 focused sub-questions whose answers together fully address it, plus an ordered outline of the final report's sections, plus a rough effort estimate.`
  try {
    const out = (await extractStructured(model, prompt, PLAN_SCHEMA as Record<string, unknown>, signal, trace)) as {
      subQuestions?: string[]
      outline?: string[]
      searches?: number
      fetches?: number
    }
    const subQuestions = (out.subQuestions ?? []).filter(Boolean)
    return {
      subQuestions: subQuestions.length ? subQuestions : [question],
      outline: (out.outline ?? []).filter(Boolean),
      effortBudget: { searches: out.searches ?? 6, fetches: out.fetches ?? 10 },
    }
  } catch {
    // No structured-output support / parse failure — fall back to a 1-question plan.
    return { subQuestions: [question], outline: [], effortBudget: { searches: 6, fetches: 10 } }
  }
}

interface Reflection {
  assessments: { subQuestion: string; supported: boolean; gap?: string }[]
  done: boolean
  nextFocus?: string
}

const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subQuestion: { type: 'string' },
          supported: { type: 'boolean', description: 'Is this sub-question now well supported by the findings?' },
          gap: { type: 'string', description: 'If not supported, what is still missing' },
        },
        required: ['subQuestion', 'supported'],
      },
    },
    done: { type: 'boolean', description: 'True if the whole question is sufficiently researched and gathering should stop' },
  },
  required: ['assessments', 'done'],
} as const

async function reflect(
  question: string,
  focus: string[],
  nb: ResearchNotebook,
  model: LanguageModel,
  signal: AbortSignal,
  trace?: Trace,
): Promise<Reflection> {
  const prompt =
    `Research question: ${question}\n\n` +
    `Assess coverage of these sub-questions given what has been gathered:\n${focus.map((q) => `- ${q}`).join('\n')}\n\n` +
    `Gathered so far:\n${summarizeNotebook(nb)}\n\n` +
    `For each sub-question say whether it is now well supported; if not, name the specific gap. Then say whether the overall research is done.`
  try {
    const out = (await extractStructured(model, prompt, REFLECT_SCHEMA as Record<string, unknown>, signal, trace)) as Reflection
    return { assessments: out.assessments ?? [], done: !!out.done }
  } catch {
    // Can't assess — mark the focus supported so the loop makes progress and ends.
    return { assessments: focus.map((subQuestion) => ({ subQuestion, supported: true })), done: false }
  }
}

async function synthesize(
  question: string,
  nb: ResearchNotebook,
  model: LanguageModel,
  signal: AbortSignal,
  trace?: Trace,
): Promise<string> {
  const gen = trace?.generation({ name: 'synthesize', model: (model as { modelId?: string }).modelId, input: question })
  const outline = nb.plan.outline.join(' · ')
  const imgs = nb.images.slice(0, 12)
  const imageBlock = imgs.length
    ? `\nAVAILABLE IMAGES — embed the ones that genuinely help the reader, each on its OWN line as \`![caption](url)\` immediately followed by an italic attribution line \`*Caption. Source — License*\`. Do NOT stack images on consecutive lines (that turns them into a bare gallery with no captions), and skip images that add nothing:\n` +
      imgs
        .map(
          (im) =>
            `- url: ${im.url}${im.caption ? ` | caption: ${im.caption}` : ''}${im.license ? ` | license: ${im.license}` : ''}${im.author ? ` | author: ${im.author}` : ''}`,
        )
        .join('\n')
    : ''
  const prompt =
    `Write the final research report answering: ${question}\n\n` +
    `Use ONLY the findings and sources below. Cite each claim inline as [[n]] (DOUBLE square brackets) where n is the source number from the SOURCES list — e.g. "The market grew 12% [[3]]." End with a "Sources" section listing "[[n]] Title — URL" for every source you cite.\n` +
    (outline ? `Follow this section outline: ${outline}\n` : '') +
    `\n${summarizeNotebook(nb, { maxFindings: 200 })}\n${imageBlock}\n\n` +
    `Write a thorough, well-structured Markdown report. Do not invent facts or citations beyond the findings above.`
  try {
    const { text, usage } = await generateText({ model, prompt, abortSignal: signal })
    gen?.end({ output: text, usage })
    return text
  } catch (err) {
    gen?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Verify: (1) a grounding audit — does each cited claim actually rest on its
// source's recorded quote? — and (2) a bounded adversarial pass that red-teams
// the most load-bearing claims. Flagged claims are hedged or removed in a final
// revise pass. Resilient: any failure falls back to the un-revised draft.
// ---------------------------------------------------------------------------

const MAX_ADVERSARIAL = 3

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The claim in the report that is problematic' },
          problem: { type: 'string', description: 'Why it is not supported by its cited source (or is uncited)' },
          fix: { type: 'string', enum: ['keep', 'hedge', 'remove'], description: 'Recommended action' },
        },
        required: ['claim', 'problem', 'fix'],
      },
    },
    loadBearing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 of the most important, most falsifiable claims to double-check',
    },
  },
  required: ['issues'],
} as const

const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'True if the claim is likely false, outdated, or commonly contradicted' },
    reason: { type: 'string' },
  },
  required: ['refuted'],
} as const

interface AuditIssue {
  claim: string
  problem: string
  fix: 'keep' | 'hedge' | 'remove'
}

async function verifyReport(
  draft: string,
  notebook: NotebookHandle,
  model: LanguageModel,
  signal: AbortSignal,
  trace: Trace | undefined,
  steps: StepSink,
): Promise<{ report: string; verification?: ResearchVerification }> {
  steps.push({ kind: 'phase', tool: 'Verify', summary: 'Checking citations & claims…', detail: '', status: 'running' })
  const nb = notebook.get()
  const evidence = summarizeNotebook(nb, { maxFindings: 200 })
  try {
    // 1) Grounding audit.
    const auditPrompt =
      `Audit this research report against its evidence. Flag every claim that is NOT supported by the source it cites, ` +
      `or that states a specific fact with no citation. For each, recommend keep / hedge / remove. Also list up to 3 of the ` +
      `most load-bearing, falsifiable claims.\n\nEVIDENCE (numbered sources + recorded findings/quotes):\n${evidence}\n\nREPORT:\n${draft}`
    const audit = (await extractStructured(model, auditPrompt, AUDIT_SCHEMA as Record<string, unknown>, signal, trace)) as {
      issues?: AuditIssue[]
      loadBearing?: string[]
    }
    const issues: AuditIssue[] = (audit.issues ?? []).filter((i) => i && i.claim && i.fix !== 'keep')

    // 2) Adversarial refutation of the top load-bearing claims (bounded).
    let refuted = 0
    for (const claim of (audit.loadBearing ?? []).slice(0, MAX_ADVERSARIAL)) {
      if (signal.aborted) break
      try {
        const r = (await extractStructured(
          model,
          `Try hard to REFUTE this claim from a research report. If it is likely false, outdated, oversimplified, or commonly contradicted, set refuted=true and explain. Otherwise refuted=false.\n\nClaim: ${claim}`,
          REFUTE_SCHEMA as Record<string, unknown>,
          signal,
          trace,
        )) as { refuted?: boolean; reason?: string }
        if (r.refuted) {
          refuted++
          issues.push({ claim, problem: `Adversarial check: ${r.reason ?? 'contradicted'}`, fix: 'hedge' })
        }
      } catch {
        /* skip this refutation */
      }
    }

    const removed = issues.filter((i) => i.fix === 'remove').length
    const hedged = issues.filter((i) => i.fix === 'hedge').length
    const checked = (audit.issues?.length ?? 0) + Math.min(MAX_ADVERSARIAL, audit.loadBearing?.length ?? 0)
    const verification: ResearchVerification = {
      checked: Math.max(checked, issues.length),
      confirmed: Math.max(0, Math.max(checked, issues.length) - removed - hedged),
      hedged,
      removed,
      notes: issues.slice(0, 5).map((i) => `${i.fix}: ${i.claim.slice(0, 80)}`),
    }

    // 3) Revise: hedge/remove the flagged claims, keep everything else + citations.
    let report = draft
    if (issues.length > 0) {
      const revisePrompt =
        `Revise this research report. For each flagged claim: if action is "remove", delete the claim and its citation; ` +
        `if "hedge", soften it and note the uncertainty. Keep all other content, structure, and citations exactly as-is — ` +
        `citations use the [[n]] double-bracket form, preserve that exact form. ` +
        `Return the full revised Markdown report only.\n\nFLAGGED:\n${issues
          .map((i) => `- (${i.fix}) ${i.claim} — ${i.problem}`)
          .join('\n')}\n\nREPORT:\n${draft}`
      try {
        const gen = trace?.generation({ name: 'verify-revise', model: (model as { modelId?: string }).modelId })
        const { text, usage } = await generateText({ model, prompt: revisePrompt, abortSignal: signal })
        gen?.end({ output: text, usage })
        if (text.trim()) report = text
      } catch {
        /* keep the un-revised draft */
      }
    }

    steps.replaceTail({
      kind: 'phase',
      tool: 'Verify',
      summary: `Verified: ${verification.confirmed} ok · ${verification.hedged} hedged · ${verification.removed} removed`,
      detail: verification.notes?.length ? verification.notes.join('\n') : 'No issues found.',
      status: 'done',
    })
    return { report, verification }
  } catch {
    // Verification is best-effort — never fail the whole task over it.
    steps.replaceTail({ kind: 'phase', tool: 'Verify', summary: 'Verification skipped (unavailable)', detail: '', status: 'done' })
    return { report: draft }
  }
}
