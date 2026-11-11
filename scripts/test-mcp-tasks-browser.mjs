/** Production extension + local MCP/model fixtures: close, complete, reopen, continue. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { build } from 'esbuild'
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-mcp-tasks-'))
const extension = path.join(temporary, 'extension')
let jobSession, sessionSeq = 0
let context, complete = false, starts = 0, polls = 0, continuations = 0
const task = () => ({ taskId: 'job-1', status: complete ? 'completed' : 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: 3600000, pollInterval: 1000 })
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (req.method !== 'POST') { res.writeHead(req.url === '/mcp' ? 405 : 200); res.end('<p>MCP task fixture</p>'); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (req.url === '/mcp') {
    if (body.method === 'server/discover') { res.writeHead(404); res.end(); return }
    if (!('id' in body)) { res.writeHead(202); res.end(); return }
    let result = {}
    if (body.method === 'initialize' && req.headers['mcp-session-id']) { res.writeHead(400); res.end('already initialized'); return }
    if (body.method === 'initialize') res.setHeader('Mcp-Session-Id', `session-${++sessionSeq}`)
    if (body.method.startsWith('tasks/')) { assert.equal(req.headers['mcp-session-id'], jobSession); assert.equal(req.headers['mcp-protocol-version'], '2025-11-25') }
    if (body.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } }, serverInfo: { name: 'fixture', version: '1' } }
    if (body.method === 'tools/list') result = { tools: [{ name: 'job', description: 'Fixture job', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }] }
    if (body.method === 'tools/call') { starts++; jobSession = req.headers['mcp-session-id']; result = { task: task() } }
    if (body.method === 'tasks/get') { polls++; result = task() }
    if (body.method === 'tasks/result') result = { content: [{ type: 'text', text: 'Durable task result' }] }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
  }
  let text = '[]', name, args
  if (body.tools?.length) {
    assert.ok(JSON.stringify(body.messages).includes('[MCP completion'), 'agent receives the completion event')
    const calls = body.messages.flatMap(m => m.tool_calls ?? [])
    if (!calls.length) continuations++
    const resultCall = calls.find(c => c.function.name === 'mcp_srv_job_task')
    const result = body.messages.find(m => m.role === 'tool' && m.tool_call_id === resultCall?.id)
    if (result) {
      assert.ok(result.content.includes('Durable task result'))
      text = 'Automatically continued after the durable MCP task finished.'
    } else if (!body.tools.some(t => t.function.name === 'mcp_srv_job_task')) {
      name = 'GetTool'; args = { names: ['mcp_srv_job_task'] }
    } else { name = 'mcp_srv_job_task'; args = { taskId: 'job-1', action: 'result' } }
  }
  const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text }
  const base = { id: 'fixture-response', created: 1, model: 'fixture' }
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    for (const choice of [{ index: 0, delta: name ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }] })) }
})
try {
  await cp('dist', extension, { recursive: true })
  await writeFile(path.join(extension, 'probe.html'), '<!doctype html><title>Task probe</title>')
  await build({ stdin: { contents: `export { getMcpManager } from './src/mcp/manager'; export { listMcpTasks, updateMcpTask } from './src/data/mcpTasks'; export { saveConversation } from './src/data/conversations';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', outfile: path.join(extension, 'probe.js') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  await context.addInitScript(() => {
    window.testDatabases = []
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = (...args) => {
      const request = open(...args)
      request.addEventListener('success', () => window.testDatabases.push(request.result))
      return request
    }
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const fixture = await context.newPage(); await fixture.goto(origin)
  let probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/probe.html`)
  await probe.evaluate(async origin => {
    window.api = await import('./probe.js')
    const settings = { providers: [{ id: 'fixture', name: 'Local fixture', kind: 'custom', baseURL: `${origin}/v1`, apiKey: 'fixture', models: ['fixture'] }], selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true, tabAccess: 'all-tabs', systemPrompt: 'Continue the original task when notified.', mcp: { servers: { srv: { url: `${origin}/mcp` } }, policies: { srv: { default: 'always' } } } }
    await chrome.storage.local.set({ settings })
    const tab = (await chrome.tabs.query({})).find(t => t.url === origin + '/')
    await chrome.storage.session.set({ tabChats: { [tab.id]: { conversationId: 'durable-chat', originKey: origin, boundAt: Date.now() } } })
    await api.saveConversation({ id: 'durable-chat', messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Run the fixture task and continue when it finishes.' }] }], history: [{ role: 'user', content: 'Run the fixture task and continue when it finishes.' }] })
    const manager = api.getMcpManager(); await manager.refresh(settings); await manager.ensureConnected('srv')
    await manager.startTool('srv', 'job', {}, 'durable-chat')
  }, origin)
  assert.equal(starts, 1)
  // Stop the creating contexts and resume against the migrated task schema.
  const cdp = await context.newCDPSession(probe)
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
  await cdp.detach()
  await probe.close() // Every initiating context is gone; only the worker remains.
  complete = true
  await new Promise(resolve => setTimeout(resolve, 1100))
  probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/probe.html`)
  await probe.evaluate(async () => { window.api = await import('./probe.js'); await chrome.runtime.sendMessage({ type: 'mcp-task.changed' }) })
  await probe.waitForFunction(async () => (await api.listMcpTasks())[0]?.ready, { timeout: 15000 })
  assert.ok(polls > 0); assert.equal(continuations, 0)
  console.log('PASS a fresh worker reads the migrated task database and completes the queued task')
  const restoredTasks = await probe.evaluate(async () => {
    await api.listMcpTasks()
    for (const db of window.testDatabases) if (db.name === 'lychee-mcp-tasks') db.close()
    return await api.listMcpTasks()
  })
  assert.equal(restoredTasks.length, 1)
  assert.equal(restoredTasks[0].task.taskId, 'job-1')
  console.log('PASS a closed task database reconnects without losing the queued completion')

  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`); await fixture.bringToFront()
  await panel.getByText('Automatically continued after the durable MCP task finished.', { exact: true }).waitFor({ timeout: 20000 })
  await probe.waitForFunction(async () => (await api.listMcpTasks())[0]?.delivered, { timeout: 15000 })
  assert.equal(continuations, 1); assert.equal(starts, 1)
  console.log('PASS reopening the chat automatically continues exactly once')
  await panel.close()
  // Simulate a crash between transcript commit and inbox acknowledgement.
  await probe.evaluate(async () => {
    const record = (await api.listMcpTasks())[0]
    await api.updateMcpTask(record.id, old => ({ ...old, delivered: false, lease: undefined }))
  })
  const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`); await fixture.bringToFront()
  await reopened.getByText('Automatically continued after the durable MCP task finished.', { exact: true }).waitFor({ timeout: 10000 })
  await new Promise(resolve => setTimeout(resolve, 5500))
  assert.equal(continuations, 1)
  console.log('PASS saved receipt prevents replay even if inbox acknowledgement was lost')
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
