import { describe, it, expect } from 'vitest'
import { isBlindClick, isCommittingCheckmark, isCommittingName, isDismissalName } from './committingVocabulary'
import { isPointOfNoReturn } from './pageControl'
import type { ControlSpec } from './pageControl'
import { isSafeResearchAction } from './browsePolicy'
import type { IndexedElement } from '../platform/domIndex'

/** Minimal IndexedElement factory — only the fields the classifiers read matter. */
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

describe('committingVocabulary — isCommittingName', () => {
  it('flags the English committing verbs, including place order and continue', () => {
    for (const name of ['Buy now', 'Delete account', 'Place order', 'Continue', 'Sign up', 'Confirm']) {
      expect(isCommittingName(name), `expected "${name}" to be committing`).toBe(true)
    }
  })

  it('flags translated equivalents and committing emoji', () => {
    for (const name of ['Löschen', 'Supprimer', 'Eliminar', 'Удалить', '削除', 'حذف', '🗑️', '🛒']) {
      expect(isCommittingName(name), `expected "${name}" to be committing`).toBe(true)
    }
  })

  it('does not flag ordinary, non-committing text', () => {
    for (const name of ['Read more', 'Docs', 'Show more', 'Next page', 'Pricing']) {
      expect(isCommittingName(name), `expected "${name}" to be non-committing`).toBe(false)
    }
  })
})

describe('committingVocabulary — isDismissalName / isCommittingCheckmark / isBlindClick', () => {
  it('treats a bare dismissal word as exempt, but a compound committing phrase as not', () => {
    expect(isDismissalName('Cancel')).toBe(true)
    expect(isDismissalName('Close')).toBe(true)
    expect(isDismissalName('Cancel subscription')).toBe(false)
  })

  it('only treats a bare checkmark as committing with a committing ancestor', () => {
    expect(isCommittingCheckmark(el({ name: '✅' }))).toBe(false)
    expect(isCommittingCheckmark(el({ name: '✅', ancestorName: 'Confirm delete' }))).toBe(true)
  })

  it('treats a no-href, no-name element as a blind click', () => {
    expect(isBlindClick(el({ name: '' }))).toBe(true)
    expect(isBlindClick(el({ name: 'Docs' }))).toBe(false)
    expect(isBlindClick(el({ name: '', href: 'https://x.test' }))).toBe(false)
  })
})

/**
 * The parity check the two gates' own comments promise but never enforced:
 * pageControl.ts's isPointOfNoReturn (human-approved foreground session) and
 * browsePolicy.ts's isSafeResearchAction (unattended research browser) must
 * classify the SAME committing/dismissal names the SAME way. Before this
 * module existed, each file carried its own copy — and they had already
 * drifted: pageControl.ts's COMMITTING_NAME included "place order" and
 * "continue", browsePolicy.ts's did not, so an unattended click on a
 * bare-named "Continue"/"Place order" control (no POST form, no href) sailed
 * straight through the ONLY gate that unattended browser has. Neither file's
 * own test suite caught it, because each only exercised its own copy —
 * pageControl.test.ts even titled its version of this list "mirroring
 * browsePolicy intent" without the two ever being compared.
 *
 * This test exercises each file's REAL exported entry point (not the shared
 * module directly), with every other structural signal (origin, href, type,
 * sensitive, formMethod) held constant and benign, so only the vocabulary
 * drives the verdict. A future edit that re-introduces a local, drifted copy
 * in either file — the exact failure mode this module exists to prevent —
 * fails this test, not just committingVocabulary's own unit tests above.
 */
describe('committingVocabulary — pageControl and browsePolicy agree', () => {
  const ORIGIN = 'https://example.test'

  const committingNames = [
    'Buy now',
    'Add to cart',
    'Proceed to checkout',
    'Pay now',
    'Order now',
    'Place order',
    'Subscribe',
    'Sign up',
    'Register',
    'Log in',
    'Delete account',
    'Remove item',
    'Confirm order',
    'Apply now',
    'Submit application',
    'Continue',
    'Löschen',
    'Supprimer',
    '削除',
  ]

  const nonCommittingNames = ['Read more', 'Docs', 'Show more', 'Next page', 'Pricing', 'Cancel', 'Close']

  const pageControlSpec: ControlSpec = { action: 'click', index: 0 }

  it('both gates flag/deny the same committing names for an otherwise-benign click target', () => {
    for (const name of committingNames) {
      const target = el({ tag: 'button', type: 'button', name })
      expect(
        isPointOfNoReturn(pageControlSpec, target, ORIGIN),
        `expected pageControl to flag "${name}"`,
      ).toBe(true)
      expect(
        isSafeResearchAction({ kind: 'click', index: 0 }, target).ok,
        `expected browsePolicy to deny "${name}"`,
      ).toBe(false)
    }
  })

  it('both gates leave the same non-committing/dismissal names alone', () => {
    for (const name of nonCommittingNames) {
      const target = el({ tag: 'button', type: 'button', name })
      expect(
        isPointOfNoReturn(pageControlSpec, target, ORIGIN),
        `expected pageControl to leave "${name}" alone`,
      ).toBe(false)
      expect(
        isSafeResearchAction({ kind: 'click', index: 0 }, target).ok,
        `expected browsePolicy to allow "${name}"`,
      ).toBe(true)
    }
  })
})
