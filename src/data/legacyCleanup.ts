// System-1 (the local Von model behind the experimental Act tool) was removed
// on 2026-10-03. An install that had switched it on still holds its ~800 MB of
// model weights in Cache Storage plus a readiness flag in chrome.storage.local,
// and nothing reads either any more. Reclaim both on install/update. Each step
// is independent and best-effort: a missing cache or key is the common case.
export const LEGACY_SYSTEM1_CACHE = 'lychee-system1'
export const LEGACY_SYSTEM1_STATE_KEY = 'system1State'

export async function removeLegacySystem1(): Promise<void> {
  try {
    await caches.delete(LEGACY_SYSTEM1_CACHE)
  } catch {
    // No Cache Storage in this context, or nothing to delete.
  }
  try {
    await chrome.storage.local.remove(LEGACY_SYSTEM1_STATE_KEY)
  } catch {
    // Storage unavailable — the stale flag is inert anyway.
  }
}
