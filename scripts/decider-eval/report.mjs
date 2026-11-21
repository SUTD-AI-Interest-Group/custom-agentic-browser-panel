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
 * Pair ControlPage calls (conversation order) with `kind: 'next'` shadow records (seq order).
 * Every call that reached the decider hook has exactly one record, written from that call's own
 * spec, so the pairing is the longest order-preserving match on (op, index). A call that returned
 * before the hook (no session yet, tab not in front) has none; on a tie the LATER call is paired,
 * since the early-returned attempt is the one the model then repeats.
 * @returns {{ recFor: (object|null)[], unpairedRecords: object[] }}
 */
export function pairCalls(calls, records) {
  const recs = [...records].sort((a, b) => a.seq - b.seq || a.at - b.at)
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

/**
 * The ControlPage calls with the state each one was made in: `registry` from the latest earlier
 * tool output carrying one, `url` from the URL timeline at the start of the model step that made
 * the call (trace order ↔ conversation order), else from the latest earlier output's `url`.
 */
export function controlSteps(row) {
  const calls = []
  let registry = null
  let outUrl = row.startUrl
  for (const t of row.tools ?? []) {
    if (t.toolName === 'ControlPage') calls.push({ input: t.input ?? {}, output: t.output, registry, outUrl })
    const out = t.output && typeof t.output === 'object' ? t.output : null
    if (hasRegistry(out)) registry = out.elements
    if (out && typeof out.url === 'string') outUrl = out.url
  }
  const times = (row.traceCalls ?? []).filter((c) => c.name === 'ControlPage').map((c) => c.at)
  const aligned = times.length === calls.length && (row.urlTimeline?.length ?? 0) > 0
  return calls.map((c, i) => ({
    ...c,
    url: (aligned ? urlAt(row.urlTimeline, times[i]) : undefined) ?? c.outUrl,
    urlSource: aligned ? 'timeline' : 'outputs',
  }))
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
    const k = !neutral && s.registry && s.url ? answerKey(row.task, s.registry, s.url) : []
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
  // The hooks number every step they are handed (from 0) before deciding, and write nothing for
  // a decision superseded under dropIfBusy, so a missing seq is a dropped step. (A drop after the
  // last record is invisible here; it shows up as an unpaired call instead.)
  const seqs = new Set((row.shadow ?? []).map((r) => r.seq).filter(Number.isInteger))
  const seqGaps = seqs.size ? Math.max(...seqs) + 1 - seqs.size : 0
  const lonely = steps.filter((s, i) => !recFor[i] && !returnedBeforeHook(s.output))
  const agreeable = next.filter((r) => r.agree === true || r.agree === false)
  const mapped = (row.tools ?? [])
    .filter((t) => t.toolName === 'AutofillForm' && Array.isArray(t.output?.mapped))
    .flatMap((t) => t.output.mapped.map((m) => m.key))
  const fields = fieldScores(row.task, row.fields)
  return {
    controlCalls: steps.length,
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
    fields,
    fieldAccuracy: fields ? Object.values(fields).filter((f) => f.ok).length / Object.keys(fields).length : null,
    mapped,
    steps: scored,
  }
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
  return {
    runs: rows.length,
    success: rows.filter((r) => r.success).length,
    wallMsP50: percentile(rows.map((r) => r.wallMs), 50),
    llmSteps: sum((r) => r.llmSteps),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    costHigh: +sum((r) => r.cost?.high).toFixed(4),
    costLow: +sum((r) => r.cost?.low).toFixed(4),
    controlCalls: sum((r) => r.score.controlCalls),
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
  L.push('| arm | runs | success | wall p50 s | chat steps | tokens in / out | cost (est.) | ControlPage | keyed | chat acc | decider acc | decider acc @thr | coverage @thr | agreement | decider ms p50 / p95 | unpaired calls / records |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [arm, { overall: o }] of Object.entries(summary)) {
    L.push(
      `| ${arm} | ${o.runs} | ${pct(o.success, o.runs)} | ${o.wallMsP50 === null ? '—' : Math.round(o.wallMsP50 / 1000)} | ${o.llmSteps} | ${o.inputTokens} / ${o.outputTokens} | ${usd(o.costLow)}–${usd(o.costHigh)} | ${o.controlCalls} | ${o.keyed} | ${pct(o.chatCorrect, o.keyed)} | ${pct(o.deciderCorrect, o.deciderKeyed)} | ${pct(o.deciderCorrectAtThreshold, o.deciderAtThreshold)} | ${frac(o.coverage)} | ${frac(o.agreement)} | ${num(o.msP50)} / ${num(o.msP95)} | ${o.unpairedCalls} / ${o.unpairedRecords} |`,
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
  L.push('| task | arm | rep | ok | ended | wall s | chat steps | tokens in / out | cost | ControlPage | keyed | chat ✓ | decider ✓ | both / chat / dec / neither | agreement | decisions | ms p50 / p95 | coverage | unpaired |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const s = r.score
    const d = s.decider
    const g = s.grid
    L.push(
      `| ${r.task} | ${r.arm} | ${r.rep} | ${r.success ? '✓' : '✗'} | ${r.ended} | ${Math.round(r.wallMs / 1000)} | ${r.llmSteps} | ${r.inputTokens} / ${r.outputTokens} | ${usd(r.cost?.high)}${r.cost?.estimated === 'reserve' ? ' (reserve)' : ''} | ${s.controlCalls} | ${s.keyed} | ${s.chatCorrect} | ${d.correct}/${d.keyed} | ${g.both} / ${g.chatOnly} / ${g.deciderOnly} / ${g.neither} | ${frac(d.agreement)} | ${d.decisions}${Object.keys(d.skipped).length ? ` (skipped ${JSON.stringify(d.skipped)})` : ''} | ${num(d.msP50)} / ${num(d.msP95)} | ${frac(d.coverage)} | ${s.unpaired.calls} / ${s.unpaired.records} |`,
    )
  }
  L.push('')

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

  const failed = rows.filter((r) => !r.success)
  if (failed.length) {
    L.push('## Failed tasks', '')
    for (const r of failed) L.push(`- ${r.task}/${r.arm}/${r.rep} (${r.ended}${r.error ? `, ${cell(r.error)}` : ''}): final URL ${cell(r.finalUrl)}; reply: ${cell((r.reply ?? '').slice(0, 300)) || '—'}`)
    L.push('')
  }
  return L.join('\n')
}

/** Writes out/<ISO-time>/{results.json,report.md} under `outRoot`; returns the directory. */
export function writeReport(results, outRoot) {
  const dir = join(outRoot, results.meta.startedAt.replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 1))
  writeFileSync(join(dir, 'report.md'), renderMarkdown(results))
  return dir
}
