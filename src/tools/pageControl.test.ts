import { describe, it, expect } from 'vitest'
import { isPointOfNoReturn } from './pageControl'
import type { ControlSpec } from './pageControl'
import type { IndexedElement } from '../platform/domIndex'

const ORIGIN = 'https://example.test'

/** Minimal IndexedElement factory — only the fields the classifier reads matter. */
function el(over: Partial<IndexedElement> = {}): IndexedElement {
  return {
    index: 0,
    tag: 'button',
    name: '',
    sensitive: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...over,
  }
}

function spec(over: Partial<ControlSpec> = {}): ControlSpec {
  return { action: 'click', ...over }
}

describe('isPointOfNoReturn — click, committing names', () => {
  it('flags a same-origin button named "Delete my account" even though type is not submit', () => {
    const target = el({ tag: 'button', type: 'button', name: 'Delete my account' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('does not flag a benign same-origin "Read more" link', () => {
    const target = el({ tag: 'a', name: 'Read more', href: `${ORIGIN}/article` })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })

  it('flags the full committing-name vocabulary, mirroring browsePolicy intent', () => {
    const names = [
      'Buy now',
      'Add to cart',
      'Add to bag',
      'Proceed to checkout',
      'Pay now',
      'Payment',
      'Order now',
      'Place order',
      'Subscribe',
      'Unsubscribe',
      'Donate',
      'Sign up',
      'Signup',
      'Register',
      'Log in',
      'Login',
      'Sign in',
      'Signin',
      'Delete',
      'Remove item',
      'Cancel subscription',
      'Confirm order',
      'Apply now',
      'Submit application',
      'Continue',
    ]
    for (const name of names) {
      const target = el({ tag: 'button', type: 'button', name })
      expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN), `expected "${name}" to be flagged`).toBe(true)
    }
  })
})

describe('isPointOfNoReturn — click, structural checks', () => {
  it('flags a cross-origin href', () => {
    const target = el({ tag: 'a', name: 'External site', href: 'https://other.test/x' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('does not flag a same-origin href on a benign link', () => {
    const target = el({ tag: 'a', name: 'Docs', href: `${ORIGIN}/docs` })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })

  it('flags an element with type=submit even with a benign name', () => {
    const target = el({ tag: 'button', type: 'submit', name: 'Go' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags an element with type=image', () => {
    const target = el({ tag: 'input', type: 'image', name: 'Go' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('does not flag a click with no target element', () => {
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), undefined, ORIGIN)).toBe(false)
  })
})

describe('isPointOfNoReturn — sensitive elements', () => {
  it('flags any action on a sensitive element', () => {
    const target = el({ tag: 'input', type: 'text', name: 'Card number', sensitive: true })
    expect(isPointOfNoReturn(spec({ action: 'type', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags a model self-flagged spec regardless of the element', () => {
    expect(isPointOfNoReturn(spec({ action: 'type', index: 0, sensitive: true }), undefined, ORIGIN)).toBe(true)
  })
})

describe('isPointOfNoReturn — press', () => {
  it('flags Enter', () => {
    expect(isPointOfNoReturn(spec({ action: 'press', keys: 'Enter' }), undefined, ORIGIN)).toBe(true)
  })

  it('does not flag other keys', () => {
    expect(isPointOfNoReturn(spec({ action: 'press', keys: 'Tab' }), undefined, ORIGIN)).toBe(false)
  })
})

describe('isPointOfNoReturn — navigate', () => {
  it('flags cross-origin navigation', () => {
    expect(isPointOfNoReturn(spec({ action: 'navigate', url: 'https://other.test/x' }), undefined, ORIGIN)).toBe(true)
  })

  it('does not flag same-origin navigation', () => {
    expect(isPointOfNoReturn(spec({ action: 'navigate', url: `${ORIGIN}/next` }), undefined, ORIGIN)).toBe(false)
  })

  it('does not flag a navigate spec with no url', () => {
    expect(isPointOfNoReturn(spec({ action: 'navigate' }), undefined, ORIGIN)).toBe(false)
  })
})

describe('isPointOfNoReturn — other actions', () => {
  it('does not flag scroll, select, highlight, or wait', () => {
    expect(isPointOfNoReturn(spec({ action: 'scroll', direction: 'down' }), undefined, ORIGIN)).toBe(false)
    expect(isPointOfNoReturn(spec({ action: 'select', index: 0, value: 'a' }), el({ tag: 'select' }), ORIGIN)).toBe(false)
    expect(isPointOfNoReturn(spec({ action: 'highlight', index: 0 }), el({ name: 'Delete' }), ORIGIN)).toBe(false)
    expect(isPointOfNoReturn(spec({ action: 'wait' }), undefined, ORIGIN)).toBe(false)
  })
})
