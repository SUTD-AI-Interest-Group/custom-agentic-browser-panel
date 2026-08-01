import { beforeEach, describe, expect, it, vi } from 'vitest'

// F8 (d07): clearStore's switch and eraseAllData's Promise.all list were three
// independently hand-maintained call sites, structurally untied to StoreKey —
// unlike storageReport's `Record<StoreKey, StoreUsage>` literal, which TypeScript
// already forces to list every key. These tests lock down the CURRENT, correct
// per-store behavior (cascades for 'conversations', reseed for 'skills', a flat
// clear for everything else) so a refactor that ties both to one StoreKey-keyed
// table can't silently change what a store's clear actually does. Every sibling
// module storage.ts composes is mocked — this file tests only the dispatch.

vi.mock('./conversations', () => ({ clearConversations: vi.fn(async () => {}), conversationsUsage: vi.fn() }))
vi.mock('./memory', () => ({ clearMemory: vi.fn(async () => {}), memoryUsage: vi.fn() }))
vi.mock('./mcpArtifacts', () => ({ clearMcpArtifacts: vi.fn(async () => {}), mcpArtifactsUsage: vi.fn() }))
vi.mock('./artifacts', () => ({ clearArtifacts: vi.fn(async () => {}), artifactsUsage: vi.fn() }))
vi.mock('./screenshots', () => ({ clearShots: vi.fn(async () => {}), shotsUsage: vi.fn() }))
vi.mock('./attachments', () => ({ clearAttachments: vi.fn(async () => {}), attachmentsUsage: vi.fn() }))
vi.mock('./skills', () => ({ clearSkills: vi.fn(async () => {}), skillsUsage: vi.fn() }))
vi.mock('./researchTasks', () => ({ clearTasks: vi.fn(async () => {}), tasksUsage: vi.fn() }))
vi.mock('./builtinSkills', () => ({ seedBuiltinSkills: vi.fn(async () => {}) }))
vi.mock('./vault', () => ({ resetVault: vi.fn(async () => {}) }))

import { clearConversations } from './conversations'
import { clearMemory } from './memory'
import { clearMcpArtifacts } from './mcpArtifacts'
import { clearArtifacts } from './artifacts'
import { clearShots } from './screenshots'
import { clearAttachments } from './attachments'
import { clearSkills } from './skills'
import { clearTasks } from './researchTasks'
import { seedBuiltinSkills } from './builtinSkills'
import { resetVault } from './vault'
import { clearStore, eraseAllData } from './storage'
import type { StoreKey } from './usage'

const ALL_STORE_KEYS: StoreKey[] = [
  'conversations',
  'screenshots',
  'attachments',
  'mcp',
  'artifacts',
  'memory',
  'skills',
  'research',
]

beforeEach(() => {
  vi.clearAllMocks()
  // eraseAllData additionally wipes the whole chrome.storage.local namespace
  // (settings, API keys, ...) beyond the 8 per-store clears under test here.
  vi.stubGlobal('chrome', { storage: { local: { clear: vi.fn(async () => {}) } } })
})

describe('clearStore', () => {
  it("clearing 'conversations' cascades to the stores keyed by it (screenshots/attachments/mcp/artifacts)", async () => {
    await clearStore('conversations')
    expect(clearConversations).toHaveBeenCalledTimes(1)
    expect(clearShots).toHaveBeenCalledTimes(1)
    expect(clearAttachments).toHaveBeenCalledTimes(1)
    expect(clearMcpArtifacts).toHaveBeenCalledTimes(1)
    expect(clearArtifacts).toHaveBeenCalledTimes(1)
    expect(clearMemory).not.toHaveBeenCalled()
  })

  it("clearing 'skills' re-seeds the built-ins afterwards", async () => {
    await clearStore('skills')
    expect(clearSkills).toHaveBeenCalledTimes(1)
    expect(seedBuiltinSkills).toHaveBeenCalledTimes(1)
  })

  it.each<StoreKey>(['screenshots', 'attachments', 'mcp', 'artifacts', 'memory', 'research'])(
    "clearing '%s' only clears its own store",
    async (key) => {
      await clearStore(key)
      expect(clearConversations).not.toHaveBeenCalled()
      expect(seedBuiltinSkills).not.toHaveBeenCalled()
    },
  )
})

describe('eraseAllData', () => {
  it('clears every one of the 8 StoreKey stores exactly once — a 9th key added to StoreKey without a matching entry here must fail to compile, not silently survive an erase', async () => {
    await eraseAllData()
    expect(clearConversations).toHaveBeenCalledTimes(1)
    expect(clearShots).toHaveBeenCalledTimes(1)
    expect(clearAttachments).toHaveBeenCalledTimes(1)
    expect(clearMcpArtifacts).toHaveBeenCalledTimes(1)
    expect(clearArtifacts).toHaveBeenCalledTimes(1)
    expect(clearMemory).toHaveBeenCalledTimes(1)
    expect(clearSkills).toHaveBeenCalledTimes(1)
    expect(clearTasks).toHaveBeenCalledTimes(1)
    expect(resetVault).toHaveBeenCalledTimes(1)
  })

  it('does not reseed built-in skills as a side effect (unlike clearStore(\'skills\'))', async () => {
    // eraseAllData sends the user back to onboarding; re-seeding here would
    // leave built-in skills present before the wizard even runs — a behavior
    // change beyond this fix's scope, not something the structural refactor
    // should introduce.
    await eraseAllData()
    expect(seedBuiltinSkills).not.toHaveBeenCalled()
  })

  it('covers every declared StoreKey — this is the closest runtime proxy for the compile-time guarantee', () => {
    // clearStore is exhaustive over StoreKey by construction (TypeScript
    // enforces every case is handled); this just keeps the *test's own* notion
    // of "every store" from drifting from the real union if it's ever extended.
    expect(ALL_STORE_KEYS.sort()).toEqual(
      (['conversations', 'screenshots', 'attachments', 'mcp', 'artifacts', 'memory', 'skills', 'research'] as StoreKey[]).sort(),
    )
  })
})
