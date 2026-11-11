import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, SignJWT } from 'jose'
import { callbackResult, validateIdentity, credentials, session, profilePath } from './auth.mjs'
import { responseBody, visibleModels, CompletionReader, request } from './inference.mjs'

test('callbacks reject CSRF, denial, missing codes, and swapped registrations', () => {
  const url = query => new URL(`http://127.0.0.1/auth/callback?${query}`)
  assert.throws(() => callbackResult(url('state=wrong&code=x&client_id=issued'), 's'))
  assert.throws(() => callbackResult(url('state=s&error=access_denied'), 's'))
  assert.throws(() => callbackResult(url('state=s&code=x'), 's'))
  assert.throws(() => callbackResult(url('state=s&client_id=issued'), 's'))
  assert.throws(() => callbackResult(url('state=s&code=x&client_id=other'), 's', 'issued'))
  assert.deepEqual(callbackResult(url('state=s&code=x&client_id=issued'), 's'), { code: 'x', clientId: 'issued' })
  assert.deepEqual(callbackResult(url('state=s&code=x'), 's', 'issued'), { code: 'x', clientId: 'issued' })
})
test('identity requires signature, issuer, audience, expiry, nonce and matching account', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const sign = (claims = {}) => new SignJWT({ sub: 'account', nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setIssuer('https://auth.openai.com').setAudience('issued').setExpirationTime('5m').sign(privateKey)
  const token = await sign()
  assert.equal((await validateIdentity(token, 'issued', 'nonce', 'account', publicKey)).sub, 'account')
  await assert.rejects(validateIdentity(token, 'wrong-client', 'nonce', 'account', publicKey))
  await assert.rejects(validateIdentity(token, 'issued', 'wrong-nonce', 'account', publicKey))
  await assert.rejects(validateIdentity(token, 'issued', 'nonce', 'other-account', publicKey))
  const other = await generateKeyPair('RS256')
  await assert.rejects(validateIdentity(token, 'issued', 'nonce', 'account', other.publicKey))
  for (const [issuer, expiry] of [['https://attacker.invalid', '5m'], ['https://auth.openai.com', '-1m']]) {
    const bad = await new SignJWT({ sub: 'account', nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setIssuer(issuer).setAudience('issued').setExpirationTime(expiry).sign(privateKey)
    await assert.rejects(validateIdentity(bad, 'issued', 'nonce', 'account', publicKey))
  }
})
test('identity-only grants cannot enable usage; session DTO never returns credentials', () => {
  const record = credentials({ access_token: 'secret', token_type: 'Bearer', expires_in: 300, scope: 'openid email' })
  assert.equal(session(record).sharing, false)
  assert.equal(JSON.stringify(session(record)).includes('secret'), false)
  assert.equal(session({ ...record, scopes: ['chatgpt.tokens.use.direct'] }).sharing, true)
  assert.throws(() => credentials({ access_token: 'x', expires_in: 300 }))
  assert.throws(() => profilePath('../../tokens'))
})
test('refresh replaces rotating credentials and honors downgraded scopes', () => {
  const old = { refreshToken: 'old', scopes: ['chatgpt.tokens.use.direct'], idToken: 'identity' }
  const next = credentials({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 300, scope: 'openid' }, old)
  assert.equal(next.refreshToken, 'rotated')
  assert.equal(session(next).sharing, false)
  assert.deepEqual(credentials({ access_token: 'new', token_type: 'Bearer', expires_in: 300 }, old).scopes, old.scopes)
})
test('model catalog keeps visible slugs, display names and service order', () => {
  assert.deepEqual(visibleModels({ models: [
    { slug: 'z-model', display_name: 'Z Model', visibility: 'list' },
    { slug: 'hidden', visibility: 'hide' },
    { slug: 'a-model', visibility: 'list' },
  ] }), [{ id: 'z-model', displayName: 'Z Model' }, { id: 'a-model', displayName: 'a-model' }])
})
test('all requests force nonstored streaming and reject server-side conversation state', () => {
  assert.deepEqual(responseBody({ model: 'available-model', store: true, stream: false }), { model: 'available-model', store: false, stream: true })
  assert.throws(() => responseBody({ model: 'm', previous_response_id: 'resp_old' }))
  assert.throws(() => responseBody({ model: 'm', background: true }))
})
test('stream completion survives fragmented SSE and rejects truncation/failure', () => {
  const reader = new CompletionReader()
  const sse = 'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
  for (const char of sse) reader.push(char)
  assert.equal(reader.finish().status, 'completed')
  assert.throws(() => new CompletionReader().finish(), /before response.completed/)
  for (const type of ['response.failed', 'response.incomplete', 'error']) assert.throws(() => new CompletionReader().push(`data: {"type":"${type}"}\n\n`))
})
test('HTTP boundary pins the endpoint, attaches bearer only there and explains usage limits', async () => {
  const original = globalThis.fetch
  try {
    let captured
    globalThis.fetch = async (url, options) => { captured = { url, options }; return new Response('{}') }
    await request('/responses', 'secret', AbortSignal.timeout(1000), { model: 'm', stream: false, store: true })
    assert.equal(captured.url, 'https://api.openai.com/v1/responses')
    assert.equal(captured.options.headers.Authorization, 'Bearer secret')
    assert.deepEqual(JSON.parse(captured.options.body), { model: 'm', stream: true, store: false })
    await assert.rejects(request('https://attacker.invalid', 'secret', AbortSignal.timeout(1000)))
    globalThis.fetch = async () => new Response('', { status: 429 })
    await assert.rejects(request('/models', 'secret', AbortSignal.timeout(1000)), /Manage usage/)
  } finally { globalThis.fetch = original }
})
