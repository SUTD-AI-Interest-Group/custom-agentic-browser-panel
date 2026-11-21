// Answer keys: node --test scripts/decider-eval/keys.test.mjs
//
// The form, help and inbox registries are the ones the spike's recorded LM Studio run saw
// (scratchpad e2e/e2e-all.json). They predate Task 7, so their checkbox lines (`= "on"`) are
// hand-edited to the current `(checked)` / `(unchecked)` format, consistent with the clicks the run
// made. The store states the run never reached are built from the real fixture pages.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formTargets, key, matches, parseRegistry, TASK_IDS } from './keys.mjs'

const BASE = 'http://127.0.0.1:8770'
const sorted = (k) => [...k].sort((a, b) => a.op.localeCompare(b.op) || (a.index ?? -1) - (b.index ?? -1))
const sameSet = (got, want) => assert.deepEqual(sorted(got), sorted(want))
const has = (k, op, index) => assert.ok(matches({ op, index }, k), `expected ${op} ${index ?? ''} in ${JSON.stringify(k)}`)
const lacks = (k, op, index) => assert.ok(!matches({ op, index }, k), `did not expect ${op} ${index ?? ''} in ${JSON.stringify(k)}`)

// ── recorded: the contact form, step by step ──────────────────────────────────────────────────
const form = ({ name = '', email = '', topic = '', message = '', consent = false, newsletter = false, phone = '' } = {}) =>
  [
    '[0]<a> "Home"',
    '[1]<a> "FAQ"',
    '[2]<a> "Service status"',
    `[3]<input> "Full name"${name ? ` = "${name}"` : ''}`,
    `[4]<input> email "Email address"${email ? ` = "${email}"` : ''}`,
    `[5]<input> "Phone number"${phone ? ` = "${phone}"` : ''}`,
    `[6]<select> select-one "Topic"${topic ? ` = "${topic}"` : ''}`,
    `[7]<textarea> textarea "How can we help?"${message ? ` = "${message}"` : ''}`,
    `[8]<input> checkbox "I agree to be contacted about my request" ${consent ? '(checked)' : '(unchecked)'}`,
    `[9]<input> checkbox "Send me the monthly newsletter" ${newsletter ? '(checked)' : '(unchecked)'}`,
    '[10]<button> submit "Send message"',
    '[11]<button> reset "Clear form"',
  ].join('\n')
const FORM_URL = `${BASE}/form.html`
const FILLED = { name: 'Ada Lovelace', email: 'ada@example.com', topic: 'Billing', message: 'My last invoice was charged twice.' }

test('form step 0: every unfilled target field and the unticked consent box, never Send', () => {
  const k = key('form-contact', form(), FORM_URL)
  for (const [op, i] of [['type', 3], ['type', 4], ['select', 6], ['type', 7], ['click', 8]]) has(k, op, i)
  lacks(k, 'click', 10)
  // Nothing else: the phone has no target here and the newsletter box is already right.
  sameSet(k, [{ op: 'type', index: 3 }, { op: 'type', index: 4 }, { op: 'select', index: 6 }, { op: 'type', index: 7 }, { op: 'click', index: 8 }])
})

test('form: once every field holds its target and consent is (checked), the key is exactly Send', () => {
  assert.deepEqual(key('form-contact', form({ ...FILLED, consent: true }), FORM_URL), [{ op: 'click', index: 10 }])
})

test('form: the recorded LM Studio run was right at every step', () => {
  const steps = [
    [form(), ['type', 3]],
    [form({ name: FILLED.name }), ['type', 4]],
    [form({ name: FILLED.name, email: FILLED.email }), ['select', 6]],
    [form({ name: FILLED.name, email: FILLED.email, topic: 'Billing' }), ['type', 7]],
    [form(FILLED), ['click', 8]],
    [form({ ...FILLED, consent: true }), ['click', 10]],
  ]
  for (const [reg, [op, index]] of steps) has(key('form-contact', reg, FORM_URL), op, index)
})

test('form: a wrongly ticked newsletter box is keyed (to untick it) and blocks Send', () => {
  const k = key('form-contact', form({ ...FILLED, consent: true, newsletter: true }), FORM_URL)
  assert.deepEqual(k, [{ op: 'click', index: 9 }])
})

test('form: a wrong value is keyed for retyping; values compare case- and space-insensitively', () => {
  has(key('form-contact', form({ ...FILLED, name: 'Ada Byron', consent: true }), FORM_URL), 'type', 3)
  assert.deepEqual(key('form-contact', form({ ...FILLED, name: '  ada   LOVELACE ', consent: true }), FORM_URL), [{ op: 'click', index: 10 }])
})

test('form-sales: a typed phone number must be cleared before Send', () => {
  const sales = { ...FILLED, topic: 'Sales', message: 'Do you offer volume discounts?' }
  assert.deepEqual(key('form-sales', form({ ...sales, phone: '+44 20 7946 0958' }), FORM_URL), [{ op: 'type', index: 5 }])
  // Consent is not part of this task: ticked or not, Send is right.
  assert.deepEqual(key('form-sales', form(sales), FORM_URL), [{ op: 'click', index: 10 }])
})

test('form: after submitting (#submitted) the key is done', () => {
  assert.deepEqual(key('form-contact', '[0]<a> "Home"\n[1]<a> "FAQ"\n[2]<a> "Service status"', `${FORM_URL}#submitted`), [{ op: 'done' }])
})

test('form: a target field missing from the (viewport-only) registry leaves the state unkeyed', () => {
  const partial = form({ ...FILLED, consent: true }).split('\n').filter((l) => !l.startsWith('[7]')).join('\n')
  assert.deepEqual(key('form-contact', partial, FORM_URL), [])
})

// ── new forms, built from the fixture pages ───────────────────────────────────────────────────
const shipping = (o = {}) =>
  [
    '[0]<a> "Cart"',
    '[1]<a> "Help"',
    `[2]<input> "Full name"${o.name ? ` = "${o.name}"` : ''}`,
    `[3]<input> "Street address"${o.street ? ` = "${o.street}"` : ''}`,
    `[4]<input> "City"${o.city ? ` = "${o.city}"` : ''}`,
    `[5]<input> "Postcode"${o.postcode ? ` = "${o.postcode}"` : ''}`,
    `[6]<select> select-one "Country"${o.country ? ` = "${o.country}"` : ''}`,
    `[7]<input> radio "Standard delivery" ${o.express ? '(unchecked)' : '(checked)'}`,
    `[8]<input> radio "Express delivery" ${o.express ? '(checked)' : '(unchecked)'}`,
    '[9]<input> "Phone (optional)"',
    '[10]<textarea> textarea "Delivery notes"',
    `[11]<input> checkbox "I accept the terms and conditions" ${o.terms ? '(checked)' : '(unchecked)'}`,
    '[12]<button> submit "Continue to payment"',
  ].join('\n')

test('form-shipping: radios key only the one to tick; Continue once all hold', () => {
  const k = key('form-shipping', shipping(), `${BASE}/shipping.html`)
  sameSet(k, [2, 3, 4, 5].map((index) => ({ op: 'type', index })).concat([{ op: 'select', index: 6 }, { op: 'click', index: 8 }, { op: 'click', index: 11 }]))
  const done = { name: 'Ada Lovelace', street: "12 St James’s Square", city: 'London', postcode: 'sw1y 4jh', country: 'United Kingdom', express: true, terms: true }
  assert.deepEqual(key('form-shipping', shipping(done), `${BASE}/shipping.html`), [{ op: 'click', index: 12 }])
})

test('form-newsletter: the pre-ticked Deals box is keyed for unticking', () => {
  const reg = [
    '[0]<a> "Northwind Store"',
    '[1]<a> "Privacy"',
    '[2]<input> email "Email address" = "ada@example.com"',
    '[3]<input> "First name" = "Ada"',
    '[4]<input> "Last name" = "Lovelace"',
    '[5]<input> checkbox "Audio" (checked)',
    '[6]<input> checkbox "Kitchen" (unchecked)',
    '[7]<input> checkbox "Deals" (checked)',
    '[8]<button> submit "Subscribe"',
  ].join('\n')
  assert.deepEqual(key('form-newsletter', reg, `${BASE}/signup.html`), [{ op: 'click', index: 7 }])
  assert.deepEqual(key('form-newsletter', reg.replace('"Deals" (checked)', '"Deals" (unchecked)'), `${BASE}/signup.html`), [{ op: 'click', index: 8 }])
})

test('formTargets exposes the per-field targets for assist scoring', () => {
  assert.equal(formTargets('form-shipping')['Express delivery'], true)
  assert.equal(formTargets('form-sales')['Phone number'], '')
  assert.equal(formTargets('nav-returns'), undefined)
})

// ── recorded: help site ───────────────────────────────────────────────────────────────────────
const HELP_NAV = ['[0]<a> "Help home"', '[1]<a> "Shipping"', '[2]<a> "Orders & payments"', '[3]<a> "Contact"']
const HELP_HOME = [...HELP_NAV, '[4]<a> "Shipping & delivery"', '[5]<a> "Orders, payments & returns"', '[6]<a> "Your account"', '[7]<a> "Product warranty"'].join('\n')
const HELP_ORDERS = [...HELP_NAV, '[4]<a> "Payment methods"', '[5]<a> "Cancel an order"', '[6]<a> "Returns & refunds policy"'].join('\n')

test('nav-returns: the help home gives the returns section link', () => {
  const k = key('nav-returns', HELP_HOME, `${BASE}/help/index.html`)
  has(k, 'click', 5)
  lacks(k, 'click', 7)
})

test('nav-returns: the orders page gives the policy link; the policy page is done', () => {
  assert.deepEqual(key('nav-returns', HELP_ORDERS, `${BASE}/help/orders.html`), [{ op: 'click', index: 6 }])
  assert.deepEqual(key('nav-returns', HELP_NAV.join('\n'), `${BASE}/help/returns.html`), [{ op: 'done' }])
})

test('nav-warranty / nav-express: path tables, and a wrong page leads back', () => {
  assert.deepEqual(key('nav-warranty', HELP_HOME, `${BASE}/help/index.html`), [{ op: 'click', index: 7 }])
  assert.deepEqual(key('nav-warranty', HELP_NAV.join('\n'), `${BASE}/help/account.html`), [{ op: 'click', index: 0 }])
  sameSet(key('nav-express', HELP_HOME, `${BASE}/help/index.html`), [{ op: 'click', index: 1 }, { op: 'click', index: 4 }])
  assert.deepEqual(key('nav-express', HELP_NAV.join('\n'), `${BASE}/help/shipping.html`), [{ op: 'done' }])
})

// ── recorded: inbox ───────────────────────────────────────────────────────────────────────────
const INBOX = [
  '[0]<button> submit "Compose"',
  '[1]<a> "Inbox (6)"',
  '[2]<a> "Starred"',
  '[3]<a> "Sent"',
  '[4]<a> "Spam"',
  '[5]<input> search "Search mail"',
  '[6]<a> "Your weekly digest"',
  '[7]<a> "Your November statement is ready"',
  '[8]<a> "Your order has shipped"',
  '[9]<a> "Planned maintenance notice"',
  '[10]<a> "Dinner on Sunday?"',
  '[11]<a> "Book due soon"',
].join('\n')
const OPEN = '[0]<button> submit "Compose"\n[1]<a> "Inbox (6)"\n[2]<a> "Starred"\n[3]<a> "Sent"\n[4]<a> "Spam"\n[5]<button> submit "Back to inbox"\n[6]<button> submit "Reply"\n[7]<button> submit "Forward"\n[8]<button> submit "Archive"'

test('inbox-bill: the inbox gives the statement email', () => {
  assert.deepEqual(key('inbox-bill', INBOX, `${BASE}/inbox.html`), [{ op: 'click', index: 7 }])
})

test('inbox: the open email (named in the fragment) is done when it is the target, else back', () => {
  assert.deepEqual(key('inbox-lookalike', OPEN, `${BASE}/inbox.html#open=your-november-statement-is-ready`), [{ op: 'done' }])
  assert.deepEqual(key('inbox-lookalike', OPEN, `${BASE}/inbox.html#open=save-10-a-month-on-your-energy-bill`), [{ op: 'click', index: 5 }])
  assert.deepEqual(key('inbox-library', INBOX, `${BASE}/inbox.html`), [{ op: 'click', index: 11 }])
})

// ── store ─────────────────────────────────────────────────────────────────────────────────────
const HEADER = (q) => `[0]<a> "Northwind Store"\n[1]<input> search "Search products"${q ? ` = "${q}"` : ''}\n[2]<button> submit "Search"\n[3]<a> "Cart (0)"`
const STORE_HOME = `${HEADER()}\n[4]<a> "Speakers"\n[5]<a> "Kitchen"\n[6]<a> "Earbuds"`
const RESULTS = `${HEADER()}\n[4]<a> "Sonic Air wireless headphones"\n[5]<a> "Arc wireless headphones"\n[6]<a> "Nimbus wireless headphones"\n[7]<a> "Halo noise-cancelling wireless headphones"`
const PRODUCT = (qty = '1') => `${HEADER()}\n[4]<select> select-one "Quantity" = "${qty}"\n[5]<button> submit "Add to cart"\n[6]<button> submit "Save to wishlist"`

test('store: home → type into search (plus the category link that lists the target)', () => {
  assert.deepEqual(key('shop-cheapest', STORE_HOME, `${BASE}/store/index.html`), [{ op: 'type', index: 1 }])
  sameSet(key('shop-qty', STORE_HOME, `${BASE}/store/index.html`), [{ op: 'type', index: 1 }, { op: 'click', index: 4 }])
})

test('store: a filled box that finds the target → Search or Enter; one that does not → retype', () => {
  const k = key('shop-cheapest', `${HEADER('wireless headphones')}\n[4]<a> "Speakers"`, `${BASE}/store/index.html`)
  sameSet(k, [{ op: 'click', index: 2 }, { op: 'press' }])
  assert.ok(matches({ op: 'press', index: 1 }, k), 'an index-less key entry matches any index')
  assert.deepEqual(key('shop-mug', `${HEADER('teapot')}`, `${BASE}/store/index.html`), [{ op: 'type', index: 1 }])
})

test('store: results → the target product link (and done, for the price question)', () => {
  assert.deepEqual(key('shop-cheapest', RESULTS, `${BASE}/store/search.html?q=wireless+headphones`), [{ op: 'click', index: 5 }])
  const earbuds = `${HEADER()}\n[4]<a> "Pulse wireless earbuds"\n[5]<a> "Pulse Pro wireless earbuds"`
  sameSet(key('shop-price', earbuds, `${BASE}/store/search.html?q=pulse`), [{ op: 'click', index: 4 }, { op: 'done' }])
})

test('store: the product page → Quantity when it is wrong, then Add to cart, then done', () => {
  const url = `${BASE}/store/product.html?id=p6`
  assert.deepEqual(key('shop-qty', PRODUCT('1'), url), [{ op: 'select', index: 4 }])
  assert.deepEqual(key('shop-qty', PRODUCT('2'), url), [{ op: 'click', index: 5 }])
  assert.deepEqual(key('shop-qty', PRODUCT('2'), `${url}#added`), [{ op: 'done' }])
  assert.deepEqual(key('shop-cheapest', PRODUCT('1'), `${BASE}/store/product.html?id=p3`), [{ op: 'click', index: 5 }])
  // Another product's page: back to searching.
  assert.deepEqual(key('shop-cheapest', PRODUCT('1'), `${BASE}/store/product.html?id=p1`), [{ op: 'type', index: 1 }])
})

test('dense-catalog: the exact product among look-alikes, or search/scroll when it is off screen', () => {
  const reg = `${HEADER()}\n[4]<a> "Halo Mini wireless speaker"\n[5]<a> "Halo noise-cancelling headphones (wired)"\n[6]<a> "Halo noise-cancelling wireless headphones"\n[7]<a> "Halo wireless earbuds"`
  assert.deepEqual(key('dense-catalog', reg, `${BASE}/store/catalog.html`), [{ op: 'click', index: 6 }])
  sameSet(key('dense-catalog', `${HEADER()}\n[4]<a> "Amber candle"`, `${BASE}/store/catalog.html`), [{ op: 'type', index: 1 }, { op: 'scroll' }])
})

// ── plumbing ──────────────────────────────────────────────────────────────────────────────────
test('unknown task, unknown page or empty registry → [] (scored "no key")', () => {
  assert.deepEqual(key('no-such-task', STORE_HOME, `${BASE}/store/index.html`), [])
  assert.deepEqual(key('shop-cheapest', STORE_HOME, `${BASE}/store/cart.html`), [])
  assert.deepEqual(key('inbox-bill', '', `${BASE}/inbox.html`), [])
  assert.deepEqual(key('form-contact', form(), 'not a url'), [])
})

test('parseRegistry reads type, name, value, checked and sensitive', () => {
  const [a, b, c, d] = parseRegistry('[3]<input> "Full name" = "Ada"\n[8]<input> checkbox "I agree" (checked)\n[12]<input> password "Password" (sensitive)\n[2]<div role=button> "Menu"\n[element list truncated]')
  assert.deepEqual(a, { index: 3, tag: 'input', role: undefined, type: '', name: 'Full name', value: 'Ada', checked: undefined, sensitive: false })
  assert.equal(b.checked, true)
  assert.equal(b.type, 'checkbox')
  assert.equal(c.sensitive, true)
  assert.equal(d.role, 'button')
})

test('every task id has a key table', () => {
  assert.equal(TASK_IDS.length, 16)
  for (const id of TASK_IDS) assert.ok(Array.isArray(key(id, '', `${BASE}/`)))
})
