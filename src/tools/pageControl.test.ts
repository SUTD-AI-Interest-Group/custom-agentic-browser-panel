import { describe, it, expect } from 'vitest'
import { hasElementChanged, isPointOfNoReturn } from './pageControl'
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

describe('isPointOfNoReturn — click, blind controls (no href, no accessible name)', () => {
  // el.type is a native-IDL-only property: it silently reads as `undefined` on
  // anything that isn't a real <button>/<input>/<select>, and accessibleName()
  // returns '' for an icon-only control with no aria-label/text/title/name. A
  // <div role="button">, a plain onclick-driven <span>, or a <button
  // type="button"> wired to a destructive JS handler all report exactly this
  // shape — type undefined, name '' — which sails past every other check in
  // isPointOfNoReturn with no signal at all. These must all be flagged.
  it('flags an ARIA-role div button with a destructive handler and no accessible name', () => {
    const target = el({ tag: 'div', role: 'button', type: undefined, name: '' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags a plain onclick-driven span with no role and no name', () => {
    const target = el({ tag: 'span', role: undefined, type: undefined, name: '' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags a native <button type="button"> icon button with no accessible name', () => {
    const target = el({ tag: 'button', type: 'button', name: '' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags an <a> with no href and no name (JS-navigated, not a real link)', () => {
    const target = el({ tag: 'a', href: '', name: '' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('flags a role=tab/switch/menuitem control with no accessible name, not just role=button', () => {
    for (const role of ['tab', 'switch', 'menuitem', 'option']) {
      const target = el({ tag: 'div', role, name: '' })
      expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN), `role=${role}`).toBe(true)
    }
  })

  // Boundary: the new check must not swallow the existing, more permissive
  // behavior for controls that CAN be described.
  it('does not flag an ARIA button that has an accessible name', () => {
    const target = el({ tag: 'div', role: 'button', name: 'Toggle menu' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })

  it('does not flag a same-origin link with a real href even when it has no visible text', () => {
    const target = el({ tag: 'a', name: '', href: `${ORIGIN}/x` })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })
})

// (S2) COMMITTING_NAME was English-word-only: an emoji-only or non-English
// label is non-empty (clears isBlindClick) and matches no English word
// (clears COMMITTING_NAME) — both nets miss at once. These are the exact
// repro shapes from the adversarial review.
describe('isPointOfNoReturn — click, emoji-only committing names (S2)', () => {
  it('flags common committing icons with no text label at all', () => {
    for (const name of ['🗑️', '🗑', '🛒', '💳', '✅']) {
      const target = el({ tag: 'div', role: 'button', name })
      expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN), `expected "${name}" to be flagged`).toBe(true)
    }
  })
})

describe('isPointOfNoReturn — click, non-English committing names (S2)', () => {
  it('flags committing verbs in major non-English languages', () => {
    const names = [
      'Löschen', // German: delete
      'Kaufen', // German: buy
      'Supprimer', // French: delete
      'Confirmer', // French: confirm
      'Eliminar', // Spanish: delete
      'Comprar', // Spanish: buy
      'Confermare', // Italian: confirm
      'Удалить', // Russian: delete
      '削除', // Japanese: delete
      '购买', // Chinese: buy
      'حذف', // Arabic: delete
    ]
    for (const name of names) {
      const target = el({ tag: 'button', type: 'button', name })
      expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN), `expected "${name}" to be flagged`).toBe(true)
    }
  })
})

// (S3) Event delegation: a container attaches one handler and dispatches by
// target, so the clicked descendant (an icon, a row's plain text) can carry
// an innocuous name of its own while the ancestor that actually defines what
// happens — a <form>'s own aria-label, a dialog's title, or the nearest
// independently-clickable ancestor's own aria-label — says otherwise.
// domIndex.ts's ancestorNameOf computes this as a raw DOM fact; the
// classifier's job (tested here) is to treat a committing ancestor name the
// same way it treats the element's own name.
describe('isPointOfNoReturn — click, delegated ancestor committing context (S3)', () => {
  it('flags a click on an innocuously-named descendant whose delegated container self-describes as committing', () => {
    const target = el({ tag: 'span', name: 'Row 42', ancestorName: 'Delete row' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(true)
  })

  it('does not flag when the ancestor name is benign — being inside SOME container is not itself committing', () => {
    const target = el({ tag: 'span', name: 'Row 42', ancestorName: 'Recent activity' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })

  it('does not flag merely sitting inside an unlabelled or benignly-labelled form (card-fatigue guard)', () => {
    const target = el({ tag: 'button', type: 'button', name: 'Show details', ancestorName: 'Contact form' })
    expect(isPointOfNoReturn(spec({ action: 'click', index: 0 }), target, ORIGIN)).toBe(false)
  })
})

describe('hasElementChanged (F4 — approval card re-validation)', () => {
  const base = el({ tag: 'button', type: 'button', name: 'Delete my account' })

  it('is false when nothing meaningful changed', () => {
    expect(hasElementChanged(base, { ...base })).toBe(false)
  })

  it('ignores value/rect drift — these change on every ordinary reflow, not just a swapped element', () => {
    const after = { ...base, value: 'something typed', rect: { x: 999, y: 999, width: 1, height: 1 } }
    expect(hasElementChanged(base, after)).toBe(false)
  })

  it('is true when the name changed (e.g. an async price recalculation relabeled the button)', () => {
    expect(hasElementChanged(base, { ...base, name: 'Apply discount' })).toBe(true)
  })

  it('is true when the type changed', () => {
    expect(hasElementChanged(base, { ...base, type: 'submit' })).toBe(true)
  })

  it('is true when the href changed', () => {
    const withHref = el({ tag: 'a', name: 'Docs', href: 'https://example.test/a' })
    expect(hasElementChanged(withHref, { ...withHref, href: 'https://evil.test/x' })).toBe(true)
  })

  it('is true when sensitivity changed', () => {
    expect(hasElementChanged(base, { ...base, sensitive: true })).toBe(true)
  })

  it('is true when the tag changed', () => {
    expect(hasElementChanged(base, { ...base, tag: 'div' })).toBe(true)
  })

  it('is true when the element disappeared, or a different one now occupies the same index', () => {
    expect(hasElementChanged(base, undefined)).toBe(true)
    expect(hasElementChanged(undefined, base)).toBe(true)
  })

  it('is false when there was never a target element on either side (e.g. a navigate spec)', () => {
    expect(hasElementChanged(undefined, undefined)).toBe(false)
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
