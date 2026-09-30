import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERACTIVE_ROLES, SENSITIVE_RE, SWIFT_BIC_RAW_RE, buildRegistry, originFor, parseCandidate, parseRepr, pickTarget, siteKey,
} from './mind2web-lib.mjs'

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
