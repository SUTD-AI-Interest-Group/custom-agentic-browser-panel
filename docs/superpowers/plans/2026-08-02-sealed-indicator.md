# Sealed-Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live "encrypted at rest" status chip in Settings (Providers, Langfuse block, Data tab), computed from the actual stored bytes.

**Architecture:** One pure classifier beside the existing secret-field mapping (`settingsVault.ts`), one Chrome-coupled hook+component (`SealedChip.tsx`), three placement edits. Spec: `docs/superpowers/specs/2026-08-02-sealed-indicator-design.md` — read it first.

**Tech Stack:** React 18, existing vault modules, `.hint`/Section conventions in `src/ui/`.

## Global Constraints

- Code style: no semicolons, single quotes, 2-space indent, `interface` for object shapes, `/** ... */` on exports.
- The chip is read-only: it must never call `loadSettings()` (returns decrypted values) and never trigger vault operations — raw `chrome.storage.local` reads only.
- Initial/failed read renders nothing (`'empty'`) — the chip never shows a wrong claim.
- `npm run typecheck` (never `npx tsc`); `npm test` all green; `npm run build` succeeds.
- Commit pathspec-scoped; no Co-Authored-By / "Generated with" trailers.

---

### Task 1: Classifier, chip, placements

**Files:**
- Modify: `src/data/settingsVault.ts` (add `SealedState` + `classifySealed`), `src/data/settingsVault.test.ts` (classifier tests)
- Create: `src/ui/settings/SealedChip.tsx`
- Modify: `src/ui/settings/ProvidersTab.tsx` (Section `action` + hint copy), `src/ui/settings/GeneralTab.tsx` (top of `obs-panel`), `src/ui/settings/DataTab.tsx` (first child of "Data & storage" Section), `src/ui/styles.css` (`.sealed-chip`, `.sealed-chip--warn`)

**Interfaces:**
- Consumes: `secretValues(settings): string[]` and `isSealed(value): boolean` (existing).
- Produces: `classifySealed(values: string[]): SealedState`; `<SealedChip scope={'providers' | 'observability' | 'all'} />`.

- [ ] **Step 1: Write the failing classifier tests** (append to `src/data/settingsVault.test.ts`)

```ts
describe('classifySealed', () => {
  it('classifies all-sealed, mixed, and empty value sets', async () => {
    const sealed = await sealSecret('sk-x')
    expect(classifySealed([sealed, sealed])).toBe('sealed')
    expect(classifySealed([sealed, 'sk-plain'])).toBe('unsealed')
    expect(classifySealed(['sk-plain'])).toBe('unsealed')
    expect(classifySealed(['', ''])).toBe('empty')
    expect(classifySealed([])).toBe('empty')
    expect(classifySealed([sealed, ''])).toBe('sealed')
  })
})
```

(Import `classifySealed` beside the existing imports; `sealSecret` comes from `./vault`, already used in the file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/data/settingsVault.test.ts` → FAIL (`classifySealed` not exported).

- [ ] **Step 3: Implement the classifier** (append to `src/data/settingsVault.ts`)

```ts
/** At-rest posture of a set of secret values (for the Settings status chip). */
export type SealedState = 'sealed' | 'unsealed' | 'empty'

/**
 * Classify at-rest secret values: every non-empty value sealed → 'sealed';
 * any non-empty plaintext → 'unsealed'; nothing stored → 'empty'.
 */
export function classifySealed(values: string[]): SealedState {
  const present = values.filter((v) => v !== '')
  if (present.length === 0) return 'empty'
  return present.every(isSealed) ? 'sealed' : 'unsealed'
}
```

- [ ] **Step 4: Run to verify pass**, then `npm run typecheck`.

- [ ] **Step 5: Create `src/ui/settings/SealedChip.tsx`**

```tsx
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
```

- [ ] **Step 6: Placements** (read each file around the cited lines first; keep surrounding code byte-identical)

`src/ui/settings/ProvidersTab.tsx` (~line 132): add the import, pass the chip as the Section's `action`, and update the hint copy:

```tsx
      <Section
        title="Providers"
        hint="Any OpenAI-compatible endpoint. Keys stay in your browser, encrypted at rest, and are sent only to that endpoint."
        action={<SealedChip scope="providers" />}
      >
```

`src/ui/settings/GeneralTab.tsx` (~line 132): first child inside `<div className="obs-panel">`:

```tsx
        <div className="obs-panel">
          <SealedChip scope="observability" />
```

`src/ui/settings/DataTab.tsx` (~line 85): first child of `<Section title="Data & storage">`:

```tsx
      <Section title="Data & storage">
        <SealedChip scope="all" />
```

- [ ] **Step 7: Styles** (append to `src/ui/styles.css`, near the `.settings .hint` rules ~line 3407, matching the file's token conventions — inspect neighbours and reuse existing color variables rather than inventing values)

```css
.sealed-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-tertiary, var(--muted, #7a7a85));
  white-space: nowrap;
}
.sealed-chip--warn {
  color: var(--warn, #b58a3d);
  white-space: normal;
}
```

(If the stylesheet's real token names differ — check what `.hint` uses — substitute those; the fallback literals above are last resort.)

- [ ] **Step 8: Full verification**

Run: `npx vitest run src/data/settingsVault.test.ts` → PASS; `npm test` → all green; `npm run typecheck` → clean; `npm run build` → succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/data/settingsVault.ts src/data/settingsVault.test.ts src/ui/settings/SealedChip.tsx src/ui/settings/ProvidersTab.tsx src/ui/settings/GeneralTab.tsx src/ui/settings/DataTab.tsx src/ui/styles.css
git commit -m "feat(vault): live encrypted-at-rest status chip in Settings" -- src/data/settingsVault.ts src/data/settingsVault.test.ts src/ui/settings/SealedChip.tsx src/ui/settings/ProvidersTab.tsx src/ui/settings/GeneralTab.tsx src/ui/settings/DataTab.tsx src/ui/styles.css
```

---

## Post-implementation verification (reviewer)

Browser check via the live extension: seed a plaintext install, open the panel → Settings → Providers shows the lock chip after migration; Data tab shows "Secrets encrypted at rest"; screenshot as evidence.
