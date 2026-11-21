// Scoring corrections Task 13 found: node --test scripts/decider-eval/scoring.test.mjs
//   1. a step after an AutofillForm is keyed against the registry AFTER that fill;
//   2. a ControlPage issued in the same model step as another page-mutating call is `raced`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlSteps, renderMarkdown, scoreRow, summarize } from './report.mjs'

const BASE = 'http://127.0.0.1:8770'
const FORM_URL = `${BASE}/form.html`
const FORM = (v = {}) =>
  [
    '[0]<a> "Home"',
    '[1]<a> "FAQ"',
    '[2]<a> "Service status"',
    `[3]<input> "Full name"${v.name ? ` = "${v.name}"` : ''}`,
    `[4]<input> email "Email address"${v.email ? ` = "${v.email}"` : ''}`,
    '[5]<input> "Phone number"',
    `[6]<select> select-one "Topic"${v.topic ? ` = "${v.topic}"` : ''}`,
    `[7]<textarea> textarea "How can we help?"${v.message ? ` = "${v.message}"` : ''}`,
    `[8]<input> checkbox "I agree to be contacted about my request" ${v.consent ? '(checked)' : '(unchecked)'}`,
    '[9]<input> checkbox "Send me the monthly newsletter" (unchecked)',
    '[10]<button> submit "Send message"',
    '[11]<button> reset "Clear form"',
  ].join('\n')
const readForm = { toolName: 'ReadPage', input: {}, output: { url: FORM_URL, elements: FORM() } }
const fillAll = {
  toolName: 'AutofillForm',
  input: { fields: [{ index: 3, value: 'Ada Lovelace' }, { index: 4, value: 'ada@example.com' }, { index: 6, value: 'Billing' }, { index: 7, value: 'My last invoice was charged twice.' }] },
  output: { filled: [3, 4, 6, 7, 8], mapped: [{ index: 8, key: 'tick' }] },
}
const cp = (action, index) => ({ toolName: 'ControlPage', input: { action, index }, output: { ok: true } })
const base = { task: 'form-contact', arm: 'shadow', startUrl: FORM_URL, urlTimeline: [], shadow: [] }
const trace = (...ats) => ats.map(([name, at]) => ({ name, at }))

test('a step after an AutofillForm sees the registry with its fills applied', () => {
  const row = { ...base, tools: [readForm, fillAll, cp('click', 10)], traceCalls: trace(['ReadPage', 100], ['AutofillForm', 200], ['ControlPage', 300]) }
  const [s] = controlSteps(row)
  assert.equal(s.patched, true)
  assert.match(s.registry, /\[3\]<input> "Full name" = "Ada Lovelace"/)
  assert.match(s.registry, /\[6\]<select> select-one "Topic" = "Billing"/)
  assert.match(s.registry, /\[8\]<input> checkbox .* \(checked\)/)
  // Against the pre-fill form the key would ask for every field again; after it, only Send.
  const scored = scoreRow(row).steps[0]
  assert.deepEqual(scored.key, [{ op: 'click', index: 10 }])
  assert.equal(scored.chatOk, true)
})

test('a registry captured after the fill is not patched again; a fill that filled nothing changes nothing', () => {
  const done = FORM({ name: 'Ada Lovelace', email: 'ada@example.com', topic: 'Billing', message: 'My last invoice was charged twice.', consent: true })
  const after = { toolName: 'ReadPage', input: {}, output: { url: FORM_URL, elements: done } }
  const row = { ...base, tools: [readForm, fillAll, after, cp('click', 10)], traceCalls: trace(['ReadPage', 100], ['AutofillForm', 200], ['ReadPage', 250], ['ControlPage', 300]) }
  assert.equal(controlSteps(row)[0].patched, false)
  assert.equal(controlSteps(row)[0].registry, done)
  const noop = { ...fillAll, output: { filled: [] } }
  const row2 = { ...base, tools: [readForm, noop, cp('type', 3)], traceCalls: trace(['ReadPage', 100], ['AutofillForm', 200], ['ControlPage', 300]) }
  assert.equal(controlSteps(row2)[0].patched, false)
  assert.equal(controlSteps(row2)[0].registry, FORM())
})

test('a ControlPage in the same model step as an AutofillForm is raced: unkeyed for both models, and counted', () => {
  const row = { ...base, tools: [readForm, fillAll, cp('click', 8)], traceCalls: trace(['ReadPage', 100], ['AutofillForm', 200], ['ControlPage', 200]) }
  assert.equal(controlSteps(row)[0].raced, true)
  const s = scoreRow(row)
  assert.equal(s.raced, 1)
  assert.equal(s.keyed, 0)
  assert.equal(s.steps[0].raced, true)
  assert.deepEqual(s.steps[0].key, [])
  assert.equal(s.steps[0].chatOk, null)
})

test('two mutating ControlPage calls in one step race; a lone call, a highlight and a later step do not', () => {
  const row = {
    ...base,
    tools: [readForm, cp('type', 3), cp('type', 4), cp('highlight', 6), cp('click', 8)],
    traceCalls: trace(['ReadPage', 100], ['ControlPage', 200], ['ControlPage', 200], ['ControlPage', 300], ['ControlPage', 400]),
  }
  assert.deepEqual(controlSteps(row).map((s) => s.raced), [true, true, false, false])
  assert.equal(scoreRow(row).raced, 2)
  // A highlight sharing a step with one mutating call does not race it.
  const row2 = { ...base, tools: [readForm, cp('type', 3), cp('highlight', 6)], traceCalls: trace(['ReadPage', 100], ['ControlPage', 200], ['ControlPage', 200]) }
  assert.deepEqual(controlSteps(row2).map((s) => s.raced), [false, false])
  // Calls with no trace time are never called raced.
  assert.deepEqual(controlSteps({ ...row2, traceCalls: [] }).map((s) => s.raced), [false, false])
})

test('summarize and the report carry the raced count', () => {
  const row = {
    ...base, family: 'form', rep: 1, success: true, ended: 'turn-ended', wallMs: 1000, llmSteps: 2, inputTokens: 1, outputTokens: 1, cost: { low: 0, high: 0 },
    tools: [readForm, fillAll, cp('click', 8)], traceCalls: trace(['ReadPage', 100], ['AutofillForm', 200], ['ControlPage', 200]),
  }
  row.score = scoreRow(row)
  const summary = summarize([row])
  assert.equal(summary.shadow.overall.raced, 1)
  const md = renderMarkdown({ meta: { startedAt: 'now', provider: 'lmstudio', model: 'm', arms: ['shadow'], reps: 1, threshold: 0.6, spent: 0, cap: 10 }, rows: [row], summary })
  assert.match(md, /\| raced \|/)
})
