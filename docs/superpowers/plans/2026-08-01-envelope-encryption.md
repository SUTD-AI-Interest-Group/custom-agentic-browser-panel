# Envelope Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Envelope-encrypt every secret at rest in `chrome.storage.local` (provider API keys, Langfuse keys, MCP OAuth tokens, MCP header values) behind the existing `loadSettings`/`saveSettings` and MCP-auth chokepoints.

**Architecture:** A device-bound, non-extractable AES-KW KEK persisted in IndexedDB wraps a single AES-256-GCM DEK; each secret field is sealed under the DEK into a self-describing `lysec1.` string. Decrypt-on-load / encrypt-on-save means no key-reading call site or UI changes. Spec: `docs/superpowers/specs/2026-08-01-envelope-encryption-design.md` — read it first; it is the authority on threat model, parameters, and failure modes.

**Tech Stack:** WebCrypto (`crypto.subtle` — native in panel/SW/offscreen and real in vitest), IndexedDB, `fake-indexeddb` (new dev dependency, tests only), Vitest.

## Global Constraints

- Code style: **no semicolons**, single quotes, 2-space indent, `interface` for object shapes, `/** ... */` on exports, non-obvious *why* in block comments (CLAUDE.md).
- Typecheck with `npm run typecheck` — **never `npx tsc`** (decoy package risk).
- Tests: `npm test` (vitest run). All existing tests must stay green.
- Crypto parameters (fixed by spec, do not improvise): AES-KW 256-bit KEK, non-extractable, usages `['wrapKey','unwrapKey']`; AES-GCM 256-bit DEK, generated `extractable: true` (required by `wrapKey`), unwrapped `extractable: false`; 12-byte random IV per encryption; default 128-bit tag; IndexedDB db `lychee-vault` v1, store `vault`, record keys `kek`/`dek`.
- Never mutate a caller's `Settings` object; sealing always returns a new object.
- The vault must never throw out of `loadSettings`/`saveSettings` — degraded behavior is defined per failure mode in the spec.
- Commits: pathspec-scoped (`git commit -m "..." -- <files>`), imperative subject with `feat:`/`test:`/`docs:` prefix, **no Co-Authored-By / "Generated with" trailers**.

---

### Task 1: Sealed-string format (`vaultFormat.ts`)

**Files:**
- Create: `src/data/vaultFormat.ts`
- Test: `src/data/vaultFormat.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces: `SEALED_PREFIX: string` (`'lysec1.'`), `IV_BYTES: number` (12), `isSealed(value: string): boolean`, `serializeSealed(iv: Uint8Array, ciphertext: Uint8Array): string`, `parseSealed(value: string): { iv: Uint8Array, ciphertext: Uint8Array } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/data/vaultFormat.test.ts
import { describe, expect, it } from 'vitest'
import { IV_BYTES, SEALED_PREFIX, isSealed, parseSealed, serializeSealed } from './vaultFormat'

describe('vaultFormat', () => {
  const iv = new Uint8Array(12).fill(7)
  const ct = new Uint8Array(24).fill(9)

  it('serializes to a lysec1. string and round-trips', () => {
    const sealed = serializeSealed(iv, ct)
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true)
    expect(isSealed(sealed)).toBe(true)
    const parsed = parseSealed(sealed)
    expect(parsed).not.toBeNull()
    expect(Array.from(parsed!.iv)).toEqual(Array.from(iv))
    expect(Array.from(parsed!.ciphertext)).toEqual(Array.from(ct))
  })

  it('treats ordinary strings as not sealed', () => {
    expect(isSealed('sk-abc123')).toBe(false)
    expect(isSealed('')).toBe(false)
    expect(parseSealed('sk-abc123')).toBeNull()
  })

  it('rejects malformed sealed values', () => {
    expect(parseSealed('lysec1.')).toBeNull()
    expect(parseSealed('lysec1.onlyonepart')).toBeNull()
    expect(parseSealed('lysec1.a.b.c')).toBeNull()
    expect(parseSealed('lysec1.!!!.###')).toBeNull()
    // IV of the wrong length (8 bytes, not IV_BYTES)
    const shortIv = serializeSealed(new Uint8Array(8), ct)
    expect(parseSealed(shortIv)).toBeNull()
    // ciphertext shorter than a bare 16-byte GCM tag can never be valid
    const tinyCt = serializeSealed(iv, new Uint8Array(8))
    expect(parseSealed(tinyCt)).toBeNull()
  })

  it('IV_BYTES is the NIST-recommended 96 bits', () => {
    expect(IV_BYTES).toBe(12)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/data/vaultFormat.test.ts`
Expected: FAIL — cannot resolve `./vaultFormat`.

- [ ] **Step 3: Implement**

```ts
// src/data/vaultFormat.ts
// Pure sealed-secret string format: `lysec1.<b64url iv>.<b64url ciphertext‖tag>`.
// No WebCrypto, no Chrome — the crypto lives in vault.ts; this file only
// serializes/parses, so the format is unit-testable and versionable: the
// prefix is the crypto-agility hook (a parameter change ships as `lysec2.`
// with this parser still reading old values).

/** Version prefix of a sealed secret at rest. A value without it is legacy plaintext. */
export const SEALED_PREFIX = 'lysec1.'

/** AES-GCM IV length in bytes (96 bits — the NIST SP 800-38D recommended construction). */
export const IV_BYTES = 12

export interface ParsedSealed {
  iv: Uint8Array
  /** Ciphertext with the 128-bit GCM tag appended (WebCrypto's native output layout). */
  ciphertext: Uint8Array
}

/** Whether a stored value is a sealed secret (anything else is legacy plaintext). */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

export function serializeSealed(iv: Uint8Array, ciphertext: Uint8Array): string {
  return `${SEALED_PREFIX}${toB64Url(iv)}.${toB64Url(ciphertext)}`
}

/** Parse a sealed value. Null for anything malformed — wrong prefix, part count, base64, or length. */
export function parseSealed(value: string): ParsedSealed | null {
  if (!isSealed(value)) return null
  const parts = value.slice(SEALED_PREFIX.length).split('.')
  if (parts.length !== 2) return null
  const iv = fromB64Url(parts[0])
  const ciphertext = fromB64Url(parts[1])
  if (!iv || !ciphertext) return null
  if (iv.length !== IV_BYTES) return null
  // GCM output is plaintext + 16-byte tag; anything shorter than a bare tag is garbage.
  if (ciphertext.length < 16) return null
  return { iv, ciphertext }
}

function toB64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/data/vaultFormat.test.ts` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/vaultFormat.ts src/data/vaultFormat.test.ts
git commit -m "feat(vault): sealed-secret string format" -- src/data/vaultFormat.ts src/data/vaultFormat.test.ts
```

---

### Task 2: The vault (`vault.ts`) — KEK/DEK lifecycle, seal/open

**Files:**
- Create: `src/data/vault.ts`
- Test: `src/data/vault.test.ts`
- Modify: `package.json` (add `fake-indexeddb` to devDependencies via `npm install -D fake-indexeddb`)

**Interfaces:**
- Consumes: Task 1's `IV_BYTES`, `isSealed`, `parseSealed`, `serializeSealed`.
- Produces: `sealSecret(plain: string): Promise<string>`, `openSecret(value: string): Promise<string | null>`, `resetVault(): Promise<void>`, `_resetDekCacheForTests(): void`.
- Contract (spec §Migration & failure modes): `sealSecret('')` → `''`; `sealSecret` of an already-sealed value returns it unchanged (idempotent); vault unavailable → `sealSecret` returns the plaintext unchanged and `openSecret` returns a sealed value **verbatim** (preserves data through a transient IndexedDB outage — a later save round-trips it); a sealed value that parses or decrypts wrong with a working vault → `null` (caller resolves to `''`).

- [ ] **Step 1: Install the test dependency**

```bash
npm install -D fake-indexeddb
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/data/vault.test.ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetDekCacheForTests, openSecret, resetVault, sealSecret } from './vault'
import { isSealed } from './vaultFormat'

// resetVault deletes the fake IndexedDB and clears the module DEK cache, so
// every test starts from a pristine, vault-less state.
beforeEach(async () => {
  await resetVault()
})

describe('vault', () => {
  it('canary: a CryptoKey survives a fake-indexeddb round-trip', async () => {
    // If this fails with DataCloneError, fake-indexeddb is too old to
    // structured-clone CryptoKey — upgrade it before debugging anything else.
    const key = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'])
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('canary', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('s')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('s', 'readwrite')
      tx.objectStore('s').put(key, 'k')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const back = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction('s', 'readonly')
      const get = tx.objectStore('s').get('k')
      get.onsuccess = () => resolve(get.result as CryptoKey)
      get.onerror = () => reject(get.error)
    })
    db.close()
    expect(back.extractable).toBe(false)
  })

  it('seals and opens a secret', async () => {
    const sealed = await sealSecret('sk-test-12345')
    expect(sealed).not.toBe('sk-test-12345')
    expect(isSealed(sealed)).toBe(true)
    expect(await openSecret(sealed)).toBe('sk-test-12345')
  })

  it('uses a fresh IV per call — same plaintext never seals identically', async () => {
    expect(await sealSecret('same')).not.toBe(await sealSecret('same'))
  })

  it('passes plaintext through openSecret and empty/sealed through sealSecret', async () => {
    expect(await openSecret('sk-plain')).toBe('sk-plain')
    expect(await sealSecret('')).toBe('')
    const sealed = await sealSecret('x')
    expect(await sealSecret(sealed)).toBe(sealed)
  })

  it('returns null for a tampered ciphertext', async () => {
    const sealed = await sealSecret('secret')
    const parts = sealed.split('.')
    // Flip the FIRST ciphertext character — the trailing one can encode only
    // base64 padding bits, where a flip may decode to identical bytes.
    const ct = parts[2]
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)
    expect(await openSecret([parts[0], parts[1], flipped].join('.'))).toBeNull()
  })

  it('persists across a context restart (cache cleared, IndexedDB kept)', async () => {
    const sealed = await sealSecret('durable')
    _resetDekCacheForTests()
    expect(await openSecret(sealed)).toBe('durable')
  })

  it('a second context adopts the existing KEK instead of minting its own', async () => {
    const first = await sealSecret('one')
    _resetDekCacheForTests()
    const second = await sealSecret('two')
    _resetDekCacheForTests()
    expect(await openSecret(first)).toBe('one')
    expect(await openSecret(second)).toBe('two')
  })

  it('resetVault makes old ciphertext undecryptable (fresh KEK)', async () => {
    const sealed = await sealSecret('gone')
    await resetVault()
    expect(await openSecret(sealed)).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/data/vault.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// src/data/vault.ts
// The secrets vault: envelope encryption for values at rest in chrome.storage.
// A device-bound, NON-EXTRACTABLE AES-KW KEK lives in IndexedDB (`lychee-vault`)
// and wraps a single AES-256-GCM DEK; each secret field is sealed under the DEK
// as a `lysec1.` string (format in vaultFormat.ts). Threat model, parameters and
// failure modes: docs/superpowers/specs/2026-08-01-envelope-encryption-design.md.
//
// Failure philosophy: the vault must never brick key storage. When IndexedDB is
// unavailable, sealSecret returns the plaintext and openSecret returns a sealed
// value verbatim — data is preserved either way and a later load/save recovers.
// Only a sealed value that positively fails to parse or decrypt (lost KEK,
// corrupt blob) opens to null, which callers surface as an empty key field.

import { IV_BYTES, isSealed, parseSealed, serializeSealed } from './vaultFormat'

const DB_NAME = 'lychee-vault'
const DB_VERSION = 1
const STORE = 'vault'
const KEK_ID = 'kek'
const DEK_ID = 'dek'

let dekPromise: Promise<CryptoKey | null> | null = null
let warnedUnavailable = false
let warnedUndecryptable = false

/** Seal a secret for storage. Empty input, an already-sealed value, and a down vault all pass through unchanged. */
export async function sealSecret(plain: string): Promise<string> {
  if (plain === '' || isSealed(plain)) return plain
  const dek = await getDek()
  if (!dek) return plain
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, new TextEncoder().encode(plain))
  return serializeSealed(iv, new Uint8Array(ct))
}

/**
 * Open a stored value: plaintext passes through (that IS the legacy-format read
 * path); a sealed value decrypts; a sealed value with the vault down returns
 * verbatim (recoverable later); a sealed value that cannot decrypt → null.
 */
export async function openSecret(value: string): Promise<string | null> {
  if (!isSealed(value)) return value
  const parsed = parseSealed(value)
  if (!parsed) return warnUndecryptable()
  const dek = await getDek()
  if (!dek) return value
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv }, dek, parsed.ciphertext)
    return new TextDecoder().decode(pt)
  } catch {
    return warnUndecryptable()
  }
}

/** Delete the vault (KEK + wrapped DEK) — part of "Erase all data". Old ciphertext becomes undecryptable. */
export async function resetVault(): Promise<void> {
  dekPromise = null
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

/** Test hook: simulate a fresh context (SW restart) without touching IndexedDB. */
export function _resetDekCacheForTests(): void {
  dekPromise = null
}

function warnUndecryptable(): null {
  if (!warnedUndecryptable) {
    warnedUndecryptable = true
    console.warn('[vault] a sealed secret could not be decrypted — it will read as empty; re-enter the key in Settings')
  }
  return null
}

function getDek(): Promise<CryptoKey | null> {
  if (!dekPromise) {
    dekPromise = initDek().catch(() => {
      // Transient failure (IndexedDB blocked/broken): report unavailable now,
      // but let a later call retry rather than pinning the failure forever.
      dekPromise = null
      if (!warnedUnavailable) {
        warnedUnavailable = true
        console.warn('[vault] IndexedDB unavailable — secrets will be stored without sealing until it recovers')
      }
      return null
    })
  }
  return dekPromise
}

async function initDek(): Promise<CryptoKey | null> {
  if (typeof indexedDB === 'undefined') return null
  // Generate a CANDIDATE key pair up front: IndexedDB transactions auto-commit
  // the moment no request is pending, so nothing may be awaited inside the
  // claim transaction — the atomic first-writer-wins guarantee depends on it.
  const candidateKek = await crypto.subtle.generateKey(
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
  // extractable:true is required by wrapKey; the plaintext DEK is discarded on
  // return and only ever recovered via unwrapKey(..., extractable:false).
  const candidateDek = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  const candidateWrapped = await crypto.subtle.wrapKey('raw', candidateDek, candidateKek, 'AES-KW')
  const db = await openDb()
  try {
    const { kek, wrapped } = await claimOrAdopt(db, candidateKek, candidateWrapped)
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped,
      kek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    db.close()
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('vault: indexedDB open failed'))
    req.onblocked = () => reject(new Error('vault: indexedDB open blocked'))
  })
}

/**
 * In ONE readwrite transaction: adopt the stored KEK/wrapped-DEK if present,
 * else claim the candidates. Two contexts racing at first run serialize on the
 * transaction, so exactly one pair ever wins — a second KEK can never orphan
 * ciphertext sealed under the first.
 */
function claimOrAdopt(
  db: IDBDatabase,
  candidateKek: CryptoKey,
  candidateWrapped: ArrayBuffer,
): Promise<{ kek: CryptoKey; wrapped: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    let kek = candidateKek
    let wrapped = candidateWrapped
    const getKek = store.get(KEK_ID)
    getKek.onsuccess = () => {
      const getWrapped = store.get(DEK_ID)
      getWrapped.onsuccess = () => {
        const storedKek = getKek.result as CryptoKey | undefined
        const storedWrapped = getWrapped.result as ArrayBuffer | undefined
        if (storedKek && storedWrapped) {
          kek = storedKek
          wrapped = storedWrapped
        } else {
          store.put(candidateKek, KEK_ID)
          store.put(candidateWrapped, DEK_ID)
        }
      }
    }
    tx.oncomplete = () => resolve({ kek, wrapped })
    tx.onerror = () => reject(tx.error ?? new Error('vault: claim transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('vault: claim transaction aborted'))
  })
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/data/vault.test.ts` → PASS (canary first — if it DataCloneErrors, upgrade `fake-indexeddb` before touching vault code). Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/data/vault.ts src/data/vault.test.ts package.json package-lock.json
git commit -m "feat(vault): envelope-encryption vault (IndexedDB KEK, AES-KW-wrapped GCM DEK)" -- src/data/vault.ts src/data/vault.test.ts package.json package-lock.json
```

---

### Task 3: Settings field mapping (`settingsVault.ts`)

**Files:**
- Create: `src/data/settingsVault.ts`
- Test: `src/data/settingsVault.test.ts`

**Interfaces:**
- Consumes: Task 2's `sealSecret`/`openSecret`; `isSealed` from Task 1; `import type { Settings } from './settings'` (**type-only import — a value import would create a cycle once settings.ts imports this module in Task 4**).
- Produces: `sealSettings(settings: Settings): Promise<Settings>`, `openSettings(settings: Settings): Promise<{ settings: Settings, hadPlaintext: boolean }>`, `secretValues(settings: Settings): string[]`.
- The four secret surfaces (spec §Integration; nothing else is touched): `providers[].apiKey`, `observability.publicKey`, `observability.secretKey`, every value of `mcp.servers[*].headers`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/data/settingsVault.test.ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetVault } from './vault'
import { isSealed } from './vaultFormat'
import { openSettings, sealSettings, secretValues } from './settingsVault'
import { defaultSettings, type Settings } from './settings'

beforeEach(async () => {
  await resetVault()
})

function sampleSettings(): Settings {
  return {
    ...defaultSettings(),
    providers: [
      { id: 'p1', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-one', models: [] },
      { id: 'p2', name: 'Local', baseURL: 'http://localhost:11434/v1', apiKey: '', models: [] },
    ],
    observability: {
      enabled: true,
      publicKey: 'pk-lf-x',
      secretKey: 'sk-lf-y',
      host: 'https://cloud.langfuse.com',
      captureContent: true,
      captureScreenshots: false,
    },
    mcp: {
      servers: {
        ctx: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer tok-123' } },
        bare: { url: 'https://bare.example.com' },
      },
    },
  }
}

describe('settingsVault', () => {
  it('secretValues enumerates exactly the four surfaces', () => {
    expect(secretValues(sampleSettings())).toEqual(['sk-one', '', 'pk-lf-x', 'sk-lf-y', 'Bearer tok-123'])
  })

  it('seals every non-empty secret and nothing else', async () => {
    const input = sampleSettings()
    const sealed = await sealSettings(input)
    expect(isSealed(sealed.providers[0].apiKey)).toBe(true)
    expect(sealed.providers[1].apiKey).toBe('')
    expect(isSealed(sealed.observability!.publicKey)).toBe(true)
    expect(isSealed(sealed.observability!.secretKey)).toBe(true)
    expect(isSealed(sealed.mcp!.servers.ctx.headers!.Authorization)).toBe(true)
    // Non-secrets untouched
    expect(sealed.providers[0].baseURL).toBe('https://api.openai.com/v1')
    expect(sealed.observability!.host).toBe('https://cloud.langfuse.com')
    expect(sealed.mcp!.servers.bare).toEqual({ url: 'https://bare.example.com' })
    // Input never mutated
    expect(input.providers[0].apiKey).toBe('sk-one')
    expect(input.mcp!.servers.ctx.headers!.Authorization).toBe('Bearer tok-123')
  })

  it('openSettings round-trips and reports plaintext presence', async () => {
    const sealed = await sealSettings(sampleSettings())
    const fromSealed = await openSettings(sealed)
    expect(fromSealed.hadPlaintext).toBe(false)
    expect(fromSealed.settings.providers[0].apiKey).toBe('sk-one')
    expect(fromSealed.settings.mcp!.servers.ctx.headers!.Authorization).toBe('Bearer tok-123')
    const fromPlain = await openSettings(sampleSettings())
    expect(fromPlain.hadPlaintext).toBe(true)
    expect(fromPlain.settings.providers[0].apiKey).toBe('sk-one')
  })

  it('handles settings with no observability and no mcp', async () => {
    const bare = defaultSettings()
    bare.observability = undefined
    const sealed = await sealSettings(bare)
    const opened = await openSettings(sealed)
    expect(opened.hadPlaintext).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/data/settingsVault.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/data/settingsVault.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/data/settingsVault.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/data/settingsVault.ts src/data/settingsVault.test.ts
git commit -m "feat(vault): seal/open mapping over Settings secret fields" -- src/data/settingsVault.ts src/data/settingsVault.test.ts
```

---

### Task 4: Wire the vault into `loadSettings`/`saveSettings` + migration

**Files:**
- Modify: `src/data/settings.ts` — only `loadSettings` (line ~331) and `saveSettings` (line ~352) plus one new private helper; touch nothing else in the file.
- Test: `src/data/settingsStorage.test.ts` (new — the existing `settings.test.ts` is pure-function tests and stays chrome-free).

**Interfaces:**
- Consumes: Task 3's `sealSettings`/`openSettings`/`secretValues`; `isSealed` from Task 1.
- Produces: unchanged public signatures — `loadSettings(): Promise<Settings>` now returns decrypted settings and self-migrates plaintext installs; `saveSettings(settings: Settings): Promise<void>` now seals before writing.

- [ ] **Step 1: Write the failing tests**

```ts
// src/data/settingsStorage.test.ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault } from './vault'
import { isSealed } from './vaultFormat'
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings'

// Minimal chrome.storage.local stub backed by a plain object — the repo's
// established per-file pattern (see src/ui/tabChats.test.ts).
function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
      },
    },
  })
  return store
}

function withKey(): Settings {
  const s = defaultSettings()
  s.providers = [{ id: 'p1', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-live-1', models: [] }]
  s.onboarded = true
  return s
}

beforeEach(async () => {
  await resetVault()
})

describe('settings storage sealing', () => {
  it('saveSettings writes sealed keys and does not mutate its input', async () => {
    const store = stubChromeStorage()
    const settings = withKey()
    await saveSettings(settings)
    const stored = store.settings as Settings
    expect(isSealed(stored.providers[0].apiKey)).toBe(true)
    expect(settings.providers[0].apiKey).toBe('sk-live-1')
  })

  it('loadSettings returns decrypted keys', async () => {
    stubChromeStorage()
    await saveSettings(withKey())
    const loaded = await loadSettings()
    expect(loaded.providers[0].apiKey).toBe('sk-live-1')
  })

  it('migrates a plaintext install in place (sealed at rest after first load)', async () => {
    const store = stubChromeStorage()
    store.settings = withKey() // simulates a pre-vault install
    const loaded = await loadSettings()
    expect(loaded.providers[0].apiKey).toBe('sk-live-1')
    const migrated = store.settings as Settings
    expect(isSealed(migrated.providers[0].apiKey)).toBe(true)
  })

  it('falls back to plaintext storage when IndexedDB is unavailable', async () => {
    const store = stubChromeStorage()
    const { _resetDekCacheForTests } = await import('./vault')
    const original = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    _resetDekCacheForTests()
    try {
      await saveSettings(withKey())
      const stored = store.settings as Settings
      expect(stored.providers[0].apiKey).toBe('sk-live-1')
      const loaded = await loadSettings()
      expect(loaded.providers[0].apiKey).toBe('sk-live-1')
    } finally {
      vi.stubGlobal('indexedDB', original)
      _resetDekCacheForTests()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/data/settingsStorage.test.ts`
Expected: the seal-related assertions FAIL (keys stored plaintext today).

- [ ] **Step 3: Implement in `src/data/settings.ts`**

Add imports at the top (beside the existing `McpSettings` type import):

```ts
import { openSettings, sealSettings, secretValues } from './settingsVault'
import { isSealed } from './vaultFormat'
```

Replace the *tail* of `loadSettings` — after the existing `settings.providers = settings.providers.map(...)` kind-migration line, replace `return settings` with:

```ts
  // Secrets are sealed at rest (see src/data/vault.ts). Open them here so every
  // consumer of Settings sees plaintext; a pre-vault install is migrated in
  // place on first load.
  const { settings: opened, hadPlaintext } = await openSettings(settings)
  if (hadPlaintext) await migrateSecretsToSealed(opened)
  return opened
```

Replace the body of `saveSettings`:

```ts
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: await sealSettings(settings) })
}
```

Add the private migration helper below `saveSettings`:

```ts
/**
 * One-way plaintext→sealed migration: seal, verify the round-trip in memory,
 * and only then overwrite the stored blob — a failed vault never destroys the
 * user's only copy of their keys. Skipped when nothing sealed (vault down);
 * the next load retries. Concurrent runs from the panel and the SW both write
 * valid ciphertext of the same plaintext, so last-writer-wins is safe.
 */
async function migrateSecretsToSealed(opened: Settings): Promise<void> {
  try {
    const sealed = await sealSettings(opened)
    if (!secretValues(sealed).some(isSealed)) return
    const roundTrip = await openSettings(sealed)
    if (JSON.stringify(secretValues(roundTrip.settings)) !== JSON.stringify(secretValues(opened))) return
    await chrome.storage.local.set({ [STORAGE_KEY]: sealed })
  } catch {
    // Migration must never break loading.
  }
}
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run src/data/settingsStorage.test.ts` → PASS, then `npm test` (all existing tests must stay green — `settings.test.ts` exercises pure functions and is unaffected), then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/data/settings.ts src/data/settingsStorage.test.ts
git commit -m "feat(vault): seal secrets through loadSettings/saveSettings with in-place migration" -- src/data/settings.ts src/data/settingsStorage.test.ts
```

---

### Task 5: Seal MCP OAuth tokens (`mcp/auth.ts`) + Sign-out check

**Files:**
- Modify: `src/mcp/auth.ts` (the `load`/`save` helpers at lines 30–39, `invalidateCredentials` at 115–122; add `hasStoredAuth` export)
- Modify: `src/ui/settings/McpSection.tsx` (~line 158 — the direct `mcpAuth:<name>` read behind the Sign-out button)
- Test: `src/mcp/auth.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `sealSecret`/`openSecret`; `isSealed` from Task 1.
- Produces: stored shape becomes `{ v: 1, sealed: 'lysec1.…' }` (whole `StoredAuth` JSON sealed as one unit); legacy plaintext `StoredAuth` objects are read transparently and resealed on next save; new export `hasStoredAuth(server: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/mcp/auth.test.ts
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault } from '../data/vault'
import { ChromeOAuthProvider, clearAuth, hasStoredAuth } from './auth'

function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
      },
    },
  })
  return store
}

const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' }

beforeEach(async () => {
  await resetVault()
})

describe('mcp auth sealing', () => {
  it('persists tokens sealed and reads them back', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    const stored = store['mcpAuth:srv'] as { v: 1; sealed: string }
    expect(stored.v).toBe(1)
    expect(stored.sealed.startsWith('lysec1.')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('at-1')
    expect(await provider.tokens()).toEqual(TOKENS)
  })

  it('reads a legacy plaintext record and reseals it on next save', async () => {
    const store = stubChromeStorage()
    store['mcpAuth:srv'] = { tokens: TOKENS }
    const provider = new ChromeOAuthProvider('srv')
    expect(await provider.tokens()).toEqual(TOKENS)
    await provider.saveCodeVerifier('pkce-1')
    const stored = store['mcpAuth:srv'] as { sealed?: string }
    expect(stored.sealed?.startsWith('lysec1.')).toBe(true)
    expect(await provider.tokens()).toEqual(TOKENS)
    expect(await provider.codeVerifier()).toBe('pkce-1')
  })

  it('hasStoredAuth understands both shapes', async () => {
    const store = stubChromeStorage()
    expect(await hasStoredAuth('srv')).toBe(false)
    store['mcpAuth:srv'] = { tokens: TOKENS }
    expect(await hasStoredAuth('srv')).toBe(true)
    const provider = new ChromeOAuthProvider('srv2')
    await provider.saveTokens(TOKENS)
    expect(await hasStoredAuth('srv2')).toBe(true)
    await clearAuth('srv2')
    expect(await hasStoredAuth('srv2')).toBe(false)
  })

  it('invalidateCredentials keeps the sealed shape', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    await provider.saveCodeVerifier('pkce-1')
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.codeVerifier()).toBe('pkce-1')
    const stored = store['mcpAuth:srv'] as { sealed?: string }
    expect(stored.sealed?.startsWith('lysec1.')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/mcp/auth.test.ts` → FAIL (`hasStoredAuth` missing; stored shape plaintext).

- [ ] **Step 3: Implement in `src/mcp/auth.ts`**

Add imports:

```ts
import { openSecret, sealSecret } from '../data/vault'
import { isSealed } from '../data/vaultFormat'
```

Add beside `StoredAuth`:

```ts
/** At-rest shape since the vault: the whole StoredAuth JSON sealed as one unit. */
interface SealedStoredAuth {
  v: 1
  sealed: string
}

function isSealedShape(value: unknown): value is SealedStoredAuth {
  return typeof value === 'object' && value !== null && typeof (value as SealedStoredAuth).sealed === 'string'
}
```

Replace `load` and `save` (keep `keyFor` and `clearAuth` as they are):

```ts
async function load(server: string): Promise<StoredAuth> {
  const key = keyFor(server)
  const data = await chrome.storage.local.get(key)
  const stored = data[key] as StoredAuth | SealedStoredAuth | undefined
  if (!stored) return {}
  if (isSealedShape(stored)) {
    const json = await openSecret(stored.sealed)
    if (json === null) return {} // lost KEK / corrupt — the user re-authorizes
    try {
      return JSON.parse(json) as StoredAuth
    } catch {
      return {} // vault down returns the sealed string verbatim → not JSON → re-auth this session
    }
  }
  return stored // legacy plaintext record — resealed by the next persist()
}

/** Write the full record, sealed. Falls back to the legacy plaintext shape when the vault is down. */
async function persist(server: string, auth: StoredAuth): Promise<void> {
  const sealed = await sealSecret(JSON.stringify(auth))
  const value: SealedStoredAuth | StoredAuth = isSealed(sealed) ? { v: 1, sealed } : auth
  await chrome.storage.local.set({ [keyFor(server)]: value })
}

async function save(server: string, patch: Partial<StoredAuth>): Promise<void> {
  const current = await load(server)
  await persist(server, { ...current, ...patch })
}
```

Add the export (below `clearAuth`):

```ts
/** Whether a server has stored tokens (drives the Sign-out button) — reads both at-rest shapes. */
export async function hasStoredAuth(server: string): Promise<boolean> {
  return Boolean((await load(server)).tokens)
}
```

In `invalidateCredentials`, replace the final line `await chrome.storage.local.set({ [keyFor(this.server)]: current })` with:

```ts
    await persist(this.server, current)
```

- [ ] **Step 4: Update `McpSection.tsx`**

Read the current code around line 158 first. Replace the direct `chrome.storage.local.get` of `` `mcpAuth:${name}` `` (and its `tokens`-presence check) with a call to `hasStoredAuth(name)` imported from `../../mcp/auth`, preserving the existing state-setting behavior around it exactly.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run src/mcp/auth.test.ts` → PASS; `npm test` → all green; `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth.ts src/mcp/auth.test.ts src/ui/settings/McpSection.tsx
git commit -m "feat(vault): seal MCP OAuth tokens at rest" -- src/mcp/auth.ts src/mcp/auth.test.ts src/ui/settings/McpSection.tsx
```

---

### Task 6: Erase-all wipes the vault; docs

**Files:**
- Modify: `src/data/storage.ts` (`eraseAllData`, line ~91)
- Modify: `CLAUDE.md` (Architecture invariants list), `CHANGELOG.md` (follow the existing entry format), `docs/superpowers/specs/2026-08-01-envelope-encryption-design.md` (future-work note)

**Interfaces:**
- Consumes: Task 2's `resetVault`.
- Produces: nothing new — wiring and documentation.

- [ ] **Step 1: Wire `resetVault` into `eraseAllData`**

In `src/data/storage.ts`, add `import { resetVault } from './vault'` and append after the `chrome.storage.local.clear()` line:

```ts
  await resetVault()
```

(Behavior: erase-all destroys ciphertext *and* the KEK, so a fresh onboarding starts from a fresh vault. Covered by Task 2's `resetVault` test; no new unit test — this line is glue.)

- [ ] **Step 2: Add the CLAUDE.md invariant**

Append this bullet to the **Architecture invariants** section of `CLAUDE.md`:

```markdown
- **Secrets are sealed at rest.** Every secret in `chrome.storage.local` — provider `apiKey`s, Langfuse keys, MCP OAuth tokens (`mcpAuth:*`), MCP `headers` values — is envelope-encrypted by the vault (`src/data/vault.ts`): a non-extractable AES-KW KEK in IndexedDB (`lychee-vault`) wraps an AES-256-GCM DEK, and sealed values are `lysec1.` strings (`src/data/vaultFormat.ts`). The seal/open boundary is `loadSettings`/`saveSettings` (via `settingsVault.ts`) plus `mcp/auth.ts` — in-memory `Settings` are always plaintext, so key-reading call sites, the offscreen research handoff, and the MCP JSON export never see sealed values. Never write a secret to storage outside those chokepoints, never persist a secret in any other record (research tasks carry provider config only in runtime messages), and never make the KEK extractable. Vault-down degrades to plaintext writes (availability of the user's own keys beats hygiene); a sealed value that no longer decrypts resolves to `''` and the user re-enters it. Design + threat model: `docs/superpowers/specs/2026-08-01-envelope-encryption-design.md`.
```

- [ ] **Step 3: CHANGELOG + spec future-work note**

Read the top entry of `CHANGELOG.md` and add a new entry in the same format describing: secrets (provider API keys, Langfuse keys, MCP OAuth tokens, MCP header values) are now envelope-encrypted at rest; existing installs migrate automatically on first load; no user action needed.

In the spec's **Future work** section, append:

```markdown
- **MCP stdio `env` values**: stdio server entries are preserved-but-unrunnable config; their
  `env` can also carry secrets and currently round-trips exports in plaintext. Sealing it was
  deliberately left out of v1 scope (approved scope was the four surfaces) — same mechanism
  applies if it graduates.
```

- [ ] **Step 4: Full verification**

Run: `npm test` → all green; `npm run typecheck` → clean; `npm run build` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/data/storage.ts CLAUDE.md CHANGELOG.md docs/superpowers/specs/2026-08-01-envelope-encryption-design.md
git commit -m "feat(vault): erase-all resets the vault; document the sealed-at-rest invariant" -- src/data/storage.ts CLAUDE.md CHANGELOG.md docs/superpowers/specs/2026-08-01-envelope-encryption-design.md
```

---

## Post-implementation verification (reviewer, not a subagent task)

End-to-end per the spec's Testing section, via the `/verify-extension` flow: build, reload the unpacked extension, onboard with a real-shaped key, confirm chat works; inspect `chrome.storage.local` from the SW console (`chrome.storage.local.get('settings')`) → every secret is a `lysec1.` string; reload the extension (fresh SW) → keys still resolve (dream/research dispatch path); an install seeded with plaintext settings migrates in place; MCP "Copy JSON" still emits plaintext headers.
