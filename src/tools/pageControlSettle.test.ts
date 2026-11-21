import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from './pageControl'

// runControlStep's settle: the full wait (ControlPage, AutofillForm — unchanged) unless a caller
// asks for the quick one (driver mode's non-committing steps). The page actions are Chrome
// injections, stubbed here so the wait each step asks for is what is checked.

const snapshot = { origin: 'https://example.com', url: 'https://example.com/', text: '', title: '', dpr: 1, truncated: false, elements: [] } as PageSnapshot

vi.mock('../platform/domIndex', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  snapshotPage: vi.fn(async () => snapshot),
}))
vi.mock('../platform/pageActions', () => ({
  clickElement: vi.fn(async () => ({ ok: true, message: 'clicked' })),
  typeIntoElement: vi.fn(async () => ({ ok: true, message: 'typed' })),
  selectOption: vi.fn(async () => ({ ok: true, message: 'selected' })),
  scrollPage: vi.fn(async () => ({ ok: true, message: 'scrolled' })),
  pressKey: vi.fn(async () => ({ ok: true, message: 'pressed' })),
  navigateTab: vi.fn(async () => ({ ok: true, message: 'navigated', urlChanged: true })),
  waitForStable: vi.fn(async () => ({ ok: true, reason: 'quiet' })),
  restoreValue: vi.fn(async () => ({ ok: true, message: 'restored' })),
}))

const { runControlStep, QUICK_SETTLE } = await import('./pageControl')
const { waitForStable } = await import('../platform/pageActions')

const run = (spec: ControlSpec, settle?: 'quick' | 'full') => runControlStep({ tabId: 1, spec, snapshot, ...(settle ? { settle } : {}) })

describe('runControlStep — settle', () => {
  beforeEach(() => {
    vi.mocked(waitForStable).mockClear()
  })

  it('waits the full 400 ms-quiet / 4 s by default, as every existing caller always has', async () => {
    for (const spec of [{ action: 'click', index: 0 }, { action: 'type', index: 0, text: 'x' }, { action: 'select', index: 0, value: 'a' }] as ControlSpec[]) {
      vi.mocked(waitForStable).mockClear()
      await run(spec)
      expect(waitForStable).toHaveBeenCalledWith(1, { timeoutMs: 4000 })
    }
  })

  it("'quick' waits a couple of frames: 50 ms quiet within a 250 ms cap", async () => {
    expect(QUICK_SETTLE).toEqual({ quietMs: 50, timeoutMs: 250 })
    await run({ action: 'click', index: 0 }, 'quick')
    expect(waitForStable).toHaveBeenCalledTimes(1)
    expect(waitForStable).toHaveBeenCalledWith(1, { quietMs: 50, timeoutMs: 250 })
  })

  it("'full' is the default wait, and a navigate always gets the full navigation wait", async () => {
    await run({ action: 'click', index: 0 }, 'full')
    expect(waitForStable).toHaveBeenLastCalledWith(1, { timeoutMs: 4000 })
    await run({ action: 'navigate', url: 'https://example.com/next' }, 'quick')
    expect(waitForStable).toHaveBeenLastCalledWith(1, { timeoutMs: 8000 })
  })

  it('a scroll waits for nothing, either way', async () => {
    await run({ action: 'scroll', direction: 'down' }, 'quick')
    await run({ action: 'scroll', direction: 'down' })
    expect(waitForStable).not.toHaveBeenCalled()
  })
})
