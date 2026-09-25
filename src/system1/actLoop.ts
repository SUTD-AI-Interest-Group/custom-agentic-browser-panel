// The Act tool's step loop, pure over injected effects. Von chooses from a
// CLOSED set each step — a move, an on-screen element, a supplied value key —
// and never produces text, a URL or a navigation. Execution is delegated to
// `execute`, which in production is ControlPage's own controlStep: every
// point-of-no-return card, park and origin-drift check applies unchanged.
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from '../tools/pageControl'
import type { DecideQuestion, DecideRequest, DecideResult } from './protocol'

export const ACT_DEFAULT_STEPS = 6
export const ACT_MAX_STEPS = 8
export const ACT_CONFIDENCE = 0.6

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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const describe = (el: IndexedElement, op: string) => {
  const kind = el.role || (el.tag === 'input' ? `${el.type || 'text'} field` : el.tag)
  const cur = el.value ? ` (currently "${clip(el.value, 30)}")` : ''
  return `[${el.index}] ${kind} "${clip(el.name || '(unnamed)', 80)}"${cur} → ${op}`
}

const MOVES: Record<string, string> = {
  act: 'Act on one of the visible page elements to make progress toward the goal.',
  scroll_down: 'Scroll down: the element needed next is not visible yet.',
  WAIT: 'The page is still loading or changing; wait for it to settle.',
  DONE: 'The goal is already achieved on this page.',
  BLOCKED: 'The goal cannot be progressed here (login, captcha, a missing control, or information that was not provided).',
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
    const done = steps.map((s, i) => `${i + 1}. ${s.action}${s.label ? ` "${s.label}"` : ''}`).join('; ') || 'nothing yet'
    const state = [
      `Goal: ${input.goal}`,
      `Page: ${snap.title} (${snap.origin})`,
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
    if (move.choice === 'DONE') return { status: 'done', steps, elements: snap.text }
    if (move.choice === 'BLOCKED') return { status: 'blocked', steps, elements: snap.text }

    let spec: ControlSpec
    let label: string | undefined
    let p = move.top
    if (move.choice === 'scroll_down') spec = { action: 'scroll', direction: 'down' }
    else if (move.choice === 'WAIT') spec = { action: 'wait', timeoutMs: 3000 }
    else {
      const targetQ: Record<string, DecideQuestion> = {
        target: {
          instructions: 'Which element should be used next to progress toward the goal?',
          options: Object.fromEntries(candidates.map((el) => [String(el.index), describe(el, opFor(el))])),
        },
      }
      let t: DecideResult
      try { t = await deps.decide({ state, questions: targetQ }) } catch (err) {
        return { status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      ms += t.ms
      const ans = t.answers.target
      if (ans.top < ACT_CONFIDENCE) {
        const ranked = Object.entries(ans.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
        const byIndex = new Map(candidates.map((el) => [String(el.index), el]))
        return {
          status: 'uncertain', steps, elements: snap.text,
          message: `unsure which element to use (p=${ans.top.toFixed(2)})`,
          candidates: ranked.map(([k, pr]) => ({ index: Number(k), label: byIndex.get(k)?.name ?? '', p: pr })),
        }
      }
      const el = candidates.find((c) => String(c.index) === ans.choice)!
      label = clip(el.name || '(unnamed)', 60)
      p = Math.min(p, ans.top)
      const op = opFor(el)
      if (op === 'click') spec = { action: 'click', index: el.index }
      else {
        let v: DecideResult
        try {
          v = await deps.decide({ state, questions: { value: {
            instructions: `Which provided value belongs in ${describe(el, op)}?`,
            options: Object.fromEntries(valueKeys.map((k) => [k, `${k}: ${clip(values[k], 40)}`])),
          } } })
        } catch (err) {
          return { status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` }
        }
        ms += v.ms
        if (v.answers.value.top < ACT_CONFIDENCE)
          return { status: 'uncertain', steps, elements: snap.text, message: `unsure which value belongs in "${label}"` }
        p = Math.min(p, v.answers.value.top)
        const text = values[v.answers.value.choice]
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
