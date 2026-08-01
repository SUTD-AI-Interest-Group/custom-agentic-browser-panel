import { describe, it, expect } from 'vitest'
import { tool, type ModelMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { runAgentTurn, toValidModelMessages, type UIPart } from './agent'

// Progressive disclosure means most tools are NOT in `activeTools` until the
// model loads them with GetTool. If the model instead calls such a tool
// directly (the system prompt names them, so weaker models do exactly this),
// the AI SDK rejects the call with NoSuchToolError *before* execute() runs.
// For a gated tool that is fatal: its approval card never appears and the model
// has no way back — e.g. after denying page control it could never re-ask.
// runAgentTurn repairs those calls into GetTool so the tool gets loaded.

function toolCallThen(toolName: string, input: unknown) {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      const first = call === 1
      return {
        // The mock's chunk shapes are exercised at runtime by the SDK; typing the
        // controller loosely keeps the test focused on repair behavior.
        stream: new ReadableStream({
          start(controller: any) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            if (first) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'c1',
                toolName,
                input: JSON.stringify(input),
              })
            } else {
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 't1' })
            }
            controller.enqueue({
              type: 'finish',
              finishReason: first ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            })
            controller.close()
          },
        }),
      }
    },
  })
}

/** The always-on core + a gated tool that starts unloaded, mirroring createAgentTools. */
function makeTools(activeNames: Set<string>) {
  return {
    ReadPage: tool({
      description: 'read the current tab',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    }),
    ToolSearch: tool({
      description: 'list the available tools',
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async () => ({ tools: [{ name: 'RequestPageControl', description: 'control a page' }] }),
    }),
    GetTool: tool({
      description: 'load tools by name',
      inputSchema: z.object({ names: z.array(z.string()).min(1) }),
      execute: async ({ names }) => {
        names.forEach((n) => activeNames.add(n))
        return { loaded: names, note: 'These tools are now available to call.' }
      },
    }),
    RequestPageControl: tool({
      description: 'ask the user for permission to control the page',
      inputSchema: z.object({ plan: z.string() }),
      execute: async () => ({ started: true }),
    }),
  }
}

async function run(model: MockLanguageModelV3, activeNames: Set<string>) {
  const tools = makeTools(activeNames)
  const parts: UIPart[] = []
  const result = await runAgentTurn({
    model,
    system: 'test',
    history: [{ role: 'user', content: 'control the page' }],
    tools,
    abortSignal: new AbortController().signal,
    onUpdate: (p) => {
      parts.length = 0
      parts.push(...p)
    },
    activeNames,
  })
  return result
}

describe('runAgentTurn: unloaded-tool calls are repaired into GetTool', () => {
  it('loads a real but unloaded gated tool instead of dead-ending, so its approval card can appear', async () => {
    const activeNames = new Set<string>() // RequestPageControl is NOT loaded
    const model = toolCallThen('RequestPageControl', { plan: 'search the site' })

    const result = await run(model, activeNames)

    const toolParts = result.parts.filter((p) => p.type === 'tool') as Extract<UIPart, { type: 'tool' }>[]
    // The dead-end (a hard error on the tool) must NOT happen...
    expect(toolParts.some((p) => p.toolName === 'RequestPageControl' && p.state === 'error')).toBe(false)
    // ...instead the call is repaired into GetTool, which loads it.
    const getTool = toolParts.find((p) => p.toolName === 'GetTool')
    expect(getTool).toBeDefined()
    expect(getTool?.state).toBe('done')
    expect((getTool?.output as { loaded: string[] }).loaded).toEqual(['RequestPageControl'])
    // Now active, so the model's next call actually reaches execute() → approval card.
    expect(activeNames.has('RequestPageControl')).toBe(true)
  })

  it('still surfaces a genuinely hallucinated tool name as an error (does not mask real mistakes)', async () => {
    const activeNames = new Set<string>()
    const model = toolCallThen('TotallyMadeUpTool', { foo: 1 })

    const result = await run(model, activeNames)

    const toolParts = result.parts.filter((p) => p.type === 'tool') as Extract<UIPart, { type: 'tool' }>[]
    expect(toolParts.some((p) => p.toolName === 'TotallyMadeUpTool' && p.state === 'error')).toBe(true)
    expect(toolParts.some((p) => p.toolName === 'GetTool')).toBe(false)
    expect(activeNames.has('TotallyMadeUpTool')).toBe(false)
  })

  it('does not treat a prototype key ("constructor") as a loadable tool', async () => {
    const activeNames = new Set<string>()
    const model = toolCallThen('constructor', {})

    const result = await run(model, activeNames)

    const toolParts = result.parts.filter((p) => p.type === 'tool') as Extract<UIPart, { type: 'tool' }>[]
    expect(toolParts.some((p) => p.toolName === 'constructor' && p.state === 'error')).toBe(true)
    expect(toolParts.some((p) => p.toolName === 'GetTool')).toBe(false)
  })
})

// The ungated Checkpoint control tool is merged into streamText's toolset
// separately from `tools` (see checkpointTool in agent.ts), so it is NOT a
// member of `Object.keys(tools)` that resolveActiveTools intersects against.
// Left unhandled, activeTools (computed whenever activeNames is set — i.e.
// always, in the foreground UI) would never include 'Checkpoint': the model
// would never be offered it, hasToolCall('Checkpoint') would never fire, and
// the whole step-budget hand-off would be dead. prepareStep must force it in.
describe('Checkpoint is always reachable under progressive disclosure', () => {
  it("includes 'Checkpoint' in the tools actually sent to the model even though it is absent from `tools` and `activeNames`", async () => {
    const activeNames = new Set<string>() // deliberately empty: no ToolSearch/GetTool activity this turn
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller: any) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 't1' })
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' })
            controller.enqueue({ type: 'text-end', id: 't1' })
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            })
            controller.close()
          },
        }),
      }),
    })

    await runAgentTurn({
      model,
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(activeNames),
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames,
    })

    // doStreamCalls[0].tools is the tool-schema list the SDK actually handed to
    // the provider for that step — i.e. what the model could actually call.
    expect(model.doStreamCalls.length).toBeGreaterThan(0)
    const toolNames = (model.doStreamCalls[0].tools ?? []).map((t: any) => t.name)
    expect(toolNames).toContain('Checkpoint')
    // And the always-on core (ReadPage is in it) is still present alongside it —
    // this isn't a case of Checkpoint accidentally replacing the real active set.
    expect(toolNames).toContain('ReadPage')
    // A gated tool that was never loaded (RequestPageControl) must still be absent.
    expect(toolNames).not.toContain('RequestPageControl')
  })
})

// A turn cut off at the step ceiling must report stop.reason 'budget', not
// 'completed' — runTurnChain BREAKS the continuation chain on 'completed', so
// mislabelling a cut-off silently truncates long-horizon work. The trap: the AI
// SDK's top-level finishReason is 'other' (not 'tool-calls') when stopWhen halts
// the loop, so the obvious check is the wrong one.
describe('step-budget stop reason', () => {
  /** A model that never stops asking for another tool call. */
  function alwaysCallsATool() {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        call += 1
        return {
          stream: new ReadableStream({
            start(controller: any) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'tool-call', toolCallId: `c${call}`, toolName: 'ReadPage', input: '{}' })
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
              controller.close()
            },
          }),
        }
      },
    })
  }

  it("reports 'budget' when the model is cut off at the ceiling mid-tool-call", async () => {
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 3,
      onUpdate: () => {},
    })

    expect(result.stop.stepsUsed).toBe(3)
    expect(result.stop.reason).toBe('budget')
  })

  it("reports 'completed' when the model finishes on its own before the ceiling", async () => {
    const result = await runAgentTurn({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller: any) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'all done' })
              controller.enqueue({ type: 'text-end', id: 't1' })
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
              controller.close()
            },
          }),
        }),
      }),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 3,
      onUpdate: () => {},
    })

    expect(result.stop.reason).toBe('completed')
  })

  it("reports 'budget' when the provider truncates its own output (finishReason 'length'), even well under the step ceiling", async () => {
    // The provider hit ITS OWN max-output-tokens mid-reply — a different cut-off
    // than the step ceiling, but the same "incomplete, not a finished answer"
    // situation: it must not be shown to the user as the final reply.
    const result = await runAgentTurn({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller: any) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'cut off mid-sent' })
              controller.enqueue({ type: 'text-end', id: 't1' })
              // Unlike the plain-string `finishReason` used elsewhere in this file
              // (fine there — those assertions don't depend on its exact value),
              // this test's assertion DOES depend on it, so it must match the real
              // LanguageModelV3 wire shape: an object with a `unified` reason.
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'length', raw: 'length' },
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
              controller.close()
            },
          }),
        }),
      }),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 24,
      onUpdate: () => {},
    })

    expect(result.stop.stepsUsed).toBe(1)
    expect(result.stop.reason).toBe('budget')
  })
})

// Agent steering: while the model is mid-task, a user steer must halt the loop at
// the NEXT step boundary (after the current step's tool executes — never orphaning a
// tool call) so runTurnChain can splice the steer into history and continue with a
// fresh cycle. runAgentTurn exposes this as a `steerPending` predicate OR'd into
// stopWhen; the predicate only READS the pending flag, never drains it.
describe('agent steering: steerPending halts the loop at the next step boundary', () => {
  /** A model that never stops asking for another tool call (as in the budget test). */
  function alwaysCallsATool() {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        call += 1
        return {
          stream: new ReadableStream({
            start(controller: any) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'tool-call', toolCallId: `c${call}`, toolName: 'ReadPage', input: '{}' })
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
              controller.close()
            },
          }),
        }
      },
    })
  }

  it('stops after the current step when a steer is pending, well short of the ceiling', async () => {
    // A model that would otherwise run to maxSteps (see the budget test). With a
    // steer already pending, the loop must halt after the first step boundary.
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 8,
      onUpdate: () => {},
      steerPending: () => true,
    })

    expect(result.stop.stepsUsed).toBe(1)
    // The current step ran to completion before the halt — its tool executed
    // (state 'done'), and both the tool call and its result are in the replay
    // history, so the continuation cycle inherits no dangling/orphaned tool call.
    const toolParts = result.parts.filter((p) => p.type === 'tool') as Extract<UIPart, { type: 'tool' }>[]
    expect(toolParts.find((p) => p.toolName === 'ReadPage')?.state).toBe('done')
    expect(result.responseMessages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('runs normally (to the ceiling) when no steer is pending', async () => {
    // Same never-finishing model with the predicate returning false throughout: the
    // steer path must not perturb an ordinary run — it goes the full distance.
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 4,
      onUpdate: () => {},
      steerPending: () => false,
    })

    expect(result.stop.stepsUsed).toBe(4)
    expect(result.stop.reason).toBe('budget')
  })

  // Tab parking rides the same stop-condition machinery as steering. A page tool
  // raises it when the chat's bound tab is no longer the one in front, because a
  // capture of a background tab is impossible (captureVisibleTab only ever
  // returns the ACTIVE tab) and a click on one is invisible to the user. Without
  // the halt, a model told "not right now" spends its whole remaining budget
  // retrying. The distinct 'parked' reason is what tells runTurnChain to wait for
  // the user to come back rather than auto-continue immediately.
  it('halts with reason "parked" when a page tool parks the turn', async () => {
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 8,
      onUpdate: () => {},
      parkPending: () => true,
    })

    expect(result.stop.stepsUsed).toBe(1)
    expect(result.stop.reason).toBe('parked')
  })

  // A park outranks the step ceiling: both are true when a turn parks on its last
  // step, but only 'parked' waits for the user. Reporting 'budget' there would
  // auto-continue straight back into the same impossible capture.
  it('reports "parked" rather than "budget" when both apply', async () => {
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 1,
      onUpdate: () => {},
      parkPending: () => true,
    })

    expect(result.stop.reason).toBe('parked')
  })

  it('runs normally when nothing has parked', async () => {
    const result = await runAgentTurn({
      model: alwaysCallsATool(),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: makeTools(new Set()),
      abortSignal: new AbortController().signal,
      maxSteps: 3,
      onUpdate: () => {},
      parkPending: () => false,
    })

    expect(result.stop.stepsUsed).toBe(3)
    expect(result.stop.reason).toBe('budget')
  })
})

// Reasoning parts must be stripped from replayed history: the app never renders
// them from the model messages (display reasoning rides a separate UI-part
// channel). And because the reasoning pair is gone, the surviving parts must
// lose their OpenAI item ids too — see the itemId test below.
describe('toValidModelMessages strips reasoning from replay', () => {
  it('removes reasoning parts but keeps text and tool calls in the same message', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'let me think…' },
          { type: 'text', text: 'hello' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'ReadPage', input: {} },
        ],
      },
    ] as unknown as ModelMessage[]
    const out = toValidModelMessages(msgs)
    expect(out).toHaveLength(2)
    const content = out[1].content as Array<{ type: string }>
    expect(content.map((p) => p.type)).toEqual(['text', 'tool-call'])
  })

  it('drops an assistant message that was reasoning-only', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ] as unknown as ModelMessage[]
    const out = toValidModelMessages(msgs)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect((out[1].content as Array<{ type: string }>).map((p) => p.type)).toEqual(['text'])
  })

  // GPT-5.x models enforce that a replayed `msg_…` item id is accompanied by its
  // paired `rs_…` reasoning item. We strip reasoning parts, so the surviving
  // parts must lose their OpenAI item ids too — otherwise the adapter replays a
  // dangling item_reference and the API 400s ("Item 'msg_…' of type 'message'
  // was provided without its required 'reasoning' item").
  it('drops OpenAI item ids from surviving assistant parts (their reasoning pair is gone)', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'thinking',
            providerOptions: { openai: { itemId: 'rs_1' } },
          },
          {
            type: 'text',
            text: 'hello',
            providerOptions: { openai: { itemId: 'msg_1', phase: 'final' } },
          },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'ReadPage',
            input: {},
            providerMetadata: { openai: { itemId: 'fc_1' } },
          },
        ],
      },
    ] as unknown as ModelMessage[]
    const out = toValidModelMessages(msgs)
    const content = out[0].content as unknown as Array<
      Record<string, Record<string, Record<string, unknown>>>
    >
    expect(content.map((p) => p.type)).toEqual(['text', 'tool-call'])
    expect(content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(content[1].providerMetadata?.openai?.itemId).toBeUndefined()
    // Only the item id is dropped — other provider metadata rides through.
    expect(content[0].providerOptions?.openai?.phase).toBe('final')
  })

  it('still removes nested undefined from tool results (its original job)', () => {
    const msgs = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'ReadPage',
            output: { type: 'json', value: { ok: true, extra: undefined } },
          },
        ],
      },
    ] as unknown as ModelMessage[]
    const out = toValidModelMessages(msgs)
    const result = (out[0].content as Array<{ output: { value: Record<string, unknown> } }>)[0]
    expect(result.output.value).toEqual({ ok: true })
  })
})
