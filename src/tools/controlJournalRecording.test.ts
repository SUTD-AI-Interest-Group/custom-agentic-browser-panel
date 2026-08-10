import { describe, expect, it, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSession, ControlSpec } from './pageControl'

// Exercises the RECORDING path in runControlStep, not the pure classifier —
// pageControlJournal.test.ts already covers the latter. What matters here is
// that the two halves of the lifetime split land in the right places when a
// real step runs: a redacted entry on `journal`, the raw prior value only in
// the in-memory `undoState`, and nothing retained at all for a sensitive field.

const snapshot = { origin: 'https://example.com', url: 'https://example.com/form', text: '', title: '', dpr: 1, truncated: false } as const

vi.mock('../platform/domIndex', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  snapshotPage: vi.fn(async () => ({ ...snapshot, elements: [] }) as PageSnapshot),
}))

// The real page actions are Chrome injections; stub them to return a captured
// prior value the way injType/injSelect now do.
vi.mock('../platform/pageActions', () => ({
  clickElement: vi.fn(async () => ({ ok: true, message: 'clicked' })),
  typeIntoElement: vi.fn(async () => ({ ok: true, message: 'typed', prior: 'PRIOR-SECRET-VALUE' })),
  selectOption: vi.fn(async () => ({ ok: true, message: 'selected', prior: 'old-option' })),
  scrollPage: vi.fn(async () => ({ ok: true, message: 'scrolled' })),
  pressKey: vi.fn(async () => ({ ok: true, message: 'pressed' })),
  navigateTab: vi.fn(async () => ({ ok: true, message: 'navigated' })),
  waitForStable: vi.fn(async () => ({ ok: true, reason: 'quiet' })),
  restoreValue: vi.fn(async () => ({ ok: true, message: 'restored' })),
}))

const { runControlStep } = await import('./pageControl')

const el = (o: Partial<IndexedElement> = {}): IndexedElement => ({
  index: 3,
  tag: 'INPUT',
  name: 'Email',
  sensitive: false,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  ...o,
})

const session = (): ControlSession => ({
  tabId: 1,
  origin: snapshot.origin,
  plan: 'fill the form',
  active: true,
})

const snapWith = (elements: IndexedElement[]): PageSnapshot =>
  ({ ...snapshot, elements }) as PageSnapshot

const step = (spec: ControlSpec, elements: IndexedElement[], s: ControlSession) =>
  runControlStep({ tabId: 1, spec, snapshot: snapWith(elements), session: s })

describe('runControlStep journal recording', () => {
  it('records a redacted entry and keeps the raw prior value out of it', async () => {
    const s = session()
    await step({ action: 'type', index: 3, text: 'ada@example.com' }, [el()], s)
    expect(s.journal).toHaveLength(1)
    expect(s.journal?.[0].summary).toBe('typed into “Email”')
    // The raw prior value is what undo needs, and it must never appear in the
    // record that gets rendered or persisted.
    expect(JSON.stringify(s.journal)).not.toContain('PRIOR-SECRET-VALUE')
  })

  it('keeps the raw prior value in memory for undo', async () => {
    const s = session()
    await step({ action: 'type', index: 3, text: 'ada@example.com' }, [el()], s)
    expect(s.undoState?.get(3)).toEqual({ value: 'PRIOR-SECRET-VALUE', kind: 'type' })
  })

  it('retains nothing at all for a sensitive field', async () => {
    // The whole point of the split: a password is journalled as [redacted] and
    // its prior value is never held anywhere, so nothing can outlive the turn.
    const s = session()
    await step({ action: 'type', index: 3, text: 'hunter2' }, [el({ sensitive: true, name: 'Password' })], s)
    expect(s.journal?.[0].redactedValue).toBe('[redacted]')
    expect(s.journal?.[0].undoable).toBe(false)
    expect(s.undoState?.has(3)).toBeFalsy()
    expect(JSON.stringify([...(s.undoState?.values() ?? [])])).not.toContain('PRIOR-SECRET-VALUE')
  })

  it('keeps the FIRST prior value when a field is edited twice', async () => {
    // Undo must restore what the field held when the session started, not an
    // intermediate value the agent itself typed.
    const s = session()
    await step({ action: 'type', index: 3, text: 'first' }, [el()], s)
    s.undoState?.set(3, { value: 'FIRST-VALUE', kind: 'type' })
    await step({ action: 'type', index: 3, text: 'second' }, [el()], s)
    expect(s.undoState?.get(3)?.value).toBe('FIRST-VALUE')
    expect(s.journal).toHaveLength(2)
  })

  it('records a click but offers no undo for it', async () => {
    const s = session()
    await step({ action: 'click', index: 3 }, [el({ tag: 'BUTTON', name: 'Continue' })], s)
    expect(s.journal?.[0].summary).toBe('clicked “Continue”')
    expect(s.journal?.[0].undoable).toBe(false)
    expect(s.undoState?.size ?? 0).toBe(0)
  })

  it('does not journal a step with no session (an ungated one-off)', async () => {
    const result = await runControlStep({
      tabId: 1,
      spec: { action: 'type', index: 3, text: 'x' },
      snapshot: snapWith([el()]),
    })
    expect(result.ok).toBe(true)
  })
})
