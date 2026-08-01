import { expect, test } from 'vitest'
import { redactSecrets } from './redact'

// Adversarial, table-driven coverage for the field-aware redaction contract
// (hardening audit d03 F5): sensitive tool-call arguments — real card numbers
// and passwords typed via AutofillForm/ControlPage — must never reach the
// Langfuse span verbatim. Two independent nets, tested separately and
// together: NAME-based (a key whose name matches a sensitive pattern) and
// SHAPE-based (a string value that looks like a card number or a secret
// token, regardless of what its key is called). A third rule covers the
// `{value|text, sensitive: true}` sibling shape shared by AutofillForm,
// ControlPage and the IndexedElement DOM registry (tools.ts / domIndex.ts).
//
// Fixture secrets are all well-known placeholders (4111111111111111 is the
// standard Visa test PAN) or obviously synthetic strings — never real-looking.

const REDACTED = '[redacted]'

// --- name-based redaction ---------------------------------------------------

test('redacts a top-level key literally named for a secret', () => {
  const out = redactSecrets({ username: 'alice', password: 'hunter2' }) as any
  expect(out.username).toBe('alice')
  expect(out.password).toBe(REDACTED)
})

test('redacts a key name that only CONTAINS a sensitive word as a substring', () => {
  const out = redactSecrets({
    userPasswordConfirm: 'hunter2',
    shippingCardNumber: '4111111111111111',
    xApiKeyHeader: 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }) as any
  expect(out.userPasswordConfirm).toBe(REDACTED)
  expect(out.shippingCardNumber).toBe(REDACTED)
  expect(out.xApiKeyHeader).toBe(REDACTED)
})

test('redacts common credential/payment key name variants case-insensitively', () => {
  const out = redactSecrets({
    PASSWD: 'x',
    Secret: 'x',
    Token: 'x',
    api_key: 'x',
    Authorization: 'x',
    Cookie: 'x',
    cvv: 'x',
    cvc: 'x',
    ssn: 'x',
    pin: 'x',
    otp: 'x',
    accountNumber: 'x',
    routingNumber: 'x',
  }) as any
  for (const k of Object.keys(out)) expect(out[k]).toBe(REDACTED)
})

test('redacts the cc/acct abbreviations used by real payment forms (audit F3)', () => {
  const out = redactSecrets({ ccNumber: '4111111111111111', 'cc-num': 'x', acctNum: 'x' }) as any
  expect(out.ccNumber).toBe(REDACTED)
  expect(out['cc-num']).toBe(REDACTED)
  expect(out.acctNum).toBe(REDACTED)
})

// --- false positives on ambiguous short substrings --------------------------
// "cc" and "account" are common in ordinary, non-sensitive field names. A
// redactor this aggressive would be worse than useless (everything goes
// dark). These lock in the word-boundary judgment call.

test('does not redact ordinary field names that merely contain "cc" or "account"', () => {
  const out = redactSecrets({
    successCount: 1,
    accessLevel: 'admin',
    occurredAt: '2026-01-01',
    accountId: 'acct_abc123',
    accountName: 'Personal',
  }) as any
  expect(out.successCount).toBe(1)
  expect(out.accessLevel).toBe('admin')
  expect(out.occurredAt).toBe('2026-01-01')
  expect(out.accountId).toBe('acct_abc123')
  expect(out.accountName).toBe('Personal')
})

// --- nesting: objects and arrays --------------------------------------------

test('redacts a sensitive key nested arbitrarily deep in objects and arrays', () => {
  const out = redactSecrets({
    step: 1,
    payload: {
      items: [
        { label: 'ok', meta: { nested: { password: 'hunter2' } } },
        { label: 'also ok', value: 'benign' },
      ],
    },
  }) as any
  expect(out.payload.items[0].meta.nested.password).toBe(REDACTED)
  expect(out.payload.items[0].label).toBe('ok')
  expect(out.payload.items[1].value).toBe('benign')
})

test('redacts a deeply nested denial payload without losing sibling structure', () => {
  const payload = {
    denied: true,
    context: {
      attempt: {
        form: {
          fields: [{ index: 0, value: 'ok', sensitive: false }, { index: 1, value: '4111111111111111', sensitive: true }],
        },
        // A leaf key ("cardNumber") name-matches, but its container ("payment")
        // and sibling ("holder") don't — this proves redaction is per-key, not
        // "the whole nearest object", except when the container key itself
        // name-matches (see the next test for that case).
        payment: { cardNumber: '4111 1111 1111 1111', holder: 'A User' },
      },
    },
  }
  const out = redactSecrets(payload) as any
  expect(out.denied).toBe(true)
  expect(out.context.attempt.form.fields[0].value).toBe('ok')
  expect(out.context.attempt.form.fields[1].value).toBe(REDACTED)
  expect(out.context.attempt.payment.cardNumber).toBe(REDACTED)
  expect(out.context.attempt.payment.holder).toBe('A User')
})

test('a container key that itself name-matches (e.g. "card") redacts its whole subtree', () => {
  // Conservative-by-design: a key literally named "card" is virtually always
  // payment data end-to-end, so the whole nested object collapses rather
  // than leaking whichever of its sub-fields happen not to match by name.
  const out = redactSecrets({ card: { number: '4111 1111 1111 1111', holder: 'A User' } }) as any
  expect(out.card).toBe(REDACTED)
})

// --- AutofillForm / ControlPage shape: sibling `sensitive` flag -------------
// The real vulnerability: `value`/`text` are generic key names that match no
// name pattern at all. The tool's own `sensitive` boolean (already computed
// by domIndex.ts for exactly this purpose) is the only signal — so a plain,
// non-card-shaped password must still be caught via that sibling flag alone.

test('redacts AutofillForm-shaped fields via the sibling sensitive flag, leaves non-sensitive fields intact', () => {
  const input = {
    fields: [
      { index: 0, value: '4111111111111111', sensitive: true },
      { index: 1, value: 'John Smith', sensitive: false },
      { index: 2, value: 'hunter2', sensitive: true }, // plain password, not card-shaped
    ],
  }
  const out = redactSecrets(input) as any
  expect(out.fields[0].value).toBe(REDACTED)
  expect(out.fields[1].value).toBe('John Smith')
  expect(out.fields[2].value).toBe(REDACTED)
  // Non-value fields survive so the trace still shows *which* field was touched.
  expect(out.fields[0].index).toBe(0)
  expect(out.fields[2].sensitive).toBe(true)
})

test('redacts a ControlPage-shaped flat spec via the sibling sensitive flag (text field)', () => {
  const spec = { action: 'type', index: 3, text: 'hunter2', clear: true, sensitive: true }
  const out = redactSecrets(spec) as any
  expect(out.text).toBe(REDACTED)
  expect(out.action).toBe('type')
  expect(out.index).toBe(3)
})

test('does not redact value/text when the sibling sensitive flag is false or absent', () => {
  const a = redactSecrets({ action: 'type', text: 'hello world', sensitive: false }) as any
  const b = redactSecrets({ action: 'scroll', direction: 'down' }) as any
  expect(a.text).toBe('hello world')
  expect(b.direction).toBe('down')
})

test('redacts the shared IndexedElement registry shape (value+sensitive) the same way', () => {
  // src/platform/domIndex.ts's IndexedElement: { value?: string; sensitive: boolean; ... }
  // reaches the model (and the span) as ControlPage's `elements` output.
  const registry = [
    { index: 0, tag: 'INPUT', name: 'Card number', value: '4111111111111111', sensitive: true, rect: {} },
    { index: 1, tag: 'INPUT', name: 'Comment', value: 'nice product', sensitive: false, rect: {} },
  ]
  const out = redactSecrets(registry) as any
  expect(out[0].value).toBe(REDACTED)
  expect(out[0].name).toBe('Card number')
  expect(out[1].value).toBe('nice product')
})

// --- value-shape redaction: payment cards -----------------------------------

test('redacts a Luhn-valid card number by shape alone, key name gives no hint', () => {
  const out = redactSecrets({ value: '4111111111111111' }) as any
  expect(out.value).toBe(REDACTED)
})

test('redacts a card number split across spaces or hyphens (formatting)', () => {
  const spaced = redactSecrets({ value: '4111 1111 1111 1111' }) as any
  const hyphenated = redactSecrets({ value: '4111-1111-1111-1111' }) as any
  expect(spaced.value).toBe(REDACTED)
  expect(hyphenated.value).toBe(REDACTED)
})

test('redacts a card-shaped number embedded inside a longer string (error message echo)', () => {
  const msg = redactSecrets('Payment failed for card 4111 1111 1111 1111: insufficient funds') as string
  expect(msg).not.toContain('4111')
  expect(msg).toContain(REDACTED)
  expect(msg).toContain('insufficient funds')
})

// --- value-shape redaction: high-entropy tokens -----------------------------

test('redacts a high-entropy secret-looking token by shape alone', () => {
  const out = redactSecrets({ value: 'sk-test-AAAAbbbb1111CCCCdddd2222EEEEffff3333' }) as any
  expect(out.value).toBe(REDACTED)
})

test('redacts a secret-looking token embedded inside a longer string', () => {
  const msg = redactSecrets(
    'Request failed with key sk-test-AAAAbbbb1111CCCCdddd2222EEEEffff3333 — try again',
  ) as string
  expect(msg).not.toContain('AAAAbbbb1111CCCCdddd2222EEEEffff3333')
  expect(msg).toContain(REDACTED)
  expect(msg).toContain('try again')
})

// --- false positives: the redaction must not cry wolf -----------------------

test('does not redact ordinary prose', () => {
  const prose =
    'The quick brown fox jumps over the lazy dog and heads back to the store for more supplies.'
  expect(redactSecrets(prose)).toBe(prose)
  expect(redactSecrets({ note: prose })).toEqual({ note: prose })
})

test('does not redact a 16-digit order id that fails the Luhn check', () => {
  // Hand-verified non-Luhn: digit-sum (with every-2nd doubled) is 64, not a
  // multiple of 10.
  const orderId = '1234567890123456'
  const out = redactSecrets({ orderId }) as any
  expect(out.orderId).toBe(orderId)
})

test('does not redact a short, low-entropy value with no sensitive key or flag', () => {
  const out = redactSecrets({ city: 'Singapore', zip: '123456', count: 42 }) as any
  expect(out.city).toBe('Singapore')
  expect(out.zip).toBe('123456')
  expect(out.count).toBe(42)
})

// --- circular references ----------------------------------------------------

test('handles a circular reference without throwing', () => {
  const obj: Record<string, unknown> = { name: 'x', password: 'hunter2' }
  obj.self = obj
  expect(() => redactSecrets(obj)).not.toThrow()
  const out = redactSecrets(obj) as any
  expect(out.password).toBe(REDACTED)
  expect(out.self).toBe('[Circular]')
})

test('handles a circular reference reached through an array', () => {
  const arr: unknown[] = [{ password: 'hunter2' }]
  arr.push(arr)
  expect(() => redactSecrets(arr)).not.toThrow()
})

// --- never throws, whatever the input ---------------------------------------

test('never throws for exotic inputs (undefined, null, functions, symbols)', () => {
  expect(() => redactSecrets(undefined)).not.toThrow()
  expect(() => redactSecrets(null)).not.toThrow()
  expect(() => redactSecrets(() => {})).not.toThrow()
  expect(() => redactSecrets(Symbol('x'))).not.toThrow()
  expect(() => redactSecrets(42)).not.toThrow()
  expect(() => redactSecrets(true)).not.toThrow()
})

// --- keys are preserved, not deleted ----------------------------------------

test('redaction preserves the key so the trace still shows call structure', () => {
  const out = redactSecrets({ password: 'hunter2' }) as any
  expect(Object.keys(out)).toContain('password')
  expect(out.password).not.toBe('hunter2')
})
