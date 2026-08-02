import { expect, test } from 'vitest'
import { getMcpAppHostActions, registerMcpAppHostActions, type McpAppHostActions } from './mcpAppHostRegistry'

function actionsFor(tag: string): McpAppHostActions {
  return {
    callTool: async () => tag,
    draftMessage: () => {},
  }
}

test('a card looks up its OWN conversation, even when a different conversation registered more recently', async () => {
  registerMcpAppHostActions('conv-a', actionsFor('A'))
  registerMcpAppHostActions('conv-b', actionsFor('B'))

  // conv-b registered second, but conv-a's card must still be serviced by
  // conv-a's own actions — not silently reassigned to whichever conversation
  // last rendered (the CRITICAL bug this module fixes).
  await expect(getMcpAppHostActions('conv-a')?.callTool('s', 't', {})).resolves.toBe('A')
  await expect(getMcpAppHostActions('conv-b')?.callTool('s', 't', {})).resolves.toBe('B')
})

test('returns null for a conversation nothing has registered', () => {
  expect(getMcpAppHostActions('never-registered-xyz')).toBeNull()
})

test('re-registering a conversation replaces only that conversation\'s own entry', async () => {
  registerMcpAppHostActions('conv-c', actionsFor('C1'))
  registerMcpAppHostActions('conv-d', actionsFor('D'))
  registerMcpAppHostActions('conv-c', actionsFor('C2'))

  await expect(getMcpAppHostActions('conv-c')?.callTool('s', 't', {})).resolves.toBe('C2')
  await expect(getMcpAppHostActions('conv-d')?.callTool('s', 't', {})).resolves.toBe('D')
})

test('an out-of-order cleanup does not delete a newer registration for the same conversation', () => {
  const cleanupStale = registerMcpAppHostActions('conv-e', actionsFor('E1'))
  registerMcpAppHostActions('conv-e', actionsFor('E2')) // supersedes E1 before its cleanup runs
  cleanupStale() // must be a no-op: it is no longer the current entry
  expect(getMcpAppHostActions('conv-e')).not.toBeNull()
})

test('cleanup removes the entry when it is still current (conversation unmounted)', () => {
  const cleanup = registerMcpAppHostActions('conv-f', actionsFor('F'))
  cleanup()
  expect(getMcpAppHostActions('conv-f')).toBeNull()
})
