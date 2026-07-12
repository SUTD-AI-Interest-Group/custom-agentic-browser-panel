import { describe, it, expect } from 'vitest'
import { isSafeResearchAction, isSearchInput } from './browsePolicy'
import type { IndexedElement } from '../platform/domIndex'

/** Minimal IndexedElement factory — only the fields the policy reads matter. */
function el(over: Partial<IndexedElement> = {}): IndexedElement {
  return {
    index: 0,
    tag: 'a',
    name: '',
    sensitive: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...over,
  }
}

describe('isSearchInput', () => {
  it('accepts type=search, role=searchbox, and search-shaped names', () => {
    expect(isSearchInput(el({ tag: 'input', type: 'search' }))).toBe(true)
    expect(isSearchInput(el({ tag: 'input', role: 'searchbox' }))).toBe(true)
    expect(isSearchInput(el({ tag: 'input', type: 'text', name: 'Search docs' }))).toBe(true)
    expect(isSearchInput(el({ tag: 'input', type: 'text', name: 'Filter results' }))).toBe(true)
    expect(isSearchInput(el({ tag: 'input', type: 'text', name: 'Find a package' }))).toBe(true)
  })

  it('rejects ordinary and credential inputs', () => {
    expect(isSearchInput(el({ tag: 'input', type: 'text', name: 'Full name' }))).toBe(false)
    expect(isSearchInput(el({ tag: 'input', type: 'email', name: 'Email address' }))).toBe(false)
    expect(isSearchInput(el({ tag: 'input', type: 'password', name: 'Password', sensitive: true }))).toBe(false)
    // A search-shaped NAME must not override a credential TYPE.
    expect(isSearchInput(el({ tag: 'input', type: 'password', name: 'search', sensitive: true }))).toBe(false)
  })
})

describe('isSafeResearchAction — click', () => {
  it('allows links, tabs, accordions, and pagination', () => {
    expect(isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'a', name: 'Pricing', href: 'https://x.test/p' })).ok).toBe(true)
    expect(isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'button', role: 'tab', name: 'Annual' })).ok).toBe(true)
    expect(isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'button', name: 'Show more' })).ok).toBe(true)
    expect(isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'a', name: 'Next page' })).ok).toBe(true)
  })

  it('denies sensitive elements outright', () => {
    const v = isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'input', type: 'password', sensitive: true }))
    expect(v.ok).toBe(false)
  })

  it('denies a submit control inside a POST form', () => {
    const v = isSafeResearchAction(
      { kind: 'click', index: 1 },
      el({ tag: 'button', type: 'submit', name: 'Submit', formMethod: 'post' }),
    )
    expect(v.ok).toBe(false)
  })

  it('allows a submit control inside a GET search form', () => {
    const v = isSafeResearchAction(
      { kind: 'click', index: 1 },
      el({ tag: 'button', type: 'submit', name: 'Search', formMethod: 'get' }),
    )
    expect(v.ok).toBe(true)
  })

  it('denies purchase, auth, and destructive controls whatever the form method', () => {
    const names = [
      'Buy now',
      'Add to cart',
      'Proceed to checkout',
      'Subscribe',
      'Sign up',
      'Log in',
      'Sign in',
      'Delete account',
      'Remove item',
      'Pay $40',
    ]
    for (const name of names) {
      const v = isSafeResearchAction({ kind: 'click', index: 1 }, el({ tag: 'button', name }))
      expect(v.ok, `expected "${name}" to be denied`).toBe(false)
    }
  })

  it('denies a click on an element it cannot see', () => {
    expect(isSafeResearchAction({ kind: 'click', index: 9 }, undefined).ok).toBe(false)
  })
})

describe('isSafeResearchAction — type', () => {
  it('allows typing into a search input', () => {
    const v = isSafeResearchAction({ kind: 'type', index: 2, text: 'pricing' }, el({ tag: 'input', type: 'search', name: 'Search' }))
    expect(v.ok).toBe(true)
  })

  it('denies typing into anything that is not a search input', () => {
    expect(isSafeResearchAction({ kind: 'type', index: 2, text: 'x' }, el({ tag: 'input', type: 'text', name: 'Full name' })).ok).toBe(false)
    expect(isSafeResearchAction({ kind: 'type', index: 2, text: 'x' }, el({ tag: 'input', type: 'email', name: 'Email' })).ok).toBe(false)
    expect(isSafeResearchAction({ kind: 'type', index: 2, text: 'x' }, el({ tag: 'textarea', name: 'Message' })).ok).toBe(false)
    expect(
      isSafeResearchAction({ kind: 'type', index: 2, text: 'x' }, el({ tag: 'input', type: 'password', sensitive: true })).ok,
    ).toBe(false)
  })
})

describe('isSafeResearchAction — press', () => {
  it('allows Enter on a search input', () => {
    expect(isSafeResearchAction({ kind: 'press', keys: 'Enter', index: 2 }, el({ tag: 'input', type: 'search' })).ok).toBe(true)
  })

  it('denies Enter anywhere else — notably a login form', () => {
    expect(
      isSafeResearchAction({ kind: 'press', keys: 'Enter', index: 2 }, el({ tag: 'input', type: 'password', sensitive: true })).ok,
    ).toBe(false)
    expect(isSafeResearchAction({ kind: 'press', keys: 'Enter', index: 2 }, el({ tag: 'input', type: 'text', name: 'Username' })).ok).toBe(
      false,
    )
  })

  it('denies keys other than Enter', () => {
    expect(isSafeResearchAction({ kind: 'press', keys: 'Tab', index: 2 }, el({ tag: 'input', type: 'search' })).ok).toBe(false)
  })
})

describe('isSafeResearchAction — navigate / scroll / back', () => {
  it('allows public http(s) navigation, including cross-origin', () => {
    expect(isSafeResearchAction({ kind: 'navigate', url: 'https://example.com/docs' }).ok).toBe(true)
    expect(isSafeResearchAction({ kind: 'navigate', url: 'http://other.test/a' }).ok).toBe(true)
  })

  it('denies navigation the SSRF guard rejects', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'javascript:alert(1)',
      'http://localhost:8080/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isSafeResearchAction({ kind: 'navigate', url }).ok, `expected ${url} to be denied`).toBe(false)
    }
  })

  it('always allows scroll and back', () => {
    expect(isSafeResearchAction({ kind: 'scroll', direction: 'down' }).ok).toBe(true)
    expect(isSafeResearchAction({ kind: 'back' }).ok).toBe(true)
  })
})
