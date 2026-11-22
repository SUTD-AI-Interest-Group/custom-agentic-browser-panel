import { describe, expect, it } from 'vitest'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { runAgentTurn, type QueuedImage, type UIPart } from './agent'
import { createDriverScript, elementLabel, finalTextFor, MAX_FAST_STEPS_RUNS, MAX_SCRIPT_CALLS, nextDriverAction } from './driverScript'
import { parseDriverPrompt, type DriverSpec } from '../decider/driverPrompt'

// The scripted model behind `@driver`, driven through the REAL runAgentTurn (the same loop the
// offscreen chat host runs) with fake tools, as agent.test.ts does with its mock models. Each test
// asserts the tool calls the script made, in order, and the text it ended on.

const REGISTRY = [
  '[0]<input> search "Search the store" = "wireless headphones"',
  '[1]<button> "Search"',
  '[2]<a> "Arc wireless headphones — $64"',
  '[3]<input> email "Email" = "ada@example.com"',
  '[4]<button> "Add to cart"',
  '[5]<select> "Country" = "United Kingdom"',
  '[6]<input> = "secret-without-a-name"',
].join('\n')

const GRANT = { started: true, url: 'http://127.0.0.1/store/', title: 'Store', elements: REGISTRY }
const DENIED = { denied: true, message: 'The user denied permission for this tool call.' }
const step = (op: string, index: number | undefined, key?: string) => ({ op, ...(index === undefined ? {} : { index }), p: 0.9, ms: 40, ok: true, ...(key ? { key } : {}) })
const run = (over: Record<string, unknown>) => ({ steps: [], decisions: 1, deciderMs: 50, actions: [], elements: REGISTRY, ...over })

interface Script {
  rpc?: unknown[]
  fast?: unknown[]
  /** Throw from FastSteps instead (a tool-error). */
  fastThrows?: string
  /** Push a set-of-marks style image on the grant, as lookResult does for a vision model. */
  imageOnGrant?: boolean
  /**
   * Model the service worker's session: a grant opens it; FastSteps without one answers "No
   * page-control session is open" (a resumed chain's tool host has ended the parked chain's).
   */
  sessions?: { open: boolean }
}

async function drive(spec: DriverSpec, script: Script, history: ModelMessage[] = [{ role: 'user', content: spec.goal }]) {
  const calls: { name: string; input: any }[] = []
  const imageQueue: QueuedImage[] = []
  let r = 0
  let f = 0
  const activeNames = new Set(['RequestPageControl', 'FastSteps'])
  const tools = {
    ReadPage: tool({ description: 'read', inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
    RequestPageControl: tool({
      description: 'control',
      inputSchema: z.object({ plan: z.string() }),
      execute: async (input) => {
        calls.push({ name: 'RequestPageControl', input })
        if (script.imageOnGrant) imageQueue.push({ dataUrl: 'data:image/png;base64,AAAA', caption: 'marks' })
        const out = (script.rpc ?? [GRANT])[Math.min(r++, (script.rpc ?? [GRANT]).length - 1)] as { started?: boolean }
        if (script.sessions && out.started === true) script.sessions.open = true
        return out
      },
    }),
    FastSteps: tool({
      description: 'fast',
      inputSchema: z.object({ goal: z.string(), values: z.record(z.string(), z.string()).optional(), maxSteps: z.number().optional() }),
      execute: async (input) => {
        calls.push({ name: 'FastSteps', input })
        if (script.fastThrows) throw new Error(script.fastThrows)
        if (script.sessions && !script.sessions.open) return { error: 'No page-control session is open. Call RequestPageControl first.' }
        const list = script.fast ?? [run({ status: 'done', reason: 'done' })]
        return list[Math.min(f++, list.length - 1)] as object
      },
    }),
  }
  const parts: UIPart[] = []
  const result = await runAgentTurn({
    model: createDriverScript(spec),
    system: 'unused',
    history,
    tools,
    abortSignal: new AbortController().signal,
    onUpdate: (p) => {
      parts.length = 0
      parts.push(...p)
    },
    imageQueue,
    activeNames,
    // The agent-state block rides at the prompt's tail as a `user` message every step — and it
    // quotes the plan, which is the goal.
    agentState: () => ({ control: { plan: spec.goal, actions: 0 } }),
  })
  const text = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
  return { calls, text, result }
}

const SPEC: DriverSpec = { goal: 'search "wireless headphones" and add the cheapest under $100 to my cart', values: { search: 'wireless headphones' } }

describe('createDriverScript through runAgentTurn', () => {
  it('asks for page control first, with the goal as the plan; a grant → FastSteps with the goal and values; done → "Done in N steps"', async () => {
    const { calls, text, result } = await drive(SPEC, {
      fast: [run({ status: 'done', reason: 'done', steps: [step('type', 0, 'request.search'), step('click', 1), step('click', 2), step('click', 4)] })],
    })
    expect(calls).toEqual([
      { name: 'RequestPageControl', input: { plan: SPEC.goal } },
      { name: 'FastSteps', input: { goal: SPEC.goal, values: { search: 'wireless headphones' } } },
    ])
    expect(text).toBe('Done in 4 steps. Typed values: request.search.')
    expect(result.stop.reason).toBe('completed')
    expect(result.usage?.inputTokens ?? 0).toBe(0)
  })

  it('a denied page-control card → a final text, and no FastSteps', async () => {
    const { calls, text } = await drive(SPEC, { rpc: [DENIED] })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl'])
    expect(text).toBe('You declined page control.')
  })

  it('a page-control error → a final text naming it, and no FastSteps', async () => {
    const { calls, text } = await drive(SPEC, { rpc: [{ error: 'Cannot control this page (blocked).' }] })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl'])
    expect(text).toBe("Couldn't take control of the page (Cannot control this page (blocked).).")
  })

  it('a FastSteps error result → a final text and stop', async () => {
    const { calls, text } = await drive(SPEC, { fast: [{ error: 'The controlled tab is no longer active.' }] })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
    expect(text).toBe("Stopped before taking a step — the decision model couldn't run (The controlled tab is no longer active.).")
  })

  it('"No page-control session is open" once → control is requested again (a fresh card), then FastSteps; twice → a final text', async () => {
    const gone = { error: 'No page-control session is open. Call RequestPageControl first.' }
    const once = await drive(SPEC, { fast: [gone, run({ status: 'done', reason: 'done', steps: [step('click', 4)] })] })
    expect(once.calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps', 'RequestPageControl', 'FastSteps'])
    expect(once.text).toBe('Done in 1 step.')
    const twice = await drive(SPEC, { fast: [gone] })
    expect(twice.calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps', 'RequestPageControl', 'FastSteps'])
    expect(twice.text).toMatch(/couldn't run \(No page-control session is open/)
  })

  it('a FastSteps that throws (a tool-error) → a final text and stop', async () => {
    const { calls, text } = await drive(SPEC, { fastThrows: 'Tool FastSteps is disabled or unavailable.' })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
    expect(text).toContain("couldn't run (")
    expect(text).toContain('Tool FastSteps is disabled or unavailable.')
  })

  it('a max-steps hand-back runs FastSteps again — at most two more runs, three in all', async () => {
    const maxed = run({ status: 'handback', reason: 'max steps', message: 'Took 12 steps; re-read the page and continue.', steps: [step('click', 1), step('click', 2)] })
    const { calls, text } = await drive(SPEC, { fast: [maxed] })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps', 'FastSteps', 'FastSteps'])
    expect(calls.filter((c) => c.name === 'FastSteps')).toHaveLength(MAX_FAST_STEPS_RUNS)
    expect(text).toBe('Stopped after 6 steps — it ran out of steps before finishing.')
  })

  it('a max-steps hand-back then done: the re-run finishes, steps summed across runs', async () => {
    const { calls, text } = await drive(SPEC, {
      fast: [run({ status: 'handback', reason: 'max steps', steps: [step('click', 1), step('click', 2)] }), run({ status: 'done', reason: 'done', steps: [step('click', 4)] })],
    })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps', 'FastSteps'])
    expect(text).toBe('Done in 3 steps.')
  })

  it('an unsure hand-back → the reason, the p and the element label, and no re-run', async () => {
    const { calls, text } = await drive(SPEC, {
      fast: [run({ status: 'handback', reason: 'unsure', message: 'Unsure of the next step (p=0.52).', lastDecision: [{ op: 'click', index: 4, p: 0.52 }], steps: [step('type', 0, 'request.search'), step('click', 1), step('click', 2), step('click', 2)] })],
    })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
    expect(text).toBe('Stopped after 4 steps — the decision model wasn\'t sure (p=0.52) at "Add to cart". Typed values: request.search.')
  })

  it('other hand-back reasons each end the turn with their own short text', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: 'handback', reason: 'needs value', lastDecision: [{ op: 'type', index: 3, p: 0.8 }] }, 'Stopped before taking a step — the decision model had no value to type into "Email" — put the text in double quotes.'],
      [{ status: 'handback', reason: 'needs value', lastDecision: [{ op: 'select', index: 5, p: 0.8 }] }, 'Stopped before taking a step — the decision model couldn\'t choose an option in "Country".'],
      [{ status: 'blocked', reason: 'denied', lastDecision: [{ op: 'click', index: 4, p: 0.9 }] }, 'Stopped before taking a step — you declined the step at "Add to cart".'],
      [{ status: 'handback', reason: 'unsure', lastDecision: [{ op: 'done', p: 0.45 }] }, "Stopped before taking a step — the decision model wasn't sure the task was done (p=0.45)."],
      [{ status: 'handback', reason: 'dense page' }, 'Stopped before taking a step — the page is too dense for the decision model.'],
      [{ status: 'handback', reason: 'decider error', message: 'the decision model did not answer in time' }, 'Stopped before taking a step — the decision model failed (the decision model did not answer in time).'],
      [{ status: 'handback', reason: 'no progress' }, 'Stopped before taking a step — its last actions changed nothing on the page.'],
    ]
    for (const [over, want] of cases) {
      const { calls, text } = await drive(SPEC, { fast: [run(over)] })
      expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
      expect(text).toBe(want)
    }
  })

  it('the final text never contains a value the page holds or the profile filled in', async () => {
    // FastSteps' registry carries every field's current value; the text may name the field only.
    const { text } = await drive(
      { goal: 'sign me up', values: {} },
      { fast: [run({ status: 'handback', reason: 'unsure', lastDecision: [{ op: 'type', index: 3, p: 0.5 }], steps: [step('type', 3, 'profile.email')] })] },
    )
    expect(text).toContain('"Email"')
    expect(text).toContain('profile.email')
    expect(text).not.toContain('ada@example.com')
    // An element with no name of its own is never labelled by its value.
    const { text: unnamed } = await drive(
      { goal: 'x', values: {} },
      { fast: [run({ status: 'handback', reason: 'unsure', lastDecision: [{ op: 'click', index: 6, p: 0.5 }] })] },
    )
    expect(unnamed).not.toContain('secret-without-a-name')
    expect(unnamed).toContain('at element [6]')
  })

  it('reads only THIS turn: an earlier driver turn in history does not count', async () => {
    const earlier: ModelMessage[] = [
      { role: 'user', content: 'add the mug' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old-1', toolName: 'RequestPageControl', input: { plan: 'add the mug' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old-1', toolName: 'RequestPageControl', output: { type: 'json', value: GRANT } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old-2', toolName: 'FastSteps', input: { goal: 'add the mug' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old-2', toolName: 'FastSteps', output: { type: 'json', value: run({ status: 'done', reason: 'done' }) } }] },
      { role: 'assistant', content: 'Done in 0 steps.' },
      { role: 'user', content: SPEC.goal },
    ]
    const { calls } = await drive(SPEC, {}, earlier)
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
  })

  it('goal phrases in use: the decider is told the framed goal (plan and FastSteps goal), while the turn is still found by the user’s words', async () => {
    const spec = parseDriverPrompt('@driver add the blue Aurora mug to my cart')
    const history: ModelMessage[] = [
      // An earlier turn the script must not read.
      { role: 'user', content: 'add the mug' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'e-1', toolName: 'FastSteps', input: { goal: 'add the mug' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'e-1', toolName: 'FastSteps', output: { type: 'json', value: run({ status: 'stopped', reason: 'parked', parked: true }) } }] },
      // The panel's model-facing copy: the user's words, not the framing.
      { role: 'user', content: `${spec.goal}\n\n[Open on screen right now: "Store" (http://127.0.0.1/store/). This supersedes …]` },
    ]
    const { calls } = await drive(spec, {}, history)
    expect(calls).toEqual([
      { name: 'RequestPageControl', input: { plan: 'search for "blue Aurora mug", then add the blue Aurora mug to my cart' } },
      { name: 'FastSteps', input: { goal: 'search for "blue Aurora mug", then add the blue Aurora mug to my cart', values: { phrase: 'blue Aurora mug' } } },
    ])
  })

  it('a fresh driver turn after one that ended on a parked FastSteps starts over (page control first)', async () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'add the mug' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'o-1', toolName: 'FastSteps', input: { goal: 'add the mug' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'o-1', toolName: 'FastSteps', output: { type: 'json', value: run({ status: 'stopped', reason: 'parked', parked: true }) } }] },
      // The panel's model-facing copy: the message minus the token, then its context lines.
      { role: 'user', content: `${SPEC.goal.replace(' and ', '  and\n')}\n\n[Open on screen right now: "Store" (http://127.0.0.1/store/). This supersedes …]` },
    ]
    const { calls } = await drive(SPEC, {}, history)
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
  })

  it('steps over the messages prepareStep injects at the tail (a queued image after the grant)', async () => {
    const { calls, text } = await drive(SPEC, { imageOnGrant: true })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
    expect(text).toBe('Done in 0 steps.')
  })

  it('resuming after a parked FastSteps asks for control again (fresh card) before FastSteps — the session is the resumed chain\'s', async () => {
    const parked = run({ status: 'stopped', reason: 'parked', parked: true, steps: [step('type', 0, 'request.search'), step('click', 1)] })
    const history: ModelMessage[] = [
      { role: 'user', content: SPEC.goal },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'p-1', toolName: 'RequestPageControl', input: { plan: SPEC.goal } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'p-1', toolName: 'RequestPageControl', output: { type: 'json', value: GRANT } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'p-2', toolName: 'FastSteps', input: { goal: SPEC.goal } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'p-2', toolName: 'FastSteps', output: { type: 'json', value: parked } }] },
    ]
    // The resumed chain starts with no session in the worker: FastSteps alone would fail.
    const sessions = { open: false }
    const { calls, text } = await drive(SPEC, { sessions, fast: [run({ status: 'done', reason: 'done', steps: [step('click', 4)] })] }, history)
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
    // Steps count from the parked run too: 2 there, 1 after.
    expect(text).toBe('Done in 3 steps. Typed values: request.search.')
  })

  it('a parked page-control request is asked again, and FastSteps runs on the session it opens', async () => {
    const sessions = { open: false }
    const { calls, text } = await drive(SPEC, { sessions, rpc: [{ parked: true, note: 'x' }, GRANT], fast: [run({ status: 'done', reason: 'done' })] })
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'RequestPageControl', 'FastSteps'])
    expect(text).toBe('Done in 0 steps.')
  })

  it('fails closed when its own user message is not in the prompt: a short text, no tool call', async () => {
    const { calls, text } = await drive(SPEC, {}, [{ role: 'user', content: 'something else entirely' }])
    expect(calls).toEqual([])
    expect(text).toBe('Stopped: this request could not be found in the conversation.')
  })

  it('resuming after a park (the newest result is parked) makes the same call again', async () => {
    const parkedRpc = { parked: true, note: 'Cannot take control of this page: … stop here.' }
    const history: ModelMessage[] = [
      { role: 'user', content: SPEC.goal },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'p-1', toolName: 'RequestPageControl', input: { plan: SPEC.goal } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'p-1', toolName: 'RequestPageControl', output: { type: 'json', value: parkedRpc } }] },
    ]
    const { calls } = await drive(SPEC, {}, history)
    expect(calls.map((c) => c.name)).toEqual(['RequestPageControl', 'FastSteps'])
  })
})

describe('nextDriverAction (the pure decision)', () => {
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: SPEC.goal }] }
  it('without RequestPageControl on offer, says so rather than calling it', () => {
    expect(nextDriverAction(SPEC, [user], new Set(['FastSteps']))).toEqual({ text: expect.stringMatching(/Page control isn't available/) })
  })
  it('without FastSteps on offer (model not ready, Mode off): says so BEFORE asking for control — no card for a run that cannot proceed', () => {
    expect(nextDriverAction(SPEC, [user], new Set(['RequestPageControl']))).toEqual({ text: expect.stringMatching(/decision model isn't available/) })
    const granted = [
      user,
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'a', toolName: 'RequestPageControl', input: {} }] },
      { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: 'a', toolName: 'RequestPageControl', output: { type: 'json' as const, value: GRANT } }] },
    ]
    expect(nextDriverAction(SPEC, granted, new Set(['RequestPageControl']))).toEqual({ text: expect.stringMatching(/decision model isn't available/) })
  })
  it('an empty goal fails closed too', () => {
    expect(nextDriverAction({ goal: '', values: {} }, [user], null)).toEqual({ text: 'Stopped: this request could not be found in the conversation.' })
  })
  it('stops after MAX_SCRIPT_CALLS calls whatever the prompt holds', () => {
    const prompt: any[] = [user]
    for (let i = 0; i < MAX_SCRIPT_CALLS; i++) {
      prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'RequestPageControl', input: {} }] })
      prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'RequestPageControl', output: { type: 'json', value: { parked: true } } }] })
    }
    expect('text' in nextDriverAction(SPEC, prompt, null)).toBe(true)
  })
})

describe('elementLabel / finalTextFor', () => {
  it('reads the name, never the value', () => {
    expect(elementLabel(REGISTRY, 4)).toBe('Add to cart')
    expect(elementLabel(REGISTRY, 3)).toBe('Email')
    expect(elementLabel(REGISTRY, 6)).toBeUndefined()
    expect(elementLabel(REGISTRY, 99)).toBeUndefined()
    expect(elementLabel(undefined, 1)).toBeUndefined()
  })
  it('one step reads singular', () => {
    expect(finalTextFor([{ kind: 'value', value: { status: 'done', steps: [step('click', 1)] } }])).toBe('Done in 1 step.')
  })
})
