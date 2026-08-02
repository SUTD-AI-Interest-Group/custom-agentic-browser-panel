# Encrypted-at-rest indicator in Settings

**Date:** 2026-08-02 · **Status:** Approved (form: section-level live status chip)

## Summary

Users get no visual confirmation that the envelope-encryption vault
(`docs/superpowers/specs/2026-08-01-envelope-encryption-design.md`) is protecting their keys.
Add a small **live** status chip at the section level: top of Settings → Providers, inside the
Langfuse block in Settings → General, and a line in Settings → Data. Live means computed from
the actual at-rest bytes — a static label would silently lie in the vault's documented
degraded mode (plaintext writes while IndexedDB is unavailable).

## Design

### Pure classifier (`src/data/settingsVault.ts`)

```ts
export type SealedState = 'sealed' | 'unsealed' | 'empty'
/** Classify at-rest secret values: all sealed → 'sealed'; any non-empty plaintext → 'unsealed'; no non-empty values → 'empty'. */
export function classifySealed(values: string[]): SealedState
```

Lives beside `secretValues` (same file owns "which fields are secrets"). Unit-tested.

### Chip component (`src/ui/settings/SealedChip.tsx`)

`<SealedChip scope>` with `scope: 'providers' | 'observability' | 'all'`, backed by a
`useSealedStatus(scope)` hook in the same file:

- Reads the RAW stored blob (`chrome.storage.local.get('settings')`; scope `'all'` uses
  `get(null)` once to also see every `mcpAuth:*` record). Never uses `loadSettings()` — that
  returns decrypted values by design.
- Scope → values: `providers` = raw `providers[].apiKey`; `observability` = raw Langfuse
  `publicKey`/`secretKey`; `all` = `secretValues(rawSettings)` plus each `mcpAuth:*` record
  (sealed iff the stored value has a string `.sealed` field; a legacy plaintext record with
  `tokens` counts as unsealed; absent records are skipped).
- Recomputes on `chrome.storage.onChanged` for the `settings` key and `mcpAuth:*` keys
  (area `local`), so the chip flips live after a save/migration.
- Initial state before the first read resolves is `'empty'` — render nothing, never a wrong
  claim.
- Render: `'sealed'` → lock glyph + "All keys encrypted at rest" (`'all'` scope says
  "Secrets encrypted at rest"); `'unsealed'` → subdued warning "Some keys aren't encrypted
  yet — they encrypt on the next save"; `'empty'` → `null`.
- The lock is a small inline stroke SVG matching the settings UI's existing icon style; no new
  dependency. Styles: `.sealed-chip` + `.sealed-chip--warn` in `src/ui/styles.css`, sized to
  sit in a `Section`'s `action` slot.

### Placement

- **ProvidersTab**: `Section action={<SealedChip scope='providers' />}`, and the section hint
  becomes "Any OpenAI-compatible endpoint. Keys stay in your browser, encrypted at rest, and
  are sent only to that endpoint."
- **GeneralTab**: `<SealedChip scope='observability' />` at the top of the `obs-panel` block
  (visible only when Langfuse is enabled — the keys are only shown then).
- **DataTab**: `<SealedChip scope='all' />` as the first child of the "Data & storage"
  Section.

## Error handling

The hook treats a storage read failure as `'empty'` (chip hidden). It renders nothing rather
than guessing.

## Testing

- Unit: `classifySealed` (all sealed / mixed / all empty / empty list) in
  `settingsVault.test.ts`.
- Chrome-coupled hook/UI: `npm run build` + live-extension check (panel screenshot asserting
  the chip renders "encrypted" after the vault has sealed storage).

## Out of scope

Per-field indicators, an onboarding mention, and any vault status page. The chip never
triggers vault operations — read-only.
