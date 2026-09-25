// The Act tool's step loop, pure over injected effects. Von chooses from a
// CLOSED set each step — a move, an on-screen element, a supplied value key —
// and never produces text, a URL or a navigation. Execution is delegated to
// `execute`, which in production is ControlPage's own controlStep: every
// point-of-no-return card, park and origin-drift check applies unchanged.
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from '../tools/pageControl'
import type { DecideAnswer, DecideQuestion, DecideRequest, DecideResult } from './protocol'

export const ACT_DEFAULT_STEPS = 6
export const ACT_MAX_STEPS = 8
export const ACT_CONFIDENCE = 0.6
/**
 * The target question's option text is proportional to candidate count, and
 * a dense page (domIndex.ts caps at 200 elements) overflows Von's maxTokens
 * budget in a single question. Above this many candidates, split into chunks
 * of at most this size (document order), ask the same question per chunk,
 * then run one final round over the chunk winners — see pickTarget below.
 */
export const TARGET_CHUNK = 40

export type ActStatus = 'done' | 'blocked' | 'uncertain' | 'denied' | 'drifted' | 'repeat' | 'aborted' | 'capped' | 'error' | 'parked'
export type ExecOutcome =
  | { kind: 'ok'; elements: string }
  | { kind: 'denied' }
  | { kind: 'parked'; note: string }
  | { kind: 'drifted'; message: string; elements?: string }
  | { kind: 'error'; message: string }
export interface ActStep { action: ControlSpec['action']; index?: number; label?: string; p: number; ms: number }
export interface ActResult {
  status: ActStatus
  steps: ActStep[]
  candidates?: { index: number; label: string; p: number }[]
  message?: string
  elements?: string
}
export interface ActDeps {
  snapshot(): Promise<PageSnapshot>
  decide(req: DecideRequest): Promise<DecideResult>
  execute(spec: ControlSpec): Promise<ExecOutcome>
  aborted(): boolean
}

const TEXT_INPUT = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

export function opFor(el: IndexedElement): 'click' | 'type' | 'select' {
  const tag = el.tag.toLowerCase()
  if (tag === 'select') return 'select'
  if (tag === 'textarea') return 'type'
  if (tag === 'input' && TEXT_INPUT.has((el.type ?? '').toLowerCase())) return 'type'
  if (el.role === 'textbox' || el.role === 'searchbox') return 'type'
  return 'click'
}

// The tokenizer treats these exact, case-sensitive strings as special tokens
// (a literal "[MASK]" resolves to a fixed id outside the vocabulary Von
// reasons over as ordinary text). Page-controlled text — an element's own
// name or current value — or the caller's goal could contain one verbatim
// and silently inject a control token into what's meant to be ordinary
// content. Lowercasing is enough to defuse it: BPE is case-sensitive, so
// "[mask]" tokenizes as plain text.
const SPECIAL_TOKENS = /\[(MASK|SEP|CLS|PAD|UNK)\]/g
const neutralize = (s: string): string => s.replace(SPECIAL_TOKENS, (m) => m.toLowerCase())

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const describe = (el: IndexedElement, op: string) => {
  const tag = el.tag.toLowerCase()
  // el.role is arbitrary page-authored ARIA text (domIndex.ts), same
  // provenance as el.name/el.value — neutralize it too rather than only
  // the tag/type fallback, which are internal, bracket-free strings.
  const kind = neutralize(el.role || (tag === 'input' ? `${el.type || 'text'} field` : tag))
  const name = neutralize(el.name || '(unnamed)')
  const cur = el.value ? ` (currently "${clip(neutralize(el.value), 30)}")` : ''
  return `[${el.index}] ${kind} "${clip(name, 60)}"${cur} → ${op}`
}

const MOVES: Record<string, string> = {
  act: 'Act on one of the visible page elements to make progress toward the goal.',
  scroll_down: 'Scroll down: the element needed next is not visible yet.',
  WAIT: 'The page is still loading or changing; wait for it to settle.',
  DONE: 'The goal is already achieved on this page.',
  BLOCKED: 'The goal cannot be progressed here (login, captcha, a missing control, or information that was not provided).',
}

type TargetAsk = { kind: 'ok'; ans: DecideAnswer; ms: number } | { kind: 'error'; message: string }

async function askTarget(state: string, pool: IndexedElement[], deps: ActDeps): Promise<TargetAsk> {
  const targetQ: Record<string, DecideQuestion> = {
    target: {
      instructions: 'Which element should be used next to progress toward the goal?',
      options: Object.fromEntries(pool.map((el) => [String(el.index), describe(el, opFor(el))])),
    },
  }
  try {
    const t = await deps.decide({ state, questions: targetQ })
    return { kind: 'ok', ans: t.answers.target, ms: t.ms }
  } catch (err) {
    return { kind: 'error', message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

type TargetPick =
  | { kind: 'ok'; el: IndexedElement; p: number; ms: number }
  | { kind: 'uncertain'; ms: number; top: number; probabilities: Record<string, number> }
  | { kind: 'error'; message: string }

/**
 * Picks one element from `candidates`. Within TARGET_CHUNK, this is exactly
 * one decide() call, same as before the tournament existed. Above it, splits
 * into document-order chunks of at most TARGET_CHUNK, asks the same target
 * question per chunk (sequentially — one decide() realm, see ExecHost/engine
 * for the reasoning), takes each chunk's winner, then asks one final target
 * question over the winners only. The final round's calibrated confidence is
 * what ACT_CONFIDENCE gates on and what `uncertain` candidates are drawn
 * from — earlier rounds only narrow the field, they never gate.
 */
async function pickTarget(state: string, candidates: IndexedElement[], deps: ActDeps): Promise<TargetPick> {
  let ms = 0
  let pool = candidates
  if (candidates.length > TARGET_CHUNK) {
    const winners: IndexedElement[] = []
    for (let i = 0; i < candidates.length; i += TARGET_CHUNK) {
      const chunk = candidates.slice(i, i + TARGET_CHUNK)
      const r = await askTarget(state, chunk, deps)
      if (r.kind === 'error') return r
      ms += r.ms
      const winner = chunk.find((el) => String(el.index) === r.ans.choice)
      if (!winner) return { kind: 'error', message: 'System-1 returned an unknown choice' }
      winners.push(winner)
    }
    pool = winners
  }
  const r = await askTarget(state, pool, deps)
  if (r.kind === 'error') return r
  ms += r.ms
  if (r.ans.top < ACT_CONFIDENCE) return { kind: 'uncertain', ms, top: r.ans.top, probabilities: r.ans.probabilities }
  const el = pool.find((c) => String(c.index) === r.ans.choice)
  if (!el) return { kind: 'error', message: 'System-1 returned an unknown choice' }
  return { kind: 'ok', el, p: r.ans.top, ms }
}

export async function runActLoop(
  input: { goal: string; values?: Record<string, string>; maxSteps?: number },
  deps: ActDeps,
): Promise<ActResult> {
  const values = input.values ?? {}
  const valueKeys = Object.keys(values)
  const cap = Math.max(1, Math.min(ACT_MAX_STEPS, input.maxSteps ?? ACT_DEFAULT_STEPS))
  const steps: ActStep[] = []
  let lastElements: string | undefined
  let prev: { action: string; index?: number } | null = null

  for (let n = 0; n < cap; n++) {
    if (n > 0 && deps.aborted()) return { status: 'aborted', steps, elements: lastElements }
    let snap: PageSnapshot
    try { snap = await deps.snapshot() } catch (err) {
      return { status: 'error', steps, message: `could not read the page: ${err instanceof Error ? err.message : String(err)}` }
    }
    const candidates = snap.elements.filter((el) => {
      if (el.sensitive) return false
      const op = opFor(el)
      return op === 'click' || valueKeys.length > 0
    })
    // Cap the recap to the last 8 steps so a long-running chain can't grow
    // "Done so far" without bound; numbering stays absolute (not
    // renumbered from 1) so a trimmed recap doesn't misrepresent progress.
    const recentSteps = steps.slice(-8)
    const stepOffset = steps.length - recentSteps.length
    const done = recentSteps.map((s, i) => `${stepOffset + i + 1}. ${s.action}${s.label ? ` "${s.label}"` : ''}`).join('; ') || 'nothing yet'
    // Clip before neutralize: goal/title are the two unbounded-length
    // inputs in the state prefix (element/value text is already clipped in
    // describe()), so this closes the remaining overflow axis alongside
    // the target-question tournament above.
    const state = [
      `Goal: ${neutralize(clip(input.goal, 300))}`,
      `Page: ${neutralize(clip(snap.title, 150))} (${snap.origin})`,
      `Done so far: ${done}`,
      valueKeys.length ? `Provided values: ${valueKeys.join(', ')}` : 'Provided values: none',
    ].join('\n')

    const moveOptions = { ...MOVES }
    if (candidates.length === 0) delete moveOptions.act
    const questions: Record<string, DecideQuestion> = {
      move: { instructions: 'Decide the next browser move toward the goal.', options: moveOptions },
    }
    let result: DecideResult
    let ms = 0
    try {
      result = await deps.decide({ state, questions })
      ms += result.ms
    } catch (err) {
      return { status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const move = result.answers.move
    if (move.top < ACT_CONFIDENCE) return { status: 'uncertain', steps, message: `unsure of the next move (p=${move.top.toFixed(2)})`, elements: snap.text }
    if (!Object.prototype.hasOwnProperty.call(moveOptions, move.choice))
      return { status: 'error', steps, message: 'System-1 returned an unknown choice' }
    if (move.choice === 'DONE') return { status: 'done', steps, elements: snap.text }
    if (move.choice === 'BLOCKED') return { status: 'blocked', steps, elements: snap.text }

    let spec: ControlSpec
    let label: string | undefined
    let p = move.top
    if (move.choice === 'scroll_down') spec = { action: 'scroll', direction: 'down' }
    else if (move.choice === 'WAIT') spec = { action: 'wait', timeoutMs: 3000 }
    else {
      const pick = await pickTarget(state, candidates, deps)
      if (pick.kind === 'error') return { status: 'error', steps, message: pick.message }
      ms += pick.ms
      if (pick.kind === 'uncertain') {
        const ranked = Object.entries(pick.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
        const byIndex = new Map(candidates.map((el) => [String(el.index), el]))
        return {
          status: 'uncertain', steps, elements: snap.text,
          message: `unsure which element to use (p=${pick.top.toFixed(2)})`,
          candidates: ranked.map(([k, pr]) => ({ index: Number(k), label: byIndex.get(k)?.name ?? '', p: pr })),
        }
      }
      const el = pick.el
      label = clip(neutralize(el.name || '(unnamed)'), 60)
      p = Math.min(p, pick.p)
      const op = opFor(el)
      if (op === 'click') spec = { action: 'click', index: el.index }
      else {
        let v: DecideResult
        try {
          v = await deps.decide({ state, questions: { value: {
            instructions: `Which provided value belongs in ${describe(el, op)}?`,
            options: Object.fromEntries(valueKeys.map((k) => [k, `${k}: ${clip(neutralize(values[k]), 40)}`])),
          } } })
        } catch (err) {
          return { status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` }
        }
        ms += v.ms
        if (v.answers.value.top < ACT_CONFIDENCE)
          return { status: 'uncertain', steps, elements: snap.text, message: `unsure which value belongs in "${label}"` }
        p = Math.min(p, v.answers.value.top)
        const chosenKey = v.answers.value.choice
        if (!Object.prototype.hasOwnProperty.call(values, chosenKey))
          return { status: 'error', steps, message: 'System-1 returned an unknown choice' }
        const text = values[chosenKey]
        spec = op === 'type' ? { action: 'type', index: el.index, text, clear: true } : { action: 'select', index: el.index, value: text }
      }
    }

    if (prev && prev.action === spec.action && prev.index === spec.index && spec.index !== undefined)
      return { status: 'repeat', steps, elements: snap.text, message: `would repeat ${spec.action} on [${spec.index}]` }

    const out = await deps.execute(spec)
    if (out.kind === 'denied') return { status: 'denied', steps }
    if (out.kind === 'parked') return { status: 'parked', steps, message: out.note }
    if (out.kind === 'drifted') return { status: 'drifted', steps, message: out.message, elements: out.elements }
    if (out.kind === 'error') return { status: 'error', steps, message: out.message }
    steps.push({ action: spec.action, index: spec.index, label, p: Math.round(p * 100) / 100, ms })
    lastElements = out.elements
    prev = { action: spec.action, index: spec.index }
  }
  return { status: 'capped', steps, elements: lastElements }
}
