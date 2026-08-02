import { expect, test } from 'vitest'
import type { McpSettings } from '../../mcp/config'
import { pruneOrphanedSidecars } from './mcpSidecar'

// Regression coverage for the LOW finding: replacing the whole server map
// (the JSON editor's Save, or a rename) must drop serverState/policies for
// any server name no longer present — mirroring what the one-row Remove
// button (removeServer) already does explicitly.

const baseMcp: McpSettings = {
  servers: { linear: { url: 'https://mcp.linear.app/mcp' }, notion: { url: 'https://mcp.notion.so' } },
  serverState: { linear: { enabled: false }, notion: { enabled: true } },
  policies: { linear: { default: 'ask' }, notion: { default: 'always', tools: { search: 'never' } } },
}

test('drops sidecar entries for a server renamed away (old name absent from the new map)', () => {
  const next = pruneOrphanedSidecars(baseMcp, {
    'linear-renamed': baseMcp.servers.linear,
    notion: baseMcp.servers.notion,
  })
  expect(next.serverState).not.toHaveProperty('linear')
  expect(next.policies).not.toHaveProperty('linear')
  // The untouched server's sidecar state survives.
  expect(next.serverState).toEqual({ notion: { enabled: true } })
  expect(next.policies).toEqual({ notion: { default: 'always', tools: { search: 'never' } } })
})

test('leaves every sidecar entry alone when no server name was removed', () => {
  const next = pruneOrphanedSidecars(baseMcp, baseMcp.servers)
  expect(next.serverState).toEqual(baseMcp.serverState)
  expect(next.policies).toEqual(baseMcp.policies)
})

test('a superset (import/merge, which only adds or overwrites by name) drops nothing', () => {
  const next = pruneOrphanedSidecars(baseMcp, { ...baseMcp.servers, github: { url: 'https://mcp.github.com' } })
  expect(Object.keys(next.serverState ?? {})).toEqual(['linear', 'notion'])
  expect(Object.keys(next.policies ?? {})).toEqual(['linear', 'notion'])
})

test('drops every sidecar entry when the whole server map is cleared', () => {
  const next = pruneOrphanedSidecars(baseMcp, {})
  expect(next.serverState).toEqual({})
  expect(next.policies).toEqual({})
})

test('is a no-op on serverState/policies when there was no sidecar state to begin with', () => {
  const mcp: McpSettings = { servers: { linear: { url: 'https://mcp.linear.app/mcp' } } }
  const next = pruneOrphanedSidecars(mcp, {})
  expect(next.serverState).toEqual({})
  expect(next.policies).toEqual({})
})
