// Maps the vault over the secret-bearing fields of a Settings object. This is
// the ONLY place that knows which settings fields are secrets; loadSettings/
// saveSettings call these so every other consumer of Settings sees plaintext.
// Sealing always returns a new object — callers keep using their (plaintext)
// settings after a save.

import type { Settings } from './settings'
import { openSecret, sealSecret } from './vault'
import { isSealed } from './vaultFormat'

/**
 * Every secret-bearing field value in stable order: provider apiKeys,
 * observability keys, MCP header values. Empty strings included, so indexes
 * line up with the mapped object for verification.
 */
export function secretValues(settings: Settings): string[] {
  const values = settings.providers.map((p) => p.apiKey)
  if (settings.observability) values.push(settings.observability.publicKey, settings.observability.secretKey)
  for (const entry of Object.values(settings.mcp?.servers ?? {})) {
    for (const v of Object.values(entry.headers ?? {})) values.push(v)
  }
  return values
}

/** Seal every secret field for storage. Returns a new Settings; never mutates. */
export async function sealSettings(settings: Settings): Promise<Settings> {
  return mapSecrets(settings, sealSecret)
}

/**
 * Open every secret field after load. `hadPlaintext` reports whether any
 * non-empty secret was stored unsealed — the caller's cue to migrate. A sealed
 * value that no longer decrypts resolves to '' (the user re-enters the key).
 */
export async function openSettings(settings: Settings): Promise<{ settings: Settings; hadPlaintext: boolean }> {
  const hadPlaintext = secretValues(settings).some((v) => v !== '' && !isSealed(v))
  const opened = await mapSecrets(settings, async (value) => (await openSecret(value)) ?? '')
  return { settings: opened, hadPlaintext }
}

async function mapSecrets(settings: Settings, fn: (value: string) => Promise<string>): Promise<Settings> {
  const providers = await Promise.all(
    settings.providers.map(async (p) => ({ ...p, apiKey: await fn(p.apiKey) })),
  )
  const out: Settings = { ...settings, providers }
  if (settings.observability) {
    out.observability = {
      ...settings.observability,
      publicKey: await fn(settings.observability.publicKey),
      secretKey: await fn(settings.observability.secretKey),
    }
  }
  if (settings.mcp?.servers) {
    const servers: typeof settings.mcp.servers = {}
    for (const [name, entry] of Object.entries(settings.mcp.servers)) {
      if (entry.headers) {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(entry.headers)) headers[k] = await fn(v)
        servers[name] = { ...entry, headers }
      } else {
        servers[name] = entry
      }
    }
    out.mcp = { ...settings.mcp, servers }
  }
  return out
}
