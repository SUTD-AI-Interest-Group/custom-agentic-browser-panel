import { describe, it, expect } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { runBrowseSession, type BrowseBroker } from './browseAgent'
import { createNotebook } from './notebook'
import type { BrowseOp, BrowseResult } from '../data/researchTasks'

// The browse sub-agent is the one place the research agent touches a live page, so
// what matters here is the CONTRACT around the loop, not the model's cleverness:
// it must always release the tab (the lease is exclusive — leaking one stalls every
// later fetch in the task), findings must reach the shared notebook, a policy
// refusal must come back as a normal result the model can route around, and the
// step budget must actually stop it.

function observation(url: string, extra: Partial<BrowseResult['observation']> = {}) {
  return {
    url,
    title: `Title of ${url}`,
    elements: '[0]<a> "Pricing"\n[1]<input> search "Search docs"',
    excerpt: `Readable text of ${url}`,
    more: true,
    ...extra,
  }
}

/** Records every op, answers with a canned observation. */
function fakeBroker(over: Partial<Record<BrowseOp['kind'], BrowseResult>> = {}) {
  const ops: BrowseOp[] = []
  const broker: BrowseBroker = {
    async step(_sessionId: string, op: BrowseOp): Promise<BrowseResult> {
      ops.push(op)
      if (over[op.kind]) return over[op.kind]!
      switch (op.kind) {
        case 'open':
          return { ok: true, message: 'opened', observation: observation(op.url) }
        case 'act':
          return { ok: true, message: 'acted', observation: observation('https://site.test/after') }
        case 'read':
          return { ok: true, message: 'read', text: 'The full page text.', url: 'https://site.test/after', title: 'After' }
        case 'close':
          return { ok: true, message: 'closed' }
      }
    },
  }
  return { broker, ops }
}

/** Scripts one model turn per entry: a tool call, or plain text to finish. */
function scriptedModel(script: Array<{ tool: string; input: unknown } | { text: string }>) {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = script[Math.min(call, script.length - 1)]
      call += 1
      return {
        stream: new ReadableStream({
          start(controller: any) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            if ('tool' in step) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `c${call}`,
                toolName: step.tool,
                input: JSON.stringify(step.input),
              })
            } else {
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: step.text })
              controller.enqueue({ type: 'text-end', id: 't1' })
            }
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool' in step ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            })
            controller.close()
          },
        }),
      }
    },
  })
}

function run(script: Parameters<typeof scriptedModel>[0], broker: BrowseBroker, notebook = createNotebook()) {
  return runBrowseSession({
    sessionId: 's1',
    url: 'https://site.test/docs',
    objective: 'find the pricing table',
    broker,
    model: scriptedModel(script),
    notebook,
    signal: new AbortController().signal,
  })
}

describe('runBrowseSession', () => {
  it('walks the page, records findings in the shared notebook, and reports back', async () => {
    const { broker, ops } = fakeBroker()
    const notebook = createNotebook()

    const outcome = await run(
      [
        { tool: 'ClickElement', input: { index: 0 } },
        { tool: 'ReadPage', input: {} },
        {
          tool: 'Notebook.write',
          input: {
            findings: [{ claim: 'The plan costs $40/mo', sourceUrl: 'https://site.test/after', quote: '$40 per month' }],
          },
        },
        { text: 'Found the pricing table: $40/mo.' },
      ],
      broker,
      notebook,
    )

    expect(outcome.stoppedBecause).toBe('done')
    expect(outcome.findingsAdded).toBe(1)
    expect(outcome.digest).toContain('$40/mo')
    // The finding landed in the SHARED notebook, not just the digest.
    expect(notebook.get().findings[0].claim).toBe('The plan costs $40/mo')
    // ReadPage also registers the page as a citable source.
    expect(notebook.get().sources.some((s) => s.url.includes('site.test'))).toBe(true)
    // It visited the start page and wherever the click led.
    expect(outcome.visited).toEqual(['https://site.test/docs', 'https://site.test/after'])
    // Notebook.write is local — it is the only tool that does not hit the browser.
    expect(ops.map((o) => o.kind)).toEqual(['open', 'act', 'read', 'close'])
  })

  it('always closes the session — even when the walk throws', async () => {
    const { broker, ops } = fakeBroker()
    const exploding: BrowseBroker = {
      step: async (id, op) => {
        if (op.kind === 'act') throw new Error('tab crashed')
        return broker.step(id, op)
      },
    }
    const outcome = await run([{ tool: 'ClickElement', input: { index: 0 } }, { text: 'done' }], exploding)

    // The tool error is surfaced to the model, which then finishes normally; the
    // point is that the lease is released whatever happens.
    expect(ops.at(-1)?.kind).toBe('close')
    expect(outcome).toBeDefined()
  })

  it('closes the session when the page will not even open', async () => {
    const { broker, ops } = fakeBroker({ open: { ok: false, message: 'refused to navigate (blocked scheme file:)' } })
    const outcome = await run([{ text: 'unused' }], broker)

    expect(outcome.stoppedBecause).toBe('error')
    expect(outcome.digest).toContain('refused to navigate')
    expect(outcome.findingsAdded).toBe(0)
    expect(ops.map((o) => o.kind)).toEqual(['open', 'close'])
  })

  it('passes a policy refusal back to the model as a normal result, with a fresh view', async () => {
    // The SW refuses the action and still returns an observation, so the model can
    // pick another route instead of dead-ending.
    const { broker, ops } = fakeBroker({
      act: {
        ok: false,
        message: 'refused to click "Log in" — it looks like it commits an action (purchase/auth/destructive)',
        observation: observation('https://site.test/docs'),
      },
    })
    const outcome = await run([{ tool: 'ClickElement', input: { index: 0 } }, { text: 'That was a login button; the docs are public.' }], broker)

    expect(ops.map((o) => o.kind)).toEqual(['open', 'act', 'close'])
    expect(outcome.stoppedBecause).toBe('done')
    expect(outcome.digest).toContain('login button')
  })

  it('stops at the step budget instead of clicking forever', async () => {
    const { broker, ops } = fakeBroker()
    // A model that only ever wants to click — the budget is the only thing that
    // ends this.
    const outcome = await run([{ tool: 'ScrollPage', input: { direction: 'down' } }], broker)

    expect(outcome.stoppedBecause).toBe('budget')
    const acts = ops.filter((o) => o.kind === 'act')
    expect(acts.length).toBeGreaterThan(0)
    expect(acts.length).toBeLessThanOrEqual(12) // MAX_BROWSE_STEPS
    expect(ops.at(-1)?.kind).toBe('close')
  })
})
