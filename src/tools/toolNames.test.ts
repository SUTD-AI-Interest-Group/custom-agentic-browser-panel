import { describe, it, expect } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { createResearchTools } from './research'
import { createNotebook } from '../agent/notebook'
import { runBrowseSession, type BrowseBroker } from '../agent/browseAgent'
import { mcpToolName } from '../mcp/config'

// Every provider validates tool names, and OpenAI's rule is the strictest one we
// have to satisfy: ^[a-zA-Z0-9_-]{1,64}$. A name with a dot in it (the research
// notebook tools were once 'Notebook.write'/'Notebook.read') is not a soft
// degradation — the whole request 400s with
//   Invalid 'tools[7].name': string does not match pattern
// and, because the research pipeline retries transient failures, a permanently
// invalid name means the task retries until its 24h deadline without ever
// reaching the model. The research toolset is the surface that matters here: it
// is all-active (no progressive disclosure), so EVERY name ships on EVERY call.
const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** A broker stub — enough to build the toolset; the session itself is scripted. */
const stubBroker: BrowseBroker = {
  async step(_sessionId, op) {
    switch (op.kind) {
      case 'open':
        return {
          ok: true,
          message: 'opened',
          observation: { url: op.url, title: 't', elements: '[0]<a> "x"', excerpt: 'text', more: false },
        }
      default:
        return { ok: true, message: 'ok' }
    }
  },
}

describe('tool names are valid at the provider wire', () => {
  it('createResearchTools', () => {
    const tools = createResearchTools({
      selected: null,
      notebook: createNotebook(),
      browseBroker: stubBroker, // include BrowseSite, which is conditional
    })
    const names = Object.keys(tools)
    expect(names.length).toBeGreaterThan(5)
    expect(names.filter((n) => !PROVIDER_TOOL_NAME.test(n))).toEqual([])
  })

  it('the browse sub-agent toolset, as it reaches the model', async () => {
    // Assert on what is actually SENT, not on the ToolSet keys: this is the layer
    // the provider validates, and it also covers the Checkpoint tool runAgentTurn
    // injects on top of the caller's toolset.
    let sent: string[] = []
    const capturing = new MockLanguageModelV3({
      doStream: async ({ tools }: any) => {
        sent = (tools ?? []).map((t: any) => t.name)
        return {
          stream: new ReadableStream({
            start(controller: any) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 't1' })
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
              controller.close()
            },
          }),
        }
      },
    })

    await runBrowseSession({
      sessionId: 's1',
      url: 'https://site.test/docs',
      objective: 'anything',
      broker: stubBroker,
      model: capturing,
      notebook: createNotebook(),
      signal: new AbortController().signal,
    })

    expect(sent.length).toBeGreaterThan(3)
    expect(sent.filter((n) => !PROVIDER_TOOL_NAME.test(n))).toEqual([])
  })

  it('MCP tool keys are sanitized to the same rule', () => {
    // Already covered in depth by mcp/config.test.ts; asserted here too so the
    // dynamic surface is checked against the same regex as the static ones.
    expect(PROVIDER_TOOL_NAME.test(mcpToolName('my server!', 'do.the/thing', new Set()))).toBe(true)
  })
})
