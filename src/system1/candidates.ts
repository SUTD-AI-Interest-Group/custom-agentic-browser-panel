// The candidate-action layer's second half: an observation plus the task's
// facts become the FINITE space a policy may choose from — which operations
// exist right now, which control ids each element operation may target, which
// value keys exist — and a ranking that decides what the state block shows.
// Pure. The rule (doc §24): an impossible action is never a candidate, so
// nothing downstream has to reject it.
import type { BrowserControl, BrowserObservation } from './observation'

export type ElementOperation = 'CLICK' | 'TYPE_TEXT' | 'SELECT_OPTION'
export type BrowserOperation = ElementOperation | 'SCROLL_DOWN' | 'SCROLL_UP' | 'WAIT' | 'DONE' | 'BLOCKED'
export const ELEMENT_OPERATIONS: readonly ElementOperation[] = ['CLICK', 'TYPE_TEXT', 'SELECT_OPTION']
/** Fixed rendering order. Von is order-invariant; this is for humans and golden tests. */
export const OPERATION_ORDER: readonly BrowserOperation[] = ['CLICK', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED']
export const isElementOperation = (op: BrowserOperation): op is ElementOperation => (ELEMENT_OPERATIONS as readonly string[]).includes(op)
export const isFieldOperation = (op: BrowserOperation): boolean => op === 'TYPE_TEXT' || op === 'SELECT_OPTION'

/** How many controls the state block lists. Beyond this the block says how many more exist; every eligible control stays a target. */
export const SHOWN_CONTROLS = 60

export interface CandidateActionSpace {
  operations: BrowserOperation[]
  /** Ranked control ids per element operation; [] when none. */
  targets: Record<ElementOperation, number[]>
  /** Ranked ids the state block lists (≤ SHOWN_CONTROLS). */
  shown: number[]
  valueKeys: string[]
  stats: { controls: number; eligible: number; shown: number; hidden: number }
}

/** What the ranker needs to know about a past step — structural, so actLoop's ActStep satisfies it without a cycle. */
export interface HistoryLike {
  targetId?: number
  result: 'success' | 'no_change' | 'stale'
}

/** Lowercased goal words of ≥ 3 letters/digits, deduplicated. */
export function goalWords(goal: string): string[] {
  const words = goal.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)
  return [...new Set(words)]
}

/**
 * The doc's §25 placeholder score, deterministic, ties by document order.
 * `score = 0.6·overlap + 0.2·fieldFit − 0.2·done + 0.1·focused`: overlap is
 * the fraction of goal words found in name + group; fieldFit is 1 for a field
 * when there are values to put in it; done is 1 when a successful step already
 * acted on this control; focused from the page. It orders and picks what is
 * SHOWN — it never removes a control from a target list (doc §26).
 */
export function rankControls(goal: string, controls: readonly BrowserControl[], valueKeys: readonly string[], history: readonly HistoryLike[]): BrowserControl[] {
  const words = goalWords(goal)
  const done = new Set(history.filter((h) => h.result === 'success' && h.targetId !== undefined).map((h) => h.targetId))
  const score = (c: BrowserControl): number => {
    const hay = `${c.name} ${c.group ?? ''}`.toLowerCase()
    const overlap = words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0
    const field = c.actions.includes('type_text') || c.actions.includes('select_option')
    const fieldFit = field && valueKeys.length > 0 ? 1 : 0
    return 0.6 * overlap + 0.2 * fieldFit - 0.2 * (done.has(c.id) ? 1 : 0) + 0.1 * (c.states.focused ? 1 : 0)
  }
  return controls
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)
}

export function buildCandidateSpace(input: {
  goal: string
  observation: BrowserObservation
  values: Record<string, string>
  history: readonly HistoryLike[]
}): CandidateActionSpace {
  const { observation, values, history } = input
  const valueKeys = Object.keys(values)
  const ranked = rankControls(input.goal, observation.controls, valueKeys, history)
  const targets: Record<ElementOperation, number[]> = { CLICK: [], TYPE_TEXT: [], SELECT_OPTION: [] }
  for (const c of ranked) {
    // Independent of observation.ts having already emptied a sensitive
    // control's actions: the invariant "sensitive elements are never
    // candidates" must not rest on one guard.
    if (c.sensitive) continue
    if (c.actions.includes('click')) targets.CLICK.push(c.id)
    if (valueKeys.length > 0 && c.actions.includes('type_text')) targets.TYPE_TEXT.push(c.id)
    if (valueKeys.length > 0 && c.actions.includes('select_option')) targets.SELECT_OPTION.push(c.id)
  }
  const operations: BrowserOperation[] = OPERATION_ORDER.filter((op) => {
    if (isElementOperation(op)) return targets[op].length > 0
    if (op === 'SCROLL_DOWN') return observation.state.canScrollDown
    if (op === 'SCROLL_UP') return observation.state.canScrollUp
    return true
  })
  const eligible = new Set([...targets.CLICK, ...targets.TYPE_TEXT, ...targets.SELECT_OPTION]).size
  const shown = ranked.slice(0, SHOWN_CONTROLS).map((c) => c.id)
  return {
    operations,
    targets,
    shown,
    valueKeys,
    stats: { controls: observation.controls.length, eligible, shown: shown.length, hidden: observation.controls.length - shown.length },
  }
}
