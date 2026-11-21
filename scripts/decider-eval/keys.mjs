// Answer keys for the decider eval: from a fixture's live state (the element registry the agent
// saw, plus the page URL) to the SET of correct next actions. Both the chat model's ControlPage
// call and the decider's top option are scored against it — agreement between the two says
// nothing when the chat model is wrong, a key does.
//
// Everything is matched by element LABEL (the quoted accessible name in the registry), never by a
// remembered index, so a key keeps working when a page renders its elements in another order.
// Pure: no I/O, no browser. An unrecognised state returns [] — scored "no key" and excluded.

/** @typedef {{ op: 'click' | 'type' | 'select' | 'press' | 'scroll' | 'done', index?: number }} KeyAction */

const LINE = /^\[(\d+)\]<(\w+)(?: role=(\S+))?>\s*(.*)$/

/** One registry line → {index, tag, role, type, name, value, checked, sensitive}. */
function parseLine(line) {
  const m = LINE.exec(line.trim())
  if (!m) return null
  let s = m[4].trim()
  const flag = (f) => {
    const re = new RegExp(`\\s*\\(${f}\\)$`)
    if (!re.test(s)) return false
    s = s.replace(re, '')
    return true
  }
  // serializeRegistry's order is: type, "name", = "value", (checked|unchecked), (sensitive).
  const sensitive = flag('sensitive')
  const checked = flag('checked') ? true : flag('unchecked') ? false : undefined
  let type = ''
  if (s && !s.startsWith('"') && !s.startsWith('= "')) {
    const sp = s.indexOf(' ')
    type = sp < 0 ? s : s.slice(0, sp)
    s = sp < 0 ? '' : s.slice(sp + 1)
  }
  let name = ''
  let value
  if (s.startsWith('"')) {
    const j = s.indexOf('" = "', 1)
    if (j >= 0) {
      name = s.slice(1, j)
      value = s.slice(j + 5).replace(/"$/, '')
    } else name = s.slice(1).replace(/"$/, '')
  } else if (s.startsWith('= "')) value = s.slice(3).replace(/"$/, '')
  return { index: Number(m[1]), tag: m[2], role: m[3], type, name, value, checked, sensitive }
}

export function parseRegistry(text) {
  return String(text ?? '')
    .split('\n')
    .map(parseLine)
    .filter(Boolean)
}

/** Case-, space- and apostrophe-insensitive text comparison. */
const norm = (s) =>
  String(s ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const act = (op, index) => (index === undefined ? { op } : { op, index })
const DONE = { op: 'done' }

/** True when `a` is in the key. A key entry without an index (press, scroll, done) matches any index. */
export function matches(a, keyActions) {
  if (!a || !keyActions?.length) return false
  return keyActions.some((k) => k.op === a.op && (k.index === undefined || k.index === a.index))
}

const isCheckable = (e) => e.tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')
const isTypeable = (e) => e.tag === 'textarea' || (e.tag === 'input' && !isCheckable(e) && !['submit', 'button', 'reset', 'image', 'file'].includes(e.type))
const byName = (els, name, pred = () => true) => els.find((e) => norm(e.name) === norm(name) && pred(e))
const link = (els, name) => byName(els, name, (e) => e.tag === 'a' || e.role === 'link')
const button = (els, name) => byName(els, name, (e) => e.tag === 'button' || e.role === 'button' || (e.tag === 'input' && e.type === 'submit'))

// ── store ─────────────────────────────────────────────────────────────────────────────────────
// `category`: the store home's category link whose results list the target — as correct a first
// move as searching, so it is in the key too.
const STORE = {
  'shop-cheapest': { product: 'Arc wireless headphones', id: 'p3', qty: 1 },
  'shop-qty': { product: 'Orbit wireless speaker', id: 'p6', qty: 2, category: 'Speakers' },
  'shop-mug': { product: 'Aurora mug (blue)', id: 'p8', qty: 1, category: 'Kitchen' },
  'shop-price': { product: 'Pulse wireless earbuds', id: 'p5', retrieval: true, category: 'Earbuds' },
  'dense-catalog': { product: 'Halo noise-cancelling wireless headphones', id: 'p7', qty: 1 },
}

/** The store's own search (fixtures/store/search.html): every word, plural-stripped, is a substring. */
function searchFinds(query, product) {
  const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => product.toLowerCase().includes(w.replace(/s$/, '')))
}

function storeKey(t, els, u) {
  const file = u.pathname.split('/').pop()
  if (file === 'product.html' && u.searchParams.get('id') === t.id) {
    if (t.retrieval || u.hash === '#added') return [DONE]
    const qty = byName(els, 'Quantity', (e) => e.tag === 'select')
    if (qty && (qty.value ?? '1') !== String(t.qty)) return [act('select', qty.index)]
    const add = button(els, 'Add to cart')
    return add ? [act('click', add.index)] : []
  }
  if (file === 'cart.html') return []
  const target = link(els, t.product)
  if (target) return t.retrieval && file === 'search.html' ? [act('click', target.index), DONE] : [act('click', target.index)]
  const box = byName(els, 'Search products', isTypeable)
  if (!box) return []
  if (box.value && searchFinds(box.value, t.product)) {
    const go = button(els, 'Search')
    return [...(go ? [act('click', go.index)] : []), act('press')]
  }
  const out = [act('type', box.index)]
  const cat = t.category && file === 'index.html' ? link(els, t.category) : undefined
  if (cat) out.push(act('click', cat.index))
  if (file === 'catalog.html') out.push(act('scroll'))
  return out
}

// ── forms ─────────────────────────────────────────────────────────────────────────────────────
// Targets by field label: a string for text fields and selects, a boolean for checkboxes/radios.
// A field with no entry is "don't care" — never keyed, never blocking. A radio is only listed
// when it should end up ticked (ticking its sibling is how it gets unticked).
const FORMS = {
  'form-contact': {
    file: 'form.html',
    submit: 'Send message',
    fields: {
      'Full name': 'Ada Lovelace',
      'Email address': 'ada@example.com',
      Topic: 'Billing',
      'How can we help?': 'My last invoice was charged twice.',
      'I agree to be contacted about my request': true,
      'Send me the monthly newsletter': false,
    },
  },
  'form-sales': {
    file: 'form.html',
    submit: 'Send message',
    fields: {
      'Full name': 'Ada Lovelace',
      'Email address': 'ada@example.com',
      'Phone number': '',
      Topic: 'Sales',
      'How can we help?': 'Do you offer volume discounts?',
      'Send me the monthly newsletter': false,
    },
  },
  'form-shipping': {
    file: 'shipping.html',
    submit: 'Continue to payment',
    fields: {
      'Full name': 'Ada Lovelace',
      'Street address': "12 St James's Square",
      City: 'London',
      Postcode: 'SW1Y 4JH',
      Country: 'United Kingdom',
      'Express delivery': true,
      'I accept the terms and conditions': true,
    },
  },
  'form-newsletter': {
    file: 'signup.html',
    submit: 'Subscribe',
    fields: {
      'Email address': 'ada@example.com',
      'First name': 'Ada',
      'Last name': 'Lovelace',
      Audio: true,
      Kitchen: false,
      Deals: false,
    },
  },
}

/** The per-field targets of a form task ({label: string | boolean}), or undefined. */
export function formTargets(taskId) {
  return FORMS[taskId] ? { ...FORMS[taskId].fields } : undefined
}

function formKey(f, els, u) {
  if (u.pathname.split('/').pop() !== f.file) return []
  if (u.hash === '#submitted') return [DONE]
  const pending = []
  let missing = false
  for (const [label, want] of Object.entries(f.fields)) {
    const e = byName(els, label, (x) => x.tag === 'input' || x.tag === 'select' || x.tag === 'textarea')
    if (!e) {
      missing = true
      continue
    }
    if (typeof want === 'boolean') {
      if (!isCheckable(e)) continue
      const on = e.checked === true
      if (on === want) continue
      if (e.type === 'radio' && !want) continue
      pending.push(act('click', e.index))
    } else if (e.tag === 'select') {
      if (norm(e.value) !== norm(want)) pending.push(act('select', e.index))
    } else if (norm(e.value) !== norm(want)) pending.push(act('type', e.index))
  }
  if (pending.length || missing) return pending
  const submit = button(els, f.submit)
  return submit ? [act('click', submit.index)] : []
}

// ── navigation ────────────────────────────────────────────────────────────────────────────────
// Per page: the link labels that lead toward the target page. '*' covers every other help page.
const NAV = {
  'nav-returns': {
    target: 'returns.html',
    via: { 'index.html': ['Orders, payments & returns', 'Orders & payments'], 'orders.html': ['Returns & refunds policy'], '*': ['Orders & payments'] },
  },
  'nav-warranty': { target: 'warranty.html', via: { 'index.html': ['Product warranty'], '*': ['Help home'] } },
  'nav-express': { target: 'shipping.html', via: { 'index.html': ['Shipping & delivery', 'Shipping'], '*': ['Shipping'] } },
}

function navKey(n, els, u) {
  if (!u.pathname.includes('/help/')) return []
  const file = u.pathname.split('/').pop() || 'index.html'
  if (file === n.target) return [DONE]
  return (n.via[file] ?? n.via['*'])
    .map((label) => link(els, label))
    .filter(Boolean)
    .map((e) => act('click', e.index))
}

// ── inbox ─────────────────────────────────────────────────────────────────────────────────────
const INBOX = {
  'inbox-bill': 'Your November statement is ready',
  'inbox-order': 'Your order has shipped',
  'inbox-library': 'Book due soon',
  'inbox-lookalike': 'Your November statement is ready',
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function inboxKey(subject, els, u) {
  if (u.pathname.split('/').pop() !== 'inbox.html') return []
  const open = /^#open=(.+)$/.exec(u.hash)
  if (open) {
    if (open[1] === slug(subject)) return [DONE]
    const back = button(els, 'Back to inbox')
    return back ? [act('click', back.index)] : []
  }
  const row = link(els, subject)
  return row ? [act('click', row.index)] : []
}

export const TASK_IDS = [...Object.keys(STORE), ...Object.keys(FORMS), ...Object.keys(NAV), ...Object.keys(INBOX)]

/**
 * The set of correct next actions for `taskId` in the state described by the registry text and
 * the page URL. [] when the state is unknown.
 * @returns {KeyAction[]}
 */
export function key(taskId, registryText, url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return []
  }
  const els = parseRegistry(registryText)
  if (STORE[taskId]) return storeKey(STORE[taskId], els, u)
  if (FORMS[taskId]) return formKey(FORMS[taskId], els, u)
  if (NAV[taskId]) return navKey(NAV[taskId], els, u)
  if (INBOX[taskId]) return inboxKey(INBOX[taskId], els, u)
  return []
}
