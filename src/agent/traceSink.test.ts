import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { runAgentTurn, type TraceSink } from './agent'
import type { TraceStep } from '../data/traces'

/**
 * A model that calls one tool with the given input, then finishes.
 * Mirrors the shape agent.test.ts already uses for its repair tests.
 */
function callsToolThenFinishes(toolName: string, input: unknown) {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      const first = call === 1
      return {
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
              usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            })
            controller.close()
          },
        }),
      }
    },
  })
}

function collectingSink(): { sink: TraceSink; steps: TraceStep[] } {
  const steps: TraceStep[] = []
  return { sink: { step: (s) => steps.push(s) }, steps }
}

const SECRET = 'hunter2-correct-horse'

/** Stands in for ControlPage: a generic `text` field the UI maps a real form
 *  field onto — exactly the shape that carries a typed password. */
const controlPage = tool({
  description: 'Type into a field',
  inputSchema: z.object({
    index: z.number(),
    text: z.string(),
    sensitive: z.boolean().optional(),
  }),
  execute: async () => ({ ok: true, message: 'typed' }),
})

describe('local trace sink', () => {
  it('records a step with the tools that were active and the calls that ran', async () => {
    const { sink, steps } = collectingSink()
    await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', { index: 1, text: 'hello' }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'type hello' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
      sink,
    })
    expect(steps.length).toBeGreaterThan(0)
    expect(steps[0].activeTools).toContain('ControlPage')
    expect(steps[0].toolCalls.map((c) => c.name)).toContain('ControlPage')
    // Deliberately NOT asserting usage/finishReason here: MockLanguageModelV3's
    // finish chunk does not surface them on onStepFinish's step object, so an
    // assertion would be testing the mock rather than the capture. Whether a
    // real provider populates them is checked in the browser instead.
    expect(steps[0].model).toBeTruthy()
    expect(steps[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits one step per model step, indexed in order', async () => {
    const { sink, steps } = collectingSink()
    await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', { index: 1, text: 'hello' }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'type hello' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
      sink,
    })
    // Tool-call step, then the step that answers — indices must not repeat, or
    // the drawer would render two rows claiming to be the same step.
    expect(steps.map((s) => s.index)).toEqual([0, 1])
  })

  it('records the always-on Checkpoint tool alongside what disclosure exposed', async () => {
    // Checkpoint is injected into every turn's toolset but is not in the
    // disclosure catalog, so a reader seeing it in a trace should see it named
    // rather than wonder where it came from.
    const { sink, steps } = collectingSink()
    await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', { index: 1, text: 'hello' }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'type hello' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
      sink,
    })
    expect(steps[0].activeTools).toContain('Checkpoint')
  })

  it('never lets a typed secret reach the sink', async () => {
    // THE test for this feature. Driven through the REAL capture path rather
    // than by calling redactSecrets directly: testing the redactor proves the
    // redactor works, not that it is wired in. The bug this guards against is
    // a future edit adding tool inputs to a step and quietly shipping every
    // password the agent types into a page to disk.
    const { sink, steps } = collectingSink()
    await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', {
        index: 3,
        text: SECRET,
        sensitive: true,
      }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'log me in' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
      sink,
    })
    expect(steps.length).toBeGreaterThan(0)
    expect(JSON.stringify(steps)).not.toContain(SECRET)
  })

  it('runs the turn normally when no sink is supplied', async () => {
    // The sink is opt-in and off by default; its absence must cost nothing.
    const result = await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', { index: 1, text: 'hello' }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'type hello' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
    })
    expect(result.stop.reason).toBe('completed')
  })

  it('a throwing sink cannot break the turn', async () => {
    // Tracing insures the turn; it must never be able to fail it.
    const result = await runAgentTurn({
      model: callsToolThenFinishes('ControlPage', { index: 1, text: 'hello' }),
      system: { stable: 'sys', volatile: '' },
      history: [{ role: 'user', content: 'type hello' }],
      tools: { ControlPage: controlPage },
      abortSignal: new AbortController().signal,
      onUpdate: () => {},
      activeNames: new Set(['ControlPage']),
      sink: {
        step: () => {
          throw new Error('sink exploded')
        },
      },
    })
    expect(result.stop.reason).toBe('completed')
  })
})
