// Local-only conformance fixture. Never proxies a real MCP server or account.
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
const outDir = await mkdtemp(join(tmpdir(), 'lychee-mcp-browser-'))
await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
  outDir, target: 'es2022', minify: false,
  lib: { entry: resolve('tests/mcp-browser/main.ts'), name: 'McpSmoke', formats: ['iife'], fileName: () => 'smoke.js' },
} })
let origin
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin)
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'" })
      res.end('<!doctype html><title>MCP browser smoke</title><h1>MCP native browser verification</h1><pre>Running…</pre><script src="/smoke.js"></script>'); return
    }
    if (url.pathname === '/smoke.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(join(outDir, 'smoke.js'))); return }
    if (url.pathname.includes('/.well-known/oauth-protected-resource')) return json({ resource: `${origin}/${url.pathname.endsWith('/modern') ? 'modern' : 'protected'}`, authorization_servers: [origin] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true })
    if (url.pathname === '/authorize') {
      if (!url.searchParams.get('code_challenge') || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Missing PKCE')
      const redirect = new URL(url.searchParams.get('redirect_uri'))
      redirect.searchParams.set('state', url.searchParams.get('state')); redirect.searchParams.set('iss', origin); redirect.searchParams.set('code', 'fixture-code')
      return json({ redirect: redirect.toString() })
    }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Fixture request too large') }
    if (url.pathname === '/register') {
      const data = JSON.parse(raw)
      if (data.application_type !== 'web' || data.token_endpoint_auth_method !== 'none') throw new Error('Invalid public client registration')
      return json({ ...data, client_id: 'fixture-client' }, 201)
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(raw)
      if (!params.get('code_verifier') || ![`${origin}/protected`, `${origin}/modern`].includes(params.get('resource'))) throw new Error('Invalid token exchange')
      return json({ access_token: 'fixture-access', token_type: 'Bearer' })
    }
    if (!['/modern', '/legacy'].includes(url.pathname) || req.method !== 'POST') return json({}, 405)
    const rpc = JSON.parse(raw), modern = url.pathname === '/modern'
    const result = data => json({ jsonrpc: '2.0', id: rpc.id, result: { ...(modern ? { resultType: 'complete' } : {}), ...data } })
    if (!modern && rpc.method === 'server/discover') return json({}, 405)
    if (modern && (req.headers['mcp-method'] !== rpc.method || rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || req.headers['mcp-session-id'])) throw new Error('Invalid modern wire metadata')
    const capabilities = { tools: { listChanged: true }, resources: { subscribe: true } }
    if (rpc.method === 'server/discover') return result({ supportedVersions: ['2026-07-28'], capabilities })
    if (rpc.method === 'initialize') return result({ protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'fixture', version: '1' } })
    if (!rpc.id) { res.writeHead(202); res.end(); return }
    if (rpc.method === 'tools/list') return result({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } }, outputSchema: { type: 'object', properties: { message: { type: 'string' } } } }], ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'resources/list') return result({ resources: [{ uri: 'fixture://one', name: 'Fixture' }], ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'tools/call' && rpc.params.name === 'needs_scope') {
      if (req.headers.authorization !== 'Bearer fixture-access') {
        res.writeHead(403, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="files:write", resource_metadata="${origin}/.well-known/oauth-protected-resource/modern"` }); res.end(); return
      }
      return result({ content: [{ type: 'text', text: 'authorized' }] })
    }
    if (rpc.method === 'tools/call') return result({ content: [{ type: 'text', text: rpc.params.arguments.message }], structuredContent: { message: rpc.params.arguments.message } })
    if (rpc.method === 'subscriptions/listen') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const send = (method, params) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method, params: { ...params, _meta: { 'io.modelcontextprotocol/subscriptionId': rpc.id } } })}\n\n`)
      send('notifications/subscriptions/acknowledged', { notifications: rpc.params.notifications })
      setTimeout(() => { if (!res.destroyed) send('notifications/resources/updated', { uri: 'fixture://one' }) }, 100)
      return
    }
    return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; console.log(origin) })
