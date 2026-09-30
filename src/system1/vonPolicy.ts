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
import type { DecideAnswer, DecideQuestion, DecideRequest, DecideResult } from './protocol'
import { clip, type BrowserControl, type ElementAction } from './observation'
import { ELEMENT_OPERATIONS, isElementOperation, isFieldOperation, OPERATION_ORDER, type BrowserOperation, type CandidateActionSpace, type ElementOperation } from './candidates'
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

/** The control line without its actions suffix — shared by renderControl and renderControlAction so the two can never drift. */
function renderControlLine(c: BrowserControl): string[] {
  const parts = [`[${c.id}]`, neutralize(c.role), `"${clip(neutralize(c.name || '(unnamed)'), 60)}"`]
  if (c.group) parts.push(`in "${clip(neutralize(c.group), 40)}"`)
  if (c.checked !== undefined) parts.push(c.checked ? '(checked)' : '(unchecked)')
  else if (c.value) parts.push(`(currently "${clip(neutralize(c.value), 30)}")`)
  if (c.sensitive) parts.push('(sensitive)')
  else if (!c.states.enabled) parts.push('(disabled)')
  else if (c.kind !== 'click' && !c.states.editable) parts.push('(read-only)')
  return parts
}

/** One control line — the state block's line AND the target option's text, byte-identical. */
export function renderControl(c: BrowserControl): string {
  const parts = renderControlLine(c)
  if (c.actions.length) parts.push(`→ ${c.actions.map((a) => ACTION_WORD[a]).join(', ')}`)
  return parts.join(' ')
}

const OP_ACTION: Record<ElementOperation, ElementAction> = { CLICK: 'click', TYPE_TEXT: 'type_text', SELECT_OPTION: 'select_option' }

/** The single-pass head's option text: the control line with exactly ONE action — `[12] textbox "Email" → type`. */
export function renderControlAction(c: BrowserControl, op: ElementOperation): string {
  return [...renderControlLine(c), `→ ${ACTION_WORD[OP_ACTION[op]]}`].join(' ')
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
  return balancedChunks(pool, TARGET_CHUNK)
}

/** k near-equal chunks of at most `size`, in the pool's order; one chunk when the pool fits. */
export function balancedChunks<T>(pool: readonly T[], size: number): T[][] {
  if (pool.length <= size) return [[...pool]]
  const k = Math.ceil(pool.length / size)
  const base = Math.floor(pool.length / k)
  const extra = pool.length % k
  const chunks: T[][] = []
  for (let c = 0, i = 0; c < k; c++) {
    const n = base + (c < extra ? 1 : 0)
    chunks.push(pool.slice(i, i + n))
    i += n
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

        if (isFieldOperation(decision.operation)) await askValue(decision, ctx, byId, ask)
      } else if (decision.operation === 'BLOCKED') {
        await askBlocked(decision, ctx, byId, ask)
      }
      return { ...decision, ms }
    },
  }
}

type Ask = (questions: Record<string, DecideQuestion>, withControls: boolean) => Promise<DecideResult>

/** The value head: which provided key belongs in the chosen field. Shared by both policies. */
async function askValue(decision: BrowserDecision, ctx: DecisionContext, byId: Map<number, BrowserControl>, ask: Ask): Promise<void> {
  const control = decision.targetId !== undefined ? byId.get(decision.targetId) : undefined
  if (!control) return
  const v = await ask({ value: valueQuestion(control, ctx.values) }, false)
  decision.valueKey = v.answers.value.choice
  decision.confidence.value = v.answers.value.top
}

/** After BLOCKED: the reason, then (for MISSING_USER_DATA) which editable field lacks a value. Shared by both policies. */
async function askBlocked(decision: BrowserDecision, ctx: DecisionContext, byId: Map<number, BrowserControl>, ask: Ask): Promise<void> {
  const b = await ask({ blocked_reason: blockedQuestion() }, true)
  decision.blockedReason = b.answers.blocked_reason.choice as BlockedReason
  decision.confidence.blockedReason = b.answers.blocked_reason.top
  if (decision.blockedReason !== 'MISSING_USER_DATA') return
  const fields = ctx.observation.controls.filter((c) => c.actions.includes('type_text') || c.actions.includes('select_option'))
  if (fields.length === 0) return
  const m = await ask({ missing_field: missingFieldQuestion(fields.slice(0, TARGET_CHUNK)) }, false)
  const id = Number(m.answers.missing_field.choice)
  if (byId.has(id)) {
    decision.missingFieldId = id
    decision.confidence.missingField = m.answers.missing_field.top
  }
}

// ---------------------------------------------------------------------------
// The single-pass act head — jev-ultrafast's "one request per decision"
// (2026-09-30). ONE question whose options are every (control, action) pair
// the candidate space allows, each its own option (`[12] textbox "Email" →
// type` and `[12] textbox "Email" → click` are two options), plus the global
// moves. The state block omits the control list: the options ARE the
// controls, and the operation is implied by the chosen option. A click step
// is therefore one Von pass (was two, operation then target); a field step
// adds the value head. Above ACT_CHUNK element options the tournament runs
// over element options only and the final round adds the moves, so a move
// competes against the best control from every chunk, never a chunk's
// leftovers. Trained on rows rendered by exactly these functions
// (scripts/von-finetune/render.mjs --head act).

/** Element options per pass before the tournament kicks in. ~20 tokens each + a ~150-token state fits Von's 4096 with room. */
export const ACT_CHUNK = 120
/** The tournament never chunks below this on an over-length pack. */
export const MIN_ACT_CHUNK = 16
export const ACT_INSTRUCTIONS = 'Choose the next browser action toward the goal: one listed control with its action, or a move.'

export interface ActOption {
  /** `${controlId}:${operation}` for an element option, the operation name for a move. */
  id: string
  text: string
  operation: BrowserOperation
  control?: BrowserControl
}

/** Every (control, operation) pair the space allows, in the space's ranked control order, operations in the fixed order. */
export function actElementOptions(space: CandidateActionSpace, byId: Map<number, BrowserControl>): ActOption[] {
  const allowed = Object.fromEntries(ELEMENT_OPERATIONS.map((op) => [op, new Set(space.targets[op])])) as Record<ElementOperation, Set<number>>
  const out: ActOption[] = []
  for (const id of space.ranked) {
    const control = byId.get(id)
    if (!control) continue
    for (const op of ELEMENT_OPERATIONS) if (allowed[op].has(id)) out.push({ id: `${id}:${op}`, text: renderControlAction(control, op), operation: op, control })
  }
  return out
}

/** The global moves the space offers (scroll/wait/done/blocked), in the fixed order. */
export function actMoveOptions(space: CandidateActionSpace): ActOption[] {
  return OPERATION_ORDER.filter((op) => !isElementOperation(op) && space.operations.includes(op)).map((op) => ({ id: op, text: OPERATION_TEXT[op], operation: op }))
}

export function actQuestion(options: readonly ActOption[]): DecideQuestion {
  return { instructions: ACT_INSTRUCTIONS, options: Object.fromEntries(options.map((o) => [o.id, o.text])) }
}

export function createVonActPolicy(decide: (req: DecideRequest) => Promise<DecideResult>): BrowserPolicy {
  return {
    async decide(ctx: DecisionContext): Promise<BrowserDecision> {
      const threshold = ctx.threshold ?? 0
      const { space, observation: obs } = ctx
      const byId = new Map(obs.controls.map((c) => [c.id, c]))
      const state = renderState(ctx, space.shown, { controls: false })
      let ms = 0
      const ask: Ask = async (questions) => {
        const r = await decide({ state, questions })
        ms += r.ms
        return r
      }
      const elements = actElementOptions(space, byId)
      const moves = actMoveOptions(space)
      const byOption = new Map([...elements, ...moves].map((o) => [o.id, o]))

      let size = ACT_CHUNK
      let answer: DecideAnswer
      for (;;) {
        try {
          let finalists = elements
          if (elements.length > size) {
            const winners: ActOption[] = []
            for (const chunk of balancedChunks(elements, size)) {
              const r = await ask({ act: actQuestion(chunk) }, false)
              const w = chunk.find((o) => o.id === r.answers.act.choice)
              if (!w) throw new Error('System-1 returned an unknown choice')
              winners.push(w)
            }
            finalists = winners
          }
          answer = (await ask({ act: actQuestion([...finalists, ...moves]) }, false)).answers.act
          break
        } catch (err) {
          // Over-length: the state cannot shrink (no list), so chunk finer — down to MIN_ACT_CHUNK, then it is the caller's problem, stated.
          if (!isTooLong(err)) throw err
          const next = Math.max(MIN_ACT_CHUNK, Math.floor(size / 2))
          if (next >= size) throw new PolicyInputError('the page is too dense for the local model even in the smallest chunks')
          size = next
        }
      }

      const chosen = byOption.get(answer.choice)
      if (!chosen) throw new Error('System-1 returned an unknown choice')
      const decision: BrowserDecision = { operation: chosen.operation, confidence: { operation: answer.top }, ms }
      const ranked = Object.entries(answer.probabilities)
        .map(([id, p]) => ({ o: byOption.get(id), p }))
        .filter((x): x is { o: ActOption & { control: BrowserControl }; p: number } => !!x.o?.control)
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .map((x) => ({ id: x.o.control.id, p: x.p }))
      if (ranked.length) decision.ranked = ranked
      if (chosen.control) {
        decision.targetId = chosen.control.id
        decision.confidence.target = answer.top
        if (answer.top < threshold) return { ...decision, ms }
        if (isFieldOperation(chosen.operation)) await askValue(decision, ctx, byId, ask)
      } else if (chosen.operation === 'BLOCKED') {
        await askBlocked(decision, ctx, byId, ask)
      }
      return { ...decision, ms }
    },
  }
}
