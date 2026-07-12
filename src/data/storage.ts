// The destructive resets and the storage report behind Settings → Data.
//
// This is the one module that knows all five stores exist. Each store owns its
// clear/usage pair (they live beside their data model); this file composes them
// into a single report and dispatches "clear this one" / "erase everything", so
// the Data tab never opens a database itself.

import { clearConversations, conversationsUsage } from './conversations'
import { clearMemory, memoryUsage } from './memory'
import { clearShots, shotsUsage } from './screenshots'
import { clearSkills, skillsUsage } from './skills'
import { clearTasks, tasksUsage } from './researchTasks'
import { seedBuiltinSkills } from './builtinSkills'
import type { StorageReport, StoreKey, StoreUsage } from './usage'

/** Read every store once and total it up. Counts are dozens, so one pass is cheap. */
export async function storageReport(): Promise<StorageReport> {
  const [conversations, screenshots, memory, skills, research] = await Promise.all([
    conversationsUsage(),
    shotsUsage(),
    memoryUsage(),
    skillsUsage(),
    tasksUsage(),
  ])
  const stores: Record<StoreKey, StoreUsage> = {
    conversations,
    screenshots,
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
      return
    case 'screenshots':
      await clearShots()
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
  }
}

/**
 * Erase everything: all five stores plus the whole chrome.storage.local namespace
 * — settings, API keys, the vision-probe cache, the lot. The caller sends the user
 * back to onboarding afterwards; with the settings key gone, `loadSettings()`
 * returns an un-onboarded config and `App.tsx` renders the wizard on its own.
 */
export async function eraseAllData(): Promise<void> {
  await Promise.all([clearConversations(), clearShots(), clearMemory(), clearSkills(), clearTasks()])
  await chrome.storage.local.clear()
}
