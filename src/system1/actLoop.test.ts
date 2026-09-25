import { describe, it, expect, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from '../tools/pageControl'
import type { DecideRequest, DecideResult } from './protocol'
import { ACT_MAX_STEPS, opFor, runActLoop, type ActDeps, type ExecOutcome } from './actLoop'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement

const snap = (elements: IndexedElement[]): PageSnapshot =>
  ({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: 'REGISTRY', truncated: false })

/**
 * Scripted decide, one entry per loop STEP (a step makes up to three calls:
 * move, then target, then value). The step pointer advances whenever a `move`
 * question is asked; the last entry repeats. p defaults to 0.9.
 */
function scripted(script: Array<Record<string, string | [string, number]>>) {
  const calls: DecideRequest[] = []
  let step = -1
  const decide = vi.fn(async (req: DecideRequest): Promise<DecideResult> => {
    calls.push(req)
    if ('move' in req.questions) step++
    const s = script[Math.min(step, script.length - 1)]
    const answers: DecideResult['answers'] = {}
    for (const key of Object.keys(req.questions)) {
      const v = s[key]
      const [choice, p] = Array.isArray(v) ? v : [v, 0.9]
      answers[key] = { choice, probabilities: { [choice]: p }, top: p, confidence: p }
    }
    return { answers, ms: 5 }
  })
  return { decide, calls }
}

function deps(over: Partial<ActDeps> & { elements?: IndexedElement[] } = {}): ActDeps & { executed: ControlSpec[] } {
  const executed: ControlSpec[] = []
  const elements = over.elements ?? [el(0), el(1, { tag: 'input', type: 'email', name: 'Email' })]
  return {
    executed,
    snapshot: async () => snap(elements),
    decide: over.decide ?? scripted([{ move: 'DONE' }]).decide,
    execute: over.execute ?? (async (spec) => { executed.push(spec); return { kind: 'ok', elements: 'REGISTRY' } as ExecOutcome }),
    aborted: over.aborted ?? (() => false),
  }
}

describe('opFor', () => {
  it('maps elements to the action they imply', () => {
    expect(opFor(el(0))).toBe('click')
    expect(opFor(el(0, { tag: 'a' }))).toBe('click')
    expect(opFor(el(0, { tag: 'input', type: 'email' }))).toBe('type')
    expect(opFor(el(0, { tag: 'input', type: 'checkbox' }))).toBe('click')
    expect(opFor(el(0, { tag: 'textarea' }))).toBe('type')
    expect(opFor(el(0, { tag: 'select' }))).toBe('select')
  })
})

describe('runActLoop', () => {
  it('stops done without acting when the model says DONE', async () => {
    const d = deps()
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('done')
    expect(d.executed).toEqual([])
  })

  it('clicks the chosen element, then finishes', async () => {
    const { decide } = scripted([{ move: 'act', target: '0' }, { move: 'DONE' }])
    const d = deps({ decide })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(d.executed).toEqual([{ action: 'click', index: 0 }])
    expect(r.status).toBe('done')
    expect(r.steps).toHaveLength(1)
  })

  it('types only a supplied value, verbatim, chosen by key', async () => {
    const { decide, calls } = scripted([{ move: 'act', target: '1', value: 'email' }, { move: 'DONE' }])
    const d = deps({ decide })
    await runActLoop({ goal: 'g', values: { email: 'a@b.co', name: 'Ada' } }, d)
    expect(d.executed).toEqual([{ action: 'type', index: 1, text: 'a@b.co', clear: true }])
    const valueQ = calls.find((c) => c.questions.value)!
    expect(Object.keys(valueQ.questions.value.options)).toEqual(['email', 'name'])
  })

  it('offers no type/select targets when no values were supplied', async () => {
    const { decide, calls } = scripted([{ move: 'act', target: '0' }, { move: 'DONE' }])
    await runActLoop({ goal: 'g' }, deps({ decide }))
    const targetQ = calls.find((c) => c.questions.target)!
    expect(Object.keys(targetQ.questions.target.options)).toEqual(['0'])
  })

  it('never offers a sensitive element', async () => {
    const { decide, calls } = scripted([{ move: 'act', target: '0' }, { move: 'DONE' }])
    const elements = [el(0), el(1, { tag: 'input', type: 'password', name: 'Password', sensitive: true })]
    await runActLoop({ goal: 'g', values: { pw: 'x' } }, deps({ decide, elements }))
    const targetQ = calls.find((c) => c.questions.target)!
    expect(Object.keys(targetQ.questions.target.options)).toEqual(['0'])
  })

  it('returns uncertain with top candidates when confidence is low', async () => {
    const { decide } = scripted([{ move: 'act', target: ['0', 0.4] }])
    const d = deps({ decide })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('uncertain')
    expect(d.executed).toEqual([])
    expect(r.candidates?.[0].index).toBe(0)
  })

  it('stops blocked', async () => {
    const r = await runActLoop({ goal: 'g' }, deps({ decide: scripted([{ move: 'BLOCKED' }]).decide }))
    expect(r.status).toBe('blocked')
  })

  it('stops on an immediate repeat of the same click', async () => {
    const d = deps({ decide: scripted([{ move: 'act', target: '0' }]).decide })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('repeat')
    expect(d.executed).toHaveLength(1)
  })

  it('maps denied / parked / drifted / error outcomes to their statuses', async () => {
    for (const [outcome, status] of [
      [{ kind: 'denied' }, 'denied'],
      [{ kind: 'parked', note: 'n' }, 'parked'],
      [{ kind: 'drifted', message: 'm' }, 'drifted'],
      [{ kind: 'error', message: 'm' }, 'error'],
    ] as const) {
      const d = deps({ decide: scripted([{ move: 'act', target: '0' }]).decide, execute: async () => outcome as ExecOutcome })
      expect((await runActLoop({ goal: 'g' }, d)).status).toBe(status)
    }
  })

  it('checks abort between steps (never before the first)', async () => {
    // The loop only consults aborted() from the second step on, so an
    // always-true signal still lets exactly one step run.
    const d = deps({ decide: scripted([{ move: 'scroll_down' }]).decide, aborted: () => true })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('aborted')
    expect(d.executed).toHaveLength(1)
  })

  it('caps at maxSteps, clamped to ACT_MAX_STEPS', async () => {
    let k = 0
    const decide = vi.fn(async (req: DecideRequest): Promise<DecideResult> => {
      const answers: DecideResult['answers'] = {}
      for (const key of Object.keys(req.questions))
        answers[key] = key === 'move'
          ? { choice: 'act', probabilities: {}, top: 0.9, confidence: 0.9 }
          : { choice: String(k++ % 2), probabilities: {}, top: 0.9, confidence: 0.9 }
      return { answers, ms: 1 }
    })
    // Two plain buttons, alternated, so no step is a repeat and no value is needed.
    const d = deps({ decide, elements: [el(0), el(1)] })
    const r = await runActLoop({ goal: 'g', maxSteps: 99 }, d)
    expect(r.status).toBe('capped')
    expect(d.executed).toHaveLength(ACT_MAX_STEPS)
  })

  it('reports an engine failure as error, not a throw', async () => {
    const d = deps({ decide: async () => { throw new Error('gpu lost') } })
    const r = await runActLoop({ goal: 'g' }, d)
    expect(r.status).toBe('error')
    expect(r.message).toMatch(/gpu lost/)
  })
})
