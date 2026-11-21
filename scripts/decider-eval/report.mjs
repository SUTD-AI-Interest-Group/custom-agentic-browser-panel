// Scoring and reporting for the decider eval. Pure functions over the raw rows run.mjs records
// (conversation tool calls, trace timings, the fixture tab's URL timeline, shadow records), plus
// `writeReport`, which writes out/<ISO-time>/{results.json,report.md}.
//
// The scoring rule: every ControlPage call is a step. The state before step i is the `elements`
// registry of the latest earlier tool output that has one (as the spike's replay did) and the
// fixture tab's URL when the model started that step. The answer key for that state scores the
// chat model's (op, index) and the decider's top option independently.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formTargets, key as answerKey, matches } from './keys.mjs'

export const DEFAULT_THRESHOLD = 0.6
const BUCKETS = [0, 0.4, 0.6, 0.8, 1.0001]
const NEUTRAL_OPS = new Set(['highlight', 'wait'])

// ── cost ──────────────────────────────────────────────────────────────────────────────────────
/**
 * Estimated USD for one task's usage. Only the hosted provider costs money; a local model is $0.
 * $2 / $10 per M input / output, $0.10 per M cached read; `high` charges uncached input at
 * 1.25× (cache writes) and is the figure the spend cap uses.
 */
export function estimateCost({ inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 }, providerKind) {
  if (providerKind !== 'anthropic') return { low: 0, high: 0 }
  const unc = Math.max(0, inputTokens - cachedInputTokens)
  const low = (unc * 2 + cachedInputTokens * 0.1 + outputTokens * 10) / 1e6
  const high = (unc * 2 * 1.25 + cachedInputTokens * 0.1 + outputTokens * 10) / 1e6
  return { low: +low.toFixed(4), high: +high.toFixed(4) }
}

/** Token usage summed over turn-trace steps. */
export function usageOf(steps) {
  const sum = (k) => (steps ?? []).reduce((a, s) => a + (s?.usage?.[k] ?? 0), 0)
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedInputTokens: sum('cachedInputTokens') }
}

/** Charged against the cap for a hosted task whose spend cannot be read back. */
export const RESERVE_USD = 0.5

/**
 * One task's cost for the spend cap. From the turn-trace steps when any are readable. When none
 * are (the run threw, the browser died, a stopped turn wrote no trace) but the prompt went out
 * to the hosted model, the spend is unknown, so `high` (the figure the cap uses) is a flat
 * $0.50 reserve, labelled `estimated: 'reserve'`. A prompt never sent cost nothing. A local
 * model is always $0.
 * @returns {{ low: number, high: number, estimated: 'trace' | 'reserve' | 'not-sent' | 'local' }}
 */
export function taskCost(steps, { providerKind, sent }) {
  if (providerKind !== 'anthropic') return { low: 0, high: 0, estimated: 'local' }
  if (!sent) return { low: 0, high: 0, estimated: 'not-sent' }
  if (Array.isArray(steps) && steps.length) return { ...estimateCost(usageOf(steps), providerKind), estimated: 'trace' }
  return { low: 0, high: RESERVE_USD, estimated: 'reserve' }
}

// ── pairing ───────────────────────────────────────────────────────────────────────────────────
const sameAction = (call, rec) =>
  !!rec.llm && rec.llm.op === call.input?.action && (rec.llm.index ?? null) === (call.input?.index ?? null)

/**
 * Shadow records in step order. `seq` restarts with every continuation chain, so it orders
 * records only within one chain; `at` (taken synchronously as the hook is handed the step) orders
 * them across chains, with `seq` breaking a same-millisecond tie.
 */
export const inStepOrder = (records) => [...records].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0))

/**
 * Steps the hooks numbered but never recorded (a decision superseded under dropIfBusy), summed
 * over chains. A chain starts wherever `seq` stops increasing; within one, seqs count from 0. A
 * drop after a chain's last record is invisible here (it shows up as an unpaired call instead).
 */
export function seqGapsOf(records) {
  let gaps = 0
  let max = -1
  let count = 0
  for (const r of inStepOrder(records).filter((x) => Number.isInteger(x.seq))) {
    if (count && r.seq <= max) {
      gaps += max + 1 - count
      max = -1
      count = 0
    }
    max = Math.max(max, r.seq)
    count++
  }
  return count ? gaps + max + 1 - count : gaps
}

/**
 * Pair ControlPage calls (conversation order) with `kind: 'next'` shadow records (step order).
 * Every call that reached the decider hook has exactly one record, written from that call's own
 * spec, so the pairing is the longest order-preserving match on (op, index). A call that returned
 * before the hook (no session yet, tab not in front) has none; on a tie the LATER call is paired,
 * since the early-returned attempt is the one the model then repeats.
 * @returns {{ recFor: (object|null)[], unpairedRecords: object[] }}
 */
export function pairCalls(calls, records) {
  const recs = inStepOrder(records)
  const n = calls.length
  const m = recs.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = sameAction(calls[i - 1], recs[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const recFor = new Array(n).fill(null)
  const used = new Set()
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (sameAction(calls[i - 1], recs[j - 1]) && dp[i][j] === dp[i - 1][j - 1] + 1) {
      recFor[i - 1] = recs[j - 1]
      used.add(j - 1)
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--
    else j--
  }
  return { recFor, unpairedRecords: recs.filter((_, j) => !used.has(j)) }
}

/**
 * True for a ControlPage result that `tools.ts` returns BEFORE the snapshot the decider hook
 * observes (no session, tab not active or not in front, origin drift, unreadable page), or a call
 * that never returned at all (schema rejection). Such a call has no shadow record by design, so it
 * is not counted as unpaired.
 */
export function returnedBeforeHook(output) {
  if (!output || typeof output !== 'object') return true
  if (output.parked === true) return true
  if (/^The page is now on /.test(output.message ?? '')) return true
  return /^(No page-control session is open|The controlled tab is no longer active|Cannot read this page)|page control ended for safety/.test(output.error ?? '')
}

// ── step states ───────────────────────────────────────────────────────────────────────────────
const hasRegistry = (out) => out && typeof out === 'object' && typeof out.elements === 'string' && out.elements.startsWith('[')

/** URL of the fixture tab at time t: the last timeline entry at or before t. */
export function urlAt(timeline, t) {
  let url
  for (const e of timeline ?? []) {
    if (e.at <= t) url = e.url
    else break
  }
  return url
}

// Two scoring corrections (Task 13 found both; the results doc's section 5.1 explains them).
//
// 1. A stale registry after `AutofillForm`. A step's registry is the latest earlier tool output
//    that carries `elements`, and AutofillForm's result carries none, so a step after a fill was
//    keyed against the PRE-fill form. The fills an earlier-model-step AutofillForm reported are
//    applied to that registry first. (The AI SDK finishes every tool of a step before the next
//    step starts, so an earlier step's fills are on the page.)
// 2. Parallel page-mutating calls. A ControlPage issued in the same model step as another
//    page-mutating call (an AutofillForm, or another non-neutral ControlPage) runs concurrently
//    with it on one page, so "the state before this action" has no single value. Such a call is
//    flagged `raced`, left unkeyed for both models, and counted.

/** What the decider's profile lookup writes into a form field, by the profile key's tail. */
const PROFILE = [
  [/first/, 'Ada'], [/last|surname|family/, 'Lovelace'], [/work/, 'ada@analytical-engines.co.uk'], [/mail/, 'ada@example.com'],
  [/phone|tel|mobile/, '+44 20 7946 0958'], [/street|address_line|line1|^address$/, "12 St James's Square"], [/city|town/, 'London'],
  [/post|zip/, 'SW1Y 4JH'], [/country/, 'United Kingdom'], [/name/, 'Ada Lovelace'],
]
const profileValue = (k) => PROFILE.find(([re]) => re.test(k.toLowerCase()))?.[1]

/** Rewrites registry line `[idx]` to show a value, or a checked state for a checkbox/radio. */
export function patchLine(registry, idx, { value, checked }) {
  return registry
    .split('\n')
    .map((line) => {
      if (!line.startsWith(`[${idx}]`)) return line
      if (checked !== undefined) return line.replace(/\((un)?checked\)/, checked ? '(checked)' : '(unchecked)')
      const base = line.replace(/ = ".*"(?=( \(sensitive\))?$)/, '')
      return base.replace(/("[^"]*")(?=( \(sensitive\))?$)/, `$1 = "${value}"`)
    })
    .join('\n')
}
const isBox = (registry, idx) => new RegExp(`^\\[${idx}\\]<input> (checkbox|radio)`, 'm').test(registry)

/** What one AutofillForm call wrote: `{ [index]: {value} | {checked} }` for each field it reports filled, or null. */
export function fillsOf(t) {
  const out = t.output && typeof t.output === 'object' ? t.output : {}
  if (!Array.isArray(out.filled) || !out.filled.length) return null
  const byIdx = {}
  for (const f of t.input?.fields ?? []) byIdx[f.index] = { value: String(f.value) }
  for (const m of out.mapped ?? []) {
    if (m.key === 'tick') byIdx[m.index] = { checked: true }
    else if (m.key.startsWith('profile.')) byIdx[m.index] = { value: profileValue(m.key.slice(8)) ?? `?${m.key}` }
    else if (m.key.startsWith('request.')) byIdx[m.index] = { value: String(t.input?.values?.[m.key.slice(8)] ?? `?${m.key}`) }
    else byIdx[m.index] = { value: m.key } // a select's chosen option text
  }
  const res = {}
  for (const idx of out.filled) if (byIdx[idx]) res[idx] = byIdx[idx]
  return res
}

/** `registry` with each fill applied (a checkbox/radio takes a checked state, anything else a value). */
export function applyFills(registry, fills) {
  let reg = registry
  for (const [idx, v] of Object.entries(fills))
    reg = patchLine(reg, idx, isBox(reg, idx) ? { checked: v.checked ?? (v.value !== 'false' && v.value !== '') } : v)
  return reg
}

/** Model-step start time of every tool call, by aligning the k-th call of each name with the trace. */
export function stepTimes(row) {
  const byName = {}
  for (const c of row.traceCalls ?? []) (byName[c.name] ??= []).push(c.at)
  const seen = {}
  return (row.tools ?? []).map((t) => {
    const k = (seen[t.toolName] = (seen[t.toolName] ?? -1) + 1)
    return byName[t.toolName]?.[k] ?? null
  })
}

/**
 * The ControlPage calls with the state each one was made in: `registry` from the latest earlier
 * tool output carrying one (with the fills of any earlier-step AutofillForm applied; `patched`
 * says so), `url` from the URL timeline at the start of the model step that made the call (trace
 * order <-> conversation order), else from the latest earlier output's `url`. `raced` marks a call
 * issued in the same model step as another page-mutating call.
 */
/** A call that changes the page: AutofillForm, FastSteps, or a ControlPage that is not highlight/wait. */
const mutating = (t) => t.toolName === 'AutofillForm' || t.toolName === 'FastSteps' || (t.toolName === 'ControlPage' && !NEUTRAL_OPS.has(t.input?.action))

/**
 * The state every tool call was made in, by conversation position: the registry of the latest
 * earlier output carrying one (with the fills of any earlier-step AutofillForm applied), the latest
 * earlier output's `url`, the model-step start time, and whether the call raced another
 * page-mutating call issued in the same model step.
 */
function toolStates(row) {
  const tools = row.tools ?? []
  const at = stepTimes(row)
  const autofills = tools.map((t, i) => (t.toolName === 'AutofillForm' ? { at: at[i], fills: fillsOf(t) } : null)).filter((x) => x?.fills)
  const states = []
  let registry = null
  let regAt = -Infinity
  let outUrl = row.startUrl
  for (const [i, t] of tools.entries()) {
    const callAt = at[i]
    const raced = callAt != null && mutating(t) && tools.some((o, j) => j !== i && at[j] === callAt && mutating(o))
    let reg = registry
    let patched = false
    if (reg && callAt != null) {
      // Fills from earlier steps that this registry predates (captured at or before the fill's step).
      const due = autofills.filter((a) => a.at != null && a.at < callAt && a.at >= regAt)
      if (due.length) {
        reg = due.reduce((r, a) => applyFills(r, a.fills), reg)
        patched = reg !== registry
      }
    }
    states.push({ registry: reg, patched, raced, outUrl, at: callAt })
    const out = t.output && typeof t.output === 'object' ? t.output : null
    if (hasRegistry(out)) {
      registry = out.elements
      regAt = at[i] ?? regAt
    }
    if (out && typeof out.url === 'string') outUrl = out.url
  }
  return { tools, states }
}

export function controlSteps(row) {
  const { tools, states } = toolStates(row)
  const calls = []
  for (const [i, t] of tools.entries()) {
    if (t.toolName !== 'ControlPage') continue
    const { registry, patched, raced, outUrl } = states[i]
    calls.push({ input: t.input ?? {}, output: t.output, registry, patched, raced, outUrl })
  }
  const times = (row.traceCalls ?? []).filter((c) => c.name === 'ControlPage').map((c) => c.at)
  const aligned = times.length === calls.length && (row.urlTimeline?.length ?? 0) > 0
  return calls.map((c, i) => ({
    ...c,
    url: (aligned ? urlAt(row.urlTimeline, times[i]) : undefined) ?? c.outUrl,
    urlSource: aligned ? 'timeline' : 'outputs',
  }))
}

// ── driver mode (FastSteps) ───────────────────────────────────────────────────────────────────
// A FastSteps call takes up to 12 page steps on the decider's own decisions, and its result lists
// the executed steps as `{op, index?, p, ms, ok}` with no page content. Each executed step is keyed
// against the state the decider decided it on:
//
// 1. `capture` (primary). run.mjs copies every `decider.next` request the worker posts to the panel
//    (its masked snapshot: url + elements) into `row.driveRequests`. Each `drive` shadow record is
//    the panel's answer to the latest request it had received, so request ↔ record pair by time
//    (`pairDriveRequests`). An executed step is the next decision, in order within its call's model
//    step, whose top-1 is the step's (op, index) at the same rounded p (a repeat's excluded first
//    ask is passed over). Its registry is the request's elements, rendered by `registryOf`, a port
//    of domIndex.ts serializeRegistry — the exact text ControlPage shows the chat model.
// 2. `replay` (fallback, no capture for that step). The registry the chat model last saw before
//    the call (patched by any earlier AutofillForm) at the call's URL, with this call's earlier
//    executed steps replayed onto it: a `type`/`select` writes the journal's value, a click on a
//    checkbox/radio flips its state. Any other click, a scroll or a press may navigate or move the
//    viewport, so every step after one is `unscoreable`.
//
// Every decision (executed or not) with a captured state is also keyed, so the report can say
// whether a hand-back's own top-1 was right (the gate's cost) as well as whether an action was.

/** domIndex.ts `serializeRegistry`, ported: a decision snapshot's elements → the registry text. */
export function registryOf(elements) {
  if (!Array.isArray(elements)) return null
  if (elements.length === 0) return '(no interactive elements found)'
  return elements
    .map((e) => {
      const attrs = [
        e.type && e.type !== 'text' ? e.type : '',
        e.name ? `"${e.name}"` : '',
        (e.checked === undefined || e.checked === null) && e.value ? `= "${e.value}"` : '',
        e.checked === undefined || e.checked === null ? '' : e.checked ? '(checked)' : '(unchecked)',
        e.sensitive ? '(sensitive)' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `[${e.index}]<${e.tag}${e.role ? ` role=${e.role}` : ''}> ${attrs}`.trimEnd()
    })
    .join('\n')
}

/** How late a record may be stamped before its request was copied (both are taken in the panel). */
const PAIR_TOLERANCE_MS = 50

/**
 * Pair captured `decider.next` requests with `drive` records, in time order: a record answers the
 * latest request copied at or before it. A cancelled request (`decider.next.cancel`: the worker
 * gave up) has no record by design.
 * @returns {{ pairs: {req: object, rec: object|null, cancelled: boolean}[], unpairedRecords: object[] }}
 */
export function pairDriveRequests(requests, records) {
  const all = Array.isArray(requests) ? requests : []
  const cancelled = new Set(all.filter((q) => q?.cancel).map((q) => q.requestId))
  const pairs = all
    .filter((q) => q && !q.cancel)
    .sort((a, b) => a.at - b.at)
    .map((req) => ({ req, rec: null, cancelled: cancelled.has(req.requestId) }))
  const unpairedRecords = []
  for (const rec of inStepOrder((records ?? []).filter((r) => r?.kind === 'drive'))) {
    let k = -1
    for (let i = 0; i < pairs.length && pairs[i].req.at <= (rec.at ?? 0) + PAIR_TOLERANCE_MS; i++) k = i
    if (k >= 0 && !pairs[k].rec) pairs[k].rec = rec
    else unpairedRecords.push(rec)
  }
  return { pairs, unpairedRecords }
}

const round2 = (p) => Math.round(p * 100) / 100
const topOf = (rec) => (rec && !rec.skipped && rec.top3?.length ? rec.top3[0] : null)
const sameStep = (top, s) => !!top && top.op === s.op && (top.index ?? null) === (s.index ?? null) && Math.abs(round2(top.p) - s.p) < 0.006

/**
 * One executed step replayed onto `registry`: the new registry, or null when its effect cannot be
 * known from the registry alone (a click that is not on a checkbox/radio, a scroll, a press).
 * A step the page refused (`ok: false`) changed nothing.
 */
export function replayStep(registry, step, value) {
  if (!step.ok) return registry
  if ((step.op === 'type' || step.op === 'select') && value !== undefined) return patchLine(registry, step.index, { value })
  if (step.op === 'click' && isBox(registry, step.index)) {
    const line = registry.split('\n').find((l) => l.startsWith(`[${step.index}]`)) ?? ''
    const radio = /^\[\d+\]<input> radio/.test(line)
    return patchLine(registry, step.index, { checked: radio ? true : !/\(checked\)/.test(line) })
  }
  return null
}

/**
 * What one `type`/`select` step wrote, by the step's own `key` (builds from ba598bd on: the result
 * never echoes a value): `request.<name>` → the call's `values`, `profile.<key>` → the seeded
 * profile, `option.<n>` → the n-th option the worker read for that select (`options(index)`).
 * Older builds' results carried the journal's value in `actions[]` instead; that is used first,
 * matched in order by (action, index).
 */
export function valueOfStep(key, values, options) {
  if (typeof key !== 'string') return undefined
  const dot = key.indexOf('.')
  const group = key.slice(0, dot)
  const name = key.slice(dot + 1)
  if (group === 'request') return values && Object.hasOwn(values, name) ? String(values[name]) : /^\d+$/.test(name) ? Object.values(values ?? {})[Number(name)] : undefined
  if (group === 'profile') return profileValue(name)
  if (group === 'option') return options?.[Number(name)]
  return undefined
}

function valuesFor(steps, actions, values, options) {
  const out = []
  let j = 0
  for (const s of steps) {
    if (!s.ok || (s.op !== 'type' && s.op !== 'select')) {
      out.push(undefined)
      continue
    }
    let v
    while (j < actions.length && !(actions[j].action === s.op && actions[j].index === s.index)) j++
    if (j < actions.length) v = actions[j++].value
    out.push(v ?? valueOfStep(s.key, values, options(s.index)))
  }
  return out
}

/**
 * Every FastSteps call with its executed steps keyed (see the section comment) and its decisions:
 * `[{ i, input, status, reason, message, error, raced, decisions, deciderMs, steps, decided }]`.
 * A call's decisions are the captured requests issued during its model step (from that step's
 * start to the next step's); without trace times, they are taken in order across calls.
 */
export function driverCalls(row) {
  const { tools, states } = toolStates(row)
  const { pairs } = pairDriveRequests(row.driveRequests, row.shadow)
  const starts = [...new Set((row.traceCalls ?? []).map((c) => c.at).filter((x) => x != null))].sort((a, b) => a - b)
  const used = new Set()
  let cursor = 0
  const calls = []
  for (const [i, t] of tools.entries()) {
    if (t.toolName !== 'FastSteps') continue
    const out = t.output && typeof t.output === 'object' ? t.output : {}
    const steps = Array.isArray(out.steps) ? out.steps : []
    const decisions = Number.isFinite(out.decisions) ? out.decisions : 0
    const st = states[i]
    const callAt = st.at
    const end = callAt == null ? Infinity : (starts.find((s) => s > callAt) ?? Infinity)
    // A call that decided nothing (refused, errored before the loop) owns no decisions.
    const mine =
      decisions === 0 && steps.length === 0
        ? []
        : pairs
            .map((p, k) => ({ ...p, k }))
            .filter((p) => !used.has(p.k) && (callAt == null ? p.k >= cursor : p.req.at >= callAt && p.req.at < end))
    for (const p of mine) used.add(p.k)
    if (callAt == null && mine.length) cursor = mine.at(-1).k + 1
    const startUrl = (callAt != null && row.urlTimeline?.length ? urlAt(row.urlTimeline, callAt) : undefined) ?? st.outUrl
    // A select's options, as the worker read them for this call's decisions (captured requests).
    const options = (index) => mine.map((p) => p.req.selectOptions?.[index]).find(Array.isArray)
    const values = valuesFor(steps, Array.isArray(out.actions) ? out.actions : [], t.input?.values ?? {}, options)
    const executed = new Set()
    let next = 0
    // The latest known state, carried forward: from the call's start, or the last captured step.
    let replay = st.registry ? { registry: st.registry, url: startUrl } : null
    const keyed = steps.map((s, j) => {
      let state = null
      for (let k = next; k < mine.length; k++)
        if (sameStep(topOf(mine[k].rec), s)) {
          executed.add(k)
          next = k + 1
          state = { registry: registryOf(mine[k].req.elements), url: mine[k].req.url, method: 'capture' }
          break
        }
      if (!state && replay) state = { ...replay, method: 'replay' }
      const after = state?.registry && state.url ? replayStep(state.registry, s, values[j]) : null
      replay = after ? { registry: after, url: state.url } : null
      const key = state?.registry && state.url ? answerKey(row.task, state.registry, state.url) : []
      const verdict = !state ? 'unscoreable' : !key.length ? 'unkeyed' : matches(s, key) ? 'right' : 'wrong'
      return { ...s, method: state?.method ?? null, url: state?.url ?? null, key, verdict, registry: state?.registry ?? null }
    })
    // Every decision with a captured state, keyed: was its top-1 right, and was it acted on?
    const decided = mine.map((p, k) => {
      const top = topOf(p.rec)
      const registry = registryOf(p.req.elements)
      const key = registry && p.req.url && top ? answerKey(row.task, registry, p.req.url) : []
      return {
        at: p.req.at,
        url: p.req.url,
        top3: p.rec?.top3?.map((o) => ({ op: o.op, ...(o.index !== undefined ? { index: o.index } : {}), p: round2(o.p) })) ?? null,
        skipped: p.rec?.skipped ?? null,
        cancelled: p.cancelled,
        ms: p.rec?.ms ?? null,
        cold: p.rec?.cold ?? null,
        tokens: p.rec?.tokens ?? null,
        executed: executed.has(k),
        key,
        topOk: key.length && top ? matches(top, key) : null,
      }
    })
    calls.push({
      i,
      input: t.input ?? {},
      status: out.status ?? null,
      reason: out.reason ?? null,
      message: out.message ?? null,
      error: out.error ?? (t.output === undefined ? 'no result' : null),
      raced: st.raced,
      decisions,
      deciderMs: Number.isFinite(out.deciderMs) ? out.deciderMs : 0,
      steps: keyed,
      decided,
    })
  }
  return calls
}

/** One row's driver-mode summary (zeros for a row without FastSteps). */
export function driverScore(row) {
  const calls = driverCalls(row)
  const steps = calls.flatMap((c) => c.steps)
  const decided = calls.flatMap((c) => c.decided)
  const count = (xs, f) => xs.reduce((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {})
  const drive = (row.shadow ?? []).filter((r) => r.kind === 'drive')
  const timed = drive.filter((r) => !r.skipped && Number.isFinite(r.ms))
  const stops = decided.filter((d) => !d.executed && d.top3)
  return {
    calls: calls.length,
    // A call is "used" when it reached the loop: the model called it inside a session.
    usedCalls: calls.filter((c) => c.status).length,
    errors: calls.filter((c) => c.error).map((c) => c.error),
    statuses: count(calls.filter((c) => c.status), (c) => `${c.status}/${c.reason}`),
    executed: steps.length,
    executedOk: steps.filter((s) => s.ok).length,
    decisions: calls.reduce((a, c) => a + c.decisions, 0),
    deciderMs: calls.reduce((a, c) => a + c.deciderMs, 0),
    verdicts: count(steps, (s) => s.verdict),
    methods: count(steps.filter((s) => s.method), (s) => s.method),
    captured: (row.driveRequests ?? []).filter((q) => !q.cancel).length,
    driveRecords: drive.length,
    driveSkipped: count(drive.filter((r) => r.skipped), (r) => r.skipped),
    msP50: percentile(timed.map((r) => r.ms), 50),
    msP95: percentile(timed.map((r) => r.ms), 95),
    coldMs: timed.filter((r) => r.cold).map((r) => r.ms),
    ms: timed.map((r) => r.ms),
    // Decision-level: every keyed decision, and the not-executed ones (hand-backs, re-asked repeats).
    decisionsKeyed: decided.filter((d) => d.topOk !== null).length,
    decisionsRight: decided.filter((d) => d.topOk === true).length,
    stopsKeyed: stops.filter((d) => d.topOk !== null).length,
    stopsRight: stops.filter((d) => d.topOk === true).length,
    wrongSteps: steps.filter((s) => s.verdict === 'wrong').map((s) => ({ op: s.op, index: s.index, p: s.p, url: s.url, key: s.key, method: s.method })),
    detail: calls,
  }
}

// ── scoring ───────────────────────────────────────────────────────────────────────────────────
function percentile(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

const emptyGrid = () => ({ both: 0, chatOnly: 0, deciderOnly: 0, neither: 0 })
const norm = (v) => String(v ?? '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

/** Per-field correctness of the form's final values (`window.__fields()`), for assist scoring. */
export function fieldScores(taskId, fields) {
  const want = formTargets(taskId)
  if (!want || !fields) return null
  const out = {}
  for (const [label, w] of Object.entries(want)) {
    const got = fields[label]
    out[label] = { want: w, got: got ?? null, ok: typeof w === 'boolean' ? got === w : norm(got) === norm(w) }
  }
  return out
}

/** Score one raw row: per-step states and keys, the 2×2 grid, decider latency and coverage. */
export function scoreRow(row, threshold = DEFAULT_THRESHOLD) {
  const recording = row.arm !== 'off'
  const steps = controlSteps(row)
  const next = (row.shadow ?? []).filter((r) => r.kind === 'next')
  const fills = (row.shadow ?? []).filter((r) => r.kind === 'fill')
  const { recFor, unpairedRecords } = pairCalls(steps, next)
  const grid = emptyGrid()
  const calib = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: Math.min(1, BUCKETS[i + 1]), n: 0, correct: 0 }))
  let keyed = 0
  let chatRight = 0
  let decKeyed = 0
  let decRight = 0
  let decAtThr = 0
  let decRightAtThr = 0
  const scored = steps.map((s, i) => {
    const rec = recFor[i]
    // highlight / wait change nothing on the page: a highlight of the answer after the task is
    // done is presentation, not a wrong move. Such steps are left unkeyed for both models.
    const neutral = NEUTRAL_OPS.has(s.input.action)
    // A raced call has no single "state before": unkeyed for both models, counted separately.
    const k = !neutral && !s.raced && s.registry && s.url ? answerKey(row.task, s.registry, s.url) : []
    const chat = { op: s.input.action, index: s.input.index }
    const top = rec && !rec.skipped && rec.top3?.length ? rec.top3[0] : null
    const chatOk = k.length ? matches(chat, k) : null
    const decOk = k.length && top ? matches(top, k) : null
    if (k.length) {
      keyed++
      if (chatOk) chatRight++
      if (top) {
        decKeyed++
        if (decOk) decRight++
        if (top.p >= threshold) {
          decAtThr++
          if (decOk) decRightAtThr++
        }
        const b = calib.find((c) => top.p >= c.lo && top.p < (c.hi === 1 ? 1.0001 : c.hi))
        if (b) {
          b.n++
          if (decOk) b.correct++
        }
        grid[chatOk && decOk ? 'both' : chatOk ? 'chatOnly' : decOk ? 'deciderOnly' : 'neither']++
      }
    }
    return {
      i,
      neutral,
      raced: s.raced,
      patched: s.patched,
      url: s.url ?? null,
      urlSource: s.urlSource,
      registry: s.registry,
      key: k,
      chat,
      chatOk,
      error: s.output?.error ?? null,
      decider: rec
        ? { seq: rec.seq, top3: rec.top3, ms: rec.ms, cold: rec.cold, backend: rec.backend, tokens: rec.tokens, agree: rec.agree, wouldAct: rec.wouldAct, skipped: rec.skipped ?? null }
        : null,
      deciderOk: decOk,
    }
  })
  const decided = next.filter((r) => !r.skipped && r.top3?.length)
  const ms = decided.map((r) => r.ms)
  const seqGaps = seqGapsOf(row.shadow ?? [])
  const lonely = steps.filter((s, i) => !recFor[i] && !returnedBeforeHook(s.output))
  const reachedHook = steps.filter((s) => !returnedBeforeHook(s.output)).length
  const agreeable = next.filter((r) => r.agree === true || r.agree === false)
  const autofill = autofillCalls(row.tools)
  const mapped = autofill.flatMap((a) => a.mapped)
  const fields = fieldScores(row.task, row.fields)
  return {
    controlCalls: steps.length,
    raced: steps.filter((s) => s.raced && !NEUTRAL_OPS.has(s.input.action)).length,
    keyed,
    chatCorrect: chatRight,
    decider: {
      records: next.length,
      seqGaps,
      decisions: decided.length,
      skipped: next.filter((r) => r.skipped).reduce((a, r) => ({ ...a, [r.skipped]: (a[r.skipped] ?? 0) + 1 }), {}),
      keyed: decKeyed,
      correct: decRight,
      atThreshold: decAtThr,
      correctAtThreshold: decRightAtThr,
      coverage: decided.length ? decided.filter((r) => r.top3[0].p >= threshold).length / decided.length : null,
      msP50: percentile(ms, 50),
      msP95: percentile(ms, 95),
      coldMsP50: percentile(decided.filter((r) => r.cold).map((r) => r.ms), 50),
      backends: [...new Set(decided.map((r) => r.backend))],
      agreement: agreeable.length ? agreeable.filter((r) => r.agree).length / agreeable.length : null,
      agreeN: agreeable.length,
      agreeYes: agreeable.filter((r) => r.agree).length,
      fillRecords: fills.length,
      fills: fills.flatMap((r) => (r.fill ?? []).map((f) => ({ key: f.key, p: f.p, llmAgrees: f.llmAgrees }))),
    },
    grid,
    calibration: calib,
    // The `off` arm records nothing by design, so nothing there is "unpaired"; nor is a call that
    // returned before the hook.
    unpaired: recording ? { calls: lonely.length, records: unpairedRecords.length } : { calls: 0, records: 0 },
    unpairedCallErrors: recording ? lonely.map((s) => s.output?.error ?? s.output?.message ?? null) : [],
    beforeHookCalls: recording ? steps.filter((s, i) => !recFor[i] && returnedBeforeHook(s.output)).length : 0,
    reachedHookCalls: reachedHook,
    // The silent failure this harness exists to catch (a stale service worker, a decider that
    // never became ready): page steps reached the decider path and not one record was written.
    missingShadow: recording && reachedHook > 0 && (row.shadow ?? []).length === 0,
    fields,
    fieldAccuracy: fields ? Object.values(fields).filter((f) => f.ok).length / Object.keys(fields).length : null,
    autofill,
    assistUsed: autofill.some((a) => a.withoutFields && !a.error),
    mapped,
    // Page actions the chat model took itself (a ControlPage that reached the page, not
    // highlight/wait), beside FastSteps' executed steps.
    chatActions: steps.filter((s) => !NEUTRAL_OPS.has(s.input.action) && !returnedBeforeHook(s.output)).length,
    driver: driverScore(row),
    steps: scored,
  }
}

/**
 * Each AutofillForm call: whether it left `fields` out (the assist path, where the decider maps
 * the form), the names of the `values` it passed, and what its result reported (mapped keys,
 * left reasons, how many fields were filled, an error).
 */
export function autofillCalls(tools) {
  return (tools ?? [])
    .filter((t) => t.toolName === 'AutofillForm')
    .map((t) => {
      const out = t.output && typeof t.output === 'object' ? t.output : {}
      return {
        withoutFields: !Array.isArray(t.input?.fields),
        values: Object.keys(t.input?.values ?? {}),
        mapped: Array.isArray(out.mapped) ? out.mapped.map((m) => m.key) : [],
        left: Array.isArray(out.left) ? out.left.map((l) => ({ index: l.index, reason: l.reason })) : [],
        filled: Array.isArray(out.filled) ? out.filled.length : typeof out.filled === 'number' ? out.filled : 0,
        error: out.error ?? (t.output === undefined ? 'no result' : null),
      }
    })
}

// ── aggregation ───────────────────────────────────────────────────────────────────────────────
function aggregate(rows) {
  const grid = emptyGrid()
  const calib = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: Math.min(1, BUCKETS[i + 1]), n: 0, correct: 0 }))
  const ms = []
  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
  for (const r of rows) {
    for (const k of Object.keys(grid)) grid[k] += r.score.grid[k]
    r.score.calibration.forEach((b, i) => {
      calib[i].n += b.n
      calib[i].correct += b.correct
    })
    for (const s of r.score.steps) if (s.decider && !s.decider.skipped && s.decider.top3?.length) ms.push(s.decider.ms)
  }
  const keyed = sum((r) => r.score.keyed)
  const decKeyed = sum((r) => r.score.decider.keyed)
  const atThr = sum((r) => r.score.decider.atThreshold)
  const decisions = sum((r) => r.score.decider.decisions)
  const covered = rows.reduce((a, r) => a + (r.score.decider.coverage ?? 0) * r.score.decider.decisions, 0)
  const agreeN = sum((r) => r.score.decider.agreeN)
  const merge = (f) => rows.reduce((a, r) => {
    for (const [k, v] of Object.entries(f(r) ?? {})) a[k] = (a[k] ?? 0) + v
    return a
  }, {})
  const dv = (r) => r.score.driver ?? {}
  return {
    runs: rows.length,
    success: rows.filter((r) => r.success).length,
    wallMsP50: percentile(rows.map((r) => r.wallMs), 50),
    wallMsMean: rows.length ? Math.round(sum((r) => r.wallMs) / rows.length) : null,
    llmStepsP50: percentile(rows.map((r) => r.llmSteps), 50),
    inputTokensP50: percentile(rows.map((r) => r.inputTokens), 50),
    outputTokensP50: percentile(rows.map((r) => r.outputTokens), 50),
    chatActions: sum((r) => r.score.chatActions),
    driver: {
      rowsUsing: rows.filter((r) => dv(r).usedCalls > 0).length,
      calls: sum((r) => dv(r).calls),
      usedCalls: sum((r) => dv(r).usedCalls),
      errors: rows.flatMap((r) => dv(r).errors ?? []),
      statuses: merge((r) => dv(r).statuses),
      executed: sum((r) => dv(r).executed),
      executedOk: sum((r) => dv(r).executedOk),
      decisions: sum((r) => dv(r).decisions),
      verdicts: merge((r) => dv(r).verdicts),
      methods: merge((r) => dv(r).methods),
      decisionsKeyed: sum((r) => dv(r).decisionsKeyed),
      decisionsRight: sum((r) => dv(r).decisionsRight),
      stopsKeyed: sum((r) => dv(r).stopsKeyed),
      stopsRight: sum((r) => dv(r).stopsRight),
      msP50: percentile(rows.flatMap((r) => dv(r).ms ?? []), 50),
      msP95: percentile(rows.flatMap((r) => dv(r).ms ?? []), 95),
      driveSkipped: merge((r) => dv(r).driveSkipped),
    },
    llmSteps: sum((r) => r.llmSteps),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    costHigh: +sum((r) => r.cost?.high).toFixed(4),
    costLow: +sum((r) => r.cost?.low).toFixed(4),
    controlCalls: sum((r) => r.score.controlCalls),
    raced: sum((r) => r.score.raced),
    keyed,
    chatCorrect: sum((r) => r.score.chatCorrect),
    deciderKeyed: decKeyed,
    deciderCorrect: sum((r) => r.score.decider.correct),
    deciderAtThreshold: atThr,
    deciderCorrectAtThreshold: sum((r) => r.score.decider.correctAtThreshold),
    decisions,
    coverage: decisions ? covered / decisions : null,
    agreement: agreeN ? sum((r) => r.score.decider.agreeYes) / agreeN : null,
    msP50: percentile(ms, 50),
    msP95: percentile(ms, 95),
    unpairedCalls: sum((r) => r.score.unpaired.calls),
    unpairedRecords: sum((r) => r.score.unpaired.records),
    grid,
    calibration: calib,
  }
}

/** Per arm, and per arm × task family. */
export function summarize(rows) {
  const arms = [...new Set(rows.map((r) => r.arm))]
  const byArm = {}
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm)
    const families = [...new Set(mine.map((r) => r.family))]
    byArm[arm] = { overall: aggregate(mine), byFamily: Object.fromEntries(families.map((f) => [f, aggregate(mine.filter((r) => r.family === f))])) }
  }
  return byArm
}

/**
 * The run in one line, per arm: decider accuracy vs the key at p ≥ threshold, chat accuracy vs
 * the key, coverage, and decider ms p50/p95.
 */
export function summaryLine(summary, threshold = DEFAULT_THRESHOLD) {
  const p = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : '—')
  const parts = Object.entries(summary).map(([arm, { overall: o }]) => {
    const dec = arm === 'off' ? 'decider off' : `decider@p≥${threshold} ${p(o.deciderCorrectAtThreshold, o.deciderAtThreshold)}`
    const cov = o.coverage === null ? '—' : `${Math.round(100 * o.coverage)}%`
    const d = o.driver
    const drv =
      arm === 'driver'
        ? `; FastSteps in ${d.rowsUsing}/${o.runs} tasks, ${d.executed} steps, wrong ${d.verdicts.wrong ?? 0}/${(d.verdicts.wrong ?? 0) + (d.verdicts.right ?? 0)} keyed, drive ms p50/p95 ${d.msP50 ?? '—'}/${d.msP95 ?? '—'}`
        : ''
    return `${arm}: success ${p(o.success, o.runs)}, ${dec}, chat ${p(o.chatCorrect, o.keyed)}, coverage ${cov}, decider ms p50/p95 ${o.msP50 ?? '—'}/${o.msP95 ?? '—'}${drv}`
  })
  return `summary — ${parts.join(' · ') || 'no rows'}`
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : '—')
const frac = (x) => (x === null || x === undefined ? '—' : `${Math.round(100 * x)}%`)
const num = (x) => (x === null || x === undefined ? '—' : String(x))
const usd = (x) => `$${(x ?? 0).toFixed(3)}`
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderMarkdown(results) {
  const { meta, rows, summary } = results
  const L = []
  L.push(`# Decider eval — ${meta.startedAt}`, '')
  L.push(`- Provider: **${meta.provider}** \`${meta.model}\`; arms: ${meta.arms.join(', ')}; reps: ${meta.reps}; threshold: ${meta.threshold}`)
  L.push(`- Spend (upper estimate): **${usd(meta.spent)}** of a ${usd(meta.cap)} cap${meta.capReached ? ' — **cap reached**, remaining tasks not run' : ''}`)
  if (meta.interrupted) L.push('- **Interrupted** before the task list finished.')
  if (meta.fatal) L.push(`- **Stopped by a harness error:** ${cell(String(meta.fatal).split('\n')[0])}`)
  if (meta.skipped?.length) L.push(`- Not run: ${meta.skipped.map((s) => `${s.task}/${s.arm} (${s.reason})`).join(', ')}`)
  L.push(`- Decider model: ${meta.deciderModel ?? '—'}`, '')

  L.push('## Summary by arm', '')
  L.push('| arm | runs | success | wall p50 s | chat steps | tokens in / out | cost (est.) | ControlPage | raced | keyed | chat acc | decider acc | decider acc @thr | coverage @thr | agreement | decider ms p50 / p95 | unpaired calls / records |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [arm, { overall: o }] of Object.entries(summary)) {
    L.push(
      `| ${arm} | ${o.runs} | ${pct(o.success, o.runs)} | ${o.wallMsP50 === null ? '—' : Math.round(o.wallMsP50 / 1000)} | ${o.llmSteps} | ${o.inputTokens} / ${o.outputTokens} | ${usd(o.costLow)}–${usd(o.costHigh)} | ${o.controlCalls} | ${o.raced} | ${o.keyed} | ${pct(o.chatCorrect, o.keyed)} | ${pct(o.deciderCorrect, o.deciderKeyed)} | ${pct(o.deciderCorrectAtThreshold, o.deciderAtThreshold)} | ${frac(o.coverage)} | ${frac(o.agreement)} | ${num(o.msP50)} / ${num(o.msP95)} | ${o.unpairedCalls} / ${o.unpairedRecords} |`,
    )
  }
  L.push('')

  L.push('## Decider vs chat model on keyed steps (2×2)', '')
  L.push('| arm | family | both right | chat only | decider only | both wrong | n |')
  L.push('|---|---|---|---|---|---|---|')
  for (const [arm, s] of Object.entries(summary)) {
    for (const [fam, a] of [['**all**', s.overall], ...Object.entries(s.byFamily)]) {
      const g = a.grid
      const n = g.both + g.chatOnly + g.deciderOnly + g.neither
      if (n || fam === '**all**') L.push(`| ${arm} | ${fam} | ${g.both} | ${g.chatOnly} | ${g.deciderOnly} | ${g.neither} | ${n} |`)
    }
  }
  L.push('')

  L.push('## Calibration (decider top-1 confidence vs. accuracy, keyed steps)', '')
  L.push('| arm | p bucket | n | decider acc |')
  L.push('|---|---|---|---|')
  for (const [arm, { overall: o }] of Object.entries(summary))
    for (const b of o.calibration) L.push(`| ${arm} | ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${pct(b.correct, b.n)} |`)
  L.push('')

  L.push('## Per task', '')
  L.push('| task | arm | rep | ok | ended | wall s | chat steps | tokens in / out | cost | ControlPage | raced | keyed | chat ✓ | decider ✓ | both / chat / dec / neither | agreement | decisions | ms p50 / p95 | coverage | unpaired |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const s = r.score
    const d = s.decider
    const g = s.grid
    L.push(
      `| ${r.task} | ${r.arm} | ${r.rep} | ${r.success ? '✓' : '✗'} | ${r.ended} | ${Math.round(r.wallMs / 1000)} | ${r.llmSteps} | ${r.inputTokens} / ${r.outputTokens} | ${usd(r.cost?.high)}${r.cost?.estimated === 'reserve' ? ' (reserve)' : ''} | ${s.controlCalls} | ${s.raced} | ${s.keyed} | ${s.chatCorrect} | ${d.correct}/${d.keyed} | ${g.both} / ${g.chatOnly} / ${g.deciderOnly} / ${g.neither} | ${frac(d.agreement)} | ${d.decisions}${Object.keys(d.skipped).length ? ` (skipped ${JSON.stringify(d.skipped)})` : ''} | ${num(d.msP50)} / ${num(d.msP95)} | ${frac(d.coverage)} | ${s.unpaired.calls} / ${s.unpaired.records} |`,
    )
  }
  L.push('')

  L.push(...renderDriver(results))

  const assist = rows.filter((r) => r.score.fields)
  if (assist.length) {
    L.push('## Form fields (final values from `window.__fields()`)', '')
    L.push('| task | arm | rep | field accuracy | wrong fields | AutofillForm mapped keys | decider fill records |')
    L.push('|---|---|---|---|---|---|---|')
    for (const r of assist) {
      const wrong = Object.entries(r.score.fields)
        .filter(([, f]) => !f.ok)
        .map(([label, f]) => `${label}: got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`)
      L.push(`| ${r.task} | ${r.arm} | ${r.rep} | ${frac(r.score.fieldAccuracy)} | ${cell(wrong.join('; ') || '—')} | ${cell(r.score.mapped.join(', ') || '—')} | ${r.score.decider.fillRecords} |`)
    }
    L.push('')
  }

  const assistRows = rows.filter((r) => r.arm === 'assist')
  if (assistRows.length) {
    L.push('## Assist: AutofillForm calls', '')
    L.push('| task | rep | AutofillForm without fields | calls | values passed | mapped keys | left (index: reason) | filled | errors |')
    L.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of assistRows) {
      const a = r.score.autofill ?? []
      const all = (f) => a.flatMap(f)
      L.push(
        `| ${r.task} | ${r.rep} | ${r.score.assistUsed ? 'yes' : a.some((x) => x.withoutFields) ? 'tried (error)' : '**no**'} | ${a.length} | ${cell(all((x) => x.values).join(', ') || '—')} | ${cell(all((x) => x.mapped).join(', ') || '—')} | ${cell(all((x) => x.left.map((l) => `${l.index}: ${l.reason}`)).join(', ') || '—')} | ${a.reduce((s, x) => s + x.filled, 0)} | ${cell(all((x) => (x.error ? [x.error] : [])).join('; ') || '—')} |`,
      )
    }
    L.push('')
  }

  const misses = rows.flatMap((r) =>
    r.score.steps
      .filter((s) => s.key.length && (s.chatOk === false || s.deciderOk === false))
      .map((s) => ({ r, s })),
  )
  if (misses.length) {
    L.push('## Keyed steps where either model was wrong', '')
    L.push('| task | arm | rep | step | url | key | chat | decider top-1 (p) |')
    L.push('|---|---|---|---|---|---|---|---|')
    const fmt = (a) => (a ? `${a.op}${a.index === undefined ? '' : ` ${a.index}`}` : '—')
    for (const { r, s } of misses) {
      const top = s.decider?.top3?.[0]
      L.push(
        `| ${r.task} | ${r.arm} | ${r.rep} | ${s.i} | ${cell((s.url ?? '').replace(/^https?:\/\/[^/]+/, ''))} | ${cell(s.key.map(fmt).join(', '))} | ${fmt(s.chat)}${s.chatOk ? ' ✓' : ' ✗'} | ${top ? `${fmt(top)} (${top.p.toFixed(2)})${s.deciderOk ? ' ✓' : ' ✗'}` : '—'} |`,
      )
    }
    L.push('')
  }

  const unp = rows.filter((r) => r.score.unpaired.calls || r.score.unpaired.records)
  if (unp.length) {
    L.push('## Unpaired', '')
    for (const r of unp)
      L.push(
        `- ${r.task}/${r.arm}/${r.rep}: ${r.score.unpaired.calls} call(s) without a record (${cell(r.score.unpairedCallErrors.map((e) => e ?? 'no error').join('; '))}), ` +
          `${r.score.unpaired.records} record(s) without a call, ${r.score.decider.seqGaps} seq gap(s) (decisions superseded under dropIfBusy); ` +
          `${r.score.beforeHookCalls} more call(s) returned before the hook (not counted)`,
      )
    L.push('')
  }

  const broken = rows.filter((r) => r.ended === 'harness-error')
  if (broken.length) {
    L.push('## Harness errors', '')
    for (const r of broken) L.push(`- **${r.task}/${r.arm}/${r.rep}: ${cell(r.error ?? 'harness error')}**${r.success ? ' (the task itself succeeded)' : ''}`)
    L.push('')
  }

  const failed = rows.filter((r) => !r.success)
  if (failed.length) {
    L.push('## Failed tasks', '')
    for (const r of failed) L.push(`- ${r.task}/${r.arm}/${r.rep} (${r.ended}${r.error ? `, ${cell(r.error)}` : ''}): final URL ${cell(r.finalUrl)}; reply: ${cell((r.reply ?? '').slice(0, 300)) || '—'}`)
    L.push('')
  }
  return L.join('\n')
}

const sec = (ms) => (ms === null || ms === undefined ? '—' : String(Math.round(ms / 1000)))
const tally = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'
const fmtAct = (a) => (a ? `${a.op}${a.index === undefined || a.index === null ? '' : ` ${a.index}`}` : '—')

/** The driver-mode sections: only when a row ran in driver mode. */
export function renderDriver(results) {
  const { rows, summary } = results
  const drows = rows.filter((r) => r.arm === 'driver')
  if (!drows.length) return []
  const L = []
  L.push('## Driver mode: FastSteps', '')
  L.push('Executed steps are keyed against the state their decision saw (`capture`), else replayed from the chat model\'s last registry (`replay`); see report.mjs.', '')
  L.push('| arm | runs | FastSteps used (tasks) | calls (reached the loop) | statuses | executed steps (ok) | chat page actions | decisions | right / wrong / unkeyed / unscoreable | method | all decisions top-1 right | hand-back top-1 right | drive ms p50 / p95 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [arm, { overall: o }] of Object.entries(summary)) {
    if (arm !== 'driver') continue
    const d = o.driver
    const v = d.verdicts
    L.push(
      `| ${arm} | ${o.runs} | ${d.rowsUsing}/${o.runs} | ${d.calls} (${d.usedCalls}) | ${cell(tally(d.statuses))} | ${d.executed} (${d.executedOk}) | ${o.chatActions} | ${d.decisions} | ${v.right ?? 0} / ${v.wrong ?? 0} / ${v.unkeyed ?? 0} / ${v.unscoreable ?? 0} | ${cell(tally(d.methods))} | ${pct(d.decisionsRight, d.decisionsKeyed)} | ${pct(d.stopsRight, d.stopsKeyed)} | ${num(d.msP50)} / ${num(d.msP95)} |`,
    )
  }
  L.push('')

  if (summary.off && summary.driver) {
    L.push('## Driver vs off, by task family', '')
    L.push('| family | success off → driver | wall p50 s off → driver | chat steps p50 off → driver | chat steps total | tokens in p50 off → driver | tokens in / out total off → driver | FastSteps used |')
    L.push('|---|---|---|---|---|---|---|---|')
    const fams = ['**all**', ...Object.keys(summary.driver.byFamily)]
    for (const f of fams) {
      const a = f === '**all**' ? summary.off.overall : summary.off.byFamily[f]
      const b = f === '**all**' ? summary.driver.overall : summary.driver.byFamily[f]
      if (!a || !b) continue
      L.push(
        `| ${f} | ${a.success}/${a.runs} → ${b.success}/${b.runs} | ${sec(a.wallMsP50)} → ${sec(b.wallMsP50)} | ${num(a.llmStepsP50)} → ${num(b.llmStepsP50)} | ${a.llmSteps} → ${b.llmSteps} | ${num(a.inputTokensP50)} → ${num(b.inputTokensP50)} | ${a.inputTokens} / ${a.outputTokens} → ${b.inputTokens} / ${b.outputTokens} | ${b.driver.rowsUsing}/${b.runs} |`,
      )
    }
    L.push('')
  }

  L.push('## Driver: per task', '')
  L.push('| task | rep | ok | wall s | chat steps | tokens in / out | FastSteps calls | statuses (reason) | steps executed | chat page actions | decisions | drive ms p50 / p95 | right / wrong / unkeyed / unscoreable | errors |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of drows) {
    const d = r.score.driver
    const v = d.verdicts
    L.push(
      `| ${r.task} | ${r.rep} | ${r.success ? '✓' : '✗'} | ${sec(r.wallMs)} | ${r.llmSteps} | ${r.inputTokens} / ${r.outputTokens} | ${d.calls} | ${cell(tally(d.statuses))} | ${d.executed} | ${r.score.chatActions} | ${d.decisions} | ${num(d.msP50)} / ${num(d.msP95)} | ${v.right ?? 0} / ${v.wrong ?? 0} / ${v.unkeyed ?? 0} / ${v.unscoreable ?? 0} | ${cell(d.errors.join('; ') || '—')} |`,
    )
  }
  L.push('')

  const calls = drows.flatMap((r) => r.score.driver.detail.filter((c) => c.status || c.error).map((c) => ({ r, c })))
  if (calls.length) {
    L.push('## Driver: FastSteps calls', '')
    L.push('| task | rep | goal | executed (p, verdict) | ended | last decision |')
    L.push('|---|---|---|---|---|---|')
    for (const { r, c } of calls) {
      const exec = c.steps.map((s) => `${fmtAct(s)} (${s.p}${s.ok ? '' : ', refused'}, ${s.verdict})`).join(' → ') || '—'
      const last = c.decided.filter((d) => !d.executed).at(-1)
      const lastTxt = last?.top3 ? `${fmtAct(last.top3[0])} ${last.top3[0].p}${last.topOk === null ? '' : last.topOk ? ' ✓' : ' ✗'}` : last?.skipped ? `skipped (${last.skipped})` : '—'
      L.push(`| ${r.task} | ${r.rep} | ${cell(c.input.goal ?? '')} | ${cell(exec)} | ${cell(c.error ? `error: ${c.error}` : `${c.status}/${c.reason}${c.message ? `: ${c.message}` : ''}`)} | ${cell(lastTxt)} |`)
    }
    L.push('')
  }

  const wrong = drows.flatMap((r) => r.score.driver.wrongSteps.map((s) => ({ r, s })))
  if (wrong.length) {
    L.push('## Driver: wrong executed steps', '')
    L.push('| task | rep | url | step (p) | key | method |')
    L.push('|---|---|---|---|---|---|')
    for (const { r, s } of wrong)
      L.push(`| ${r.task} | ${r.rep} | ${cell((s.url ?? '').replace(/^https?:\/\/[^/]+/, ''))} | ${fmtAct(s)} (${s.p}) | ${cell(s.key.map(fmtAct).join(', '))} | ${s.method} |`)
    L.push('')
  }
  return L
}

/** Writes out/<ISO-time>/{results.json,report.md} under `outRoot`; returns the directory. */
export function writeReport(results, outRoot) {
  const dir = join(outRoot, results.meta.startedAt.replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 1))
  writeFileSync(join(dir, 'report.md'), renderMarkdown(results))
  return dir
}
