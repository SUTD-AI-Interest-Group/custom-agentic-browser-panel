// The Settings "encrypted at rest" status chip. Read-only over the RAW stored
// bytes — deliberately not loadSettings(), which decrypts. A static label
// would lie in the vault's degraded (plaintext-write) mode; this one reports
// what is actually on disk and re-checks on every storage change.

import { useEffect, useState } from 'react'
import type { Settings } from '../../data/settings'
import { classifySealed, secretValues, type SealedState } from '../../data/settingsVault'

type SealedScope = 'providers' | 'observability' | 'all'

/** The at-rest values a scope vouches for, pulled from raw storage records. */
function valuesFor(scope: SealedScope, raw: Record<string, unknown>): string[] {
  const settings = (raw.settings ?? {}) as Partial<Settings>
  if (scope === 'providers') return (settings.providers ?? []).map((p) => p.apiKey)
  if (scope === 'observability') {
    const o = settings.observability
    return o ? [o.publicKey, o.secretKey] : []
  }
  const values = secretValues({
    providers: [],
    selected: null,
    systemPrompt: '',
    tabAccess: 'active-tab',
    onboarded: false,
    ...settings,
  } as Settings)
  for (const [key, record] of Object.entries(raw)) {
    if (!key.startsWith('mcpAuth:') || typeof record !== 'object' || record === null) continue
    const rec = record as { sealed?: unknown; tokens?: unknown }
    // Sealed records contribute their lysec1 string; a legacy plaintext record
    // with tokens counts as an unsealed secret; anything else holds no secret.
    if (typeof rec.sealed === 'string') values.push(rec.sealed)
    else if (rec.tokens) values.push('mcp-plaintext-token')
  }
  return values
}

function useSealedStatus(scope: SealedScope): SealedState {
  const [state, setState] = useState<SealedState>('empty')
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const raw =
          scope === 'all'
            ? await chrome.storage.local.get(null)
            : await chrome.storage.local.get('settings')
        if (alive) setState(classifySealed(valuesFor(scope, raw)))
      } catch {
        if (alive) setState('empty')
      }
    }
    void read()
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return
      if ('settings' in changes || Object.keys(changes).some((k) => k.startsWith('mcpAuth:')))
        void read()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [scope])
  return state
}

/**
 * Live encrypted-at-rest indicator for a Settings section. Renders nothing
 * until the first read lands (and when no secrets are stored), so it never
 * makes a claim it hasn't verified.
 */
export function SealedChip({ scope }: { scope: SealedScope }) {
  const state = useSealedStatus(scope)
  if (state === 'empty') return null
  if (state === 'unsealed')
    return (
      <span className="sealed-chip sealed-chip--warn">
        Some keys aren&apos;t encrypted yet — they encrypt on the next save
      </span>
    )
  return (
    <span className="sealed-chip" title="Sealed with a device-bound key (AES-256-GCM)">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {scope === 'all' ? 'Secrets encrypted at rest' : 'All keys encrypted at rest'}
    </span>
  )
}
