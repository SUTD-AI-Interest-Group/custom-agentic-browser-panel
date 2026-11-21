// The destructive resets and the storage report behind Settings → Data.
//
// This is the one module that knows all five stores exist. Each store owns its
// clear/usage pair (they live beside their data model); this file composes them
// into a single report and dispatches "clear this one" / "erase everything", so
// the Data tab never opens a database itself.

import { clearMcpTasks, mcpTasksUsage } from '../mcp/tasks'
import { clearConversations, conversationsUsage } from './conversations'
import { clearMemory, memoryUsage } from './memory'
import { clearMcpArtifacts, mcpArtifactsUsage } from './mcpArtifacts'
import { clearArtifacts, artifactsUsage } from './artifacts'
import { clearShots, shotsUsage } from './screenshots'
import { clearAttachments, attachmentsUsage } from './attachments'
import { clearSkills, skillsUsage } from './skills'
import { clearTasks, tasksUsage } from './researchTasks'
import { clearTraces, tracesUsage } from './traces'
import { seedBuiltinSkills } from './builtinSkills'
import { resetVault } from './vault'
import type { StorageReport, StoreKey, StoreUsage } from './usage'

/** Read every store once and total it up. Counts are dozens, so one pass is cheap. */
export async function storageReport(): Promise<StorageReport> {
  const [conversations, screenshots, attachments, mcp, artifacts, memory, skills, research, traces, mcpTasks] =
    await Promise.all([
      conversationsUsage(),
      shotsUsage(),
      attachmentsUsage(),
      mcpArtifactsUsage(),
      artifactsUsage(),
      memoryUsage(),
      skillsUsage(),
      tasksUsage(),
      tracesUsage(),
      mcpTasksUsage(),
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
    traces,
    mcpTasks,
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
    case 'mcpTasks':
      await clearMcpTasks()
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
    case 'traces':
      await clearTraces()
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
  traces: clearTraces,
  mcpTasks: clearMcpTasks,
}

/**
 * The on-device decision model's data, which no StoreKey covers (Settings →
 * Experimental manages it): the imported model in OPFS (`decider/`, ~4.6 GB)
 * and the shadow log in its own IndexedDB (`lychee-decider`). Loaded on demand
 * so that the OPFS code reaches no chunk but the ones that already carry it —
 * this module is panel-only (DataTab), never the service worker. The engine is
 * disposed first: a booted worker holds the model files open, and OPFS refuses
 * to remove a file with a live sync access handle.
 */
async function eraseDecider(): Promise<void> {
  const [{ getDeciderEngine }, { deleteModel }, { clearShadow }] = await Promise.all([
    import('../decider/engine'),
    import('../decider/storage'),
    import('../decider/shadowStore'),
  ])
  await getDeciderEngine().dispose()
  await Promise.all([deleteModel(), clearShadow()])
}

/**
 * Erase everything: all eight stores, the decision model and its shadow log,
 * plus the whole chrome.storage.local namespace — settings, API keys, the
 * vision-probe cache, the lot. The decider goes BEFORE the storage clear:
 * deleteModel writes its `absent` status there, which the clear then removes.
 * The caller sends the user back to onboarding afterwards; with the settings
 * key gone, `loadSettings()` returns an un-onboarded config and `App.tsx`
 * renders the wizard on its own.
 *
 * A store or the decider failing must not keep the settings and API keys: every
 * clear is settled first, then chrome.storage and the vault are wiped
 * REGARDLESS, and only then is the first failure rethrown so the caller still
 * reports an erase that did not finish. (The likeliest one is OPFS refusing to
 * delete model files another window's panel holds open; those stay deletable
 * from Settings → Experimental, which offers Delete whenever files are there.)
 */
export async function eraseAllData(): Promise<void> {
  const [decider, ...stores] = await Promise.allSettled([eraseDecider(), ...Object.values(RAW_CLEARERS).map((clear) => clear())])
  await chrome.storage.local.clear()
  await resetVault()
  const storeFailure = stores.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (storeFailure) throw storeFailure.reason
  if (decider.status === 'rejected') {
    const reason = decider.reason instanceof Error ? decider.reason.message : String(decider.reason)
    throw new Error(`Everything else was erased, but the decision model could not be deleted (${reason}); delete it from Settings → Experimental.`)
  }
}
