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
})

// Reasoning parts must be stripped from replayed history: the app never renders
// them from the model messages, and once persisted they lose the OpenAI Responses
// adapter's provider metadata, so replaying them only logs a "Non-OpenAI reasoning
// parts are not supported" warning. (Display reasoning rides a separate UI-part
// channel.)
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
