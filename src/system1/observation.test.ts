import { describe, it, expect } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { buildControl, buildObservation, observationHash, opFor } from './observation'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement
const snap = (elements: IndexedElement[], over: Partial<PageSnapshot> = {}): PageSnapshot =>
  ({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: '', truncated: false, ...over })

describe('opFor', () => {
  it('maps elements to the operation they imply', () => {
    expect(opFor(el(0))).toBe('click')
    expect(opFor(el(0, { tag: 'a' }))).toBe('click')
    expect(opFor(el(0, { tag: 'input', type: 'email' }))).toBe('type')
    expect(opFor(el(0, { tag: 'input', type: 'checkbox' }))).toBe('click')
    expect(opFor(el(0, { tag: 'textarea' }))).toBe('type')
    expect(opFor(el(0, { tag: 'select' }))).toBe('select')
    expect(opFor(el(0, { tag: 'div', role: 'textbox' }))).toBe('type')
  })
})

describe('buildControl', () => {
  it('derives a role from tag/type when the page gives none, and keeps a page role verbatim', () => {
    expect(buildControl(el(0), undefined).role).toBe('button')
    expect(buildControl(el(0, { tag: 'a' }), undefined).role).toBe('link')
    expect(buildControl(el(0, { tag: 'input', type: 'email' }), undefined).role).toBe('email field')
    expect(buildControl(el(0, { tag: 'input', type: 'text' }), undefined).role).toBe('textbox')
    expect(buildControl(el(0, { tag: 'input', type: 'submit' }), undefined).role).toBe('button')
    expect(buildControl(el(0, { tag: 'select' }), undefined).role).toBe('combobox')
    expect(buildControl(el(0, { tag: 'div', role: 'menuitem' }), undefined).role).toBe('menuitem')
  })

  it('gives a button click only, a field click + type, a select click + select', () => {
    expect(buildControl(el(0), undefined).actions).toEqual(['click'])
    expect(buildControl(el(0, { tag: 'input', type: 'email' }), undefined).actions).toEqual(['click', 'type_text'])
    expect(buildControl(el(0, { tag: 'select' }), undefined).actions).toEqual(['click', 'select_option'])
  })

  it('withholds every action from a disabled control and type_text from a read-only field', () => {
    const disabled = buildControl(el(0, { disabled: true }), undefined)
    expect(disabled.actions).toEqual([])
    expect(disabled.states.enabled).toBe(false)
    const ro = buildControl(el(0, { tag: 'input', type: 'text', readonly: true }), undefined)
    expect(ro.actions).toEqual(['click'])
    expect(ro.states.editable).toBe(false)
  })

  it('lists a sensitive control with no actions and no value', () => {
    const c = buildControl(el(0, { tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }), undefined)
    expect(c.sensitive).toBe(true)
    expect(c.actions).toEqual([])
    expect(c.value).toBeUndefined()
    expect(c.role).toBe('password field')
  })

  it('carries checked state for a toggle instead of its submit token', () => {
    const c = buildControl(el(0, { tag: 'input', type: 'checkbox', value: 'on', checked: false }), undefined)
    expect(c.checked).toBe(false)
    expect(c.value).toBeUndefined()
  })

  it('carries value, group, focus and a fingerprint matching hasElementChanged fields', () => {
    const c = buildControl(el(3, { tag: 'input', type: 'text', name: 'First name', value: 'Ada', ancestorName: 'Passenger details', href: undefined }), 3)
    expect(c.value).toBe('Ada')
    expect(c.group).toBe('Passenger details')
    expect(c.states.focused).toBe(true)
    expect(c.fingerprint).toEqual({ tag: 'input', type: 'text', name: 'First name', href: undefined, sensitive: false })
    const box = buildControl(el(3, { tag: 'input', type: 'checkbox', name: 'Agree', value: 'on', checked: false }), undefined)
    expect(box.fingerprint).toMatchObject({ checked: false })
    const off = buildControl(el(4, { name: 'Search', disabled: true }), undefined)
    expect(off.fingerprint).toMatchObject({ disabled: true })
  })
})

describe('buildObservation', () => {
  it('reads scroll state from the snapshot and assumes both directions without it', () => {
    const top = buildObservation(snap([], { scroll: { y: 0, max: 500 } }))
    expect(top.state).toMatchObject({ canScrollUp: false, canScrollDown: true })
    const bottom = buildObservation(snap([], { scroll: { y: 500, max: 500 } }))
    expect(bottom.state).toMatchObject({ canScrollUp: true, canScrollDown: false })
    const flat = buildObservation(snap([], { scroll: { y: 0, max: 0 } }))
    expect(flat.state).toMatchObject({ canScrollUp: false, canScrollDown: false })
    const unknown = buildObservation(snap([]))
    expect(unknown.state).toMatchObject({ canScrollUp: true, canScrollDown: true })
  })

  it('hashes url and control semantics, not scroll position', () => {
    const a = buildObservation(snap([el(0), el(1, { tag: 'input', type: 'text', value: '' })], { scroll: { y: 0, max: 100 } }))
    const scrolled = buildObservation(snap([el(0), el(1, { tag: 'input', type: 'text', value: '' })], { scroll: { y: 50, max: 100 } }))
    const typed = buildObservation(snap([el(0), el(1, { tag: 'input', type: 'text', value: 'Ada' })]))
    const other = buildObservation(snap([el(0), el(1, { tag: 'input', type: 'text', value: '' })], { url: 'https://shop.example/cart' }))
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(scrolled.hash).toBe(a.hash)
    expect(typed.hash).not.toBe(a.hash)
    expect(other.hash).not.toBe(a.hash)
  })

  it('observationHash is a pure function of its inputs', () => {
    const c = buildObservation(snap([el(0)])).controls
    expect(observationHash('u', c)).toBe(observationHash('u', c))
  })
})
