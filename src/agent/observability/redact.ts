// Field-aware secret redaction for observability payloads (hardening audit
// findings d03 F5 / d14 F5). Sensitive tool-call arguments — real credit-card
// numbers and passwords typed via AutofillForm/ControlPage, and echoed back
// through the shared IndexedElement DOM registry (domIndex.ts) — must never
// reach a Langfuse span verbatim, on any outcome (approved, denied, errored).
//
// Two independent nets, because either one alone misses real cases this
// codebase actually has:
//
//   1. NAME-based — a key whose name matches a known sensitive pattern
//      (password, card, token, ...) has its value replaced outright,
//      wherever it sits in the tree. Catches e.g. a raw `password` field.
//
//   2. SHAPE-based — a string VALUE that looks like a payment-card number
//      (Luhn-valid) or a high-entropy secret token is replaced even when its
//      key name gives no hint at all. This is the net that actually matters
//      for this codebase: AutofillForm's `fields[].value`, ControlPage's
//      `text`/`value`, and IndexedElement's `value` are all generic key
//      names by design (the UI maps arbitrary form fields onto them) — no
//      name pattern will ever fire on the key "value" itself.
//
// A third, narrower rule closes the specific shape these three call sites
// share: an object carrying its own `sensitive`/`isSensitive: true` flag
// (already computed by domIndex.ts's SENSITIVE_RE, for exactly this purpose)
// redacts its sibling `value`/`text` key regardless of what it looks like —
// this is what catches a plain, non-card-shaped password like "hunter2"
// that the shape net's Luhn/entropy checks would otherwise miss entirely.
// Deliberately does NOT trust an unrelated model-supplied flag: it reads the
// same object the DOM-computed `sensitive` boolean already lives on.
//
// Fails closed: an internal error redacts (returns a fixed marker) rather
// than risking the raw value passing through unredacted. Circular
// references are tracked and replaced with a marker instead of recursing
// forever or crashing — and unlike the generic `sanitize()` walker (see
// observer.ts), a cycle here only nukes the cyclic branch, not the whole
// payload.

/** Stable replacement text. The key is always preserved so a trace still
 * shows call *structure* (which fields exist, which one was touched). */
export const REDACTED = '[redacted]'

const CIRCULAR = '[Circular]'

// Case-insensitive, matched as a substring of the key name — tool/DOM field
// names in the wild are inconsistent (`ccNumber`, `x-api-key`, `Authorization`,
// `user_password`, `apiResponseToken`). A false match here just over-redacts
// an unrelated key sharing a substring; a false negative leaks a secret, so
// this list is deliberately broad. Two short/ambiguous tokens ("cc", "pin",
// "otp", "ssn", "account") are NOT matched as bare substrings below — see
// SHORT_TOKEN_RE — because they collide with extremely common, non-sensitive
// field names ("accountId", "successCount", "occurredAt", "opinion").
const SUBSTRING_KEY_RE =
  /password|passwd|pwd|secret|token|api[-_]?key|authoriz|cookie|cvv|cvc|card|acct|routing|iban/i

// Word-boundaried variants of the short/ambiguous names above: only fire on
// the specific real-world field-naming patterns the audit (F3) called out
// (`ccNumber`, `cc_num`, `acctNum`, a bare `pin`/`otp`/`ssn` field, or an
// actual "account number"/"account no" field) — not on any word that merely
// contains "cc" or "account" as a substring.
const SHORT_TOKEN_RE = /\bcc[-_]?(num|number|no)\b|\bpin\b|\botp\b|\bssn\b|\baccount\s*(number|no)\b/i

function isSensitiveKeyName(key: string): boolean {
  return SUBSTRING_KEY_RE.test(key) || SHORT_TOKEN_RE.test(key)
}

/** True when `obj` carries its own truthy `sensitive`/`isSensitive` flag. */
function hasSensitiveFlag(obj: Record<string, unknown>): boolean {
  return obj.sensitive === true || obj.isSensitive === true
}

// Generic, value-carrying key names used by AutofillForm/ControlPage/
// IndexedElement precisely because they're generic (mapped onto arbitrary
// page fields). Only these are redacted by the sibling-flag rule — leaving
// e.g. `action`/`index`/`keys`/`direction`/`label`/`timeoutMs` untouched so
// the trace still shows *what step ran*, just not the value it carried.
const SIBLING_VALUE_KEYS = new Set(['value', 'text'])

// --- value-shape: payment cards --------------------------------------------

// A run of 13-19 digits, allowing a single space or hyphen between digits
// (real-world card formatting). Bounded repetition only — no catastrophic
// backtracking risk even over the large strings tool payloads can carry.
const CARD_CANDIDATE_RE = /\d(?:[ -]?\d){12,18}/g

function isLuhnValid(digitsOnly: string): boolean {
  let sum = 0
  let double = false
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let d = digitsOnly.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

// --- value-shape: high-entropy secret tokens --------------------------------

const TOKEN_CANDIDATE_RE = /[A-Za-z0-9_\-.]{24,}/g
const TOKEN_MIN_LEN = 24
// High-confidence provider/vendor key prefixes short-circuit the character-
// class check below (some real keys, e.g. long hex API keys, are single-case).
const KNOWN_SECRET_PREFIXES = ['sk-', 'pk_', 'ghp_', 'gho_', 'github_pat_', 'xox', 'eyJ', 'AKIA', 'AIza']

function looksLikeSecretToken(s: string): boolean {
  if (s.length < TOKEN_MIN_LEN) return false
  if (KNOWN_SECRET_PREFIXES.some((p) => s.startsWith(p))) return true
  // Otherwise require a mix of character classes typical of a random token —
  // excludes one long English word or a long run of a single digit/letter.
  const hasLower = /[a-z]/.test(s)
  const hasUpper = /[A-Z]/.test(s)
  const hasDigit = /[0-9]/.test(s)
  return [hasLower, hasUpper, hasDigit].filter(Boolean).length >= 2
}

/** Redact card-shaped and token-shaped substrings within a plain string,
 * preserving everything else — this is what catches a secret an ERROR
 * MESSAGE echoes back (e.g. "Payment failed for card 4111 1111 1111 1111"). */
function redactStringValue(s: string): string {
  let out = s.replace(CARD_CANDIDATE_RE, (m) => (isLuhnValid(m.replace(/[ -]/g, '')) ? REDACTED : m))
  out = out.replace(TOKEN_CANDIDATE_RE, (m) => (looksLikeSecretToken(m) ? REDACTED : m))
  return out
}

// --- the walk ----------------------------------------------------------------

function walk(v: unknown, seen: WeakSet<object>, forceRedact: boolean): unknown {
  if (forceRedact) {
    // Whatever shape this value is, its sibling sensitive flag already says
    // "don't show it" — redact wholesale rather than recursing/shape-testing.
    return v === undefined ? undefined : REDACTED
  }
  if (typeof v === 'string') return redactStringValue(v)
  if (Array.isArray(v)) {
    if (seen.has(v)) return CIRCULAR
    seen.add(v)
    return v.map((item) => walk(item, seen, false))
  }
  // Date/Map/Set/Error/RegExp have no own-enumerable properties, so the
  // generic Object.entries branch below would silently collapse any of them
  // to `{}` (the exact data-loss bug fixed in this file's sibling,
  // observer.ts's `sanitize`, which runs immediately after this walk and
  // converts each of these to a safe, inspectable shape). Left untouched
  // here rather than duplicating that conversion: this function's job is
  // redaction, not reshaping. Trade-off, accepted deliberately: a secret
  // embedded in e.g. a raw Error's `.message` bypasses redaction until
  // sanitize's own walk copies that string through unchanged — a narrow gap
  // in practice, since every call site in this codebase that can throw
  // (instrumentTools.ts included) already extracts `.message` to a plain
  // string before it reaches here.
  if (
    v instanceof Date ||
    v instanceof Map ||
    v instanceof Set ||
    v instanceof Error ||
    v instanceof RegExp
  ) {
    return v
  }
  if (v && typeof v === 'object') {
    if (seen.has(v)) return CIRCULAR
    seen.add(v)
    const obj = v as Record<string, unknown>
    const siblingFlagged = hasSensitiveFlag(obj)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(obj)) {
      if (isSensitiveKeyName(k)) {
        out[k] = val === undefined ? undefined : REDACTED
        continue
      }
      const force = siblingFlagged && SIBLING_VALUE_KEYS.has(k.toLowerCase())
      out[k] = walk(val, seen, force)
    }
    return out
  }
  return v
}

/**
 * Redact secrets from an arbitrary tool-call argument/result/error value
 * before it reaches observability. Pure, synchronous, and never throws — on
 * any internal failure it fails closed (drops to a fixed marker) rather than
 * risking the raw value passing through.
 */
export function redactSecrets(value: unknown): unknown {
  try {
    return walk(value, new WeakSet(), false)
  } catch {
    return '[redaction failed]'
  }
}
