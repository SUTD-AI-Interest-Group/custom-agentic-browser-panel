// Optional-permission helpers for the browsing-data tools.
//
// history, bookmarks, topSites and downloads live in the manifest's
// optional_permissions, so the install prompt stays clean. They are granted at
// runtime from the Settings toggles (chrome.permissions.request must run inside
// a user gesture — the toggle click). The granted permission is the single
// source of truth for whether a capability is on; nothing is mirrored into
// Settings.

/** A browser-data capability, keyed by its Chrome permission name. */
export type BrowsingCapability = 'history' | 'bookmarks' | 'topSites' | 'downloads'

/** All browsing capabilities, in the order shown in Settings. */
export const BROWSING_CAPABILITIES: BrowsingCapability[] = [
  'history',
  'bookmarks',
  'topSites',
  'downloads',
]

/** The browsing capabilities the user has currently granted. */
export async function grantedCapabilities(): Promise<Set<BrowsingCapability>> {
  const granted = new Set<BrowsingCapability>()
  await Promise.all(
    BROWSING_CAPABILITIES.map(async (cap) => {
      if (await chrome.permissions.contains({ permissions: [cap] })) granted.add(cap)
    }),
  )
  return granted
}

/**
 * Request one or more capabilities. Must be called synchronously from a user
 * gesture (e.g. a Settings toggle click). Resolves to whether the request was
 * granted.
 */
export async function requestCapabilities(caps: BrowsingCapability[]): Promise<boolean> {
  if (caps.length === 0) return true
  return chrome.permissions.request({ permissions: caps })
}

/** Remove one or more capabilities. Resolves to whether removal succeeded. */
export async function removeCapabilities(caps: BrowsingCapability[]): Promise<boolean> {
  if (caps.length === 0) return true
  return chrome.permissions.remove({ permissions: caps })
}
