// Pairing, step states, cost and the 2×2: node --test scripts/decider-eval/report.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  autofillCalls, controlSteps, estimateCost, pairCalls, renderMarkdown, RESERVE_USD, scoreRow, seqGapsOf, summarize, summaryLine, taskCost, urlAt, usageOf,
} from './report.mjs'

const BASE = 'http://127.0.0.1:8770'
const call = (action, index) => ({ input: index === undefined ? { action } : { action, index } })
const rec = (seq, op, index, top, p = 0.9, extra = {}) => ({
  kind: 'next', seq, at: 1000 + seq, ms: 100 + seq, cold: seq === 0, backend: 'webgpu', tokens: 500,
  llm: index === undefined ? { op } : { op, index },
  top3: [{ ...top, p }], agree: top.op === op && top.index === index, wouldAct: p >= 0.6, ...extra,
})

test('pairCalls: one record per call that reached the hook, in order', () => {
  const calls = [call('type', 3), call('type', 4), call('click', 8)]
  const { recFor, unpairedRecords } = pairCalls(calls, [rec(2, 'click', 8, { op: 'click', index: 8 }), rec(0, 'type', 3, { op: 'type', index: 3 }), rec(1, 'type', 4, { op: 'type', index: 4 })])
  assert.deepEqual(recFor.map((r) => r.seq), [0, 1, 2])
  assert.equal(unpairedRecords.length, 0)
})

test('pairCalls: an early-returned call (no session yet) stays unpaired; its repeat gets the record', () => {
  const calls = [call('type', 3), call('type', 3), call('type', 4)]
  const { recFor } = pairCalls(calls, [rec(0, 'type', 3, { op: 'type', index: 3 }), rec(1, 'type', 4, { op: 'type', index: 4 })])
  assert.equal(recFor[0], null)
  assert.equal(recFor[1].seq, 0)
  assert.equal(recFor[2].seq, 1)
})

test('pairCalls: a record whose call is missing is reported', () => {
  const { recFor, unpairedRecords } = pairCalls([call('click', 1)], [rec(0, 'click', 1, { op: 'click', index: 1 }), rec(1, 'click', 9, { op: 'click', index: 9 })])
  assert.equal(recFor[0].seq, 0)
  assert.deepEqual(unpairedRecords.map((r) => r.seq), [1])
})

test('pairCalls / seqGapsOf: seq restarts per continuation chain, so records are ordered by `at`', () => {
  // Chain 1 handed seqs 0, 1, 2 (1 superseded); chain 2 restarted at 0 and handed 0, 1.
  const records = [
    rec(0, 'type', 3, { op: 'type', index: 3 }, 0.9, { at: 100 }),
    rec(2, 'select', 6, { op: 'select', index: 6 }, 0.9, { at: 300 }),
    rec(0, 'type', 7, { op: 'type', index: 7 }, 0.9, { at: 400 }),
    rec(1, 'click', 8, { op: 'click', index: 8 }, 0.9, { at: 500 }),
  ]
  const calls = [call('type', 3), call('type', 4), call('select', 6), call('type', 7), call('click', 8)]
  const { recFor, unpairedRecords } = pairCalls(calls, records)
  assert.deepEqual(recFor.map((r) => r?.at ?? null), [100, null, 300, 400, 500])
  assert.equal(unpairedRecords.length, 0)
  assert.equal(seqGapsOf(records), 1)
  assert.equal(seqGapsOf([...records, rec(3, 'click', 10, { op: 'click', index: 10 }, 0.9, { at: 600 })]), 2) // chain 2: 0, 1, _, 3
  assert.equal(seqGapsOf([]), 0)
})

test('urlAt: the last navigation at or before t', () => {
  const tl = [{ at: 10, url: 'a' }, { at: 20, url: 'b' }, { at: 30, url: 'c' }]
  assert.equal(urlAt(tl, 5), undefined)
  assert.equal(urlAt(tl, 20), 'b')
  assert.equal(urlAt(tl, 29), 'b')
  assert.equal(urlAt(tl, 99), 'c')
})

test('controlSteps: registry from the latest earlier output, URL from the timeline at the step start', () => {
  const row = {
    startUrl: `${BASE}/help/index.html`,
    tools: [
      { toolName: 'ReadPage', input: {}, output: { url: `${BASE}/help/index.html`, elements: '[5]<a> "Orders, payments & returns"' } },
      { toolName: 'ControlPage', input: { action: 'click', index: 5 }, output: { ok: true, elements: '[6]<a> "Returns & refunds policy"' } },
      { toolName: 'ControlPage', input: { action: 'click', index: 6 }, output: { ok: true, elements: '(could not re-read the page)' } },
    ],
    traceCalls: [{ name: 'ControlPage', at: 100 }, { name: 'ControlPage', at: 200 }],
    urlTimeline: [{ at: 1, url: `${BASE}/help/index.html` }, { at: 150, url: `${BASE}/help/orders.html` }, { at: 250, url: `${BASE}/help/returns.html` }],
  }
  const s = controlSteps(row)
  assert.equal(s[0].registry, '[5]<a> "Orders, payments & returns"')
  assert.equal(s[0].url, `${BASE}/help/index.html`)
  assert.equal(s[1].registry, '[6]<a> "Returns & refunds policy"')
  assert.equal(s[1].url, `${BASE}/help/orders.html`)
  assert.equal(s[1].urlSource, 'timeline')
  // Trace and conversation disagree on the count → fall back to output URLs.
  const fallback = controlSteps({ ...row, traceCalls: [{ name: 'ControlPage', at: 100 }] })
  assert.equal(fallback[1].url, `${BASE}/help/index.html`)
  assert.equal(fallback[1].urlSource, 'outputs')
})

test('estimateCost: $0 locally; the high bound charges uncached input at 1.25×', () => {
  assert.deepEqual(estimateCost({ inputTokens: 1e6, outputTokens: 1e6 }, 'lmstudio'), { low: 0, high: 0 })
  // 108k in (38k cached), 1.5k out — the spike's measured Sonnet form run.
  const c = estimateCost({ inputTokens: 108_000, cachedInputTokens: 38_000, outputTokens: 1_500 }, 'anthropic')
  assert.equal(c.low, 0.1588)
  assert.equal(c.high, 0.1938)
})

test('taskCost: trace usage when readable; the $0.50 reserve when a sent prompt left none', () => {
  const steps = [{ usage: { inputTokens: 60_000, cachedInputTokens: 20_000, outputTokens: 1_000 } }, { usage: { inputTokens: 48_000, cachedInputTokens: 18_000, outputTokens: 500 } }]
  assert.deepEqual(taskCost(steps, { providerKind: 'anthropic', sent: true }), { low: 0.1588, high: 0.1938, estimated: 'trace' })
  // The run threw / the browser died / a stopped turn wrote no trace: spend unknown → reserve.
  for (const unreadable of [null, []]) assert.deepEqual(taskCost(unreadable, { providerKind: 'anthropic', sent: true }), { low: 0, high: RESERVE_USD, estimated: 'reserve' })
  assert.equal(RESERVE_USD, 0.5)
  // Nothing went out, or the model is local: nothing to charge.
  assert.deepEqual(taskCost(null, { providerKind: 'anthropic', sent: false }), { low: 0, high: 0, estimated: 'not-sent' })
  assert.deepEqual(taskCost(null, { providerKind: 'lmstudio', sent: true }), { low: 0, high: 0, estimated: 'local' })
  assert.deepEqual(usageOf(steps), { inputTokens: 108_000, outputTokens: 1_500, cachedInputTokens: 38_000 })
})

test('a reserve-charged row renders its cost as a reserve', () => {
  const row = {
    task: 'shop-mug', family: 'store', arm: 'shadow', rep: 1, success: false, ended: 'harness-error', error: 'boom', wallMs: 1000, llmSteps: 0,
    inputTokens: 0, outputTokens: 0, cost: taskCost(null, { providerKind: 'anthropic', sent: true }), tools: [], traceCalls: [], urlTimeline: [], shadow: [],
  }
  row.score = scoreRow(row)
  const md = renderMarkdown({ meta: { startedAt: 'now', provider: 'anthropic', model: 'm', arms: ['shadow'], reps: 1, threshold: 0.6, spent: 0.5, cap: 10 }, rows: [row], summary: summarize([row]) })
  assert.match(md, /\$0\.500 \(reserve\)/)
})

test('scoreRow: both models scored against the key, into the 2×2', () => {
  const reg0 = '[3]<input> "Full name"\n[4]<input> email "Email address"\n[10]<button> submit "Send message"'
  const row = {
    task: 'form-contact', arm: 'shadow', startUrl: `${BASE}/form.html`,
    tools: [
      { toolName: 'RequestPageControl', input: {}, output: { url: `${BASE}/form.html`, elements: reg0 } },
      { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { ok: true, elements: reg0.replace('"Full name"', '"Full name" = "Ada Lovelace"') } },
      { toolName: 'ControlPage', input: { action: 'click', index: 10 }, output: { ok: true, elements: '[0]<a> "Home"' } },
    ],
    traceCalls: [],
    urlTimeline: [],
    shadow: [
      rec(0, 'type', 3, { op: 'type', index: 4 }, 0.7), // decider picks another missing field: also right
      rec(1, 'click', 10, { op: 'type', index: 4 }, 0.5), // chat submits too early; decider right
      { kind: 'fill', seq: 2, at: 2000, fill: [{ index: 4, key: 'email', p: 0.9, llmAgrees: null }] },
    ],
  }
  const s = scoreRow(row, 0.6)
  assert.equal(s.keyed, 2)
  assert.equal(s.chatCorrect, 1)
  assert.deepEqual(s.grid, { both: 1, chatOnly: 0, deciderOnly: 1, neither: 0 })
  assert.equal(s.decider.correct, 2)
  assert.equal(s.decider.atThreshold, 1)
  assert.equal(s.decider.coverage, 0.5)
  assert.deepEqual(s.unpaired, { calls: 0, records: 0 })
  assert.equal(s.decider.fillRecords, 1)
  assert.deepEqual(s.decider.fills, [{ key: 'email', p: 0.9, llmAgrees: null }])
})

test('scoreRow: highlight and wait are presentation, left unkeyed for both models', () => {
  const row = {
    task: 'form-contact', arm: 'shadow', startUrl: `${BASE}/form.html#submitted`,
    tools: [{ toolName: 'ReadPage', input: {}, output: { url: `${BASE}/form.html#submitted`, elements: '[0]<a> "Home"' } }, { toolName: 'ControlPage', input: { action: 'highlight', label: 'Sent' }, output: { ok: true } }],
    shadow: [rec(0, 'highlight', undefined, { op: 'done' })],
  }
  const s = scoreRow(row)
  assert.equal(s.keyed, 0)
  assert.equal(s.steps[0].neutral, true)
  assert.deepEqual(s.grid, { both: 0, chatOnly: 0, deciderOnly: 0, neither: 0 })
  assert.deepEqual(s.unpaired, { calls: 0, records: 0 })
})

test('scoreRow: a call that returned before the hook is not unpaired; one that reached it is', () => {
  const row = {
    task: 'form-contact', arm: 'shadow',
    tools: [
      { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { error: 'No page-control session is open. Call RequestPageControl first.' } },
      { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { ok: true } },
      { toolName: 'ControlPage', input: { action: 'type', index: 4 }, output: { ok: true } },
    ],
    shadow: [rec(0, 'type', 3, { op: 'type', index: 3 })],
  }
  const s = scoreRow(row)
  assert.deepEqual(s.unpaired, { calls: 1, records: 0 })
  assert.equal(s.beforeHookCalls, 1)
  assert.deepEqual(s.unpairedCallErrors, [null])
})

test('scoreRow: steps that reached the decider path with zero records → missingShadow (shadow/assist only)', () => {
  const tools = [
    { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { error: 'No page-control session is open. Call RequestPageControl first.' } },
    { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { ok: true } },
  ]
  const s = scoreRow({ task: 'form-contact', arm: 'shadow', tools, shadow: [] })
  assert.equal(s.reachedHookCalls, 1)
  assert.equal(s.missingShadow, true)
  assert.equal(scoreRow({ task: 'form-contact', arm: 'off', tools, shadow: [] }).missingShadow, false)
  // Only a before-hook call (no session was ever granted): nothing should have been recorded.
  assert.equal(scoreRow({ task: 'form-contact', arm: 'assist', tools: tools.slice(0, 1), shadow: [] }).missingShadow, false)
  // One record (even a skipped one) means the decider is recording.
  assert.equal(scoreRow({ task: 'form-contact', arm: 'shadow', tools, shadow: [{ kind: 'next', seq: 0, at: 1, llm: { op: 'type', index: 3 }, top3: [], skipped: 'too-long' }] }).missingShadow, false)
})

test('autofillCalls: the assist path (no fields), its mapped keys, left reasons and errors', () => {
  const tools = [
    { toolName: 'AutofillForm', input: { values: { message: 'Do you offer volume discounts?', topic: 'Sales' } },
      output: { filled: [3, 4, 6], left: [{ index: 5, reason: 'leave-empty' }, { index: 8, reason: 'low-confidence' }], mapped: [{ index: 3, key: 'profile.full_name' }, { index: 6, key: 'option.3' }, { index: 7, key: 'request.0' }] } },
    { toolName: 'AutofillForm', input: { fields: [{ index: 3, value: 'Ada' }] }, output: { filled: [3] } },
    { toolName: 'AutofillForm', input: {}, output: { error: 'Could not map fields automatically (no profile); pass fields explicitly.' } },
  ]
  const a = autofillCalls(tools)
  assert.deepEqual(a[0], {
    withoutFields: true, values: ['message', 'topic'], mapped: ['profile.full_name', 'option.3', 'request.0'],
    left: [{ index: 5, reason: 'leave-empty' }, { index: 8, reason: 'low-confidence' }], filled: 3, error: null,
  })
  assert.equal(a[1].withoutFields, false)
  assert.match(a[2].error, /Could not map/)
  const s = scoreRow({ task: 'form-sales', arm: 'assist', tools, shadow: [] })
  assert.equal(s.assistUsed, true)
  assert.deepEqual(s.mapped, ['profile.full_name', 'option.3', 'request.0'])
  assert.equal(scoreRow({ task: 'form-sales', arm: 'assist', tools: tools.slice(1), shadow: [] }).assistUsed, false)
})

test('summaryLine: per arm, decider@p≥thr, chat accuracy, coverage, ms', () => {
  const reg0 = '[3]<input> "Full name"\n[4]<input> email "Email address"\n[10]<button> submit "Send message"'
  const row = {
    task: 'form-contact', family: 'form', arm: 'shadow', rep: 1, success: true, ended: 'turn-ended', wallMs: 1, llmSteps: 1, inputTokens: 0, outputTokens: 0,
    cost: { low: 0, high: 0 }, startUrl: `${BASE}/form.html`, traceCalls: [], urlTimeline: [],
    tools: [
      { toolName: 'RequestPageControl', input: {}, output: { url: `${BASE}/form.html`, elements: reg0 } },
      { toolName: 'ControlPage', input: { action: 'type', index: 3 }, output: { ok: true, elements: reg0 } },
      { toolName: 'ControlPage', input: { action: 'click', index: 10 }, output: { ok: true } },
    ],
    shadow: [rec(0, 'type', 3, { op: 'type', index: 4 }, 0.7), rec(1, 'click', 10, { op: 'type', index: 4 }, 0.5)],
  }
  row.score = scoreRow(row)
  assert.equal(
    summaryLine(summarize([row]), 0.6),
    'summary — shadow: success 100% (1/1), decider@p≥0.6 100% (1/1), chat 50% (1/2), coverage 50%, decider ms p50/p95 100/101',
  )
  assert.equal(summaryLine({}), 'summary — no rows')
})

test('scoreRow: a seq the hooks numbered but never recorded counts as a superseded step', () => {
  const row = {
    task: 'nav-returns', arm: 'shadow', tools: [call('click', 5), call('click', 6)].map((c) => ({ toolName: 'ControlPage', ...c, output: { ok: true } })),
    shadow: [rec(0, 'click', 5, { op: 'click', index: 5 }), rec(2, 'click', 6, { op: 'click', index: 6 })],
  }
  const s = scoreRow(row)
  assert.equal(s.decider.seqGaps, 1)
  assert.deepEqual(s.unpaired, { calls: 0, records: 0 })
})

test('scoreRow: assist field correctness and AutofillForm mapped keys', () => {
  const row = {
    task: 'form-newsletter', arm: 'assist', tools: [{ toolName: 'AutofillForm', input: {}, output: { filled: 3, mapped: [{ index: 2, key: 'email' }, { index: 3, key: 'first_name' }] } }],
    shadow: [], fields: { 'Email address': 'ada@example.com', 'First name': 'Ada', 'Last name': 'Lovelace', Audio: true, Kitchen: false, Deals: true },
  }
  const s = scoreRow(row)
  assert.deepEqual(s.mapped, ['email', 'first_name'])
  assert.equal(s.fields.Deals.ok, false)
  assert.equal(s.fieldAccuracy, 5 / 6)
})

test('the off arm has nothing unpaired, and the report renders', () => {
  const row = {
    task: 'nav-returns', family: 'nav', arm: 'off', rep: 1, success: true, ended: 'turn-ended', wallMs: 40_000, llmSteps: 6,
    inputTokens: 100, outputTokens: 10, cost: { low: 0, high: 0 }, startUrl: `${BASE}/help/index.html`,
    tools: [{ toolName: 'ControlPage', input: { action: 'click', index: 5 }, output: { ok: true } }], traceCalls: [], urlTimeline: [], shadow: [],
  }
  row.score = scoreRow(row)
  assert.deepEqual(row.score.unpaired, { calls: 0, records: 0 })
  const md = renderMarkdown({ meta: { startedAt: 'now', provider: 'lmstudio', model: 'm', arms: ['off'], reps: 1, threshold: 0.6, spent: 0, cap: 10 }, rows: [row], summary: summarize([row]) })
  assert.match(md, /\| off \| 1 \| 100% \(1\/1\)/)
  assert.match(md, /both right \| chat only \| decider only \| both wrong/)
})
