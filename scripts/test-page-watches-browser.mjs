/** Real Chrome extension checks; no external services or model calls. Run after npm run build. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { build } from 'esbuild'
const temp = await mkdtemp(path.join(os.tmpdir(), 'lychee-watches-'))
let enabled = false, context
async function waitForWatch(probe, predicate) {
  let watch
  for (let attempt = 0; attempt < 150; attempt++) {
    watch = await probe.evaluate(async () => (await window.api.listPageWatches())[0])
    if (predicate(watch)) return watch
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Watch did not settle: ${JSON.stringify(watch)}`)
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(`<button id="register" ${enabled ? '' : 'disabled'}>Register</button>`)
})
try {
  const extension = path.join(temp, 'extension')
  await cp('dist', extension, { recursive: true })
  await writeFile(path.join(extension, 'probe.html'), '<!doctype html><title>Watch test</title>')
  await build({ stdin: { contents: `export { createPageWatchTools } from './src/tools/pageWatches'; export { listPageWatches, updatePageWatch } from './src/data/pageWatches'; export { pollPageWatches } from './src/background/pageWatches';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', outfile: path.join(extension, 'probe.js') })
  await appendFile(path.join(extension, 'background.js'), '\nimport { pollPageWatches as testPoll } from \"./probe.js\"; globalThis.testPoll = testPoll;\n')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), { executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  await worker.evaluate(() => {
    globalThis.notices = []
    chrome.notifications.create = async (id, options) => { globalThis.notices.push({ id, ...options }); return id }
  })
  const id = new URL(worker.url()).host
  const original = await context.newPage(); await original.goto(url)
  let probe = await context.newPage(); await probe.goto(`chrome-extension://${id}/probe.html`)
  const created = await probe.evaluate(async url => {
    window.api = await import('./probe.js')
    const target = (await chrome.tabs.query({})).find(t => t.url === url)
    const tools = api.createPageWatchTools({ conversationId: 'test', resolveTab: async () => target, approve: async request => { window.approval = request; return true } })
    const args = { description: 'Registration opens', selector: '#register', condition: 'enabled', intervalSeconds: 60, deadline: new Date(Date.now() + 600000).toISOString() }
    const created = await tools.CreatePageWatch.execute(args, {})
    if (!created.watchId) throw new Error(JSON.stringify(created))
    await api.updatePageWatch(created.watchId, w => ({ ...w, nextCheckAt: 0 }))
    return { created, watches: await api.listPageWatches(), approval: window.approval }
  }, url)
  await worker.evaluate(() => globalThis.testPoll())
  // The production change listener may already own the lease. The bundled
  // probe has a separate module instance, so await the persisted outcome too.
  await waitForWatch(probe, watch => watch.lastCheckedAt && !watch.leaseUntil)
  assert.equal(created.watches[0].status, 'active', 'background check observes disabled button')
  assert.ok(created.approval.summary.includes('Every 60 seconds'))
  await original.close()
  enabled = true
  await probe.evaluate(async () => {
    const [watch] = await api.listPageWatches()
    await api.updatePageWatch(watch.id, w => ({ ...w, nextCheckAt: 0 }))
  })
  await probe.close() // Neither the original page nor the initiating extension view survives.
  await worker.evaluate(async () => { await globalThis.testPoll(); await globalThis.testPoll() })
  probe = await context.newPage(); await probe.goto(`chrome-extension://${id}/probe.html`)
  await probe.evaluate(async () => { window.api = await import('./probe.js') })
  await waitForWatch(probe, watch => watch.status === 'matched' && watch.notified)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await probe.evaluate(async () => !Object.keys(await chrome.storage.session.get(null)).some(key => key.startsWith('page-watch-tab:')))) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const notices = await worker.evaluate(() => globalThis.notices)
  const result = await probe.evaluate(async () => {
    const api = await import('./probe.js')
    return { watches: await api.listPageWatches(), tabs: await chrome.tabs.query({}) }
  })
  assert.equal(result.watches[0].status, 'matched', 'closed page is reopened and read')
  assert.equal(notices.length, 1, 'one notification delivery')
  assert.equal(result.tabs.filter(t => t.url === url || t.url === 'about:blank').length, 1, 'only initial Chromium blank tab remains')
  console.log('PASS: approved setup, background check, closed-tab reopening with panel closed, match, single notification, temporary-tab cleanup')
} finally {
  await context?.close(); server.close(); await rm(temp, { recursive: true, force: true })
}
