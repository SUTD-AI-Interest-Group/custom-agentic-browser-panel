// Driver-mode (FastSteps) scoring: node --test scripts/decider-eval/driver.test.mjs
// The fixtures below are trimmed from a real shop-cheapest driver run (captured `decider.next`
// requests, `drive` records and the FastSteps result).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlSteps, driverCalls, driverScore, pairDriveRequests, registryOf, renderMarkdown, replayStep, scoreRow, summarize, valueOfStep } from './report.mjs'

const BASE = 'http://127.0.0.1:8770'
const HOME = `${BASE}/store/index.html`
const SEARCH = `${BASE}/store/search.html?q=wireless+headphones`
const PRODUCT = `${BASE}/store/product.html?id=p3`

const el = (index, tag, name, extra = {}) => ({ index, tag, name, sensitive: false, ...extra })
const header = (cart = 0, value) => [
  el(0, 'a', 'Northwind Store'),
  el(1, 'input', 'Search products', { type: 'search', ...(value ? { value } : {}) }),
  el(2, 'button', 'Search', { type: 'submit' }),
  el(3, 'a', `Cart (${cart})`),
]
const HOME_ELS = (value) => [...header(0, value), el(4, 'a', 'Speakers'), el(5, 'a', 'Kitchen'), el(6, 'a', 'Earbuds')]
const SEARCH_ELS = [...header(), el(4, 'a', 'Sonic Air wireless headphones'), el(5, 'a', 'Arc wireless headphones'), el(6, 'a', 'Nimbus wireless headphones'), el(7, 'a', 'Halo noise-cancelling wireless headphones')]
const PRODUCT_ELS = (cart = 0) => [
  ...header(cart),
  el(4, 'select', 'Quantity', { type: 'select-one', value: '1' }),
  el(5, 'button', 'Add to cart', { type: 'submit' }),
  el(6, 'button', 'Save to wishlist', { type: 'submit' }),
]
/** The registry text ControlPage / FastSteps return for the product page, verbatim from the run. */
const PRODUCT_TEXT =
  '[0]<a> "Northwind Store"\n[1]<input> search "Search products"\n[2]<button> submit "Search"\n[3]<a> "Cart (1)"\n' +
  '[4]<select> select-one "Quantity" = "1"\n[5]<button> submit "Add to cart"\n[6]<button> submit "Save to wishlist"'

const req = (at, url, elements, extra = {}) => ({ at, requestId: `r${at}`, conversationId: 'c', goal: 'g', url, title: 't', elements, exclude: [], previousActions: [], values: {}, ...extra })
const rec = (at, top3, extra = {}) => ({ kind: 'drive', at, seq: 0, conversationId: 'c', llm: null, agree: null, top3, ms: 150, tokens: 400, cold: false, backend: 'webgpu', ...extra })
const o = (op, index, p) => (index === undefined ? { op, p } : { op, index, p })

/** shop-cheapest: ReadPage → RequestPageControl → FastSteps (4 steps, hands back on done 0.56). */
function shopRow(overrides = {}) {
  const steps = overrides.steps ?? [
    { op: 'type', index: 1, p: 0.94, ms: 616, ok: true },
    { op: 'click', index: 2, p: 0.6, ms: 129, ok: true },
    { op: 'click', index: 5, p: 0.8, ms: 925, ok: true },
    { op: 'click', index: 5, p: 0.87, ms: 242, ok: true },
  ]
  return {
    task: 'shop-cheapest',
    family: 'store',
    arm: 'driver',
    rep: 1,
    startUrl: HOME,
    success: true,
    wallMs: 89000,
    llmSteps: 6,
    inputTokens: 30000,
    outputTokens: 2000,
    cost: { low: 0, high: 0 },
    urlTimeline: [{ at: 0, url: HOME }],
    tools: [
      { toolName: 'ReadPage', input: {}, output: { url: HOME, elements: registryOf(HOME_ELS()) } },
      { toolName: 'RequestPageControl', input: { plan: 'p' }, output: { started: true } },
      {
        toolName: 'FastSteps',
        input: { goal: 'Search for wireless headphones', values: { query: 'wireless headphones' } },
        output: {
          status: 'handback',
          reason: 'unsure',
          message: 'Possibly done (p=0.56); check the page.',
          steps,
          decisions: overrides.decisions ?? 5,
          deciderMs: 2069,
          actions: [
            { action: 'type', index: 1, summary: 'typed', value: 'wireless headphones' },
            { action: 'click', index: 2, summary: 'clicked “Search”' },
            { action: 'click', index: 5, summary: 'clicked' },
            { action: 'click', index: 5, summary: 'clicked “Add to cart”' },
          ],
          elements: PRODUCT_TEXT,
        },
      },
      ...(overrides.after ?? []),
    ],
    traceCalls: [
      { name: 'ReadPage', at: 100 },
      { name: 'RequestPageControl', at: 200 },
      { name: 'FastSteps', at: 300 },
      ...(overrides.afterTrace ?? []),
    ],
    driveRequests: overrides.driveRequests ?? [
      req(1000, HOME, HOME_ELS()),
      req(2000, HOME, HOME_ELS('wireless headphones')),
      req(3000, SEARCH, SEARCH_ELS),
      req(4000, PRODUCT, PRODUCT_ELS()),
      req(5000, `${PRODUCT}#added`, PRODUCT_ELS(1)),
    ],
    shadow: overrides.shadow ?? [
      rec(1000, [o('type', 1, 0.939), o('click', 2, 0.023), o('click', 6, 0.018)], { cold: true, ms: 616 }),
      rec(2000, [o('click', 2, 0.604), o('scroll', undefined, 0.271), o('done', undefined, 0.047)], { ms: 129 }),
      rec(3002, [o('click', 5, 0.796), o('click', 6, 0.178), o('click', 3, 0.007)], { ms: 925 }),
      rec(4000, [o('click', 5, 0.873), o('select', 4, 0.079), o('done', undefined, 0.017)], { ms: 242 }),
      rec(5000, [o('done', undefined, 0.557), o('click', 3, 0.117), o('scroll', undefined, 0.114)], { ms: 157 }),
    ],
  }
}

test('registryOf renders a decision snapshot exactly as ControlPage shows the registry', () => {
  assert.equal(registryOf(PRODUCT_ELS(1)), PRODUCT_TEXT)
  const form = [
    el(3, 'input', 'Full name', { value: 'Ada' }),
    el(8, 'input', 'I agree', { type: 'checkbox', checked: false }),
    el(9, 'input', 'News', { type: 'checkbox', checked: true, value: 'on' }),
    el(10, 'input', 'Password', { type: 'password', value: '••••', sensitive: true }),
    el(11, 'div', 'Menu', { role: 'button' }),
  ]
  assert.equal(
    registryOf(form),
    '[3]<input> "Full name" = "Ada"\n[8]<input> checkbox "I agree" (unchecked)\n[9]<input> checkbox "News" (checked)\n' +
      '[10]<input> password "Password" = "••••" (sensitive)\n[11]<div role=button> "Menu"',
  )
  assert.equal(registryOf([]), '(no interactive elements found)')
  assert.equal(registryOf(null), null)
})

test('pairDriveRequests: a record answers the latest request copied before it; a cancelled request has none', () => {
  const requests = [req(100, HOME, []), req(300, HOME, []), { at: 400, cancel: true, requestId: 'r300' }, req(500, HOME, [])]
  const records = [rec(102, [o('done', undefined, 0.9)]), rec(530, [o('done', undefined, 0.8)]), rec(10, [o('done', undefined, 0.7)])]
  const { pairs, unpairedRecords } = pairDriveRequests(requests, records)
  assert.deepEqual(pairs.map((p) => [p.req.at, p.rec?.at ?? null, p.cancelled]), [[100, 102, false], [300, null, true], [500, 530, false]])
  // A record stamped before any request has no request to answer.
  assert.deepEqual(unpairedRecords.map((r) => r.at), [10])
  // A record stamped a few ms before its request was copied (listener order) still pairs.
  assert.equal(pairDriveRequests([req(200, HOME, [])], [rec(190, [o('done', undefined, 0.9)])]).pairs[0].rec.at, 190)
})

test('every executed step is keyed against the state its own decision saw (capture)', () => {
  const [call] = driverCalls(shopRow())
  assert.deepEqual(call.steps.map((s) => [s.op, s.index, s.method, s.verdict]), [
    ['type', 1, 'capture', 'right'],
    ['click', 2, 'capture', 'right'], // the query is in the box: Search is the key
    ['click', 5, 'capture', 'right'], // "Arc wireless headphones" on the results page
    ['click', 5, 'capture', 'right'], // "Add to cart" on the product page — same index, other page
  ])
  assert.equal(call.steps[3].url, PRODUCT)
  assert.match(call.steps[3].registry, /\[5\]<button> submit "Add to cart"/)
  // The hand-back's own top-1 (done at 0.56 on #added) was right: the gate cost a turn.
  const stop = call.decided.at(-1)
  assert.equal(stop.executed, false)
  assert.equal(stop.topOk, true)
  assert.deepEqual(stop.top3[0], { op: 'done', p: 0.56 })
})

test('a wrong executed step is scored wrong against its key', () => {
  const steps = [{ op: 'type', index: 1, p: 0.94, ms: 616, ok: true }, { op: 'click', index: 2, p: 0.6, ms: 129, ok: true }, { op: 'click', index: 5, p: 0.8, ms: 925, ok: true }, { op: 'click', index: 6, p: 0.7, ms: 200, ok: true }]
  const row = shopRow({ steps })
  row.shadow[3] = rec(4000, [o('click', 6, 0.7), o('click', 5, 0.2), o('done', undefined, 0.05)])
  const s = driverScore(row)
  assert.deepEqual(s.verdicts, { right: 3, wrong: 1 })
  assert.deepEqual(s.wrongSteps, [{ op: 'click', index: 6, p: 0.7, url: PRODUCT, key: [{ op: 'click', index: 5 }], method: 'capture' }])
})

test("a repeat's excluded first ask is passed over: the step matches the re-asked decision", () => {
  const steps = [{ op: 'click', index: 5, p: 0.8, ms: 900, ok: true }, { op: 'select', index: 4, p: 0.63, ms: 300, ok: true }]
  const row = shopRow({
    steps,
    decisions: 3,
    driveRequests: [req(1000, SEARCH, SEARCH_ELS), req(2000, PRODUCT, PRODUCT_ELS()), req(2100, PRODUCT, PRODUCT_ELS(), { exclude: [{ op: 'click', index: 5 }] })],
    shadow: [rec(1000, [o('click', 5, 0.8)]), rec(2000, [o('click', 5, 0.79)]), rec(2100, [o('select', 4, 0.63)])],
  })
  const [call] = driverCalls(row)
  assert.deepEqual(call.decided.map((d) => d.executed), [true, false, true])
  assert.equal(call.steps[1].method, 'capture')
  // Quantity already 1 for shop-cheapest: the key is Add to cart, so the select is a wrong move.
  assert.equal(call.steps[1].verdict, 'wrong')
  assert.equal(call.decided[1].topOk, true) // the excluded ask (Add to cart) was the right one
})

test('without a capture, steps are replayed from the chat model’s last registry until one cannot be', () => {
  const FORM_URL = `${BASE}/form.html`
  const FORM = [
    '[0]<a> "Home"',
    '[1]<a> "FAQ"',
    '[2]<a> "Service status"',
    '[3]<input> "Full name"',
    '[4]<input> email "Email address"',
    '[5]<input> "Phone number"',
    '[6]<select> select-one "Topic"',
    '[7]<textarea> textarea "How can we help?"',
    '[8]<input> checkbox "I agree to be contacted about my request" (unchecked)',
    '[9]<input> checkbox "Send me the monthly newsletter" (unchecked)',
    '[10]<button> submit "Send message"',
  ].join('\n')
  const row = {
    task: 'form-contact',
    arm: 'driver',
    startUrl: FORM_URL,
    urlTimeline: [],
    shadow: [],
    tools: [
      { toolName: 'ReadPage', input: {}, output: { url: FORM_URL, elements: FORM } },
      {
        toolName: 'FastSteps',
        input: { goal: 'fill', values: { name: 'Ada Lovelace' } },
        output: {
          status: 'handback',
          reason: 'max steps',
          decisions: 4,
          deciderMs: 800,
          steps: [
            { op: 'type', index: 3, p: 0.9, ms: 200, ok: true },
            { op: 'click', index: 8, p: 0.8, ms: 200, ok: true },
            { op: 'click', index: 2, p: 0.7, ms: 200, ok: true },
            { op: 'type', index: 4, p: 0.9, ms: 200, ok: true },
          ],
          actions: [{ action: 'type', index: 3, summary: 's', value: 'Ada Lovelace' }, { action: 'click', index: 8, summary: 's' }, { action: 'click', index: 2, summary: 's' }, { action: 'type', index: 4, summary: 's', value: 'ada@example.com' }],
        },
      },
    ],
    traceCalls: [{ name: 'ReadPage', at: 100 }, { name: 'FastSteps', at: 200 }],
  }
  const [call] = driverCalls(row)
  assert.deepEqual(call.steps.map((s) => [s.method, s.verdict]), [
    ['replay', 'right'], // type Full name on the empty form
    ['replay', 'right'], // tick consent, with Full name now filled
    ['replay', 'wrong'], // a "Service status" link is never in the key
    [null, 'unscoreable'], // after a link click the page is unknown
  ])
  assert.match(call.steps[1].registry, /\[3\]<input> "Full name" = "Ada Lovelace"/)
  assert.match(call.steps[2].registry, /\[8\]<input> checkbox .* \(checked\)/)
})

test('valueOfStep: a step key resolves to the value it wrote (results from ba598bd on carry no values)', () => {
  assert.equal(valueOfStep('request.query', { query: 'wireless headphones' }), 'wireless headphones')
  assert.equal(valueOfStep('request.1', { a: 'x', b: 'y' }), 'y') // a positional key, as records store it
  assert.equal(valueOfStep('profile.email', {}), 'ada@example.com')
  assert.equal(valueOfStep('profile.full_name', {}), 'Ada Lovelace')
  assert.equal(valueOfStep('option.2', {}, ['General', 'Sales', 'Billing']), 'Billing')
  assert.equal(valueOfStep('option.2', {}, undefined), undefined)
  assert.equal(valueOfStep(undefined, {}), undefined)
})

test('replay takes a type value from the step key when the result carries no values', () => {
  const FORM_URL = `${BASE}/form.html`
  const FORM = '[3]<input> "Full name"\n[4]<input> email "Email address"\n[6]<select> select-one "Topic"\n[7]<textarea> textarea "How can we help?"\n[8]<input> checkbox "I agree to be contacted about my request" (unchecked)\n[10]<button> submit "Send message"'
  const row = {
    task: 'form-contact',
    arm: 'driver',
    startUrl: FORM_URL,
    urlTimeline: [],
    shadow: [],
    tools: [
      { toolName: 'ReadPage', input: {}, output: { url: FORM_URL, elements: FORM } },
      {
        toolName: 'FastSteps',
        input: { goal: 'fill', values: { name: 'Ada Lovelace' } },
        output: {
          status: 'handback',
          reason: 'unsure',
          decisions: 3,
          deciderMs: 600,
          steps: [
            { op: 'type', index: 3, p: 0.9, ms: 200, ok: true, key: 'request.name' },
            { op: 'type', index: 4, p: 0.9, ms: 200, ok: true, key: 'profile.email' },
            { op: 'click', index: 10, p: 0.9, ms: 200, ok: true },
          ],
          actions: [{ action: 'type', index: 3, summary: 's' }, { action: 'type', index: 4, summary: 's' }, { action: 'click', index: 10, summary: 's' }],
        },
      },
    ],
    traceCalls: [{ name: 'ReadPage', at: 100 }, { name: 'FastSteps', at: 200 }],
  }
  const [call] = driverCalls(row)
  assert.match(call.steps[2].registry, /\[3\]<input> "Full name" = "Ada Lovelace"\n\[4\]<input> email "Email address" = "ada@example.com"/)
  // Topic, message and consent are still pending, so Send is a wrong move.
  assert.deepEqual(call.steps.map((s) => s.verdict), ['right', 'right', 'wrong'])
})

test('replayStep: values, checkbox/radio state, refused steps, and what cannot be replayed', () => {
  const reg = '[3]<input> "Name"\n[5]<input> checkbox "A" (checked)\n[6]<input> radio "B" (unchecked)\n[7]<a> "Next"'
  assert.match(replayStep(reg, { op: 'type', index: 3, ok: true }, 'Ada'), /\[3\]<input> "Name" = "Ada"/)
  assert.match(replayStep(reg, { op: 'click', index: 5, ok: true }), /\[5\]<input> checkbox "A" \(unchecked\)/)
  assert.match(replayStep(reg, { op: 'click', index: 6, ok: true }), /\[6\]<input> radio "B" \(checked\)/)
  assert.equal(replayStep(reg, { op: 'click', index: 7, ok: false }), reg)
  assert.equal(replayStep(reg, { op: 'click', index: 7, ok: true }), null)
  assert.equal(replayStep(reg, { op: 'scroll', ok: true }), null)
  assert.equal(replayStep(reg, { op: 'type', index: 3, ok: true }, undefined), null)
})

test("decisions belong to their call's model step; a refused concurrent call owns none", () => {
  const row = shopRow({
    after: [
      { toolName: 'FastSteps', input: { goal: 'again' }, output: { status: 'stopped', reason: 'another FastSteps run is in progress' } },
      { toolName: 'FastSteps', input: { goal: 'add to cart' }, output: { status: 'done', reason: 'done', steps: [{ op: 'click', index: 5, p: 0.9, ms: 150, ok: true }], decisions: 2, deciderMs: 300, actions: [] } },
    ],
    afterTrace: [{ name: 'FastSteps', at: 300 }, { name: 'FastSteps', at: 9000 }],
  })
  row.driveRequests.push(req(9500, PRODUCT, PRODUCT_ELS()), req(9800, `${PRODUCT}#added`, PRODUCT_ELS(1)))
  row.shadow.push(rec(9500, [o('click', 5, 0.9)]), rec(9800, [o('done', undefined, 0.8)]))
  const calls = driverCalls(row)
  assert.deepEqual(calls.map((c) => c.decided.length), [5, 0, 2])
  // The refused call may come FIRST in conversation order (the model listed it first; the other
  // one won the race): it still owns none of the step's decisions.
  const first = { ...row, tools: [row.tools[0], row.tools[1], row.tools[3], row.tools[2], row.tools[4]] }
  assert.deepEqual(driverCalls(first).map((c) => c.decided.length), [0, 5, 2])
  assert.deepEqual(calls[2].steps.map((s) => [s.method, s.verdict]), [['capture', 'right']])
  const s = driverScore(row)
  assert.deepEqual(s.statuses, { 'handback/unsure': 1, 'stopped/another FastSteps run is in progress': 1, 'done/done': 1 })
  assert.equal(s.executed, 5)
  assert.equal(s.stopsKeyed, 2)
  assert.equal(s.stopsRight, 2)
})

test('a ControlPage in the same model step as a FastSteps is raced', () => {
  const row = shopRow({
    after: [{ toolName: 'ControlPage', input: { action: 'click', index: 5 }, output: { ok: true } }],
    afterTrace: [{ name: 'ControlPage', at: 300 }],
  })
  assert.equal(controlSteps(row)[0].raced, true)
})

test('driverScore: errors, statuses, latency; the off arm has none of it', () => {
  const row = shopRow()
  row.tools.splice(1, 0, { toolName: 'FastSteps', input: { goal: 'x' }, output: { error: 'No page-control session is open. Call RequestPageControl first.' } })
  row.traceCalls.splice(1, 0, { name: 'FastSteps', at: 150 })
  const s = driverScore(row)
  assert.equal(s.calls, 2)
  assert.equal(s.usedCalls, 1)
  assert.deepEqual(s.errors, ['No page-control session is open. Call RequestPageControl first.'])
  assert.deepEqual(s.methods, { capture: 4 })
  assert.equal(s.msP50, 242)
  assert.equal(s.msP95, 925)
  assert.deepEqual(s.coldMs, [616])
  const off = driverScore({ task: 'shop-cheapest', arm: 'off', tools: [], shadow: [] })
  assert.equal(off.calls, 0)
  assert.deepEqual(off.verdicts, {})
})

test('the report carries the driver sections and the off-vs-driver table', () => {
  const driver = shopRow()
  const off = { ...shopRow(), arm: 'off', tools: [shopRow().tools[0]], traceCalls: [{ name: 'ReadPage', at: 100 }], driveRequests: undefined, shadow: [], wallMs: 120000, llmSteps: 12 }
  const rows = [off, driver].map((r) => ({ ...r, score: scoreRow(r) }))
  const summary = summarize(rows)
  assert.equal(summary.driver.overall.driver.rowsUsing, 1)
  assert.equal(summary.driver.overall.driver.executed, 4)
  assert.equal(summary.off.overall.driver.executed, 0)
  assert.equal(summary.driver.overall.llmStepsP50, 6)
  const md = renderMarkdown({ meta: { startedAt: 't', provider: 'lmstudio', model: 'm', arms: ['off', 'driver'], reps: 1, threshold: 0.6, spent: 0, cap: 10 }, rows, summary })
  assert.match(md, /## Driver mode: FastSteps/)
  assert.match(md, /## Driver vs off, by task family/)
  assert.match(md, /\| \*\*all\*\* \| 1\/1 → 1\/1 \| 120 → 89 \| 12 → 6 \|/)
  assert.match(md, /type 1 \(0\.94, right\) → click 2 \(0\.6, right\)/)
})
