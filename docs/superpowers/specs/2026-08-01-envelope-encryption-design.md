# Envelope encryption for secrets at rest

**Date:** 2026-08-01 · **Status:** Approved (KEK model: device-bound silent; scope: all four secret surfaces)

## Summary

Lychee stores every user secret in plaintext inside `chrome.storage.local` — provider API keys
(`Settings.providers[].apiKey`), Langfuse keys (`Settings.observability.publicKey/secretKey`),
MCP OAuth tokens (`mcpAuth:<server>`), and any bearer tokens users paste into MCP server
`headers`. Chrome persists that store as unencrypted LevelDB files on disk, so any process with
user-level filesystem access can lift the keys (the exact failure mode disclosed against the
Claude for Chrome extension in 2026). This design adds **envelope encryption**: a random data
key (DEK) encrypts each secret field, and a device-bound key-encryption key (KEK) wraps the
DEK. The whole change hides behind the existing `loadSettings()`/`saveSettings()` and MCP-auth
`load()`/`save()` chokepoints — no call site, UI surface, or message flow changes.

## Threat model (honest)

| Threat | Today | After |
|---|---|---|
| Web pages / other extensions reading Lychee's storage | Already blocked by Chrome's per-extension partitioning | Unchanged |
| Malware / other OS processes reading Chrome's LevelDB or IndexedDB files off disk | **All keys readable in plaintext** | Ciphertext only; the KEK is a non-extractable `CryptoKey` whose raw bytes never exist outside the browser's key store |
| Accidental export (MCP "Copy JSON"/"Edit JSON" round-trips `headers` values) | Pasted bearer tokens leave the extension in plaintext at rest | At rest sealed; explicit user exports still emit the standard plaintext `mcpServers` JSON (see Integration) |
| Code running inside the extension origin (compromised update / dependency), DevTools on an extension page | Full access | **Full access — unchanged.** Non-extractability restricts export, not use. No backend and no OS keychain means the JS-origin boundary is the only boundary. This is a documented non-goal. |

## Non-goals

- Protection from the extension's own origin (see above).
- A passphrase/unlock UX. The wrapped-DEK format is deliberately shaped so an opt-in "App
  Lock" (PBKDF2-derived second KEK wrapping the *same* DEK) can be added later without
  migration, but v1 ships zero-friction. Background features require this: dreaming runs from
  a service-worker alarm and research runs in the offscreen host with no user present.
- Encrypting non-secret settings, conversations, memories, or screenshots.

## Architecture

### Keys

- **KEK** — AES-KW, 256-bit, generated once per install via
  `crypto.subtle.generateKey({name:'AES-KW', length:256}, /*extractable*/ false, ['wrapKey','unwrapKey'])`.
  Persisted by structured clone into IndexedDB. Non-extractable: no JS in the origin can ever
  read its bytes; disk copies of the IndexedDB backing store contain an opaque key record.
- **DEK** — AES-GCM, 256-bit, generated once (`extractable: true`, required by `wrapKey`),
  immediately wrapped under the KEK with **AES-KW (NIST SP 800-38F; no IV, deterministic)**,
  then discarded. At runtime it is recovered via `unwrapKey(..., /*extractable*/ false)` — the
  working DEK is itself non-extractable. The unwrapped DEK is cached in a module-level closure
  per context (never in any `chrome.storage` area).

### Vault store (IndexedDB)

Database `lychee-vault`, version 1, one object store `vault`:

| key | value |
|---|---|
| `kek` | the non-extractable `CryptoKey` (structured clone) |
| `dek` | `ArrayBuffer` — the AES-KW-wrapped DEK |

Both records are created inside a **single readwrite transaction** using read-then-create-if-
absent. IndexedDB serializes readwrite transactions on a store, so two contexts (side panel +
service worker) racing at first run cannot each mint a KEK and orphan the other's ciphertext.
Both keys live in IndexedDB (not "wrapped DEK beside ciphertext in storage.local") precisely
to get this atomicity; the data is device-bound anyway, so portability of the wrapped DEK buys
nothing.

### Sealed-field format

Secrets are sealed **field-level**, not blob-level — the settings object stays diffable and
`storage.onChanged` consumers keep working. A sealed value is a self-describing string:

```
lysec1.<base64url(iv)>.<base64url(ciphertext‖tag)>
```

- AES-256-GCM under the DEK; fresh random 96-bit IV per encryption call (never reused —
  OWASP ASVS 11.3.4); 128-bit tag (both per NIST SP 800-38D / Web Crypto defaults).
- The `lysec1` version prefix is the crypto-agility hook (ASVS 11.2.2): the open path branches
  on the recorded version, so parameters can change under `lysec2` with old values still
  readable. No AAD in v1; a future version can add it behind a version bump.
- A value **without** the prefix is legacy plaintext (see Migration). The collision risk of a
  real API key beginning with `lysec1.` is accepted and documented.

### Module layout

- `src/data/vaultFormat.ts` — **pure**: serialize/parse/detect `lysec1.` strings, version
  handling. No WebCrypto, no Chrome. Unit-tested.
- `src/data/vault.ts` — the vault: IndexedDB KEK/DEK lifecycle (`ensureVault`), DEK cache,
  `sealSecret(plain): Promise<string>`, `openSecret(sealed): Promise<string | null>`
  (`null` = undecryptable), `resetVault()` (deletes the DB; for erase-all). WebCrypto is real
  in vitest/Node; IndexedDB is faked with the `fake-indexeddb` dev dependency.
- `src/data/settingsVault.ts` — maps seal/open over the secret fields of a `Settings` object:
  `providers[].apiKey`, `observability.publicKey`, `observability.secretKey`, and every value
  of `mcp.servers[*].headers`. Always returns a **new** object — the caller's in-memory
  settings (plaintext) are never mutated by a save.

## Integration

- `saveSettings()` seals a copy, then writes. `loadSettings()` opens every sealed field and
  returns fully-plaintext in-memory `Settings` — all ~13 existing key-reading call sites
  across the side panel, service worker, and offscreen flow are untouched. The offscreen host
  keeps receiving a decrypted `ProviderConfig` via the existing internal runtime message.
- `src/mcp/auth.ts`: `StoredAuth` is sealed as one unit — stored shape becomes
  `{v: 1, sealed: 'lysec1.…'}`; the legacy shape (has `tokens`/`clientInformation` at top
  level) is detected, opened, and re-sealed on next save. `McpSection.tsx`'s direct
  `mcpAuth:<server>` read (the "Sign out" presence check) must go through a helper that
  understands both shapes.
- MCP export/copy/edit (`serializeMcpJson`) reads the **in-memory** decrypted settings, so the
  standard `mcpServers` JSON contract is preserved byte-for-byte with zero special-casing.
  Sealing applies only at rest.
- `eraseAllData()` additionally calls `resetVault()`.
- **Integration checklist for the implementer** (verify, don't assume):
  - `src/background.ts:80` `onChanged` listener only reads `dreamIntervalMs` — unaffected.
  - `src/agent/observability/observer.ts` fingerprints `host|publicKey|secretKey`; confirm it
    reads via `loadSettings`/config resolution (decrypted), not raw `changes` values. Fresh
    IVs mean sealed bytes change on every save even when the secret didn't — an invalidation
    false-positive is harmless, but confirm nothing *stores* the raw changed value.
  - Confirm `src/data/researchTasks.ts` never persists a `ProviderConfig` (key included) into
    `chrome.storage`; if any task record does, that is in scope and must be sealed too.

## Migration & failure modes

- **Plaintext → sealed:** on `loadSettings()`, if any secret field lacks the `lysec1.` prefix
  and the vault is available: seal every plaintext field, **round-trip-verify in memory**
  (open each sealed value and compare to the original), and only then write back. Two contexts
  migrating concurrently both write valid ciphertext of the same plaintext — last-writer-wins
  is safe. The plaintext-read fallback stays permanently (it *is* the format detection), so a
  user rolling the extension back to a pre-vault version only loses keys saved after the
  rollback boundary — and forward-upgrading re-migrates whatever is plaintext.
- **Vault unavailable** (IndexedDB broken/blocked): `loadSettings` passes values through
  as stored; `saveSettings` falls back to plaintext write with a one-time `console.warn`.
  Availability of the user's own keys beats at-rest hygiene — never brick key storage.
- **Undecryptable sealed value** (KEK lost — e.g. vault DB deleted — or corrupted blob):
  `openSecret` returns `null`; the field resolves to `''`. The UI naturally shows an empty
  key field and the user re-enters the key. One `console.warn`, no crash, no throw out of
  `loadSettings`.

## Standards mapping

| Requirement | How met |
|---|---|
| NIST SP 800-38D (AES-GCM) | 96-bit random IV, 128-bit tag, fresh IV per call |
| NIST SP 800-38F (key wrap) | DEK wrapped with AES-KW |
| NIST SP 800-57 (key mgmt) | KEK/DEK separation; rotation = re-wrap 40 bytes, not re-encrypt data; this doc is the documented lifecycle (ASVS 11.1.1) |
| OWASP ASVS 11.2.2 (agility) | `lysec1` version prefix; MetaMask `keyMetadata` precedent |
| OWASP ASVS 11.3.2/11.3.4 | Approved AEAD mode; IV uniqueness per (key, element) |
| OWASP ASVS 11.5.1 | All randomness from `crypto.getRandomValues`/`generateKey` |
| FIPS 140-3 | Every primitive rides Chrome's WebCrypto (BoringCrypto module, cert #5104). Deliberately **no** WASM Argon2 — OWASP's PBKDF2-SHA256 ≥600k path is the FIPS-compatible choice reserved for the future App Lock |

## Testing

- Unit (vitest, real WebCrypto, `fake-indexeddb`): format round-trip/malformed-input;
  seal→open round-trip; concurrent `ensureVault` yields one KEK; unwrapped DEK is
  non-extractable; tampered ciphertext/wrong-KEK → `null`; settings mapping seals exactly the
  four surfaces and never mutates its input; migration seals-verifies-writes and passes
  through when the vault is down.
- End-to-end (`/verify-extension` flow): build, reload, onboard with a real-shaped key, chat
  works; inspect `chrome.storage.local` from the SW console → only `lysec1.` strings; reload
  extension (new SW) → dream/research dispatch still resolves keys; existing plaintext install
  upgrades in place.

## Future work (explicitly out of v1)

- **App Lock**: opt-in passphrase KEK (PBKDF2-HMAC-SHA256, ≥600k iterations, 16-byte salt)
  as a *second* wrap of the same DEK; device wrap removed only when the user opts into
  lock-required mode.
- **WebAuthn PRF** KEK (Chrome 122+): needs a feasibility spike from the side panel first.
