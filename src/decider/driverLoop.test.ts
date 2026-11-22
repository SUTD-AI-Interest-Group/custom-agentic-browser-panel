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
  /** A `@driver` run. */
  cardTentative?: boolean
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
    guard: vi.fn(async () => {
      log.push('guard')
      return s.guard ? s.guard() : null
    }),
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
    ...(s.cardTentative !== undefined ? { cardTentative: s.cardTentative } : {}),
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

  it('the risky-step gate comes before the value check: a tentative risky type is "unsure", not "needs value"', async () => {
    const h = harness({ decisions: [decision(opt('type', 0, 0.5))], ponr: (spec) => spec.action === 'type' })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(r.message).toMatch(/risky/)
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

  it('a NaN confidence clears no bar: never acts, never carded, never done (M2)', async () => {
    // A non-risky click, a risky click and a done — each with p = NaN.
    for (const top of [opt('click', 3, Number.NaN), opt('click', 1, Number.NaN), opt('done', undefined, Number.NaN)]) {
      const h = harness({ decisions: [decision(top)] })
      expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
      expect(h.deps.act).not.toHaveBeenCalled()
      expect(h.deps.approve).not.toHaveBeenCalled()
    }
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
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'done' })
    expect(h.acts[0].spec).toEqual({ action: 'type', index: 0, text: 'wireless headphones', clear: true })
    // The step names the key the value came from, never the value itself (M4).
    expect(r.steps).toEqual([{ op: 'type', index: 0, p: 0.9, ms: 150, ok: true, key: 'request.query' }])
    expect(JSON.stringify(r)).not.toContain('wireless headphones')
  })

  it('a select without a confident option hands back "needs value"', async () => {
    const h = harness({ decisions: [decision(opt('select', 4, 0.9))] })
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'needs value' })
    expect(r.message).toContain('[4]')
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a select with an option chooses it', async () => {
    const h = harness({ decisions: [decision(opt('select', 4, 0.9), { value: { key: 'option.1', text: 'Price: low to high', p: 0.8 } }), decision(opt('done', undefined, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.acts[0]).toMatchObject({ spec: { action: 'select', index: 4, value: 'Price: low to high' }, settle: 'quick' })
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
    // The guards run AFTER the re-read (whose wait for a loading tab can take seconds).
    expect(h.log.slice(0, 7)).toEqual(['guard', 'snapshot', 'decide', 'approve', 'snapshot', 'guard', 'act click1'])
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

  it('a non-risky target that changed between the decision and the act is handed back, not clicked', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.92))] })
    let reads = 0
    // Decided on "Choose size"; by the time it would be clicked, the same button says "Buy now".
    h.deps.snapshot = vi.fn(async () => pageOf(`p${reads}`, reads++ === 0 ? SEARCH : SEARCH.map((e) => (e.index === 3 ? { ...e, name: 'Buy now' } : e))))
    const r = await runDriverLoop(h.deps)
    expect(r).toMatchObject({ status: 'handback', reason: 'page changed' })
    expect(h.deps.act).not.toHaveBeenCalled()
    expect(h.deps.approve).not.toHaveBeenCalled()
    expect(h.deps.hasElementChanged).toHaveBeenCalledWith(SEARCH[3], { ...SEARCH[3], name: 'Buy now' })
  })

  it('a box that flipped between the decision and the act is handed back: the click would do the opposite', async () => {
    const BOX = [...SEARCH, el({ index: 5, tag: 'input', type: 'checkbox', name: 'Gift wrap', checked: false })]
    const h = harness({ decisions: [decision(opt('click', 5, 0.95))] })
    let reads = 0
    // Decided "tick [5]" on an unticked box; by the act, the page had ticked it itself.
    h.deps.snapshot = vi.fn(async () => pageOf(`p${reads}`, reads++ === 0 ? BOX : BOX.map((e) => (e.index === 5 ? { ...e, checked: true } : e))))
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'page changed' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('an unchanged box is still clicked (the checked re-check is not a blanket refusal)', async () => {
    const BOX = [...SEARCH, el({ index: 5, tag: 'input', type: 'checkbox', name: 'Gift wrap', checked: false })]
    const h = harness({ decisions: [decision(opt('click', 5, 0.95)), decision(opt('done', undefined, 0.9))] })
    let reads = 0
    h.deps.snapshot = vi.fn(async () => pageOf(`p${reads++}`, BOX))
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.acts.map((a) => a.spec)).toEqual([{ action: 'click', index: 5 }])
  })

  it('every step acts on the snapshot re-read right before it, not the one it was decided on', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(h.deps)
    expect(h.log.slice(0, 5)).toEqual(['guard', 'snapshot', 'decide', 'snapshot', 'guard'])
    expect(vi.mocked(h.deps.act).mock.calls[0][1].text).toBe('page 1') // the second read, not 'page 0'
  })

  it('a step that BECAME risky by the time it would run is carded at full confidence, then re-checked again', async () => {
    let classified = 0
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))], ponr: () => ++classified > 1 })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.deps.approve).toHaveBeenCalledTimes(1)
    expect(h.log.slice(0, 8)).toEqual(['guard', 'snapshot', 'decide', 'snapshot', 'guard', 'approve', 'snapshot', 'guard'])
    expect(h.acts[0]).toMatchObject({ spec: { action: 'click', index: 3 }, settle: 'full', approved: true })
  })

  it('a step that became risky in the tentative band is handed back, with no card', async () => {
    let classified = 0
    const h = harness({ decisions: [decision(opt('click', 3, 0.5))], ponr: () => ++classified > 1 })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(h.deps.approve).not.toHaveBeenCalled()
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

describe('a @driver run (cardTentative): an unsure point of no return is put to the user, not handed back', () => {
  it('a tentative point of no return raises the one-shot card saying the model is unsure (with p), then re-checks and acts', async () => {
    const h = harness({ cardTentative: true, decisions: [decision(opt('click', 1, 0.493)), decision(opt('done', undefined, 0.9))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done', steps: [{ op: 'click', index: 1, p: 0.49, ok: true }] })
    expect(h.deps.approve).toHaveBeenCalledTimes(1)
    expect(h.deps.approve).toHaveBeenCalledWith({ action: 'click', index: 1 }, SEARCH[1], { p: 0.49 })
    // The same stale re-check as a confident card: re-read, guards, element unchanged — then act.
    expect(h.log.slice(0, 7)).toEqual(['guard', 'snapshot', 'decide', 'approve', 'snapshot', 'guard', 'act click1'])
    expect(h.deps.hasElementChanged).toHaveBeenCalledWith(SEARCH[1], SEARCH[1])
    expect(h.acts[0]).toMatchObject({ settle: 'full', approved: true })
  })

  it('the user declining that card is a denial, and nothing acts', async () => {
    const h = harness({ cardTentative: true, approve: false, decisions: [decision(opt('click', 1, 0.5))] })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'blocked', reason: 'denied' })
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('an element that changed while that card was up is handed back, not clicked', async () => {
    const h = harness({ cardTentative: true, decisions: [decision(opt('click', 1, 0.5))] })
    let n = 0
    h.deps.snapshot = vi.fn(async () => pageOf(`p${n}`, n++ === 0 ? SEARCH : SEARCH.map((e) => (e.index === 1 ? { ...e, name: 'Place order' } : e))))
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'page changed' })
    expect(h.deps.approve).toHaveBeenCalledTimes(1)
    expect(h.deps.act).not.toHaveBeenCalled()
  })

  it('a confident point of no return gets the ordinary card (no unsure note)', async () => {
    const h = harness({ cardTentative: true, decisions: [decision(opt('click', 1, 0.9)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(h.deps)
    expect(vi.mocked(h.deps.approve).mock.calls[0]).toEqual([{ action: 'click', index: 1 }, SEARCH[1]])
  })

  it('a step that became risky in the tentative band is carded as unsure too', async () => {
    let classified = 0
    const h = harness({ cardTentative: true, decisions: [decision(opt('click', 3, 0.5)), decision(opt('done', undefined, 0.9))], ponr: () => ++classified > 1 })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.deps.approve).toHaveBeenCalledWith({ action: 'click', index: 3 }, SEARCH[3], { p: 0.5 })
    expect(h.acts[0]).toMatchObject({ spec: { action: 'click', index: 3 }, approved: true })
  })

  it('unchanged otherwise: below 0.4 hands back, a tentative done hands back, a tentative safe step acts without a card', async () => {
    const low = harness({ cardTentative: true, decisions: [decision(opt('click', 1, 0.39))] })
    expect(await runDriverLoop(low.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(low.deps.approve).not.toHaveBeenCalled()
    const done = harness({ cardTentative: true, decisions: [decision(opt('done', undefined, 0.59))] })
    expect(await runDriverLoop(done.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    const safe = harness({ cardTentative: true, decisions: [decision(opt('click', 3, 0.45)), decision(opt('done', undefined, 0.95))] })
    expect(await runDriverLoop(safe.deps)).toMatchObject({ status: 'done' })
    expect(safe.deps.approve).not.toHaveBeenCalled()
    const nan = harness({ cardTentative: true, decisions: [decision(opt('click', 1, Number.NaN))] })
    expect(await runDriverLoop(nan.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(nan.deps.approve).not.toHaveBeenCalled()
  })

  it('without it (the chat model’s FastSteps) the same tentative point of no return still hands back with no card', async () => {
    for (const cardTentative of [undefined, false]) {
      const h = harness({ cardTentative, decisions: [decision(opt('click', 1, 0.5))] })
      expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'handback', reason: 'unsure' })
      expect(h.deps.approve).not.toHaveBeenCalled()
    }
  })
})

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

  it('an immediate repeat of an element target is excluded even when the page changed (the double "Add to cart")', async () => {
    const h = harness({
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))],
    })
    expect(await runDriverLoop(h.deps)).toMatchObject({ status: 'done' })
    expect(h.acts.map((a) => a.spec.index)).toEqual([3])
    expect(h.decideCalls.map((c) => c.exclude)).toEqual([[], [], [{ op: 'click', index: 3 }]])
  })

  it('a repeat on the same page counts even when only its fragment changed (the store adds #added after a buy)', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    let reads = 0
    // Two reads before the click (the decision, and the re-read before acting); the fragment lands after it.
    h.deps.snapshot = vi.fn(async () => pageOf(`p${reads}`, SEARCH, reads++ < 2 ? 'https://shop.test/product?id=3' : 'https://shop.test/product?id=3#added'))
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3])
    expect(h.decideCalls.map((c) => c.exclude)).toEqual([[], [], [{ op: 'click', index: 3 }]])
  })

  it('the same index after a page change is a different target, not a repeat', async () => {
    // Measured: [5] was "Arc wireless headphones" on the results, then "Add to cart" on the product page.
    const results = SEARCH.map((e) => (e.index === 3 ? { ...e, tag: 'a', name: 'Arc wireless headphones', href: 'https://shop.test/product?id=3' } : e))
    const product = SEARCH.map((e) => (e.index === 3 ? { ...e, name: 'Add to cart' } : e))
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    h.deps.snapshot = vi.fn(async () => (h.acts.length === 0 ? pageOf('results', results, 'https://shop.test/search?q=arc') : pageOf(`product ${h.acts.length}`, product, 'https://shop.test/product?id=3')))
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3, 3])
    expect(h.decideCalls.every((c) => c.exclude.length === 0)).toBe(true)
  })

  it('an identical element at the same index on the next page is not a repeat ("Next page" through results)', async () => {
    const next = SEARCH.map((e) => (e.index === 3 ? { ...e, name: 'Next page' } : e))
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    h.deps.snapshot = vi.fn(async () => pageOf(`page ${h.acts.length + 1}`, next, `https://shop.test/search?q=mug&page=${h.acts.length + 1}`))
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3, 3])
    expect(h.decideCalls.every((c) => c.exclude.length === 0)).toBe(true)
  })

  it('the same index on the same page at an element that changed is not a repeat either', async () => {
    const h = harness({ decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))] })
    h.deps.snapshot = vi.fn(async () => pageOf(`p${h.acts.length}`, SEARCH.map((e) => (e.index === 3 ? { ...e, name: `Show more (${h.acts.length})` } : e))))
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3, 3])
    expect(h.decideCalls.every((c) => c.exclude.length === 0)).toBe(true)
  })

  it('the same target is fine again once another step came between', async () => {
    const h = harness({
      decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 0, 0.9)), decision(opt('click', 3, 0.9)), decision(opt('done', undefined, 0.9))],
    })
    await runDriverLoop(h.deps)
    expect(h.acts.map((a) => a.spec.index)).toEqual([3, 0, 3])
    expect(h.decideCalls.every((c) => c.exclude.length === 0)).toBe(true)
  })

  it('scrolling on down a page that keeps changing is not a repeat; a scroll that changed nothing is', async () => {
    const moving = harness({ decisions: [decision(opt('scroll', undefined, 0.8)), decision(opt('scroll', undefined, 0.8)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(moving.deps)
    expect(moving.acts.map((a) => a.spec.action)).toEqual(['scroll', 'scroll'])
    const stuck = harness({ pages: ['bottom'], decisions: [decision(opt('scroll', undefined, 0.8)), decision(opt('scroll', undefined, 0.8)), decision(opt('done', undefined, 0.9))] })
    await runDriverLoop(stuck.deps)
    expect(stuck.acts.map((a) => a.spec.action)).toEqual(['scroll'])
    expect(stuck.decideCalls.map((c) => c.exclude)).toEqual([[], [], [{ op: 'scroll' }]])
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
    const h = harness({ maxSteps: 3, decisions: [decision(opt('click', 3, 0.9)), decision(opt('click', 0, 0.9)), decision(opt('click', 3, 0.9))] })
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
    const alternating = Array.from({ length: 13 }, (_, k) => decision(opt('click', k % 2 ? 0 : 3, 0.9)))
    const big = harness({ maxSteps: 99, decisions: alternating })
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
