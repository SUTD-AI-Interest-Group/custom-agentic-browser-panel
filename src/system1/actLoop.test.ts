import { describe, it, expect, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { BrowserDecision, BrowserPolicy, DecisionContext } from './policy'
import { PolicyInputError } from './policy'
import type { ValidatedAction } from './validate'
import { ACT_CONFIDENCE, ACT_MAX_STEPS, ACT_TRY_CONFIDENCE, NO_PROGRESS_STEPS, runActLoop, type ActDeps, type ExecOutcome } from './actLoop'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement
const snap = (elements: IndexedElement[], over: Partial<PageSnapshot> = {}): PageSnapshot =>
  ({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: 'REGISTRY', truncated: false, scroll: { y: 0, max: 500 }, ...over })

type Script = Partial<BrowserDecision> & { operation: BrowserDecision['operation']; p?: number; pt?: number; pv?: number }
/** A policy scripted per STEP; the last entry repeats. Records every context it was given. */
function policyOf(script: Script[]): BrowserPolicy & { contexts: DecisionContext[] } {
  const contexts: DecisionContext[] = []
  return {
    contexts,
    async decide(ctx) {
      contexts.push(ctx)
      const s = script[Math.min(contexts.length - 1, script.length - 1)]
      const { p = 0.9, pt, pv, ...rest } = s
      const d: BrowserDecision = { ms: 5, ...rest, confidence: { operation: p } }
      if (rest.targetId !== undefined) d.confidence.target = pt ?? 0.9
      if (rest.valueKey !== undefined) d.confidence.value = pv ?? 0.9
      return d
    },
  }
}

function deps(over: Partial<ActDeps> & { elements?: IndexedElement[]; snapshots?: PageSnapshot[] } = {}) {
  const executed: ValidatedAction[] = []
  const elements = over.elements ?? [el(0), el(1, { tag: 'input', type: 'email', name: 'Email' })]
  let i = 0
  const snapshots = over.snapshots
  const d: ActDeps & { executed: ValidatedAction[] } = {
    executed,
    snapshot: over.snapshot ?? (async () => (snapshots ? snapshots[Math.min(i++, snapshots.length - 1)] : snap(elements))),
    policy: over.policy ?? policyOf([{ operation: 'DONE' }]),
    execute: over.execute ?? (async (a) => { executed.push(a); return { kind: 'ok', elements: 'REGISTRY' } as ExecOutcome }),
    aborted: over.aborted ?? (() => false),
    now: over.now,
  }
  return d
}

describe('runActLoop — terminal answers and gates', () => {
  it('stops done without acting when the policy says DONE', async () => {
    const d = deps()
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('done')
    expect(d.executed).toEqual([])
    expect(r.elements).toBe('REGISTRY')
    expect(r.transitions).toHaveLength(1)
    expect(r.transitions[0].decision.operation).toBe('DONE')
  })

  it('stops blocked with the reason code', async () => {
    const r = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'BLOCKED', blockedReason: 'AUTH_REQUIRED' }]) }))
    expect(r).toMatchObject({ status: 'blocked', blockedReason: 'AUTH_REQUIRED', elements: 'REGISTRY' })
  })

  it('returns uncertain below ACT_TRY_CONFIDENCE on the operation, target or value head, with the ranked candidates', async () => {
    const op = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, p: 0.3 }]) }))
    expect(op.status).toBe('uncertain')
    expect(op.message).toMatch(/operation/)
    const target = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, pt: 0.35, ranked: [{ id: 0, p: 0.35 }, { id: 1, p: 0.3 }] }]) }))
    expect(target.status).toBe('uncertain')
    expect(target.candidates).toEqual([{ index: 0, label: 'Button 0', p: 0.35 }, { index: 1, label: 'Email', p: 0.3 }])
    const value = await runActLoop({ goal: 'g', values: { email: 'a@b.co' } }, deps({ policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email', pv: 0.2 }]) }))
    expect(value.status).toBe('uncertain')
    expect(value.message).toContain('"Email"')
  })

  it('executes a decision in the tentative band as tentative, and hands back if the executor finds it committing', async () => {
    expect(ACT_TRY_CONFIDENCE).toBeLessThan(ACT_CONFIDENCE)
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, p: 0.9, pt: 0.45, ranked: [{ id: 0, p: 0.45 }] }, { operation: 'DONE' }]), snapshots: [snap([el(0)]), snap([el(0), el(1)])] })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('done')
    expect(d.executed[0].tentative).toBe(true)
    expect(r.steps[0].p).toBe(0.45)

    const confident = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, p: 0.9, pt: 0.7 }, { operation: 'DONE' }]), snapshots: [snap([el(0)]), snap([el(0), el(1)])] })
    await runActLoop({ goal: 'g' }, confident)
    expect(confident.executed[0].tentative).toBeUndefined()

    const refused = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, pt: 0.5, ranked: [{ id: 0, p: 0.5 }] }]), execute: async () => ({ kind: 'uncertain', message: 'committing' }) })
    const r2 = await runActLoop({ goal: 'g' }, refused)
    expect(r2.status).toBe('uncertain')
    expect(r2.message).toContain('committing')
    expect(r2.candidates).toEqual([{ index: 0, label: 'Button 0', p: 0.5 }])
    expect(r2.transitions[0].result).toBe('uncertain')
    expect(r2.steps).toEqual([])
  })

  it('needs ACT_CONFIDENCE for the terminal answers, and names the missing field on BLOCKED/MISSING_USER_DATA', async () => {
    const done = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'DONE', p: 0.5 }]) }))
    expect(done.status).toBe('uncertain')
    expect(done.message).toMatch(/possibly done/)
    const blocked = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'BLOCKED', blockedReason: 'AUTH_REQUIRED', p: 0.5 }]) }))
    expect(blocked.status).toBe('uncertain')
    const missing = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'BLOCKED', blockedReason: 'MISSING_USER_DATA', missingFieldId: 1 }]) }))
    expect(missing).toMatchObject({ status: 'blocked', blockedReason: 'MISSING_USER_DATA', missingField: { index: 1, label: 'Email' } })
    expect(missing.message).toContain('[1] "Email"')
    const unknownField = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'BLOCKED', blockedReason: 'MISSING_USER_DATA', missingFieldId: 99 }]) }))
    expect(unknownField.missingField).toBeUndefined()
  })

  it('passes ACT_TRY_CONFIDENCE to the policy and never asks for a target it cannot gate', async () => {
    const p = policyOf([{ operation: 'CLICK', targetId: 0 }])
    await runActLoop({ goal: 'g' }, deps({ policy: p }))
    expect(p.contexts[0].threshold).toBe(ACT_TRY_CONFIDENCE)
    const noTarget = await runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'CLICK' }]) }))
    expect(noTarget.status).toBe('uncertain')
  })

  it('turns PolicyInputError into uncertain and any other policy failure into error', async () => {
    const tooDense = await runActLoop({ goal: 'g' }, deps({ policy: { decide: async () => { throw new PolicyInputError('too dense') } } }))
    expect(tooDense).toMatchObject({ status: 'uncertain', message: 'too dense', elements: 'REGISTRY' })
    const boom = await runActLoop({ goal: 'g' }, deps({ policy: { decide: async () => { throw new Error('gpu lost') } } }))
    expect(boom).toMatchObject({ status: 'error', message: 'System-1 engine failed: gpu lost' })
    const unreadable = await runActLoop({ goal: 'g' }, deps({ snapshot: async () => { throw new Error('no tab') } }))
    expect(unreadable).toMatchObject({ status: 'error', message: 'could not read the page: no tab' })
  })
})

describe('runActLoop — acting', () => {
  it('executes a click with the target fingerprint, then records the step with the min confidence', async () => {
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0, p: 0.9, pt: 0.7 }, { operation: 'DONE' }]), snapshots: [snap([el(0)]), snap([el(0), el(1, { name: 'Added!' })])] })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('done')
    expect(d.executed).toHaveLength(1)
    expect(d.executed[0]).toMatchObject({ operation: 'CLICK', spec: { action: 'click', index: 0 }, targetId: 0, expect: { id: 0, fingerprint: { tag: 'button', name: 'Button 0' } } })
    expect(r.steps).toEqual([{ operation: 'CLICK', targetId: 0, label: 'Button 0', valueKey: undefined, result: 'success', p: 0.7, ms: 5 }])
  })

  it('types a provided value verbatim by key and never any other text', async () => {
    const d = deps({ policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email' }, { operation: 'DONE' }]) })
    const r = await runActLoop({ goal: 'g', values: { email: 'ada@example.com' } }, d)
    expect(d.executed[0].spec).toEqual({ action: 'type', index: 1, text: 'ada@example.com', clear: true })
    expect(r.steps[0]).toMatchObject({ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email', label: 'Email' })
  })

  it('maps scroll and wait to their specs', async () => {
    const d = deps({ policy: policyOf([{ operation: 'SCROLL_DOWN' }, { operation: 'WAIT' }, { operation: 'DONE' }]), snapshots: [snap([el(0)]), snap([el(0), el(1)]), snap([el(0), el(1), el(2)])] })
    await runActLoop({ goal: 'g' }, d)
    expect(d.executed.map((a) => a.spec)).toEqual([{ action: 'scroll', direction: 'down' }, { action: 'wait', timeoutMs: 3000 }])
  })

  it('rejects an action outside the candidate space instead of executing it', async () => {
    const sensitive = deps({ elements: [el(0), el(1, { tag: 'input', type: 'password', name: 'Password', sensitive: true })], policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'pw' }]) })
    const r1 = await runActLoop({ goal: 'g', values: { pw: 'hunter2' } }, sensitive)
    expect(r1.status).toBe('error')
    expect(r1.message).toMatch(/outside the candidate space/)
    expect(sensitive.executed).toEqual([])
    expect(r1.transitions[0].result).toBe('rejected')

    const noValues = deps({ policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email' }]) })
    expect((await runActLoop({ goal: 'g' }, noValues)).status).toBe('error')
    expect(noValues.executed).toEqual([])

    const badOp = deps({ policy: policyOf([{ operation: 'SCROLL_UP' }]) }) // at the top: not offered
    expect((await runActLoop({ goal: 'g' }, badOp)).status).toBe('error')
    expect(badOp.executed).toEqual([])
  })

  it('never offers a sensitive control as a target to the policy', async () => {
    const p = policyOf([{ operation: 'DONE' }])
    await runActLoop({ goal: 'g', values: { pw: 'x' } }, deps({ elements: [el(0), el(1, { tag: 'input', type: 'password', sensitive: true })], policy: p }))
    expect(p.contexts[0].space.targets).toEqual({ CLICK: [0], TYPE_TEXT: [], SELECT_OPTION: [] })
    expect(p.contexts[0].space.shown).toEqual([0, 1])
  })
})

describe('runActLoop — history, loops and staleness', () => {
  it('marks a step no_change when the page hash did not move, and the policy sees that in its history', async () => {
    const p = policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'DONE' }])
    const r = await runActLoop({ goal: 'g' }, deps({ policy: p }))
    expect(r.steps[0].result).toBe('no_change')
    expect(r.transitions[0].result).toBe('no_change')
    expect(p.contexts[1].steps[0].result).toBe('no_change')
  })

  it('keeps success when the page changed', async () => {
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'DONE' }]), snapshots: [snap([el(0)]), snap([el(0), el(1, { name: 'Added!' })])] })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.steps[0].result).toBe('success')
  })

  it('stops with repeat before executing the same action on an unchanged page a second time', async () => {
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0 }]) })
    const r = await runActLoop({ goal: 'g', maxSteps: 5 }, d)
    expect(r.status).toBe('repeat')
    expect(d.executed).toHaveLength(1)
    expect(r.message).toContain('[0]')
    expect(r.transitions[1].result).toBe('repeat')
  })

  it('stops with repeat on the same element action twice in a row even when the page changed', async () => {
    // Measured: "Add to cart" changes the cart badge (a new hash) and the
    // policy never says DONE, so without this rule it clicked five times.
    const snapshots = Array.from({ length: 6 }, (_, i) => snap([el(0, { name: 'Add mug' }), el(1, { name: `Cart (${i})` })]))
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0 }]), snapshots })
    const r = await runActLoop({ goal: 'add the mug', maxSteps: 6 }, d)
    expect(r.status).toBe('repeat')
    expect(r.message).toContain('twice in a row')
    expect(d.executed).toHaveLength(1)

    // A retry after a stale step is not a repeat.
    let n = 0
    const afterStale = deps({
      policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'CLICK', targetId: 0 }, { operation: 'DONE' }]),
      execute: async () => (n++ === 0 ? { kind: 'stale' } : { kind: 'ok', elements: 'R' }),
      snapshots: [snap([el(0)]), snap([el(0, { name: 'Renamed' })]), snap([el(0, { name: 'Renamed' }), el(1)])],
    })
    expect((await runActLoop({ goal: 'g' }, afterStale)).status).toBe('done')
    expect(n).toBe(2)
  })

  it('stops after NO_PROGRESS_STEPS consecutive actions that changed nothing, WAIT excluded', async () => {
    // Three different clicks on an unchanged page: no hash-repeat (different targets), but no progress either.
    const elements = [el(0), el(1), el(2), el(3)]
    const futile = deps({ elements, policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'CLICK', targetId: 1 }, { operation: 'CLICK', targetId: 2 }, { operation: 'CLICK', targetId: 3 }]) })
    const r = await runActLoop({ goal: 'g', maxSteps: 8 }, futile)
    expect(r.status).toBe('repeat')
    expect(r.message).toContain(`${NO_PROGRESS_STEPS} actions in a row`)
    expect(futile.executed).toHaveLength(NO_PROGRESS_STEPS)
    // Waiting on a page that is still loading is not a loop — twice. A third
    // WAIT with nothing changed is.
    const waiting = deps({ elements, policy: policyOf([{ operation: 'WAIT' }, { operation: 'WAIT' }, { operation: 'DONE' }]) })
    expect((await runActLoop({ goal: 'g', maxSteps: 8 }, waiting)).status).toBe('done')
    const waitedOut = deps({ elements, policy: policyOf([{ operation: 'WAIT' }]) })
    const w = await runActLoop({ goal: 'g', maxSteps: 8 }, waitedOut)
    expect(w.status).toBe('repeat')
    expect(w.message).toContain('waited twice')
    expect(waitedOut.executed).toHaveLength(2)
  })

  it('observes from the executor’s post-action snapshot when it gives one, instead of reading the page again', async () => {
    let reads = 0
    const after = snap([el(0), el(1, { name: 'Added!' })])
    const d = deps({
      policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'DONE' }]),
      snapshot: async () => { reads++; return snap([el(0)]) },
      execute: async () => ({ kind: 'ok', elements: 'R', snapshot: after }),
    })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('done')
    expect(reads).toBe(1)
    expect(r.transitions[1].observation.controls).toBe(2)
    expect(r.steps[0].result).toBe('success')
  })

  it('asks once more with the repeated (operation, target) excluded, and executes the second choice', async () => {
    // Run A, 2026-09-30: every form call typed one value, then chose the same
    // field again. Now that first repeat narrows the space and asks again.
    const message = el(1, { tag: 'input', type: 'text', name: 'Message' })
    const name = el(2, { tag: 'input', type: 'text', name: 'Name' })
    const p = policyOf([
      { operation: 'TYPE_TEXT', targetId: 1, valueKey: 'message' },
      { operation: 'TYPE_TEXT', targetId: 1, valueKey: 'message' }, // would repeat → excluded → asked again
      { operation: 'TYPE_TEXT', targetId: 2, valueKey: 'name' },
      { operation: 'DONE' },
    ])
    const d = deps({ policy: p, snapshots: [snap([el(0), message, name]), snap([el(0), { ...message, value: 'Hello' }, name]), snap([el(0), { ...message, value: 'Hello' }, { ...name, value: 'Ada' }])] })
    const r = await runActLoop({ goal: 'fill the form', values: { message: 'Hello there', name: 'Ada Lovelace' } }, d)
    expect(r.status).toBe('done')
    expect(d.executed.map((a) => a.targetId)).toEqual([1, 2])
    expect(p.contexts[2].space.targets.TYPE_TEXT).toEqual([2])
    expect(p.contexts[2].space.operations).toContain('TYPE_TEXT')
    expect(r.transitions.map((t) => t.result)).toEqual(['success', 'repeat', 'success', undefined])
    expect(r.transitions[2].retry).toBe(true)
    expect(r.transitions[2].seq).toBe(2)
    // Excluding the last target of an operation withdraws the operation.
    const only = deps({ policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'message' }, { operation: 'TYPE_TEXT', targetId: 1, valueKey: 'message' }, { operation: 'DONE' }]), snapshots: [snap([el(0), message]), snap([el(0), { ...message, value: 'Hello' }])] })
    const r2 = await runActLoop({ goal: 'g', values: { message: 'Hello there' } }, only)
    expect(r2.status).toBe('done')
    expect(only.policy === undefined).toBe(false)
    const ctx = (only.policy as ReturnType<typeof policyOf>).contexts[2]
    expect(ctx.space.operations).not.toContain('TYPE_TEXT')
    expect(ctx.space.targets.TYPE_TEXT).toEqual([])
  })

  it('allows the same action again once the page changed (a second value into the same field)', async () => {
    const d = deps({
      policy: policyOf([{ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'a' }, { operation: 'TYPE_TEXT', targetId: 1, valueKey: 'b' }, { operation: 'DONE' }]),
      snapshots: [snap([el(0), el(1, { tag: 'input', type: 'text', name: 'Q', value: '' })]), snap([el(0), el(1, { tag: 'input', type: 'text', name: 'Q', value: 'A' })]), snap([el(0), el(1, { tag: 'input', type: 'text', name: 'Q', value: 'B' })])],
    })
    const r = await runActLoop({ goal: 'g', values: { a: 'AAAA', b: 'BBBB' } }, d)
    expect(r.status).toBe('done')
    expect(d.executed).toHaveLength(2)
  })

  it('records a stale target, re-observes, and errors on the second consecutive stale', async () => {
    let calls = 0
    const d = deps({
      policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'CLICK', targetId: 1 }, { operation: 'DONE' }]),
      execute: async () => { calls++; return { kind: 'stale' } },
      snapshots: [snap([el(0)]), snap([el(0), el(1)]), snap([el(0), el(1), el(2)])],
    })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(calls).toBe(2)
    expect(r.status).toBe('error')
    expect(r.steps.map((s) => s.result)).toEqual(['stale', 'stale'])
    expect(r.transitions.map((t) => t.result)).toEqual(['stale', 'stale'])

    let n = 0
    const recovers = deps({
      policy: policyOf([{ operation: 'CLICK', targetId: 0 }, { operation: 'CLICK', targetId: 0 }, { operation: 'DONE' }]),
      execute: async () => (n++ === 0 ? { kind: 'stale' } : { kind: 'ok', elements: 'R' }),
      snapshots: [snap([el(0)]), snap([el(0, { name: 'Renamed' })]), snap([el(0, { name: 'Renamed' }), el(1)])],
    })
    const r2 = await runActLoop({ goal: 'g' }, recovers)
    expect(r2.status).toBe('done')
    expect(r2.steps.map((s) => s.result)).toEqual(['stale', 'success'])
  })

  it('maps denied, parked, drifted and error outcomes to their statuses', async () => {
    const run = (kind: ExecOutcome) => runActLoop({ goal: 'g' }, deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0 }]), execute: async () => kind }))
    expect((await run({ kind: 'denied' })).status).toBe('denied')
    expect(await run({ kind: 'parked', note: 'come back' })).toMatchObject({ status: 'parked', message: 'come back' })
    expect(await run({ kind: 'drifted', message: 'moved', elements: 'NEW' })).toMatchObject({ status: 'drifted', message: 'moved', elements: 'NEW' })
    expect(await run({ kind: 'error', message: 'nope' })).toMatchObject({ status: 'error', message: 'nope' })
  })

  it('checks abort between steps, never before the first', async () => {
    let aborted = false
    const d = deps({ policy: policyOf([{ operation: 'CLICK', targetId: 0 }]), aborted: () => aborted, execute: async () => { aborted = true; return { kind: 'ok', elements: 'R' } } })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('aborted')
    expect(d.executed).toHaveLength(0) // execute is stubbed above; the loop ran exactly one step
  })

  it('caps at maxSteps, clamped to ACT_MAX_STEPS, and records per-phase timings', async () => {
    let t = 0
    const snapshots = Array.from({ length: 12 }, (_, i) => snap(Array.from({ length: i + 1 }, (_, j) => el(j))))
    const d = deps({ policy: policyOf([{ operation: 'SCROLL_DOWN' }]), snapshots, now: () => (t += 10) })
    const r = await runActLoop({ goal: 'g', maxSteps: 99 }, d)
    expect(r.status).toBe('capped')
    expect(r.steps).toHaveLength(ACT_MAX_STEPS)
    expect(r.transitions[0].ms).toEqual({ observe: 10, policy: 10, execute: 10 })
    expect(r.transitions[0].space.stats.controls).toBe(1)
  })
})
