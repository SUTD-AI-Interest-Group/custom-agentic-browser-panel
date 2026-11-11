/** Production extension: modern clarification crosses the worker/panel boundary. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-merged-mcp-'))
let context, taskStarted = 0, taskUpdated = 0, clarificationCalls = 0, clarificationReply
const diagnostics = []
let taskStatus = 'working'
const skillText = '---\nname: review\ndescription: Review code\n---\nCheck the supplied code.'
const skill = { uri: 'skill://review/SKILL.md', frontmatter: { name: 'review', description: 'Review code' }, resources: [{ uri: 'skill://review/SKILL.md', digest: `sha256:${createHash('sha256').update(skillText).digest('hex')}`, size: Buffer.byteLength(skillText) }] }
const question = message => ({ message, requestedSchema: { type: 'object', properties: { city: { type: 'string', enum: ['Singapore', 'Seoul'], title: 'City' } }, required: ['city'] } })
const task = () => ({ taskId: 'modern-job', status: taskStatus, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 600_000, pollIntervalMs: 1000 })
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (req.method !== 'POST') { res.end('<title>Merged MCP fixture</title><p>Local fixture.</p>'); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (req.url === '/mcp') {
    diagnostics.push({rpc: body.method, tool: body.params?.name})
    const reply = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...data } })) }
    if (body.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/tasks': {}, 'io.modelcontextprotocol/skills': {} } } })
    if (body.method === 'tools/list') return reply({ tools: ['clarify', 'job'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) })
    if (body.method === 'resources/list') return reply({ resources: [] })
    if (body.method === 'skills/list') return reply({ skills: [skill] })
    if (body.method === 'skills/get') return reply({ skill })
    if (body.method === 'resources/read') return reply({ contents: [{ uri: skill.uri, text: skillText }] })
    if (body.method === 'tools/call' && body.params.name === 'clarify') {
      clarificationCalls++
      if (!body.params.inputResponses) return reply({ resultType: 'input_required', requestState: 'opaque', inputRequests: { city: { method: 'elicitation/create', params: question('Choose a city for the background tool.') } } })
      assert.equal(body.params.requestState, 'opaque')
      clarificationReply = body.params.inputResponses.city
      return reply({ content: [{ type: 'text', text: 'The user chose ' + clarificationReply.content.city }] })
    }
    if (body.method === 'tools/call' && body.params.name === 'job') { taskStarted++; return reply({ resultType: 'task', ...task() }) }
    if (body.method === 'tasks/get') return reply({ ...task(), ...(taskStatus === 'input_required' ? { inputRequests: { city: { method: 'elicitation/create', params: question('Confirm the task city.') } } } : taskStatus === 'completed' ? { result: { content: [{ type: 'text', text: 'Modern task complete' }] } } : {}) })
    if (body.method === 'tasks/update') { taskUpdated++; assert.equal(body.params.inputResponses.city.content.city, 'Singapore'); taskStatus = 'completed'; return reply(task()) }
    return reply({})
  }
  const firstUser = body.messages?.find(m => m.role === 'user')
  const target = JSON.stringify(firstUser).includes('task') ? 'mcp_srv_job' : 'mcp_srv_clarify'
  const calls = body.messages?.flatMap(message => message.tool_calls ?? []) ?? []
  const called = calls.find(call => call.function.name === target)
  const completed = called && body.messages.some(message => message.role === 'tool' && message.tool_call_id === called.id)
  let name, args, text = '[]'
  if (body.tools?.length) {
    if (completed) text = target === 'mcp_srv_job' ? 'Task queued successfully.' : 'Clarification complete.'
    else if (!body.tools.some(tool => tool.function.name === target)) { name = 'GetTool'; args = { names: [target] } }
    else { name = target; args = {} }
  }
  diagnostics.push({model: name ?? text, tools: body.tools?.map(t => t.function.name)})
  const base = { id: 'fixture', model: 'fixture', created: 1 }
  const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text }
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: text }
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] })) }
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, extension = path.resolve('dist')
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).host
  const fixture = await context.newPage(); await fixture.goto(origin)
  let panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.evaluate(async origin => chrome.storage.local.set({ settings: {
    providers: [{ id: 'fixture', name: 'Fixture', kind: 'custom', baseURL: `${origin}/v1`, apiKey: 'fixture', models: ['fixture'] }],
    selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true, tabAccess: 'all-tabs', systemPrompt: 'Use the requested tool.',
    mcp: { servers: { srv: { url: `${origin}/mcp` } }, policies: { srv: { default: 'always' } } },
  } }), origin)
  await panel.reload(); await fixture.bringToFront()
  let visible = panel.locator('.view-host:not(.is-hidden)')
  await visible.getByPlaceholder('Ask anything…').fill('Test clarification')
  await visible.getByPlaceholder('Ask anything…').press('Enter')
  await visible.getByRole('region', { name: 'Clarification from srv' }).waitFor({ timeout: 30_000 })
  assert.equal(clarificationReply, undefined)
  await panel.close()
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`); await fixture.bringToFront()
  visible = panel.locator('.view-host:not(.is-hidden)')
  const form = visible.getByRole('region', { name: 'Clarification from srv' })
  await form.waitFor({ timeout: 15_000 })
  await form.getByLabel('City (required)').selectOption({ label: 'Seoul' })
  await form.getByRole('button', { name: 'Send response to srv', exact: true }).click()
  await visible.getByText('Clarification complete.', { exact: false }).waitFor({ timeout: 30_000 })
  assert.equal(clarificationReply.content.city, 'Seoul'); assert.equal(clarificationCalls, 2)
  console.log('PASS background MCP clarification survives panel closure and resumes once with the explicit user response')
  await panel.getByTitle('New chat', { exact: true }).click()
  await visible.getByPlaceholder('Ask anything…').fill('Start a task')
  await visible.getByPlaceholder('Ask anything…').press('Enter')
  await visible.getByText('Task queued successfully.', { exact: false }).waitFor({ timeout: 30_000 })
  taskStatus = 'input_required'
  const tasks = visible.locator('.mcp-task-panel')
  await tasks.locator('summary').click()
  await tasks.getByRole('button', { name: 'Respond', exact: true }).click({ timeout: 15_000 })
  await visible.getByRole('region', { name: 'Clarification from srv' }).getByLabel('City (required)').selectOption({ label: 'Singapore' })
  await visible.getByRole('button', { name: 'Send response to srv', exact: true }).click()
  await tasks.getByText('completed', { exact: false }).waitFor({ timeout: 15_000 })
  assert.equal(taskStarted, 1); assert.equal(taskUpdated, 1)
  console.log('PASS modern task persistence, polling, explicit input and completion without replaying creation')
  await panel.getByTitle('Library', { exact: true }).click()
  await panel.getByRole('tab', { name: 'Skills', exact: true }).click()
  await panel.getByRole('button', { name: 'Discover skills from srv' }).click()
  await panel.getByRole('button', { name: 'Load in chat…' }).click()
  await panel.waitForFunction(() => document.querySelector('.view-host:not(.is-hidden) textarea')?.value.includes('ReadMcpSkill'))
  assert.match(await visible.getByPlaceholder('Ask anything…').inputValue(), /ReadMcpSkill/)
  console.log('PASS remote skill discovery and draft transfer survive controlled Library navigation')
  await panel.waitForFunction(async () => !(await chrome.offscreen.hasDocument()), { timeout: 15_000 })
  console.log('PASS offscreen host releases after interactive modern MCP work completes')
} catch (error) {
  console.log('DIAGNOSTIC', JSON.stringify(diagnostics))
  for (const page of context?.pages() ?? []) if (page.url().includes('sidepanel')) console.log('PANEL', (await page.locator('body').innerText()).slice(-8000))
  throw error
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
