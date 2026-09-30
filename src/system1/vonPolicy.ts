// Von's adapter to the policy boundary. Renders the candidate-action
// representation (doc §18) as the ONE state block every question in a step
// shares, then asks Von lazily: `operation`, then `target_<OP>` over that
// operation's targets only, then `value`, and `blocked_reason` after BLOCKED.
//
// Why the controls live in the OPERATION head's prefix: Von 1.2 scores each
// option against the prefix ALONE — options never attend to each other — so an
// operation option ("Click one of the listed controls") can only tell CLICK
// from SCROLL_DOWN if the state says what is on screen. A target head's options
// ARE the controls, each carrying its own line, so its state omits the list:
// measured 2026-09-27 (eval README), listing the controls in every head cost
// ~10× the tokens per pass (shop page: 4.4 s per pick vs 0.2 s) and dropped
// grounding from 0.685 to 0.481 — the marker's own line drowned in 40 copies
// of its siblings. Each head's prefix carries exactly what it must
// discriminate on, nothing more.
//
// Every renderer here is exported so the fine-tune pipeline can render a
// training row through the very code that builds the request at inference —
// a train/serve skew here would be silent.
import type { DecideQuestion, DecideRequest, DecideResult } from './protocol'
import { clip, type BrowserControl, type ElementAction } from './observation'
import { isElementOperation, isFieldOperation, OPERATION_ORDER, type BrowserOperation, type CandidateActionSpace, type ElementOperation } from './candidates'
import { BLOCKED_REASONS, PolicyInputError, type BlockedReason, type BrowserDecision, type BrowserPolicy, type DecisionContext } from './policy'

/**
 * A target question's option text is proportional to pool size, and a dense
 * page overflows Von's maxTokens in one question. Above this many targets the
 * pool is split into balanced chunks (in ranked order), the same question is
 * asked per chunk, and one final round runs over the chunk winners. Only the
 * final round's calibrated confidence is reported.
 */
export const TARGET_CHUNK = 40
/** The state block never shows fewer controls than this when shrinking for the token budget. */
export const MIN_SHOWN = 10
/** How many past steps the state block recaps. Numbering stays absolute so a trimmed recap does not misrepresent progress. */
export const RECENT_STEPS = 8

// The tokenizer treats these exact, case-sensitive strings as special tokens.
// Page-controlled text (a control's name, value, group) or the goal could
// contain one verbatim and inject a control token; lowercasing defuses it
// (BPE is case-sensitive, so "[mask]" tokenizes as plain text).
const SPECIAL_TOKENS = /\[(MASK|SEP|CLS|PAD|UNK)\]/g
export const neutralize = (s: string): string => s.replace(SPECIAL_TOKENS, (m) => m.toLowerCase())

const ACTION_WORD: Record<ElementAction, string> = { click: 'click', type_text: 'type', select_option: 'select' }

/** One control line — the state block's line AND the target option's text, byte-identical. */
export function renderControl(c: BrowserControl): string {
  const parts = [`[${c.id}]`, neutralize(c.role), `"${clip(neutralize(c.name || '(unnamed)'), 60)}"`]
  if (c.group) parts.push(`in "${clip(neutralize(c.group), 40)}"`)
  if (c.checked !== undefined) parts.push(c.checked ? '(checked)' : '(unchecked)')
  else if (c.value) parts.push(`(currently "${clip(neutralize(c.value), 30)}")`)
  if (c.sensitive) parts.push('(sensitive)')
  else if (!c.states.enabled) parts.push('(disabled)')
  else if (c.kind !== 'click' && !c.states.editable) parts.push('(read-only)')
  if (c.actions.length) parts.push(`→ ${c.actions.map((a) => ACTION_WORD[a]).join(', ')}`)
  return parts.join(' ')
}

/**
 * The shared state block. `shownIds` is the ranked selection; lines render in
 * document order. `controls: false` renders the block without the control
 * list — what the target and value heads get, whose options are the controls.
 */
export function renderState(ctx: DecisionContext, shownIds: readonly number[], opts: { controls?: boolean } = {}): string {
  const { observation: obs, space } = ctx
  const yn = (b: boolean) => (b ? 'yes' : 'no')
  const lines = [
    `Goal: ${neutralize(clip(ctx.goal, 300))}`,
    `Page: ${neutralize(clip(obs.page.title, 150))} (${obs.page.origin})`,
    `State: scroll down: ${yn(obs.state.canScrollDown)}; scroll up: ${yn(obs.state.canScrollUp)}` +
      (obs.state.focusedId !== undefined ? `; focused: [${obs.state.focusedId}]` : ''),
  ]
  if (opts.controls !== false) {
    const byId = new Map(obs.controls.map((c) => [c.id, c]))
    const shown = [...shownIds].sort((a, b) => a - b).map((id) => byId.get(id)).filter((c): c is BrowserControl => !!c)
    if (obs.controls.length === 0) lines.push('Controls: none')
    else {
      lines.push(shown.length < obs.controls.length ? `Controls (${shown.length} of ${obs.controls.length} shown):` : `Controls (${obs.controls.length}):`)
      for (const c of shown) lines.push(renderControl(c))
    }
  }
  lines.push(`Provided values: ${space.valueKeys.join(', ') || 'none'}`)
  const recent = ctx.steps.slice(-RECENT_STEPS)
  const offset = ctx.steps.length - recent.length
  if (recent.length === 0) lines.push('Recent actions: none')
  else {
    lines.push('Recent actions:')
    recent.forEach((s, i) => {
      const target = s.targetId !== undefined ? ` [${s.targetId}] "${clip(neutralize(s.label ?? ''), 60)}"` : ''
      const value = s.valueKey ? ` ← ${neutralize(s.valueKey)}` : ''
      lines.push(`${offset + i + 1}. ${s.operation}${target}${value} → ${s.result.replace('_', ' ')}`)
    })
  }
  return lines.join('\n')
}

export const OPERATION_TEXT: Record<BrowserOperation, string> = {
  CLICK: 'Click one of the listed controls.',
  TYPE_TEXT: 'Type one of the provided values into a listed field.',
  SELECT_OPTION: 'Choose one of the provided values in a listed dropdown.',
  SCROLL_DOWN: 'Scroll down: what is needed next is below the visible area.',
  SCROLL_UP: 'Scroll up: what is needed next is above the visible area.',
  WAIT: 'The page is still loading or changing; wait for it to settle.',
  DONE: 'The goal is already achieved on this page.',
  BLOCKED: 'The goal cannot be progressed here.',
}

export function operationQuestion(space: CandidateActionSpace): DecideQuestion {
  const present = new Set(space.operations)
  return {
    instructions: 'Decide the next browser operation toward the goal.',
    options: Object.fromEntries(OPERATION_ORDER.filter((op) => present.has(op)).map((op) => [op, OPERATION_TEXT[op]])),
  }
}

const TARGET_INSTRUCTIONS: Record<ElementOperation, string> = {
  CLICK: 'Which control should be clicked next to progress toward the goal?',
  TYPE_TEXT: 'Which field should receive a provided value next to progress toward the goal?',
  SELECT_OPTION: 'Which dropdown should be set to a provided value next to progress toward the goal?',
}

export function targetQuestion(op: ElementOperation, pool: readonly BrowserControl[]): DecideQuestion {
  return { instructions: TARGET_INSTRUCTIONS[op], options: Object.fromEntries(pool.map((c) => [String(c.id), renderControl(c)])) }
}

export function valueQuestion(control: BrowserControl, values: Record<string, string>): DecideQuestion {
  return {
    instructions: `Which provided value belongs in ${renderControl(control)}?`,
    options: Object.fromEntries(Object.keys(values).map((k) => [k, `${neutralize(k)}: ${clip(neutralize(values[k]), 40)}`])),
  }
}

const BLOCKED_TEXT: Record<BlockedReason, string> = {
  AUTH_REQUIRED: 'A login or sign-in is required first.',
  CAPTCHA: 'A CAPTCHA or human verification is in the way.',
  MISSING_USER_DATA: 'A value the goal needs was not provided.',
  UNSUPPORTED_UI: 'The needed control is not one that can be operated here (canvas, drag-and-drop, file upload…).',
  NO_VALID_ACTION: 'No listed control or move would progress the goal.',
}

export function blockedQuestion(): DecideQuestion {
  return { instructions: 'Why can the goal not be progressed here?', options: Object.fromEntries(BLOCKED_REASONS.map((r) => [r, BLOCKED_TEXT[r]])) }
}

/**
 * After BLOCKED/MISSING_USER_DATA: which field is it that lacks a value? Over
 * every enabled, editable field on the page — regardless of whether values
 * were supplied, since the point is that the needed one was not. Lets the
 * result name the field so the chat model can supply it and call again,
 * instead of falling back to a ControlPage round trip per field.
 */
export function missingFieldQuestion(pool: readonly BrowserControl[]): DecideQuestion {
  return { instructions: 'Which field needs a value that was not provided?', options: Object.fromEntries(pool.map((c) => [String(c.id), renderControl(c)])) }
}

/**
 * Balanced chunks of at most TARGET_CHUNK, in the pool's (ranked) order. Fixed
 * slicing would turn 41 targets into 40 + 1, and a one-option "chunk" wins by
 * default with no question really asked — so k chunks of near-equal size.
 */
export function targetChunks<T>(pool: readonly T[]): T[][] {
  if (pool.length <= TARGET_CHUNK) return [[...pool]]
  const k = Math.ceil(pool.length / TARGET_CHUNK)
  const base = Math.floor(pool.length / k)
  const extra = pool.length % k
  const chunks: T[][] = []
  for (let c = 0, i = 0; c < k; c++) {
    const size = base + (c < extra ? 1 : 0)
    chunks.push(pool.slice(i, i + size))
    i += size
  }
  return chunks
}

const isTooLong = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'too-long'

export function createVonPolicy(decide: (req: DecideRequest) => Promise<DecideResult>): BrowserPolicy {
  return {
    async decide(ctx: DecisionContext): Promise<BrowserDecision> {
      const threshold = ctx.threshold ?? 0
      const { space, observation: obs } = ctx
      const byId = new Map(obs.controls.map((c) => [c.id, c]))
      let shown = space.shown
      let ms = 0
      // One question, with the token-budget fallback: on Von's over-length
      // error, shrink the shown list (never below MIN_SHOWN) and retry; once
      // it cannot shrink further the overflow is the caller's problem, stated,
      // never silent. Only the operation head lists the controls; a target
      // head's overflow (its options) cannot be shrunk here and is bounded by
      // TARGET_CHUNK instead.
      const ask = async (questions: Record<string, DecideQuestion>, withControls: boolean): Promise<DecideResult> => {
        for (;;) {
          const state = renderState(ctx, shown, { controls: withControls })
          try {
            const r = await decide({ state, questions })
            ms += r.ms
            return r
          } catch (err) {
            if (!isTooLong(err)) throw err
            const next = Math.max(MIN_SHOWN, Math.floor(shown.length / 2))
            if (!withControls || next >= shown.length) throw new PolicyInputError('the page is too dense for the local model even with the shortest control list')
            shown = shown.slice(0, next)
          }
        }
      }

      const opRes = await ask({ operation: operationQuestion(space) }, true)
      const op = opRes.answers.operation
      const decision: BrowserDecision = { operation: op.choice as BrowserOperation, confidence: { operation: op.top }, ms }
      if (op.top < threshold) return { ...decision, ms }

      if (isElementOperation(decision.operation)) {
        const pool = space.targets[decision.operation].map((id) => byId.get(id)).filter((c): c is BrowserControl => !!c)
        const key = `target_${decision.operation}`
        let finalists = pool
        if (pool.length > TARGET_CHUNK) {
          const winners: BrowserControl[] = []
          for (const chunk of targetChunks(pool)) {
            const r = await ask({ [key]: targetQuestion(decision.operation, chunk) }, false)
            const w = chunk.find((c) => String(c.id) === r.answers[key].choice)
            if (!w) throw new Error('System-1 returned an unknown choice')
            winners.push(w)
          }
          finalists = winners
        }
        const r = await ask({ [key]: targetQuestion(decision.operation, finalists) }, false)
        const ans = r.answers[key]
        decision.confidence.target = ans.top
        decision.ranked = Object.entries(ans.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id, p]) => ({ id: Number(id), p }))
        decision.targetId = Number(ans.choice)
        if (ans.top < threshold) return { ...decision, ms }

        if (isFieldOperation(decision.operation)) {
          const control = byId.get(decision.targetId)
          if (control) {
            const v = await ask({ value: valueQuestion(control, ctx.values) }, false)
            decision.valueKey = v.answers.value.choice
            decision.confidence.value = v.answers.value.top
          }
        }
      } else if (decision.operation === 'BLOCKED') {
        const b = await ask({ blocked_reason: blockedQuestion() }, true)
        decision.blockedReason = b.answers.blocked_reason.choice as BlockedReason
        decision.confidence.blockedReason = b.answers.blocked_reason.top
        if (decision.blockedReason === 'MISSING_USER_DATA') {
          const fields = obs.controls.filter((c) => c.actions.includes('type_text') || c.actions.includes('select_option'))
          if (fields.length > 0) {
            const m = await ask({ missing_field: missingFieldQuestion(fields.slice(0, TARGET_CHUNK)) }, false)
            const id = Number(m.answers.missing_field.choice)
            if (byId.has(id)) {
              decision.missingFieldId = id
              decision.confidence.missingField = m.answers.missing_field.top
            }
          }
        }
      }
      return { ...decision, ms }
    },
  }
}
