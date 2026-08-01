import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _putArtifactForTests,
  _resetDbForTests,
  getMcpArtifact,
  pruneMcpArtifacts,
  saveMcpArtifact,
  type McpArtifact,
} from './mcpArtifacts'

function artifact(overrides: Partial<McpArtifact> & Pick<McpArtifact, 'id' | 'bytes' | 'createdAt'>): McpArtifact {
  return {
    kind: 'image',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,x',
    title: 'Example',
    server: 's1',
    tool: 't1',
    conversationId: 'c1',
    ...overrides,
  }
}

beforeEach(async () => {
  await _resetDbForTests()
})

describe('saveMcpArtifact', () => {
  it('returns an id that getMcpArtifact can read back', async () => {
    const id = await saveMcpArtifact({
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,x',
      title: 'A screenshot',
      conversationId: 'c1',
      server: 's1',
      tool: 't1',
    })
    const stored = await getMcpArtifact(id)
    expect(stored?.title).toBe('A screenshot')
  })
})

describe('pruneMcpArtifacts', () => {
  it('keeps the newest artifact even when it alone exceeds MAX_TOTAL_BYTES', async () => {
    // MAX_TOTAL_BYTES is 50MB — an MCP tool can plausibly return a single
    // video/audio payload over that. It must survive its own very next prune,
    // not vanish right after saveMcpArtifact handed its id back to the model
    // and the UI rendered a card for it (F4).
    await _putArtifactForTests(artifact({ id: 'huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(0)
    expect(await getMcpArtifact('huge')).not.toBeNull()
  })

  it('still evicts an oversized OLDER artifact once a newer one exists', async () => {
    // Both well within MAX_AGE_MS (30 days) — recency here differs only by
    // the byte-cap pass's oldest-first ordering, not by age eviction.
    await _putArtifactForTests(artifact({ id: 'old-huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'new-small', bytes: 10, createdAt: Date.now() - 1_000 }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(1)
    expect(await getMcpArtifact('old-huge')).toBeNull()
    expect(await getMcpArtifact('new-small')).not.toBeNull()
  })

  it('evicts artifacts past MAX_AGE_MS regardless of size', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days old; cap is 30
    await _putArtifactForTests(artifact({ id: 'ancient', bytes: 10, createdAt: ancient }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(1)
    expect(await getMcpArtifact('ancient')).toBeNull()
  })
})
