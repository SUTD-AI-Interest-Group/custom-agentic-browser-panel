import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from '../tools/pageControl'
import {
  DRIVER_MAX_FAILED,
  DRIVER_MAX_STEPS,
  DRIVER_NO_CHANGE_STEPS,
  runDriverLoop,
  type DriverActOutcome,
  type DriverDecideOutcome,
  type DriverDeps,
  type DriverOption,
  type DriverStop,
  type OpRef,
} from './driverLoop'

// ---------------------------------------------------------------------------
// Fixtures: a scripted page and a scripted decider
// ---------------------------------------------------------------------------

function el(over: Partial<IndexedElement> & { index: number }): IndexedElement {
  return { tag: 'button', name: `Element ${over.index}`, rect: { x: 0, y: 0, width: 1, height: 1 }, sensitive: false, ...over }
}

const SEARCH = [
  el({ index: 0, tag: 'input', type: 'search', name: 'Search products' }),
  el({ index: 1, tag: 'button', type: 'submit', name: 'Search' }),
  el({ index: 2, tag: 'a', name: 'Cart (0)', href: 'https://shop.test/cart' }),
  el({ index: 3, tag: 'button', name: 'Show more' }),
  el({ index: 4, tag: 'select', name: 'Sort by' }),
]

const pageOf = (text: string, elements = SEARCH, url = 'https://shop.test/'): PageSnapshot => ({
  url, title: 'Shop', origin: 'https://shop.test', dpr: 1, elements, text, truncated: false,
})

const opt = (op: DriverOption['op'], index: number | undefined, p: number): DriverOption => (index === undefined ? { op, p } : { op, index, p })
const decision = (top: DriverOption, extra: Partial<Exclude<DriverDecideOutcome, { error: string }>> = {}): DriverDecideOutcome => ({
  top3: [top, opt('scroll', undefined, 0.05), opt('done', undefined, 0.01)],
  tokens: 400,
  ms: 150,
  ...extra,
})

interface Script {
  /** Answered in order; the last one repeats. */
  decisions: DriverDecideOutcome[]
  /** The page text each snapshot returns, in order; the last one repeats. Default: changes every read. */
  pages?: string[]
  act?: (spec: ControlSpec, k: number) => DriverActOutcome
  ponr?: (spec: ControlSpec, el: IndexedElement | undefined) => boolean
  approve?: boolean | (() => Promise<boolean>)
  guard?: () => Promise<DriverStop | null>
  maxSteps?: number
  threshold?: number
  aborted?: () => boolean
}

function harness(s: Script) {
  const log: string[] = []
  const decideCalls: { exclude: OpRef[] }[] = []
  const acts: { spec: ControlSpec; settle: 'quick' | 'full'; approved: boolean }[] = []
  let reads = 0
  let d = 0
  const deps: DriverDeps = {
    maxSteps: s.maxSteps ?? DRIVER_MAX_STEPS,
    threshold: s.threshold ?? 0.6,
    aborted: s.aborted ?? (() => false),
    guard: vi.fn(s.guard ?? (async () => null)),
    snapshot: vi.fn(async () => {
      const text = s.pages ? s.pages[Math.min(reads, s.pages.length - 1)] : `page ${reads}`
      reads++
      log.push('snapshot')
      return pageOf(text)
    }),
    readPageText: vi.fn(async () => 'Northwind Store'),
    decide: vi.fn(async (i) => {
      decideCalls.push({ exclude: [...i.exclude] })
      log.push('decide')
      return s.decisions[Math.min(d++, s.decisions.length - 1)]
    }),
    isPointOfNoReturn: vi.fn(s.ponr ?? ((spec: ControlSpec, e: IndexedElement | undefined) => spec.action === 'click' && e?.type === 'submit')),
    approve: vi.fn(async () => {
      log.push('approve')
      return typeof s.approve === 'function' ? s.approve() : (s.approve ?? true)
    }),
    hasElementChanged: vi.fn((a: IndexedElement | undefined, b: IndexedElement | undefined) => a?.name !== b?.name),
    act: vi.fn(async (spec: ControlSpec, _snap: PageSnapshot, o: { settle: 'quick' | 'full'; approved: boolean }) => {
      acts.push({ spec, settle: o.settle, approved: o.approved })
      log.push(`act ${spec.action}${spec.index ?? ''}`)
      return s.act ? s.act(spec, acts.length - 1) : { ok: true, message: 'ok', registry: `after ${acts.length}` }
    }),
  }
  return { deps, log, acts, decideCalls }
}

// ---------------------------------------------------------------------------
// The gate (step 5)
// ---------------------------------------------------------------------------

describe('the confidence gate', () => {
  it('acts at or above the threshold', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.6)), decision(opt('done', undefined, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec)).toEqual([{ action: 'click', index: 3 }])
    expect(r).toMatchObject({ status: 'done', reason: 'done', steps: [{ op: 'click', index: 3, p: 0.6, ok: true }] })
  })

  it('between 0.4 and the threshold acts only when the step is not a point of no return (tentative)', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.45)), decision(opt('done', undefined, 0.95))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.acts.map((a) => a.spec)).toEqual([{ action: 'click', index: 3 }])
    expect(h.deps.approve).not.toHaveBeenCalled()
  })

  it('hands back a tentative point of no return without a card and without acting', async () => {
    const h = harness({ decisions: [decision(opt('click', 1, 0.55))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'unsure', lastDecision: [{ op: 'click', index: 1, p: 0.55 }, { op: 'scroll' }, { op: 'done' }] })
    expect(r.message).toMatch(/risky/)
    expect(h.deps.approve).not.toHaveBeenCalled()
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('hands back below 0.4, showing the top three', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.39))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(r.lastDecision).toHaveLength(3)
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('done needs the full threshold — a tentative done is a hand-back, not done', async () => {
    const h = harness({ decisions: [decision(opt('done', undefined, 0.59))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    const h2 = harness({ decisions: [decision(opt('done', undefined, 0.6))] })
    expect(await runDriverLoop(h2.deps)).toMatchObject({ status: 'done', reason: 'done' })
  })

  it('uses the configured threshold, not a constant', async () => {
    const h = harness({ threshold: 0.8, decisions: [decision(opt('click', 1, 0.7))] })
    // 0.7 is under 0.8, and [1] is a submit: tentative + point of no return → hand back.
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    const h2 = harness({ threshold: 0.8, decisions: [decision(opt('done', undefined, 0.75))] })
    expect(await runDriverLoop(h2.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
  })
})

// ---------------------------------------------------------------------------
// Dense pages, decider errors, values
// ---------------------------------------------------------------------------

describe('what the decider cannot answer', () => {
  it('a dense page is handed back as such, without acting', async () => {
    const h = harness({ decisions: [{ error: 'too-long: 3540 tokens exceeds 2500', dense: true }] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'dense page', elements: 'page 0' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('any other decider error is a hand-back with its reason', async () => {
    const h = harness({ decisions: [{ error: 'the decision model is not ready' }] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'decider error', message: 'the decision model is not ready' })
  })

  it('a type with no value hands back "needs value"', async () => {
    const h = harness({ decisions: [decision(opt('type', 0, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'needs value' })
    expect(r.message).toContain('[0]')
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a type with a value types it, replacing what is there', async () => {
    const h = harness({
      decisions: [decision(opt('type', 0, 0.9), { value: { key: 'request.query', text: 'wireless headphones', p: 0.8 } }), decision(opt('done', undefined, 0.9))],
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.acts[0].spec).toEqual({ action: 'type', index: 0, text: 'wireless headphones', clear: true })
  })

  it('a select hands back "needs value": the decider does not choose options here', async () => {
    const h = harness({ decisions: [decision(opt('select', 4, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'needs value' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a scroll scrolls down', async () => {
    const h = harness({ decisions: [decision(opt('scroll', undefined, 0.8)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(h.deps)
    expect(h.acts[0].spec).toEqual({ action: 'scroll', direction: 'down' })
  })
})

// ---------------------------------------------------------------------------
// Points of no return (step 8)
// ---------------------------------------------------------------------------

describe('a point of no return', () => {
  it('asks once, then re-checks the element before acting with the full settle', async () => {
    const h = harness({ decisions: [decision(opt('click', 1, 0.9)), decision(opt('done', undefined, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.deps.approve).toHaveBeenCalledWith({ action: 'click', index: 1 }, SEARCH[1])
    expect(h.log.slice(0, 5)).toEqual(['snapshot', 'decide', 'approve', 'snapshot', 'act click1'])
    expect(h.deps.hasElementChanged).toHaveBeenCalledWith(SEARCH[1], SEARCH[1])
    expect(h.acts[0]).toMatchObject({ settle: 'full', approved: true })
  })

  it('denied → blocked, and nothing acts', async () => {
    const h = harness({ approve: false, decisions: [decision(opt('click', 1, 0.95))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'blocked', reason: 'denied' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('an element that changed while the card was up is handed back, not clicked', async () => {
    const h = harness({ decisions: [decision(opt('click', 1, 0.95))] })
    let n = 0
    h.deps.snapshot = vi.fn(async () => pageOf(`p${n}`, n++ === 0 ? SEARCH : SEARCH.map((e) => (e.index === 1 ? { ...e, name: 'Place order' } : e))))
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'page changed' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a guard that fails after the card (the user switched tabs) stops before acting', async () => {
    let calls = 0
    const h = harness({
      decisions: [decision(opt('click', 1, 0.95))],
      guard: async () => (++calls >= 2 ? { status: 'stopped', reason: 'parked', message: 'switched away' } : null),
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'parked', message: 'switched away' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a non-committing step gets the quick settle; a link click the full one', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 2, 0.9)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => [a.spec.index, a.settle, a.approved])).toEqual([
      [3, 'quick', false],
      [2, 'full', false],
    ])
    expect(h.deps.approve).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Repeats, failures, no progress, the step cap (steps 6 and 10)
// ---------------------------------------------------------------------------

describe('loop rules', () => {
  it('a repeat on an unchanged page excludes that pair and asks once more', async () => {
    const h = harness({
      pages: ['same'],
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('scroll', undefined, 0.8)), decision(opt('done', undefined, 0.9))],
    })
    h.deps.snapshot = vi.fn(async () => pageOf(h.acts.length >= 2 ? 'scrolled' : 'same'))
    const r = await runDriverLoop(h.deps)
    expect(r.status).toBe('done')
    expect(h.decideCalls.map((c) => c.exclude)).toEqual([[], [], [{ op: 'click', index: 3 }], []])
    expect(h.acts.map((a) => a.spec.action)).toEqual(['click', 'scroll'])
  })

  it('a repeat after a click that DID change the page is not a repeat', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3, 3])
    expect(h.decideCalls.every((c) => c.exclude.length === 0)).toBe(true)
  })

  it('a second repeat after the re-ask hands back "repeat"', async () => {
    const h = harness({ pages: ['same'], decisions: [decision(opt('click', 3, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'repeat' })
    expect(h.acts).toHaveLength(1)
  })

  it(`gives up after ${DRIVER_MAX_FAILED} refused actions, excluding each refused pair from then on`, async () => {
    const h = harness({
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 0, 0.9)), decision(opt('done', undefined, 0.9))],
      act: (spec) => ({ ok: false, message: `element ${spec.index} not found`, registry: 'r' }),
    })
    h.deps.decide = vi.fn(async (i) => {
      h.decideCalls.push({ exclude: [...i.exclude] })
      return i.exclude.length ? decision(opt('click', 2, 0.9)) : decision(opt('click', 3, 0.9))
    })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'failed actions' })
    expect(r.message).toContain('element 2 not found')
    expect(h.decideCalls.map((c) => c.exclude)).toEqual([[], [{ op: 'click', index: 3 }]])
    expect(r.steps.map((s) => s.ok)).toEqual([false, false])
  })

  it(`hands back after ${DRIVER_NO_CHANGE_STEPS} actions in a row that changed nothing`, async () => {
    // Three different futile clicks: no repeat to exclude, but no progress either.
    const h = harness({
      pages: ['same'],
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 2, 0.9)), decision(opt('click', 0, 0.9)), decision(opt('done', undefined, 0.9))],
    })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'no progress' })
    expect(h.acts).toHaveLength(3)
  })

  it('stops after maxSteps actions, handing back the last registry', async () => {
    const h = harness({ maxSteps: 3, decisions: [decision(opt('click', 3, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'max steps', elements: 'after 3' })
    expect(h.acts).toHaveLength(3)
  })

  it('reports each executed step as op/index/p/ms/ok only, and totals the decider time', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.912345)), decision(opt('done', undefined, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(r.steps).toEqual([{ op: 'click', index: 3, p: 0.91, ms: 150, ok: true }])
    expect(r).toMatchObject({ decisions: 2, deciderMs: 300 })
  })

  it('a page that moved to another site hands back after the step', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9))], act: () => ({ ok: true, message: 'ok', registry: 'elsewhere', moved: 'other.test' }) })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'page moved', elements: 'elsewhere' })
    expect(r.message).toContain('other.test')
    expect(h.acts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Stop, steer, guards (steps 1 and 10)
// ---------------------------------------------------------------------------

describe('stopping', () => {
  it('an abort mid-loop does nothing further: no action on the decision in flight', async () => {
    let aborted = false
    const h = harness({ aborted: () => aborted, decisions: [decision(opt('click', 3, 0.9))] })
    h.deps.decide = vi.fn(async () => {
      aborted = true // Stop pressed while the decider was thinking
      return decision(opt('click', 3, 0.9))
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped' })
    expect(h.deps.act).not.toHaveBeenCalled()
    expect(h.deps.guard).toHaveBeenCalledTimes(1) // only the step's own, before the decision
  })

  it('an abort during the decision on a risky step raises no approval card', async () => {
    let aborted = false
    const h = harness({ aborted: () => aborted, decisions: [decision(opt('click', 1, 0.95))] })
    h.deps.decide = vi.fn(async () => {
      aborted = true
      return decision(opt('click', 1, 0.95)) // [1] is a submit: a point of no return
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped' })
    expect(h.deps.approve).not.toHaveBeenCalled()
  })

  it('an abort while the approval card is up acts on nothing, and reads the page no further', async () => {
    let aborted = false
    const h = harness({ aborted: () => aborted, approve: async () => ((aborted = true), true), decisions: [decision(opt('click', 1, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped' })
    expect(h.deps.act).not.toHaveBeenCalled()
    expect(h.deps.snapshot).toHaveBeenCalledTimes(1) // no re-check read after Stop
  })

  it('an abort in the last check before acting acts on nothing', async () => {
    let aborted = false
    let calls = 0
    const h = harness({
      aborted: () => aborted,
      guard: async () => {
        if (++calls === 2) aborted = true // Stop lands while the pre-action check runs
        return null
      },
      decisions: [decision(opt('click', 3, 0.9))],
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('an approval that throws because the turn was stopped is a stop, not a crash', async () => {
    let aborted = false
    const h = harness({
      aborted: () => aborted,
      approve: async () => {
        aborted = true
        throw new DOMException('Stopped', 'AbortError')
      },
      decisions: [decision(opt('click', 1, 0.9))],
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped' })
  })

  it('an abort before the first step touches nothing at all', async () => {
    const h = harness({ aborted: () => true, decisions: [decision(opt('click', 3, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'stopped', steps: [] })
    expect(h.deps.snapshot).not.toHaveBeenCalled()
    expect(h.deps.decide).not.toHaveBeenCalled()
  })

  it('a steer stops at the step boundary: the decision that reported it is not acted on', async () => {
    const h = harness({
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 0, 0.9), { steerPending: true }), decision(opt('click', 2, 0.9))],
    })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'stopped', reason: 'steer' })
    expect(h.acts.map((a) => a.spec.index)).toEqual([3])
    expect(h.deps.decide).toHaveBeenCalledTimes(2)
  })

  it('a steer reported with an error stops too', async () => {
    const h = harness({ decisions: [{ error: 'the decision model failed', steerPending: true }] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'steer' })
  })

  it("a guard's stop (session ended, parked, page moved) is returned as-is, before any snapshot", async () => {
    for (const stop of [
      { status: 'stopped', reason: 'session ended' },
      { status: 'stopped', reason: 'parked', message: 'switched away' },
      { status: 'handback', reason: 'page moved', message: 'now on other.test' },
    ] as DriverStop[]) {
      const h = harness({ guard: async () => stop, decisions: [decision(opt('click', 3, 0.9))] })
      expect(await runDriverLoop(h.deps)).toMatchObject(stop)
      expect(h.deps.snapshot).not.toHaveBeenCalled()
      expect(h.deps.act).not.toHaveBeenCalled()
    }
  })

  it('the guard runs again right before acting: a tab switch during the decision acts on nothing', async () => {
    let calls = 0
    const h = harness({ guard: async () => (++calls === 2 ? { status: 'stopped', reason: 'parked' } : null), decisions: [decision(opt('click', 3, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'stopped', reason: 'parked' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a snapshot that fails hands back rather than guessing', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9))] })
    h.deps.snapshot = vi.fn(async () => {
      throw new Error('Cannot access contents of the page')
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unreadable page' })
  })

  it('maxSteps is clamped to 1..12', async () => {
    const big = harness({ maxSteps: 99, decisions: [decision(opt('click', 3, 0.9))] })
    expect((await runDriverLoop(big.deps)).steps).toHaveLength(DRIVER_MAX_STEPS)
    const zero = harness({ maxSteps: 0, decisions: [decision(opt('click', 3, 0.9))] })
    expect((await runDriverLoop(zero.deps)).steps).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// driverLoop.ts is bundled into the service worker (FastSteps executes there)
// ---------------------------------------------------------------------------

describe('driverLoop.ts stays service-worker safe', () => {
  it('imports nothing at runtime', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'driverLoop.ts'), 'utf8')
    const runtime = [...src.matchAll(/^\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm)]
      .filter((m) => !/^\{\s*(type\s+\w+\s*,?\s*)+\}$/.test(m[1].trim()))
      .map((m) => basename(m[2]))
    expect(runtime).toEqual([])
  })
})
