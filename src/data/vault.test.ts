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
