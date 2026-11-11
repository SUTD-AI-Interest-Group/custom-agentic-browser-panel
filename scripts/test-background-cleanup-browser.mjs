/** Real offscreen lifecycle with concurrent, cancellable local model calls. */
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-cleanup-'))
let context, requests = 0
const responses = new Set()
const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', '*')
  if (request.method === 'OPTIONS') { response.end(); return }
  if (!request.url.includes('/chat/completions')) { response.end('<title>Cleanup fixture</title>'); return }
  for await (const _ of request) { /* drain local fixture input */ }
  requests++
  responses.add(response)
  response.on('close', () => responses.delete(response))
  // Intentionally pending until the extension cancels it.
})
async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out: ${label}`)
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const extension = path.resolve('dist')
  context = await chromium.launchPersistentContext(temporary, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).host
  await worker.evaluate(async origin => chrome.storage.local.set({ settings: {
    providers: [{ id: 'fixture', name: 'Fixture', kind: 'custom', baseURL: `${origin}/v1`, apiKey: 'fixture', models: ['fixture'] }],
    selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true,
  } }), origin)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  const send = message => panel.evaluate(message => chrome.runtime.sendMessage(message), message)
  for (const taskId of ['cleanup-one', 'cleanup-two']) {
    await send({ type: 'research.ensureAndStart', taskId, question: 'Find evidence for this local fixture', conversationId: 'cleanup' })
  }
  await until(() => requests >= 2, 'both research model calls')
  assert.equal(await worker.evaluate(() => chrome.offscreen.hasDocument()), true)
  await send({ type: 'research.cancel', taskId: 'cleanup-one' })
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(await worker.evaluate(() => chrome.offscreen.hasDocument()), true)
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('researchTasks')).researchTasks['cleanup-two'].status), 'running')
  console.log('PASS cancelling one research task preserves the other live tenant')
  await send({ type: 'research.clearTasks' })
  await until(async () => !(await worker.evaluate(() => chrome.offscreen.hasDocument())), 'offscreen shutdown after clearing research')
  await until(() => responses.size === 0, 'model connections abort')
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('researchTasks')).researchTasks), undefined)
  await until(async () => !(await worker.evaluate(() => chrome.alarms.getAll())).some(a => ['research-watchdog', 'mcp-tasks', 'page-watches'].includes(a.name)), 'idle queue alarms disarm')
  console.log('PASS clearing research aborts model requests, closes the host and disarms empty task monitors')
} finally {
  await context?.close()
  server.closeAllConnections(); server.close()
  await rm(temporary, { recursive: true, force: true })
}
