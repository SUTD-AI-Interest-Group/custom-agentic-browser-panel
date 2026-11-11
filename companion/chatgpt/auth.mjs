import { createServer } from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import lockfile from 'proper-lockfile'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export const API = 'https://api.openai.com/v1'
const AUTH = 'https://auth.openai.com'
const TOKEN = `${AUTH}/api/accounts/oauth/token`
const jwks = createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`))
const directory = process.env.LYCHEE_CHATGPT_DIR || join(homedir(), '.config', 'lychee-ai', 'chatgpt')
const random = () => randomBytes(32).toString('base64url')
export function profilePath(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid connection ID.')
  return join(directory, `${id}.json`)
}
async function read(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}
async function save(path, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
// Chrome can start one process per port (panel and offscreen research). Serialize
// rotating credentials across processes, not merely within this module.
export async function locked(id, signal, run) {
  const path = profilePath(id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 310_000
  let release
  while (!release) {
    signal?.throwIfAborted()
    try {
      release = await lockfile.lock(path, { realpath: false, stale: 30_000, update: 5_000 })
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error
      if (Date.now() > deadline) throw new Error('Another ChatGPT operation is still running. Try again.')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try { signal?.throwIfAborted(); return await run() } finally { await release() }
}
async function hostId(signal) {
  return locked('host', signal, async () => {
    const path = profilePath('host')
    const stored = await read(path)
    if (stored.hostId) return stored.hostId
    const hostId = `urn:uuid:${randomUUID()}`
    await save(path, { hostId })
    return hostId
  })
}
export function session(record) {
  return {
    connected: Boolean(record.accessToken),
    sharing: Boolean(record.accessToken && record.scopes?.includes('chatgpt.tokens.use.direct')),
    email: record.email || '',
  }
}
export async function status(id) { return session(await read(profilePath(id))) }
export function callbackResult(url, state, clientId) {
  if (url.searchParams.get('state') !== state) throw new Error('Sign-in state did not match. Try again.')
  if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined or failed. Try again when ready.')
  const issued = url.searchParams.get('client_id') || clientId
  if (!issued || issued === 'dynamic_agent_client' || (clientId && issued !== clientId)) throw new Error('ChatGPT returned an invalid client registration.')
  const code = url.searchParams.get('code')
  if (!code) throw new Error('ChatGPT did not return an authorization code.')
  return { clientId: issued, code }
}
export async function validateIdentity(token, clientId, nonce, previousSubject, keys = jwks) {
  const { payload } = await jwtVerify(token, keys, { issuer: AUTH, audience: clientId, requiredClaims: ['exp', 'sub', 'nonce', 'iat'], clockTolerance: 5 })
  if (payload.nonce !== nonce || !payload.sub || (previousSubject && payload.sub !== previousSubject)) throw new Error('ChatGPT account verification failed.')
  return payload
}
async function tokenRequest(params, signal) {
  const response = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'ChatGPT session needs a new sign-in.' : `ChatGPT sign-in service returned HTTP ${response.status}. Try again.`)
  return response.json()
}
export function credentials(data, previous = {}) {
  if (typeof data.access_token !== 'string' || !data.access_token || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('ChatGPT returned incomplete credentials.')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    idToken: data.id_token || previous.idToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/) : (previous.scopes || []),
  }
}
export async function signIn(id, signal, openBrowser) {
  const host = await hostId(signal)
  return locked(id, signal, async () => {
    const path = profilePath(id)
    const previous = await read(path)
    const state = random(), nonce = random(), verifier = random()
    let resolveCallback, rejectCallback
    const result = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
    // Attach immediately: abort can arrive while the server is starting.
    result.catch(() => {})
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return }
      // Ignore unrelated local requests without terminating the pending attempt.
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid state'); return }
      try {
        const callback = callbackResult(url, state, previous.clientId)
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end('Return to Lychee AI to finish connecting.')
        resolveCallback(callback)
      } catch (error) { res.writeHead(400).end('Sign-in did not complete. Return to Lychee AI.'); rejectCallback(error) }
    })
    const abort = () => rejectCallback(new Error('ChatGPT sign-in cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => rejectCallback(new Error('ChatGPT sign-in timed out. Try again.')), 300_000)
    try {
      signal.throwIfAborted()
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
      const query = new URLSearchParams({ client_id: previous.clientId || 'dynamic_agent_client', ext_agent_host_id: host, response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: API, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })
      if (!previous.clientId) query.set('agent_name_hint', 'Lychee AI')
      if (previous.accessToken && !previous.scopes?.includes('chatgpt.tokens.use.direct')) query.set('prompt', 'consent')
      if (previous.idToken) query.set('id_token_hint', previous.idToken)
      if (previous.email) query.set('login_hint', previous.email)
      // Only the native runtime handles this URL: it may contain an ID-token hint.
      await openBrowser(`${AUTH}/api/accounts/authorize?${query}`)
      const callback = await result
      // Keep registration even if code exchange fails or expires.
      await save(path, { ...previous, clientId: callback.clientId })
      const data = await tokenRequest({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: verifier, redirect_uri: redirectUri, resource: API }, signal)
      const identity = await validateIdentity(data.id_token, callback.clientId, nonce, previous.subject)
      const record = { clientId: callback.clientId, subject: identity.sub, email: typeof identity.email === 'string' ? identity.email : '', ...credentials(data) }
      signal.throwIfAborted()
      await save(path, record)
      return session(record)
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); server.closeAllConnections(); server.close() }
  })
}
export async function accessToken(id, signal) {
  return locked(id, signal, async () => {
    const path = profilePath(id)
    let record = await read(path)
    if (!record.accessToken) throw new Error('Sign in with ChatGPT in Settings → Providers first.')
    if (record.expiresAt < Date.now() + 60_000) {
      if (!record.refreshToken) throw new Error('ChatGPT session expired. Sign in again.')
      const data = await tokenRequest({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken, resource: API }, signal)
      // Identity belongs to the validated sign-in; a refresh does not change it.
      record = { ...record, ...credentials(data, record) }
      await save(path, record)
    }
    if (!session(record).sharing) throw new Error('ChatGPT plan usage is not enabled. Sign in again and grant plan usage.')
    return record.accessToken
  })
}
export async function signOut(id, signal) {
  return locked(id, signal, async () => {
    const path = profilePath(id), record = await read(path)
    let revoked = !record.refreshToken
    try {
      if (record.refreshToken) {
        const discovery = await fetch(`${AUTH}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
        if (!discovery.ok) throw new Error('Discovery failed')
        const endpoint = new URL((await discovery.json()).revocation_endpoint)
        if (endpoint.origin !== AUTH) throw new Error('Invalid revocation endpoint')
        for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
          try {
            const response = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }), signal: AbortSignal.timeout(10_000), redirect: 'error' })
            revoked = response.status === 200
            if (response.status < 500) break
          } catch { /* Retry once before falling back to local sign-out. */ }
          if (!revoked && attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    } catch { /* Local sign-out still clears tokens; report unconfirmed revocation. */ }
    await save(path, { clientId: record.clientId, subject: record.subject, email: record.email })
    return { ...session({}), revoked }
  })
}
