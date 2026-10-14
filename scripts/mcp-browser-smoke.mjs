// Local-only conformance fixture. Never proxies a real MCP server or account.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
const outDir = await mkdtemp(join(tmpdir(), 'lychee-mcp-browser-'))
await build({ configFile: false, publicDir: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: {
  outDir, target: 'es2022', minify: false,
  lib: { entry: resolve('tests/mcp-browser/main.ts'), name: 'McpSmoke', formats: ['iife'], fileName: () => 'smoke.js' },
} })
let origin
const taskStates = new Map()
const skillText = '---\nname: review\ndescription: Review code\n---\nCheck correctness.\n'
const skill = { uri: 'skill://review/SKILL.md', frontmatter: { name: 'review', description: 'Review code' }, resources: [{ uri: 'skill://review/SKILL.md', digest: `sha256:${createHash('sha256').update(skillText).digest('hex')}`, size: Buffer.byteLength(skillText) }] }
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
    if (!['/modern', '/legacy', '/interactive'].includes(url.pathname) || req.method !== 'POST') return json({}, 405)
    const rpc = JSON.parse(raw), modern = ['/modern', '/interactive'].includes(url.pathname)
    const result = data => json({ jsonrpc: '2.0', id: rpc.id, result: { ...(modern ? { resultType: 'complete' } : {}), ...data } })
    if (!modern && rpc.method === 'server/discover') return json({}, 405)
    if (modern && (req.headers['mcp-method'] !== rpc.method || rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || req.headers['mcp-session-id'])) throw new Error('Invalid modern wire metadata')
    const capabilities = { tools: { listChanged: true }, resources: { subscribe: true }, ...(url.pathname === '/interactive' ? { extensions: { 'io.modelcontextprotocol/tasks': {}, 'io.modelcontextprotocol/skills': {} } } : {}) }
    if (rpc.method === 'server/discover') return result({ supportedVersions: ['2026-07-28'], capabilities })
    if (rpc.method === 'initialize') return result({ protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'fixture', version: '1' } })
    if (!rpc.id) { res.writeHead(202); res.end(); return }
    if (rpc.method === 'tools/list' && url.pathname === '/interactive') return result({ tools: [{ name: 'clarify', description: 'Run a harmless local clarification UI test. Asks the user to choose a city.', inputSchema: { type: 'object', properties: {} } }, { name: 'job', description: 'Start a harmless durable local test task. Completes only after the user confirms in the tasks panel.', inputSchema: { type: 'object', properties: {} } }] })
    if (rpc.method === 'tools/list') return result({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } }, outputSchema: { type: 'object', properties: { message: { type: 'string' } } } }], ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'resources/list') return result({ resources: [{ uri: 'fixture://one', name: 'Fixture' }], ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'tools/call' && rpc.params.name === 'clarify') {
      if (!rpc.params.inputResponses) return result({ resultType: 'input_required', requestState: 'opaque-fixture', inputRequests: { choice: { method: 'elicitation/create', params: { message: 'Choose the city for this fixture operation.', requestedSchema: { type: 'object', properties: { city: { type: 'string', enum: ['Singapore', 'Seoul'], title: 'City' } }, required: ['city'] } } } } })
      if (rpc.params.requestState !== 'opaque-fixture') throw Error('Lost requestState')
      return result({ content: [{ type: 'text', text: `Clarification response: ${JSON.stringify(rpc.params.inputResponses.choice)}` }] })
    }
    if (rpc.method === 'tools/call' && rpc.params.name === 'job') {
      const taskId = `fixture-${taskStates.size + 1}`
      const task = { taskId, status: 'input_required', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 3600000, pollIntervalMs: 1000, inputRequests: { confirm: { method: 'elicitation/create', params: { message: 'Confirm completing this task.', requestedSchema: { type: 'object', properties: { confirmed: { type: 'boolean', title: 'Proceed' } }, required: ['confirmed'] } } } } }
      taskStates.set(taskId, task); const { inputRequests, ...handle } = task; return result({ ...handle, resultType: 'task' })
    }
    if (rpc.method === 'tasks/get') return result(taskStates.get(rpc.params.taskId))
    if (rpc.method === 'tasks/update') {
      const task = taskStates.get(rpc.params.taskId); if (!task) throw Error('Unknown task')
      taskStates.set(task.taskId, { ...task, status: 'completed', inputRequests: undefined, result: { content: [{ type: 'text', text: 'Durable task completed after explicit user input' }] } }); return result({})
    }
    if (rpc.method === 'tasks/cancel') { const task = taskStates.get(rpc.params.taskId); taskStates.set(task.taskId, { ...task, status: 'cancelled', inputRequests: undefined }); return result({}) }
    if (rpc.method === 'skills/list') return result({ skills: [skill], ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'skills/get') return result({ skill: rpc.params.uri === skill.uri ? skill : { uri: 'skill://changed/SKILL.md', frontmatter: { name: 'changed', description: 'Changed' }, resources: [{ ...skill.resources[0], uri: 'skill://changed/SKILL.md' }] }, ttlMs: 1000, cacheScope: 'private' })
    if (rpc.method === 'resources/read') return result({ contents: [{ uri: rpc.params.uri, text: rpc.params.uri === skill.uri ? skillText : skillText.replace('Check', 'Hacks') }] })
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
