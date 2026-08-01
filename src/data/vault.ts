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
    // .slice() copies into a fresh ArrayBuffer-backed view — parseSealed's
    // return type is the bare (ArrayBufferLike-generic) Uint8Array, which
    // WebCrypto's BufferSource (ArrayBufferView<ArrayBuffer>) rejects.
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv.slice() }, dek, parsed.ciphertext.slice())
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
