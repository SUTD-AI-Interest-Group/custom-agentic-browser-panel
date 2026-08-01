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
