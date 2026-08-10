import { describe, expect, it } from 'vitest'
import type { IndexedElement } from '../platform/domIndex'
import type { ControlSpec } from './pageControl'
import {
  buildEntry,
  classifyUndoable,
  isUndoable,
  revertableEntries,
  type ControlJournalEntry,
} from './pageControlJournal'

const PAGE = { origin: 'https://example.com', url: 'https://example.com/form' }

const el = (o: Partial<IndexedElement> = {}): IndexedElement => ({
  index: 3,
  tag: 'INPUT',
  name: 'Email',
  sensitive: false,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  ...o,
})

const spec = (o: Partial<ControlSpec> = {}): ControlSpec => ({ action: 'type', index: 3, ...o })

describe('classifyUndoable', () => {
  it('allows a plain text field with a captured prior value', () => {
    expect(classifyUndoable(spec({ text: 'hi' }), el(), 'was')).toBe(true)
  })

  it('treats an empty prior value as restorable — the field started blank', () => {
    expect(classifyUndoable(spec({ text: 'hi' }), el(), '')).toBe(true)
  })

  it('refuses when no prior value was captured', () => {
    expect(classifyUndoable(spec({ text: 'hi' }), el(), undefined)).toBe(false)
  })

  it('refuses a sensitive field flagged by the element', () => {
    // Restoring it would mean holding the prior password in memory for as long
    // as the card sits on screen, which is indefinite.
    expect(classifyUndoable(spec({ text: 'hunter2' }), el({ sensitive: true }), 'old')).toBe(false)
  })

  it('refuses a sensitive field flagged by the model on the spec', () => {
    expect(classifyUndoable(spec({ text: 'x', sensitive: true }), el(), 'old')).toBe(false)
  })

  it('refuses clicks, navigations, presses and scrolls', () => {
    for (const action of ['click', 'navigate', 'press', 'scroll', 'wait', 'highlight'] as const) {
      expect(classifyUndoable(spec({ action }), el(), 'old')).toBe(false)
    }
  })

  it('allows a select with a prior value', () => {
    expect(classifyUndoable(spec({ action: 'select', value: 'b' }), el({ tag: 'SELECT' }), 'a')).toBe(true)
  })
})

describe('buildEntry', () => {
  it('never stores the raw value of a sensitive field', () => {
    const entry = buildEntry(spec({ text: 'hunter2' }), el({ sensitive: true }), 'old', 1, PAGE)
    expect(entry.redactedValue).toBe('[redacted]')
    expect(JSON.stringify(entry)).not.toContain('hunter2')
    expect(entry.sensitive).toBe(true)
    expect(entry.undoable).toBe(false)
  })

  it('never stores a captured prior value, sensitive or not', () => {
    // The prior value is passed in only to decide undoability; the raw copy
    // lives in session memory and must never reach the rendered record.
    const entry = buildEntry(spec({ text: 'new' }), el(), 'PREVIOUS-SECRET', 1, PAGE)
    expect(JSON.stringify(entry)).not.toContain('PREVIOUS-SECRET')
  })

  it('redacts a card number typed into an innocuously-named field', () => {
    // The page never labelled this field as payment-related, so only the
    // shape-based net can catch it.
    const entry = buildEntry(spec({ text: '4111111111111111' }), el({ name: 'Reference' }), '', 1, PAGE)
    expect(entry.redactedValue).not.toContain('4111111111111111')
  })

  it('keeps an ordinary value readable', () => {
    const entry = buildEntry(spec({ text: 'ada@example.com' }), el(), '', 1, PAGE)
    expect(entry.redactedValue).toBe('ada@example.com')
  })

  it('describes the action in terms of the element name', () => {
    expect(buildEntry(spec({ text: 'x' }), el({ name: 'Email' }), '', 1, PAGE).summary).toBe(
      'typed into “Email”',
    )
  })

  it('records the page it ran on, so undo can detect drift', () => {
    const entry = buildEntry(spec({ text: 'x' }), el(), '', 1, PAGE)
    expect(entry.origin).toBe(PAGE.origin)
    expect(entry.url).toBe(PAGE.url)
  })

  it('carries no value at all for an action that has none', () => {
    expect(buildEntry(spec({ action: 'click' }), el(), undefined, 1, PAGE).redactedValue).toBeUndefined()
  })
})

describe('isUndoable', () => {
  const entry = (o: Partial<ControlJournalEntry> = {}): ControlJournalEntry => ({
    at: 1,
    action: 'type',
    index: 3,
    summary: 'typed into “Email”',
    undoable: true,
    sensitive: false,
    origin: PAGE.origin,
    url: PAGE.url,
    ...o,
  })

  it('allows an entry recorded on the page still in front', () => {
    expect(isUndoable(entry(), PAGE)).toBe(true)
  })

  it('refuses once the url has changed', () => {
    // data-agent-idx stamps live on one document; index 3 on the next page is
    // some unrelated element, so applying the undo would edit the wrong field.
    expect(isUndoable(entry(), { ...PAGE, url: 'https://example.com/thanks' })).toBe(false)
  })

  it('refuses once the origin has changed', () => {
    expect(isUndoable(entry(), { origin: 'https://evil.test', url: 'https://evil.test/form' })).toBe(
      false,
    )
  })

  it('refuses an entry that was never undoable', () => {
    expect(isUndoable(entry({ undoable: false }), PAGE)).toBe(false)
  })
})

describe('revertableEntries', () => {
  it('returns only revertable entries, newest first', () => {
    const entries: ControlJournalEntry[] = [
      { at: 1, action: 'type', summary: 'a', undoable: true, sensitive: false, ...PAGE },
      { at: 2, action: 'click', summary: 'b', undoable: false, sensitive: false, ...PAGE },
      { at: 3, action: 'type', summary: 'c', undoable: true, sensitive: false, ...PAGE },
    ]
    // Newest first: undo has to unwind in reverse, or restoring an earlier edit
    // would be overwritten by a later one that had not been undone yet.
    expect(revertableEntries(entries, PAGE).map((e) => e.summary)).toEqual(['c', 'a'])
  })

  it('returns nothing once the page has moved on', () => {
    const entries: ControlJournalEntry[] = [
      { at: 1, action: 'type', summary: 'a', undoable: true, sensitive: false, ...PAGE },
    ]
    expect(revertableEntries(entries, { ...PAGE, url: 'https://example.com/other' })).toEqual([])
  })
})
