// buildMcpTools had zero test coverage before this file (flagged by W2-D's
// audit pass: src/mcp/tools.ts, not src/tools/tools.ts). This is where the
// CRITICAL MCP invariant actually lives — "`never` at either policy level
// means the tool is not built at all" (CLAUDE.md) — so the policy matrix
// below is exhaustive, plus the approval gate, name sanitization/collision,
// and schema edge cases the audit called out by name.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { buildMcpTools } from './tools'
import type { McpManager, McpServerRuntime, McpToolInfo } from './manager'
import type { Settings } from '../data/settings'
import type { ApprovalGate } from '../tools/tools'
import type { QueuedImage } from '../agent/agent'
import type { McpSettings } from './config'

function toolInfo(over: Partial<McpToolInfo> & { name: string }): McpToolInfo {
  return { description: '', inputSchema: { type: 'object' }, ...over }
}

function serverRuntime(over: Partial<McpServerRuntime> & { name: string }): McpServerRuntime {
  return { status: 'connected', tools: [], resources: [], prompts: [], ...over }
}

interface RecordedCall {
  server: string
  tool: string
  args: Record<string, unknown>
}

/** A fake McpManager exposing only what buildMcpTools actually calls. Cast to
 *  McpManager for the call (it has private fields, so TS requires the real
 *  class structurally — the standard escape hatch for a dependency this
 *  heavy, mirrored from manager.test.ts's own `as unknown as Settings`). */
function fakeManager(
  servers: McpServerRuntime[],
  opts: { result?: unknown; error?: Error } = {},
): { manager: McpManager; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const raw = {
    runtime: () => servers,
    callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ server, tool, args })
      if (opts.error) throw opts.error
      return opts.result ?? { content: [{ type: 'text', text: 'ok' }] }
    },
    readResource: async () => {
      throw new Error('readResource should not be called by any test in this file')
    },
  }
  return { manager: raw as unknown as McpManager, calls }
}

function settingsWith(mcp: McpSettings): Settings {
  return { mcp } as unknown as Settings
}

/** Records how many times the gate was asked, and answers with `result`. */
function fakeApproval(result: boolean): { gate: ApprovalGate; calls: number[] } {
  const calls: number[] = []
  const gate: ApprovalGate = async () => {
    calls.push(1)
    return result
  }
  return { gate, calls }
}

function baseOpts(manager: McpManager, settings: Settings, requestApproval: ApprovalGate) {
  return {
    manager,
    settings,
    requestApproval,
    imageQueue: [] as QueuedImage[],
    conversationId: 'conv-1',
    visionCapable: false,
  }
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

describe('buildMcpTools — policy matrix: never at either level means the tool is not built at all', () => {
  // Each case: [label, policies-for-server-"srv", expect a "x" tool present?, expect auto-approve (no gate ask)?]
  it('per-tool override "never" wins over a permissive server default — tool absent', async () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] }),
    ])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always', tools: { x: 'never' } } },
    })
    const { gate } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('per-tool override "always" wins over a restrictive server default — tool present, auto-approved', async () => {
    const { manager, calls } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] }),
    ])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'never', tools: { x: 'always' } } },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(0) // 'always' never asks
    expect(calls).toHaveLength(1) // but the real call still happens
  })

  it('per-tool override "ask" wins over a permissive server default — tool present, asks', async () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always', tools: { x: 'ask' } } },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(1)
  })

  it('server default "never", no tool override — tool absent', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'never' } },
    })
    const { gate } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('server default "always", no tool override — tool present, auto-approved', async () => {
    const { manager, calls } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always' } },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('server default "ask", no tool override — tool present, asks', async () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'ask' } },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(1)
  })

  it('no policies entry for the server at all — falls back to "ask", tool present', async () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } }) // no `policies` key
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(1)
  })

  it('policies entry present but empty — falls back to "ask", tool present', async () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: {} },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(1)
    await (tools[keys[0]] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(1)
  })

  it('no mcp settings at all — nothing is built (not merely un-policied)', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = { /* no .mcp at all */ } as unknown as Settings
    const { gate } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })
})

describe('buildMcpTools — server-level gating (independent of tool policy)', () => {
  it('skips a server whose status is "unsupported", even with an always-allow tool policy', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', status: 'unsupported', tools: [toolInfo({ name: 'x' })] }),
    ])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always' } },
    })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('skips a server whose status is "disabled"', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', status: 'disabled', tools: [toolInfo({ name: 'x' })] }),
    ])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always' } },
    })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('skips a server present in the live runtime but removed from settings.mcp.servers', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({ servers: {} }) // "srv" no longer configured
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('skips a server disabled via the serverState sidecar', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      serverState: { srv: { enabled: false } },
    })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('builds tools for a connected, configured, enabled server (sanity control)', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(1)
  })
})

describe('buildMcpTools — every built tool gates on requestApproval unless policy is "always"', () => {
  it('denied approval short-circuits before the real MCP call ever fires', async () => {
    const { manager, calls } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } }) // default policy: ask
    const { gate, calls: approvalCalls } = fakeApproval(false)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const [key] = Object.keys(tools)
    const result = await (tools[key] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(1)
    expect(calls).toHaveLength(0) // manager.callTool must never run on a denial
    expect(result).toEqual({ denied: true, message: 'The user denied permission for this tool call.' })
  })

  it('granted approval proceeds to the real call and maps its result through', async () => {
    const { manager, calls } = fakeManager(
      [serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })],
      { result: { content: [{ type: 'text', text: 'hello from the server' }] } },
    )
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const [key] = Object.keys(tools)
    const result = (await (tools[key] as any).execute({ q: 'hi' }, {} as any)) as { text?: string }
    expect(approvalCalls).toHaveLength(1)
    expect(calls).toEqual([{ server: 'srv', tool: 'x', args: { q: 'hi' } }])
    expect(result.text).toBe('hello from the server')
  })

  it('"always" policy never asks, for every call, not just the first', async () => {
    const { manager, calls } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x' })] })])
    const settings = settingsWith({
      servers: { srv: { url: 'https://x.test' } },
      policies: { srv: { default: 'always' } },
    })
    const { gate, calls: approvalCalls } = fakeApproval(true)
    const tools = buildMcpTools(baseOpts(manager, settings, gate))
    const [key] = Object.keys(tools)
    await (tools[key] as any).execute({}, {} as any)
    await (tools[key] as any).execute({}, {} as any)
    expect(approvalCalls).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })
})

describe('buildMcpTools — name sanitization and collision handling', () => {
  it('two servers exposing the same tool name (non-colliding server names) get independent keys, both callable', async () => {
    const { manager, calls } = fakeManager([
      serverRuntime({ name: 'alpha', tools: [toolInfo({ name: 'search' })] }),
      serverRuntime({ name: 'beta', tools: [toolInfo({ name: 'search' })] }),
    ])
    const settings = settingsWith({ servers: { alpha: { url: 'https://a.test' }, beta: { url: 'https://b.test' } } })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(2)
    expect(keys).toContain('mcp_alpha_search')
    expect(keys).toContain('mcp_beta_search')
    await (tools['mcp_alpha_search'] as any).execute({}, {} as any)
    await (tools['mcp_beta_search'] as any).execute({}, {} as any)
    expect(calls.find((c) => c.server === 'alpha')?.tool).toBe('search')
    expect(calls.find((c) => c.server === 'beta')?.tool).toBe('search')
  })

  it('two servers whose SANITIZED names collide get deduped keys, and each still calls its own real server', async () => {
    const { manager, calls } = fakeManager([
      serverRuntime({ name: 'my.server', tools: [toolInfo({ name: 'x' })] }),
      serverRuntime({ name: 'my_server', tools: [toolInfo({ name: 'x' })] }),
    ])
    const settings = settingsWith({
      servers: { 'my.server': { url: 'https://a.test' }, my_server: { url: 'https://b.test' } },
    })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    const keys = Object.keys(tools)
    expect(keys).toHaveLength(2) // NOT one tool silently clobbering the other
    expect(keys).toContain('mcp_my_server_x')
    expect(keys).toContain('mcp_my_server_x_2')
    await (tools['mcp_my_server_x'] as any).execute({}, {} as any)
    await (tools['mcp_my_server_x_2'] as any).execute({}, {} as any)
    // Each key's closure must still address the ORIGINAL, distinct server —
    // the dedup suffix must not leak into what's actually sent over MCP.
    expect(calls.map((c) => c.server).sort()).toEqual(['my.server', 'my_server'])
  })

  it('a tool name with characters outside the provider-safe charset sanitizes cleanly', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'weird name.with spaces/slashes é' })] }),
    ])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    const [key] = Object.keys(tools)
    expect(key).toMatch(NAME_RE)
  })

  it('a very long combined server+tool name is capped at 64 chars but still calls the FULL original tool name', async () => {
    const longTool = 'x'.repeat(100)
    const { manager, calls } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: longTool })] })])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    const [key] = Object.keys(tools)
    expect(key.length).toBeLessThanOrEqual(64)
    expect(key).toMatch(NAME_RE)
    await (tools[key] as any).execute({}, {} as any)
    // The sanitized/truncated key is only the ToolSet-facing label — the real
    // MCP call must still use the tool's true, untruncated name.
    expect(calls[0].tool).toBe(longTool)
  })

  it('an empty tool name does not throw and produces a distinct, valid key', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: '' }), toolInfo({ name: 'real' })] }),
    ])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    expect(() => buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))).not.toThrow()
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    expect(Object.keys(tools)).toHaveLength(2)
    for (const key of Object.keys(tools)) expect(key).toMatch(NAME_RE)
  })
})

describe('buildMcpTools — schema edge cases', () => {
  it('a missing inputSchema defaults to an object schema instead of throwing', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [{ name: 'x', description: '', inputSchema: undefined }] }),
    ])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    let tools: ReturnType<typeof buildMcpTools> | undefined
    expect(() => {
      tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    }).not.toThrow()
    const [key] = Object.keys(tools!)
    expect((tools![key] as any).inputSchema.jsonSchema).toEqual({ type: 'object' })
  })

  it('a null inputSchema defaults the same way', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [{ name: 'x', description: '', inputSchema: null }] }),
    ])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const tools = buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))
    const [key] = Object.keys(tools)
    expect((tools[key] as any).inputSchema.jsonSchema).toEqual({ type: 'object' })
  })

  it('an empty-object inputSchema is passed through without throwing', () => {
    const { manager } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x', inputSchema: {} })] })])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    expect(() => buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))).not.toThrow()
  })

  it('a malformed (non-object) inputSchema does not crash tool building', () => {
    const { manager } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'x', inputSchema: 'not-a-real-schema' as unknown })] }),
    ])
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    expect(() => buildMcpTools(baseOpts(manager, settings, fakeApproval(true).gate))).not.toThrow()
  })
})

describe('buildMcpTools — a tool discovered after connect (re-invocation reflects the live catalog)', () => {
  it('a second build call sees a newly-discovered tool; the first result is unaffected', () => {
    const settings = settingsWith({ servers: { srv: { url: 'https://x.test' } } })
    const { manager: managerBefore } = fakeManager([serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'a' })] })])
    const before = buildMcpTools(baseOpts(managerBefore, settings, fakeApproval(true).gate))
    expect(Object.keys(before)).toEqual(['mcp_srv_a'])

    // Simulates the manager's catalog growing (e.g. a tools/list_changed
    // notification) between two per-cycle rebuilds of the ToolSet.
    const { manager: managerAfter } = fakeManager([
      serverRuntime({ name: 'srv', tools: [toolInfo({ name: 'a' }), toolInfo({ name: 'b' })] }),
    ])
    const after = buildMcpTools(baseOpts(managerAfter, settings, fakeApproval(true).gate))
    expect(Object.keys(after).sort()).toEqual(['mcp_srv_a', 'mcp_srv_b'])

    // No shared mutable state between calls: the earlier result is untouched.
    expect(Object.keys(before)).toEqual(['mcp_srv_a'])
  })
})
