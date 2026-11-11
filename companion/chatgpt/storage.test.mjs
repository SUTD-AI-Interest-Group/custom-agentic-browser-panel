import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('concurrent inference refreshes once, rotates credentials atomically and sign-out clears tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lychee-auth-test-'))
  process.env.LYCHEE_CHATGPT_DIR = directory
  const { accessToken, signOut, status } = await import(`./auth.mjs?storage=${Date.now()}`)
  const original = globalThis.fetch
  let refreshes = 0
  try {
    await writeFile(join(directory, 'profile.json'), JSON.stringify({ clientId: 'issued', subject: 'account', accessToken: 'expired', refreshToken: 'old-refresh', idToken: 'identity', expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'] }))
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke' })
      if (String(url).endsWith('/revoke')) {
        assert.equal(options.body.get('token'), 'new-refresh')
        return new Response('', { status: 200 })
      }
      refreshes++
      assert.equal(options.body.get('refresh_token'), 'old-refresh')
      assert.equal(options.body.get('client_id'), 'issued')
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' })
    }
    const signal = AbortSignal.timeout(5000)
    assert.deepEqual(await Promise.all([accessToken('profile', signal), accessToken('profile', signal)]), ['new-access', 'new-access'])
    assert.equal(refreshes, 1)
    assert.equal((await stat(join(directory, 'profile.json'))).mode & 0o777, 0o600)
    assert.equal((await status('profile')).sharing, true)
    assert.equal((await signOut('profile', signal)).revoked, true)
    const saved = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))
    assert.equal(saved.clientId, 'issued')
    assert.equal(saved.accessToken, undefined)
    assert.equal(saved.refreshToken, undefined)
    assert.equal(saved.idToken, undefined)
  } finally { globalThis.fetch = original; delete process.env.LYCHEE_CHATGPT_DIR; await rm(directory, { recursive: true, force: true }) }
})
test('sign-in listens on loopback, sends PKCE/state/nonce and reuses its host ID after cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lychee-oauth-test-'))
  process.env.LYCHEE_CHATGPT_DIR = directory
  const { signIn } = await import(`./auth.mjs?login=${Date.now()}`)
  let hostId
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      await assert.rejects(signIn('profile', controller.signal, async url => {
        const authorization = new URL(url)
        assert.equal(authorization.origin, 'https://auth.openai.com')
        const query = authorization.searchParams
        assert.equal(query.get('client_id'), 'dynamic_agent_client')
        assert.equal(query.get('agent_name_hint'), 'Lychee AI')
        assert.equal(query.get('code_challenge_method'), 'S256')
        assert.ok(query.get('state') && query.get('nonce') && query.get('code_challenge'))
        const redirect = new URL(query.get('redirect_uri'))
        assert.equal(redirect.hostname, '127.0.0.1')
        assert.equal(redirect.pathname, '/auth/callback')
        assert.equal((await fetch(`${redirect}?state=wrong`)).status, 400)
        if (hostId) assert.equal(query.get('ext_agent_host_id'), hostId)
        hostId = query.get('ext_agent_host_id')
        controller.abort()
      }), /cancelled/)
    }
  } finally { delete process.env.LYCHEE_CHATGPT_DIR; await rm(directory, { recursive: true, force: true }) }
})
