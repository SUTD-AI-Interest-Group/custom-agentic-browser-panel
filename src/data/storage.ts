// The destructive resets and the storage report behind Settings → Data.
//
// This is the one module that knows all five stores exist. Each store owns its
// clear/usage pair (they live beside their data model); this file composes them
// into a single report and dispatches "clear this one" / "erase everything", so
// the Data tab never opens a database itself.

import { clearConversations, conversationsUsage } from './conversations'
import { clearMemory, memoryUsage } from './memory'
import { clearMcpArtifacts, mcpArtifactsUsage } from './mcpArtifacts'
import { clearArtifacts, artifactsUsage } from './artifacts'
import { clearShots, shotsUsage } from './screenshots'
import { clearAttachments, attachmentsUsage } from './attachments'
import { clearSkills, skillsUsage } from './skills'
import { clearTasks, tasksUsage } from './researchTasks'
import { seedBuiltinSkills } from './builtinSkills'
import { resetVault } from './vault'
import type { StorageReport, StoreKey, StoreUsage } from './usage'

/** Read every store once and total it up. Counts are dozens, so one pass is cheap. */
export async function storageReport(): Promise<StorageReport> {
  const [conversations, screenshots, attachments, mcp, artifacts, memory, skills, research] =
    await Promise.all([
      conversationsUsage(),
      shotsUsage(),
      attachmentsUsage(),
      mcpArtifactsUsage(),
      artifactsUsage(),
      memoryUsage(),
      skillsUsage(),
      tasksUsage(),
    ])
  const stores: Record<StoreKey, StoreUsage> = {
    conversations,
    screenshots,
    attachments,
    mcp,
    artifacts,
    memory,
    skills,
    research,
  }
  const total = Object.values(stores).reduce((n, s) => n + s.bytes, 0)
  // estimate() is absent in some contexts; the quota bar simply hides then.
  const quota = await navigator.storage
    ?.estimate?.()
    .then((e) => e.quota ?? null)
    .catch(() => null)
  return { total, quota: quota ?? null, stores }
}

/**
 * Clear one store. Two of these deliberately cascade:
 * - conversations also drops screenshots, which are keyed by conversation and
 *   would otherwise be unreachable garbage holding the biggest share of the quota.
 * - skills re-seeds the built-ins afterwards, so "Clear" returns skills to a known
 *   state rather than an empty one. `deleteSkill` refuses to remove a built-in by
 *   design, so a user who wiped them would otherwise have no way back.
 */
export async function clearStore(key: StoreKey): Promise<void> {
  switch (key) {
    case 'conversations':
      await clearConversations()
      await clearShots()
      await clearAttachments()
      await clearMcpArtifacts()
      await clearArtifacts()
      return
    case 'screenshots':
      await clearShots()
      return
    case 'attachments':
      await clearAttachments()
      return
    case 'mcp':
      await clearMcpArtifacts()
      return
    case 'artifacts':
      await clearArtifacts()
      return
    case 'memory':
      await clearMemory()
      return
    case 'skills':
      await clearSkills()
      await seedBuiltinSkills()
      return
    case 'research':
      await clearTasks()
      return
    default: {
      // Exhaustiveness guard: if StoreKey ever gains a 9th member without a
      // case above, `key` stops being assignable to `never` here and the
      // build fails — the same guarantee storageReport's `Record<StoreKey,
      // StoreUsage>` literal already gets from TypeScript, extended to this
      // switch (which a plain switch/Promise.all list does not get for free).
      const exhaustive: never = key
      throw new Error(`clearStore: unhandled store "${exhaustive}"`)
    }
  }
}

/**
 * Every store's raw clear, one entry per StoreKey — a Record literal forces
 * TypeScript to reject a 9th StoreKey member added without an entry here, the
 * same guarantee storageReport's `stores` object gets. Deliberately flat (no
 * conversations' cascade, no skills' reseed): eraseAllData already clears
 * every store directly, so cascading would just be redundant, and reseeding
 * built-ins here would leave them present before the onboarding wizard the
 * caller sends the user to even runs — a behavior change clearStore('skills')
 * alone is meant to have, not a full erase.
 */
const RAW_CLEARERS: Record<StoreKey, () => Promise<void>> = {
  conversations: clearConversations,
  screenshots: clearShots,
  attachments: clearAttachments,
  mcp: clearMcpArtifacts,
  artifacts: clearArtifacts,
  memory: clearMemory,
  skills: clearSkills,
  research: clearTasks,
}

/**
 * Erase everything: all eight stores plus the whole chrome.storage.local
 * namespace — settings, API keys, the vision-probe cache, the lot. The caller
 * sends the user back to onboarding afterwards; with the settings key gone,
 * `loadSettings()` returns an un-onboarded config and `App.tsx` renders the
 * wizard on its own.
 */
export async function eraseAllData(): Promise<void> {
  await Promise.all(Object.values(RAW_CLEARERS).map((clear) => clear()))
  await chrome.storage.local.clear()
  await resetVault()
}
