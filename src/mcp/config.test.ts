import { describe, expect, it } from 'vitest'
import {
  classifyEntry,
  mcpToolName,
  mcpToolPolicy,
  mergeServers,
  parseMcpJson,
  serializeMcpJson,
  serverEnabled,
  type McpServerEntry,
  type McpSettings,
} from './config'

const http: McpServerEntry = { url: 'https://mcp.example.com/mcp' }
const stdio: McpServerEntry = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }

describe('classifyEntry', () => {
  it('classifies a url entry as http', () => {
    expect(classifyEntry(http)).toBe('http')
  })

  it('classifies a command entry as stdio', () => {
    expect(classifyEntry(stdio)).toBe('stdio')
  })

  it('rejects an entry with both url and command', () => {
    expect(classifyEntry({ ...http, ...stdio })).toBe('invalid')
  })

  it('rejects an entry with neither', () => {
    expect(classifyEntry({})).toBe('invalid')
  })

  it('rejects a non-http(s) url', () => {
    expect(classifyEntry({ url: 'ftp://example.com' })).toBe('invalid')
    expect(classifyEntry({ url: 'not a url' })).toBe('invalid')
  })

  it('accepts localhost http urls', () => {
    expect(classifyEntry({ url: 'http://localhost:3845/mcp' })).toBe('http')
  })
})

describe('parseMcpJson', () => {
  it('accepts the standard wrapped shape', () => {
    const r = parseMcpJson(JSON.stringify({ mcpServers: { linear: http } }))
    if ('error' in r) throw new Error(r.error)
    expect(r.servers.linear).toEqual(http)
    expect(r.invalid).toEqual([])
  })

  it('accepts a bare server map', () => {
    const r = parseMcpJson(JSON.stringify({ linear: http, fs: stdio }))
    if ('error' in r) throw new Error(r.error)
    expect(Object.keys(r.servers)).toEqual(['linear', 'fs'])
  })

  it('reports malformed JSON as a top-level error', () => {
    const r = parseMcpJson('{ not json')
    expect('error' in r).toBe(true)
  })

  it('reports a non-object as a top-level error', () => {
    expect('error' in parseMcpJson('42')).toBe(true)
    expect('error' in parseMcpJson('[]')).toBe(true)
  })

  it('lists invalid entries without blocking valid ones', () => {
    const r = parseMcpJson(
      JSON.stringify({ mcpServers: { good: http, bad: { nope: true }, worse: 'x' } }),
    )
    if ('error' in r) throw new Error(r.error)
    expect(Object.keys(r.servers)).toEqual(['good'])
    expect(r.invalid.map((i) => i.name).sort()).toEqual(['bad', 'worse'])
    expect(r.invalid[0].error).toBeTruthy()
  })

  it('keeps stdio entries verbatim (preserve + mark, not reject)', () => {
    const r = parseMcpJson(JSON.stringify({ mcpServers: { fs: stdio } }))
    if ('error' in r) throw new Error(r.error)
    expect(r.servers.fs).toEqual(stdio)
  })
})

describe('serializeMcpJson', () => {
  it('emits exactly the standard wrapped shape, pretty-printed', () => {
    const text = serializeMcpJson({ linear: http })
    expect(JSON.parse(text)).toEqual({ mcpServers: { linear: http } })
    expect(text).toContain('\n  ')
  })

  it('round-trips through parseMcpJson', () => {
    const servers = { linear: http, fs: stdio }
    const r = parseMcpJson(serializeMcpJson(servers))
    if ('error' in r) throw new Error(r.error)
    expect(r.servers).toEqual(servers)
  })
})

describe('mergeServers', () => {
  it('overwrites same-named entries and keeps the rest', () => {
    const current = { a: http, b: stdio }
    const imported = { b: { url: 'https://new.example.com/mcp' }, c: http }
    const merged = mergeServers(current, imported)
    expect(merged.a).toEqual(http)
    expect(merged.b).toEqual({ url: 'https://new.example.com/mcp' })
    expect(merged.c).toEqual(http)
  })

  it('does not mutate its inputs', () => {
    const current = { a: http }
    mergeServers(current, { a: stdio })
    expect(current.a).toEqual(http)
  })
})

describe('serverEnabled', () => {
  const mcp: McpSettings = {
    servers: { a: http, b: http },
    serverState: { b: { enabled: false } },
  }

  it('defaults to enabled when no sidecar state exists', () => {
    expect(serverEnabled(mcp, 'a')).toBe(true)
    expect(serverEnabled(undefined, 'a')).toBe(true)
  })

  it('honors an explicit disable', () => {
    expect(serverEnabled(mcp, 'b')).toBe(false)
  })
})

describe('mcpToolPolicy', () => {
  const mcp: McpSettings = {
    servers: { a: http },
    policies: {
      a: { default: 'always', tools: { dangerous: 'never' } },
    },
  }

  it('resolves tool override → server default → ask', () => {
    expect(mcpToolPolicy(mcp, 'a', 'dangerous')).toBe('never')
    expect(mcpToolPolicy(mcp, 'a', 'other')).toBe('always')
    expect(mcpToolPolicy(mcp, 'unknown', 'x')).toBe('ask')
    expect(mcpToolPolicy(undefined, 'a', 'x')).toBe('ask')
  })
})

describe('mcpToolName', () => {
  it('prefixes server and tool', () => {
    expect(mcpToolName('linear', 'create_issue', new Set())).toBe('mcp_linear_create_issue')
  })

  it('sanitizes characters outside the provider-safe charset', () => {
    expect(mcpToolName('my server!', 'do.thing', new Set())).toBe('mcp_my_server__do_thing')
  })

  it('caps the name at 64 characters', () => {
    const name = mcpToolName('s'.repeat(40), 't'.repeat(40), new Set())
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.startsWith('mcp_')).toBe(true)
  })

  it('dedupes collisions with a numeric suffix', () => {
    const taken = new Set<string>()
    const a = mcpToolName('srv', 'tool', taken)
    taken.add(a)
    const b = mcpToolName('srv', 'tool', taken)
    expect(b).not.toBe(a)
    expect(b.length).toBeLessThanOrEqual(64)
    taken.add(b)
    const c = mcpToolName('srv', 'tool', taken)
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
  })

  it('dedupes collisions even at the length cap', () => {
    const taken = new Set<string>()
    const a = mcpToolName('s'.repeat(40), 't'.repeat(40), taken)
    taken.add(a)
    const b = mcpToolName('s'.repeat(40), 't'.repeat(40), taken)
    expect(b).not.toBe(a)
    expect(b.length).toBeLessThanOrEqual(64)
  })
})
