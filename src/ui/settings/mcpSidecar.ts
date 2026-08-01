// Pure helper behind McpSection's JSON editor: when the server map is
// replaced wholesale (Save, or an import merge), a server name that vanishes
// from the new map — removed outright, or renamed to a different key — must
// not leave its `serverState`/`policies` sidecar entries behind forever.
// `removeServer()` (in McpSection.tsx) already does this cleanup explicitly
// for the one-row remove button; this gives the bulk-replace paths the same
// guarantee.

import type { McpSettings, McpServerEntry } from '../../mcp/config'

/**
 * Replace `mcp.servers` with `nextServers`, dropping `serverState`/`policies`
 * entries for any server name present in the old map but absent from the new
 * one. A pure superset (import/merge, which only adds or overwrites by name)
 * removes no names, so nothing is dropped in that path — only Save's outright
 * replace can orphan a sidecar entry.
 */
export function pruneOrphanedSidecars(
  mcp: McpSettings,
  nextServers: Record<string, McpServerEntry>,
): McpSettings {
  const removedNames = Object.keys(mcp.servers).filter((name) => !(name in nextServers))
  if (removedNames.length === 0) return { ...mcp, servers: nextServers }
  const serverState = { ...mcp.serverState }
  const policies = { ...mcp.policies }
  for (const name of removedNames) {
    delete serverState[name]
    delete policies[name]
  }
  return { ...mcp, servers: nextServers, serverState, policies }
}
