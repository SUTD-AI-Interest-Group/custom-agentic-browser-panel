import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERACTIVE_ROLES, SENSITIVE_RE, SPLIT_OF, SWIFT_BIC_RAW_RE, bucketViewports, buildRegistry, convertTask, keyFor, originFor, parseCandidate, parseRepr, pickTarget, siteKey, stepGoal,
} from './mind2web-lib.mjs'
import { rng } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const domIndexSrc = fs.readFileSync(path.join(here, '../../src/platform/domIndex.ts'), 'utf8')
const literal = (name) => {
  const m = domIndexSrc.match(new RegExp(`const ${name} =\\s*\\n?\\s*(/.*?/[a-z]*)\\n`))
  if (!m) throw new Error(`${name} not found in domIndex.ts`)
  return m[1]
}

describe('parity with domIndex.ts', () => {
  it('copies the sensitivity and role regexes verbatim', () => {
    expect(`/${SENSITIVE_RE.source}/${SENSITIVE_RE.flags}`).toBe(literal('SENSITIVE_RE'))
    expect(`/${SWIFT_BIC_RAW_RE.source}/${SWIFT_BIC_RAW_RE.flags}`).toBe(literal('SWIFT_BIC_RAW_RE'))
    expect(`/${INTERACTIVE_ROLES.source}/${INTERACTIVE_ROLES.flags}`).toBe(literal('INTERACTIVE_ROLES'))
  })
})

describe('origin and site', () => {
  it('builds a plausible placeholder origin, never a synthetic TLD', () => {
    expect(originFor('exploretock')).toBe('https://www.exploretock.com')
    expect(originFor('recreation.gov')).toBe('https://www.recreation.gov')
  })
  it('keys a site by its first label so ikea.com and ikea collide', () => {
    expect(siteKey('ikea.com')).toBe('ikea')
    expect(siteKey('www.ikea.com')).toBe('ikea')
    expect(siteKey('ikea')).toBe('ikea')
    expect(siteKey('recreation.gov')).toBe('recreation')
  })
})

describe('candidates', () => {
  it('parses attributes and rects; picks the original visible target', () => {
    const c = parseCandidate({ tag: 'LI', is_original_target: true, backend_node_id: '7', attributes: JSON.stringify({ backend_node_id: '7', bounding_box_rect: '179,540,922,40', class: 'x' }) })
    expect(c).toMatchObject({ tag: 'li', nodeId: '7', isOriginal: true, rect: { x: 179, y: 540, width: 922, height: 40 } })
    const hidden = parseCandidate({ tag: 'a', is_original_target: true, attributes: JSON.stringify({ backend_node_id: '8', bounding_box_rect: '-1,-1,-1,-1' }) })
    expect(pickTarget([hidden, c])).toBe(c)
    expect(pickTarget([hidden])).toBeUndefined()
  })
  it("accepts the dataset's own form: a candidate serialised as one JSON string", () => {
    const c = parseCandidate(JSON.stringify({ tag: 'select', is_original_target: true, backend_node_id: '4213', attributes: JSON.stringify({ backend_node_id: '4213', bounding_box_rect: '464,247,156,40' }) }))
    expect(c).toMatchObject({ tag: 'select', nodeId: '4213', isOriginal: true, rect: { x: 464, y: 247, width: 156, height: 40 } })
    expect(pickTarget([c])).toBe(c)
  })
  it('reads a Mind2Web action repr', () => {
    expect(parseRepr('[combobox]  Reservation type -> SELECT: Pickup')).toEqual({ role: 'combobox', name: 'Reservation type', op: 'SELECT', value: 'Pickup' })
    expect(parseRepr('[svg]   -> CLICK')).toEqual({ role: 'svg', name: '', op: 'CLICK', value: '' })
    expect(parseRepr('[textbox]  Find a location -> TYPE: Boston')).toEqual({ role: 'textbox', name: 'Find a location', op: 'TYPE', value: 'Boston' })
  })
})

const HTML = `<html backend_node_id="1">
<head backend_node_id="2"><title backend_node_id="3"><text backend_node_id="4">Acme &amp; Co</text></title></head>
<body backend_node_id="5">
<form backend_node_id="10" aria_label="Search flights">
  <text backend_node_id="11">From</text>
  <input backend_node_id="12" type="text" name="from" placeholder="City or airport" input_value="Boston"/>
  <input backend_node_id="13" type="password" name="pw"/>
  <input backend_node_id="14" name="ccnum" placeholder="Number"/>
  <label backend_node_id="15"><input backend_node_id="16" type="checkbox" name="flex" value="on" input_checked="true"/><text backend_node_id="17">Flexible dates</text></label>
  <select backend_node_id="18" name="type">
    <option backend_node_id="19" value="dine" option_selected="true"><text backend_node_id="20">Dine in</text></option>
    <option backend_node_id="21" value="pickup"><text backend_node_id="22">Pickup</text></option>
  </select>
  <button backend_node_id="23"><text backend_node_id="24">Search</text></button>
  <button backend_node_id="25" type="button"><text backend_node_id="26">Clear</text></button>
</form>
<div backend_node_id="30" role="dialog"><h2 backend_node_id="31"><text backend_node_id="32">Confirm order</text></h2>
  <button backend_node_id="33" type="button"><text backend_node_id="34">Cancel</text></button></div>
<a backend_node_id="40"><text backend_node_id="41">Help</text></a>
<a backend_node_id="42" aria_label="Home"><img backend_node_id="43" alt="Logo"/></a>
<svg backend_node_id="44"></svg>
<ul backend_node_id="50">
  <li backend_node_id="51" class="item"><text backend_node_id="52">Bradley Airport</text></li>
  <li backend_node_id="53" class="item"><text backend_node_id="54">Hartford</text></li>
  <li backend_node_id="55" class="other"><text backend_node_id="56">Sibling, other class</text></li>
</ul>
<div backend_node_id="60" class="item"><text backend_node_id="61">Same class, other tag</text></div>
<p backend_node_id="70"><text backend_node_id="71">Plain paragraph</text></p>
</body></html>`

const cand = (id, tag, extra = {}) => ({ tag, attributes: JSON.stringify({ backend_node_id: String(id), bounding_box_rect: `0,${id * 10},200,20`, ...extra }) })
const ALL = [1, 5, 12, 13, 14, 16, 18, 23, 25, 33, 40, 42, 43, 44, 51, 53, 55, 60, 70].map((id) => {
  const tag = { 1: 'html', 5: 'body', 12: 'input', 13: 'input', 14: 'input', 16: 'input', 18: 'select', 23: 'button', 25: 'button', 33: 'button', 40: 'a', 42: 'a', 43: 'img', 44: 'svg', 51: 'li', 53: 'li', 55: 'li', 60: 'div', 70: 'p' }[id]
  const extra = id === 42 ? { is_clickable: 'true' } : id === 1 ? { bounding_box_rect: '0,0,1280,3000' } : {}
  return parseCandidate(cand(id, tag, extra))
})

describe('buildRegistry', () => {
  const reg = buildRegistry(HTML, ALL, '51')
  const by = Object.fromEntries(reg.elements.map((e) => [e.nodeId, e]))
  it('reads the title (RCDATA tags stripped) and the page height', () => {
    expect(reg.title).toBe('Acme & Co')
    expect(reg.scrollHeight).toBe(3000)
  })
  it('keeps document order and only what domIndex would index, plus the target and its decoys', () => {
    // 51 is the target; 53 and 55 are same-tag siblings under its parent; 60 shares its class but not its tag, so it is not a decoy.
    expect(reg.elements.map((e) => e.nodeId)).toEqual(['12', '13', '14', '16', '18', '23', '25', '33', '40', '42', '51', '53', '55'])
  })
  it('names as production does: aria_label, own text, placeholder, value, title, name — never alt', () => {
    expect(by[12].name).toBe('City or airport')
    expect(by[42].name).toBe('Home')
    expect(by[40].name).toBe('Help')
    expect(by[23].name).toBe('Search')
    expect(by[18].name).toBe('Dine in Pickup')
    expect(by[16].name).toBe('flex') // a toggle's "on" is not a name; the fallback reaches the name attribute, as in production
  })
  it('defaults type like the DOM: a typeless button submits, a typeless input is text', () => {
    expect(by[23].type).toBe('submit')
    expect(by[25].type).toBe('button')
    expect(by[14].type).toBe('text')
    expect(by[18].type).toBe('select-one')
    expect(by[40].type).toBeUndefined()
  })
  it('carries value, checked and the option list', () => {
    expect(by[12].value).toBe('Boston')
    expect(by[16]).toMatchObject({ checked: true })
    expect(by[16].value).toBeUndefined()
    expect(by[18].value).toBe('dine')
    expect(by[18].options).toEqual([{ value: 'dine', text: 'Dine in', selected: true }, { value: 'pickup', text: 'Pickup', selected: false }])
  })
  it('flags sensitive fields by type and by the copied regexes', () => {
    expect(by[13].sensitive).toBe(true)
    expect(by[14].sensitive).toBe(true)
    expect(by[12].sensitive).toBe(false)
  })
  it('records the named ancestor and the enclosing form', () => {
    expect(by[12].ancestorName).toBe('Search flights')
    expect(by[33].ancestorName).toBe('Confirm order')
    expect(by[40].ancestorName).toBeUndefined()
    expect(by[12].form).toBe('10')
    expect(by[40].form).toBeUndefined()
  })
  it('never registers option, html or body, and drops plain text nodes', () => {
    expect(by[1]).toBeUndefined()
    expect(by[5]).toBeUndefined()
    expect(by[70]).toBeUndefined()
  })
  it('without a target, sibling and same-class decoys are not pulled in', () => {
    const r2 = buildRegistry(HTML, ALL, undefined)
    expect(r2.elements.map((e) => e.nodeId)).not.toContain('51')
    expect(r2.elements.map((e) => e.nodeId)).not.toContain('60')
  })
})

// ---------------------------------------------------------------------------
// Viewports, goals, keys and episodes

describe('bucketViewports', () => {
  const el = (nodeId, y, extra = {}) => ({ nodeId, tag: 'a', name: `n${nodeId}`, sensitive: false, rect: { x: 0, y, width: 100, height: 20 }, ...extra })
  it('one window when the target is on the first screen; indices and y are per window', () => {
    const v = bucketViewports({ elements: [el('1', 10), el('2', 600), el('3', 1500)] }, '2', 3000)
    expect(v.viewports).toHaveLength(1)
    expect(v.viewports[0].elements.map((e) => [e.index, e.nodeId, e.y])).toEqual([[0, '1', 10], [1, '2', 600]])
    expect(v).toMatchObject({ targetVp: 0, targetIndex: 1, sameNameOnTop: false })
  })
  it('adds a second window a third of a screen above a below-fold target, clamped to the page', () => {
    const v = bucketViewports({ elements: [el('1', 10), el('2', 1500), el('3', 2900)] }, '3', 3000)
    expect(v.viewports.map((w) => w.scrollY)).toEqual([0, 2280])
    expect(v.viewports[1].elements.map((e) => [e.index, e.nodeId, e.y])).toEqual([[0, '3', 620]])
    expect(v).toMatchObject({ targetVp: 1, targetIndex: 0 })
  })
  it('reports a same-name control on the top screen (scroll_down must then be withheld)', () => {
    const v = bucketViewports({ elements: [el('1', 10, { name: 'Search' }), el('2', 1500, { name: 'search' })] }, '2', 3000)
    expect(v.sameNameOnTop).toBe(true)
  })
  it('caps a window at 200 in document order and reports a target past the cap as absent, never re-ordered', () => {
    const many = Array.from({ length: 205 }, (_, i) => el(String(i), 5 + i))
    const v = bucketViewports({ elements: many }, '204', 3000)
    expect(v.viewports[0].elements).toHaveLength(200)
    expect(v.viewports[0].truncated).toBe(true)
    expect(v.targetIndex).toBeUndefined()
  })
})

describe('keys and goals', () => {
  it('snake-cases names and dedupes', () => {
    const taken = new Set()
    expect(keyFor('Find a location', taken)).toBe('find_a_location')
    expect(keyFor('Find a location', taken)).toBe('find_a_location_2')
    expect(keyFor('', taken)).toBe('value')
    expect(keyFor('A'.repeat(50), taken)).toHaveLength(30)
  })
  it('renders deterministic goals that name the control and, when asked, the value', () => {
    const r = rng('goal')
    const g1 = stepGoal({ op: 'SELECT', roleWord: 'combobox', name: 'Reservation type', value: 'Pickup', withValue: true }, r)
    expect(g1).toMatch(/Pickup/)
    expect(g1).toMatch(/Reservation type/)
    const g2 = stepGoal({ op: 'TYPE', roleWord: 'textbox', name: 'Find a location', value: 'Boston', withValue: false }, r)
    expect(g2).not.toMatch(/Boston/)
    expect(g2).toMatch(/Find a location/)
    const g3 = stepGoal({ op: 'CLICK', roleWord: 'link', name: 'Book Now', value: '', withValue: true }, r)
    expect(g3).toMatch(/Book Now/)
    expect(stepGoal({ op: 'SELECT', roleWord: 'combobox', name: 'Reservation type', value: 'Pickup', withValue: true }, rng('goal'))).toBe(g1)
  })
})

const TASK_HTML = `<html backend_node_id="1"><body backend_node_id="2">
<input backend_node_id="10" type="text" placeholder="Find a location" input_value=""/>
<select backend_node_id="20"><option backend_node_id="21" value="dine" option_selected="true"><text backend_node_id="22">Dine in</text></option><option backend_node_id="23" value="pickup"><text backend_node_id="24">Pickup</text></option></select>
<a backend_node_id="30"><text backend_node_id="31">Book Now</text></a>
<svg backend_node_id="40"></svg></body></html>`
const TAG = { 10: 'input', 20: 'select', 30: 'a', 40: 'svg' }
const C = (id, tag, y, extra = {}) => ({ tag, attributes: JSON.stringify({ backend_node_id: String(id), bounding_box_rect: `0,${y},200,20`, ...extra }) })
const NEG = [C(1, 'html', 0, { bounding_box_rect: '0,0,1280,2000' }), C(10, 'input', 100, { type: 'text', placeholder: 'Find a location' }), C(20, 'select', 200), C(30, 'a', 300), C(40, 'svg', 400)]
const REPRS = ['[textbox]  Find a location -> TYPE: Boston', '[combobox]  Dine in -> SELECT: Pickup', '[link]  Book Now -> CLICK', '[svg]   -> CLICK']
const row = (i, op, pos, value = '', original_op = op) => ({
  split: 'test_website', annotation_id: 'A1', action_uid: `u${i}`, website: 'exploretock', domain: 'Travel', subdomain: 'Restaurant',
  confirmed_task: 'Check for pickup in Boston', action_reprs: REPRS, target_action_index: i, target_action_reprs: REPRS[i],
  operation: { op, original_op, value },
  pos_candidates: pos.map((id) => ({ ...C(id, TAG[id], id * 10, id === 10 ? { type: 'text', placeholder: 'Find a location' } : {}), is_original_target: true })),
  neg_candidates: NEG.filter((c) => !pos.includes(Number(JSON.parse(c.attributes).backend_node_id))), cleaned_html: TASK_HTML,
})

describe('convertTask', () => {
  const rows = [row(2, 'CLICK', [30]), row(0, 'TYPE', [10], 'Boston'), row(1, 'SELECT', [20], 'Pickup'), row(3, 'CLICK', [40])]
  const out = convertTask(rows, { rng: rng('t') })
  it('orders rows by target_action_index whatever order they arrive in, one page per converted step', () => {
    expect(out.pages.map((p) => p.stepIndex)).toEqual([0, 1, 2])
    expect(out.pages[0]).toMatchObject({ pageId: 'm2w:A1:u0', site: 'exploretock', split: 'val', category: 'Travel', originPlaceholder: true, viewportInferred: true, innerHeight: 720 })
    expect(out.pages[0].viewports[0]).toMatchObject({ scrollY: 0, origin: 'https://www.exploretock.com', url: 'https://www.exploretock.com/' })
  })
  it('skips the unnamed svg click and counts it', () => {
    expect(out.skipped['unnamed-target']).toBe(1)
  })
  it('emits step-goal and task-goal episodes with the human op and the task values as history', () => {
    const eps = out.episodes.filter((e) => e.pageId === 'm2w:A1:u2')
    const step = eps.find((e) => e.goalKind === 'step' && e.kind === 'target')
    expect(step).toMatchObject({ op: 'CLICK', label: 2, values: {}, steps: [], writer: 'dataset:mind2web', corpus: 'mind2web' })
    expect(step.goal).toMatch(/Book Now/)
    const task = eps.find((e) => e.goalKind === 'task' && e.kind === 'target')
    expect(task.goal).toBe('Check for pickup in Boston')
    expect(Object.keys(task.values).sort()).toEqual(['dine_in', 'find_a_location'])
    expect(task.steps).toEqual([
      { action: 'type', index: 0, label: 'Find a location', valueKey: 'find_a_location' },
      { action: 'select', index: 1, label: 'Dine in', valueKey: 'dine_in' },
    ])
  })
  it('gives TYPE/SELECT steps a value row when two keys exist and a BLOCKED row when the goal hides the value', () => {
    const eps = out.episodes.filter((e) => e.pageId === 'm2w:A1:u1')
    const value = eps.find((e) => e.kind === 'value' && e.goalKind === 'task')
    expect(value).toMatchObject({ field: 1, label: 'dine_in' })
    const stepTarget = eps.find((e) => e.kind === 'target' && e.goalKind === 'step')
    expect(stepTarget.values.dine_in).toBe('Pickup')
    const blocked = out.episodes.filter((e) => e.kind === 'move' && e.label === 'BLOCKED')
    for (const b of blocked) expect(b.goal).not.toMatch(/Boston|Pickup/)
  })
  it('counts a SELECT value that is not among the options and keeps the option list', () => {
    const bad = convertTask([row(1, 'SELECT', [20], 'Takeaway')], { rng: rng('t') })
    expect(bad.warnings['select-value-not-in-options']).toBe(1)
    expect(bad.pages[0].viewports[0].elements.find((e) => e.tag === 'select').options.map((o) => o.text)).toEqual(['Dine in', 'Pickup'])
  })
  it('skips ENTER, empty targets and op/tag mismatches with a reason each', () => {
    const r = convertTask([row(2, 'CLICK', [30], '', 'ENTER'), row(0, 'TYPE', []), row(1, 'SELECT', [30], 'x')], { rng: rng('t') })
    expect(r.skipped).toMatchObject({ enter: 1, 'no-target': 1, 'op-mismatch:SELECT:a': 1 })
    expect(r.pages).toHaveLength(0)
  })
  it('emits scroll_down for a below-fold target unless a same-name control is on top', () => {
    const low = row(2, 'CLICK', [30])
    low.pos_candidates[0].attributes = JSON.stringify({ backend_node_id: '30', bounding_box_rect: '0,1500,200,20' })
    const r = convertTask([low], { rng: rng('t') })
    const scroll = r.episodes.filter((e) => e.label === 'scroll_down')
    expect(scroll.map((e) => e.goalKind).sort()).toEqual(['step', 'task'])
    expect(scroll[0]).toMatchObject({ vp: 0, kind: 'move' })
    expect(r.episodes.find((e) => e.kind === 'target').vp).toBe(1)
    const dup = row(2, 'CLICK', [30])
    dup.pos_candidates[0].attributes = JSON.stringify({ backend_node_id: '30', bounding_box_rect: '0,1500,200,20' })
    dup.cleaned_html = TASK_HTML.replace('<svg backend_node_id="40"></svg>', '<a backend_node_id="40"><text backend_node_id="41">Book now</text></a>')
    dup.neg_candidates = [...dup.neg_candidates.filter((c) => JSON.parse(c.attributes).backend_node_id !== '40'), C(40, 'a', 50)]
    expect(convertTask([dup], { rng: rng('t') }).episodes.some((e) => e.label === 'scroll_down')).toBe(false)
  })
  it('names a skipped unnamed prior step "(unnamed)" in later histories, as production renders one', () => {
    const unnamedFirst = { ...row(3, 'CLICK', [40]), target_action_index: 0, action_uid: 'x0' }
    const r = convertTask([unnamedFirst, row(2, 'CLICK', [30])], { rng: rng('t') })
    const task = r.episodes.find((e) => e.goalKind === 'task' && e.kind === 'target')
    expect(task.steps).toEqual([{ action: 'click', label: '(unnamed)' }])
  })
  it('maps every Mind2Web split', () => {
    expect(SPLIT_OF).toEqual({ train: 'train', test_task: 'train', test_domain: 'train', test_website: 'val' })
  })
})
