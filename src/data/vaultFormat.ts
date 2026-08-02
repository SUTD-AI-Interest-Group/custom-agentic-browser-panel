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
