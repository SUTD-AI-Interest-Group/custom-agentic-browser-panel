/** Native browser regression: production chat UI + deterministic local model + real WebMCP.
 * npm run test:webmcp:browser (build first); optionally set CHROME_BIN and WEBMCP_RESULTS_DIR.
 * A fresh profile and temporary copy of dist keep user sessions and the build untouched.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const results = path.resolve(process.env.WEBMCP_RESULTS_DIR || path.join(root, 'test-results/webmcp'))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-webmcp-'))
const extension = path.join(temporary, 'extension')
const checks = []
const pass = name => { checks.push(name); console.log(`PASS ${name}`) }
let sequence = 0
let scenario = 'increment'
let toolResults = []
let modelRequests = 0
let serverError
const fixtureHtml = await readFile(new URL('./fixtures/webmcp.html', import.meta.url), 'utf8')

// Only the model is scripted. The app's agent loop, tool loading, approval queue,
// Chrome scripting transport, discovery, and native tool execution are real.
function modelResponse(body) {
  let name, args
  let text = 'E2E complete'
  if (body.tools?.length) {
    if (++modelRequests > 12) throw new Error('Unexpected agent tool loop')
    const messages = body.messages ?? []
    const calls = messages.flatMap(m => m.tool_calls ?? [])
    toolResults = messages.filter(m => m.role === 'tool')
    const discovered = calls.find(c => c.function.name === 'DiscoverWebMcp')
    const discovery = toolResults.find(m => m.tool_call_id === discovered?.id)
    if (!discovery) { name = 'DiscoverWebMcp'; args = {} }
    else if (!body.tools.some(t => t.function.name === 'RunWebMcp')) {
      name = 'GetTool'; args = { names: ['RunWebMcp'] }
    } else if (!calls.some(c => c.function.name === 'RunWebMcp')) {
      const snapshot = JSON.parse(discovery.content)
      const tool = snapshot.tools.find(t => t.name === scenario)
      assert.ok(tool, `Missing ${scenario} in discovery`)
      name = 'RunWebMcp'
      args = { name: tool.name, handle: tool.handle, revision: snapshot.revision, args: scenario === 'increment' ? { amount: 3 } : {}, reason: 'Native browser smoke test' }
    }
  } else text = '[]' // Welcome suggestions and title generation; never a real provider.
  const id = `smoke-${++sequence}`
  const message = name
    ? { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: text }
  return { id, name, message, text }
}
const server = http.createServer(async (request, response) => {
  try {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', '*')
    if (request.method === 'OPTIONS') { response.end(); return }
    if (!request.url.includes('/chat/completions')) {
      response.setHeader('Content-Type', 'text/html'); response.end(fixtureHtml); return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const { id, name, message, text } = modelResponse(body)
    const base = { id, created: 1, model: 'smoke' }
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream')
      const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: text }
      for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) {
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  } catch (error) {
    serverError = error
    response.writeHead(500); response.end(String(error))
  }
})
let context
let panel
let browserVersion
try {
  await mkdir(results, { recursive: true })
  await cp(path.join(root, 'dist'), extension, { recursive: true })
  // Small supplemental extension page for precise adapter timing/identity probes.
  // The UI scenarios below use dist/sidepanel.js, not this supplemental bundle.
  await build({ entryPoints: [path.join(root, 'src/platform/webmcp.ts')], outfile: path.join(extension, 'probe.js'), bundle: true, format: 'esm', target: 'es2022', minify: true })
  await writeFile(path.join(extension, 'probe.html'), '<!doctype html><title>WebMCP adapter probe</title>')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: ['--enable-features=WebMCPTesting', '--enable-blink-features=WebMCP,WebMCPTesting', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  browserVersion = context.browser().version()
  console.log(`Browser ${browserVersion}`)
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const fixture = await context.newPage()
  await fixture.goto(origin)
  await fixture.evaluate(() => window.ready)
  const probe = await context.newPage()
  await probe.goto(`chrome-extension://${extensionId}/probe.html`)
  await probe.evaluate(async () => { window.adapter = await import('./probe.js') })
  const tabId = await probe.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url.startsWith(origin)).id, origin)
  const discover = () => probe.evaluate(id => adapter.discoverWebMcp(id), tabId)
  const execute = (snapshot, name, args, timeoutMs) => probe.evaluate(async ({ tabId, snapshot, name, args, timeoutMs }) => {
    try { return { result: await adapter.executeWebMcp(tabId, snapshot, snapshot.tools.find(t => t.name === name), args, { timeoutMs }) } }
    catch (error) { return { error: error.message } }
  }, { tabId, snapshot, name, args, timeoutMs })
  const snapshot = await discover()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.tools.length, 2)
  assert.equal((await discover()).revision, snapshot.revision)
  const increment = snapshot.tools.find(t => t.name === 'increment')
  assert.equal(increment.origin, origin)
  assert.equal(increment.title, 'Increment fixture')
  assert.equal(increment.annotations.untrustedContentHint, true)
  // Browser implementations may omit draft outputSchema; preserve it if exposed.
  const native = await fixture.evaluate(async () => (await document.modelContext.getTools()).find(t => t.name === 'increment').outputSchema)
  assert.deepEqual(increment.outputSchema, native)
  pass('Native discovery, metadata, stable handles and revisions')
  assert.equal((await execute(snapshot, 'increment', { amount: 2 })).result, '{"count":2}')
  assert.equal(await fixture.locator('output').textContent(), '2')
  pass('Native mutation executes exactly once')
  const cancelled = probe.evaluate(async ({ tabId, snapshot }) => {
    const controller = new AbortController(); window.cancelInvocation = () => controller.abort()
    try { await adapter.executeWebMcp(tabId, snapshot, snapshot.tools.find(t => t.name === 'wait'), {}, { signal: controller.signal }) }
    catch (error) { return error.message }
  }, { tabId, snapshot })
  await fixture.waitForFunction(() => stats.started === 1)
  await probe.evaluate(() => cancelInvocation())
  assert.match(await cancelled, /cancelled.*do not automatically retry/)
  await fixture.waitForFunction(() => stats.aborted === 1)
  pass('Cancellation reaches the native callback despite unresolved completion')
  assert.match((await execute(snapshot, 'wait', {}, 100)).error, /timed out|TimeoutError/)
  await fixture.waitForFunction(() => stats.aborted === 2)
  pass('Adapter deadline aborts native execution')
  await fixture.evaluate(() => installIncrement('Updated fixture description'))
  assert.match((await execute(snapshot, 'increment', { amount: 9 })).error, /changed or is ambiguous/)
  assert.equal(await fixture.locator('output').textContent(), '2')
  pass('Changed metadata invalidates stale handles without mutation')
  const beforeReload = await discover()
  await fixture.reload(); await fixture.evaluate(() => window.ready)
  assert.notEqual((await discover()).documentId, beforeReload.documentId)
  assert.match((await execute(beforeReload, 'increment', { amount: 9 })).error, /The action was not executed.*Discover/)
  assert.equal(await fixture.locator('output').textContent(), '0')
  pass('Same-URL reload rejects the old document identity')

  await probe.evaluate(async origin => chrome.storage.local.set({ settings: {
    providers: [{ id: 'smoke', name: 'Local smoke', kind: 'custom', baseURL: `${origin}/v1`, apiKey: 'fixture', models: ['smoke'] }],
    selected: { providerId: 'smoke', modelId: 'smoke' }, onboarded: true, tabAccess: 'all-tabs',
    systemPrompt: 'Use WebMCP tools as requested.', toolPolicies: { DiscoverWebMcp: 'always', RunWebMcp: 'always' },
  } }), origin)
  panel = await context.newPage()
  await panel.setViewportSize({ width: 480, height: 900 })
  // Render the actual sidepanel extension page in a tab so Playwright can inspect
  // it. Keep the fixture active to preserve the normal tab-bound chat behavior.
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  await fixture.bringToFront()
  await panel.getByText('WebMCP connected', { exact: true }).waitFor()
  assert.match(await panel.locator('.webmcp-welcome').innerText(), /2 actions/)
  pass('Production welcome discovers the native fixture tools')
  async function begin(name) {
    scenario = name; toolResults = []; modelRequests = 0
    await panel.getByTitle('New chat', { exact: true }).click()
    await panel.getByPlaceholder('Ask anything…').fill(`E2E ${name}`)
    await panel.getByTitle('Send', { exact: true }).click()
    await panel.locator('.approval-card').waitFor({ timeout: 15_000 })
    assert.equal(await panel.getByRole('button', { name: 'Allow this chat', exact: true }).count(), 0)
    assert.match(await panel.locator('.approval-card').innerText(), /tool origin http:\/\/127.0.0.1/)
    // ApprovalQueue intentionally ignores clicks inside its 400 ms double-click guard.
    await new Promise(resolve => setTimeout(resolve, 450))
  }
  async function finish() {
    await panel.getByText('E2E complete', { exact: true }).waitFor({ timeout: 40_000 })
    await panel.getByTitle('Stop', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(serverError, undefined)
  }
  await begin('increment')
  await panel.screenshot({ path: path.join(results, 'approval.png') })
  await panel.getByRole('button', { name: 'Deny', exact: true }).click()
  await finish()
  assert.equal(await fixture.locator('output').textContent(), '0')
  assert.match(toolResults.at(-1).content, /User denied/)
  pass('Chat → DiscoverWebMcp → GetTool → Deny prevents mutation')
  await begin('increment')
  await panel.getByRole('button', { name: 'Allow', exact: true }).click()
  await finish()
  assert.equal(await fixture.locator('output').textContent(), '3')
  assert.match(toolResults.at(-1).content, /count/)
  pass('Chat → approval → native mutation → tool result → assistant completion')
  await begin('increment')
  await fixture.evaluate(() => installIncrement('Changed while approval is pending'))
  await panel.getByRole('button', { name: 'Allow', exact: true }).click()
  await finish()
  assert.equal(await fixture.locator('output').textContent(), '3')
  assert.match(toolResults.at(-1).content, /changed or is ambiguous/)
  pass('Approval rejects a tool changed after discovery')
  await begin('wait')
  await panel.getByRole('button', { name: 'Allow', exact: true }).click()
  await fixture.waitForFunction(() => stats.started === 1)
  await panel.locator('.approval-card').waitFor({ state: 'hidden' })
  assert.equal(await panel.getByText('Waiting for permission…', { exact: true }).count(), 0)
  await panel.screenshot({ path: path.join(results, 'running.png') })
  await panel.getByTitle('Stop', { exact: true }).click()
  await fixture.waitForFunction(() => stats.aborted === 1)
  await panel.getByTitle('Stop', { exact: true }).waitFor({ state: 'hidden' })
  pass('Production Stop aborts native execution and releases the chat')
  console.log('Checking the production 30-second deadline…')
  await begin('wait')
  await panel.getByRole('button', { name: 'Allow', exact: true }).click()
  await fixture.waitForFunction(() => stats.started === 2)
  await finish()
  await fixture.waitForFunction(() => stats.aborted === 2)
  assert.match(toolResults.at(-1).content, /timed out|TimeoutError/)
  assert.equal(await fixture.evaluate(() => stats.started), 2) // no automatic retry
  await panel.screenshot({ path: path.join(results, 'timeout.png') })
  pass('Production deadline aborts the native tool, returns uncertainty, and does not retry')
  await writeFile(path.join(results, 'report.json'), JSON.stringify({ browserVersion, native: true, model: 'deterministic local OpenAI-compatible fixture', checks }, null, 2))
  console.log(`${checks.length} browser checks passed. Results: ${results}`)
} catch (error) {
  await panel?.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await context?.close()
  server.closeAllConnections(); server.close()
  await rm(temporary, { recursive: true, force: true })
}
