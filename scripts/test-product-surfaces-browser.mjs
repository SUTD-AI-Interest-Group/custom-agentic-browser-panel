/** Disposable extension profile: product surfaces, visibility, and idle I/O.
 * CHROME_BIN selects a local Chrome for Testing. No account or paid service. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const baseline = process.env.BASELINE === '1'
const extension = path.resolve(process.env.EXTENSION_DIR || 'dist')
const output = path.resolve(process.env.OUTPUT_DIR || 'test-results/product-surfaces')
const temp = await mkdtemp(path.join(os.tmpdir(), 'lychee-surfaces-'))
let context, modelRequests = 0
const errors = []
const fixture = await readFile('scripts/fixtures/webmcp.html', 'utf8')
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (req.url.includes('/chat/completions')) {
    modelRequests++
    for await (const chunk of req) { /* consume request */ }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'test', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }))
  } else { res.setHeader('Content-Type', 'text/html'); res.end(fixture) }
})
try {
  await mkdir(output, { recursive: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(temp, { executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, viewport: { width: 390, height: 844 }, args: ['--enable-features=WebMCPTesting', '--enable-blink-features=WebMCP,WebMCPTesting', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  context.setDefaultTimeout(15000)
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).host
  const page = await context.newPage(); await page.goto(origin); await page.evaluate(() => window.ready)
  const panel = await context.newPage()
  panel.on('pageerror', error => errors.push(error.message))
  await panel.addInitScript(origin => {
    window.measurements = { transactions: 0, writes: 0, injections: 0 }
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function(...args) {
      window.measurements.transactions++
      if (args[1] === 'readwrite') window.measurements.writes++
      return transaction.apply(this, args)
    }
    if (!chrome.tabs || !chrome.scripting) return
    const query = chrome.tabs.query.bind(chrome.tabs)
    chrome.tabs.query = async options => options.active ? (await query({})).filter(tab => tab.url === origin + '/') : query(options)
    // The test opens the panel as a tab. Real side panels do not activate tabs.
    chrome.tabs.onActivated.addListener = () => {}
    const inject = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (...args) => { window.measurements.injections++; return inject(...args) }
  }, origin)
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.getByRole('button', { name: 'Custom', exact: true }).waitFor()
  await panel.screenshot({ path: path.join(output, 'onboarding.png') })
  await panel.evaluate(async origin => chrome.storage.local.set({ settings: {
    providers: [{ id: 'fixture', name: 'Fixture', kind: 'custom', baseURL: `${origin}/v1`, apiKey: '', models: ['fixture'] }], selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true, tabAccess: 'all-tabs', systemPrompt: 'Answer the user.',
  } }), origin)
  await page.bringToFront(); await panel.reload(); await page.bringToFront()
  const chat = panel.locator('.view-host:not(.is-hidden)')
  await chat.getByPlaceholder('Ask anything…').waitFor()
  // Retain four idle chats, the common multi-tab/draft case.
  for (let n = 0; n < 3; n++) { await panel.getByTitle('New chat', { exact: true }).click(); await panel.waitForTimeout(150) }
  await panel.waitForTimeout(1000)
  await panel.evaluate(() => { window.measurements = { transactions: 0, writes: 0, injections: 0 } })
  const beforeModels = modelRequests
  await panel.waitForTimeout(3200)
  const metrics = await panel.evaluate(() => ({ ...window.measurements, mountedChats: document.querySelectorAll('.view-host').length, jsHeapBytes: performance.memory?.usedJSHeapSize, resources: performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('.js')).map(entry => entry.name.split('/').at(-1)) }))
  metrics.idleModelRequests = modelRequests - beforeModels
  metrics.totalUnrequestedModelRequests = modelRequests
  metrics.intervalMs = 3200
  if (!baseline) {
    assert.equal(metrics.injections, 0, 'idle panel must not inject selection/WebMCP probes')
    assert.ok(metrics.transactions <= 2, `idle panel performed ${metrics.transactions} DB transactions`)
    assert.equal(modelRequests, 0, 'opening chats must not invoke a model')
  }
  await panel.screenshot({ path: path.join(output, 'chat.png') })
  await panel.getByTitle('Settings', { exact: true }).click()
  await panel.getByRole('tab', { name: 'General', exact: true }).waitFor()
  if (!baseline) {
    await panel.getByRole('tab', { name: 'General', exact: true }).focus()
    await panel.keyboard.press('ArrowRight')
    assert.equal(await panel.getByRole('tab', { name: 'Providers', exact: true }).getAttribute('aria-selected'), 'true')
  }
  for (const name of ['General', 'Providers', 'Permissions', 'Memory', 'Skills', 'Data']) {
    await panel.getByRole('tab', { name, exact: true }).click()
    await panel.locator('.settings-tabpane').waitFor()
    await panel.screenshot({ path: path.join(output, `settings-${name.toLowerCase()}.png`) })
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflows the viewport`)
  }
  if (!baseline) {
    await panel.getByRole('tab', { name: 'General', exact: true }).click()
    const prompt = panel.getByRole('textbox', { name: 'System prompt' })
    await prompt.fill('A local draft')
    // Another window changes an unrelated setting while this field is dirty.
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings')
      await chrome.storage.local.set({ settings: { ...settings, fetchLinkPreviews: false } })
    })
    await panel.getByLabel('Fetch previews from linked sites').waitFor()
    await panel.waitForFunction(() => !document.querySelector('.settings-tabpane input[type="checkbox"]:not([role="switch"])').checked)
    assert.equal(await prompt.inputValue(), 'A local draft')
    await prompt.blur()
    await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.systemPrompt === 'A local draft')
    const saved = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings)
    assert.equal(saved.fetchLinkPreviews, false)
    // No page-selection listener remains while another surface is shown.
    await panel.waitForTimeout(250)
    const injected = await panel.evaluate(() => window.measurements.injections)
    await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('h1')); getSelection().removeAllRanges(); getSelection().addRange(range) })
    await panel.waitForTimeout(200)
    assert.equal(await panel.evaluate(() => window.measurements.injections), injected)
  }
  await panel.getByTitle('Library', { exact: true }).click()
  for (const name of ['Chats', 'Skills', 'Research']) {
    await panel.getByRole('tab', { name, exact: true }).click()
    await panel.screenshot({ path: path.join(output, `library-${name.toLowerCase()}.png`) })
  }
  await panel.getByRole('tab', { name: 'Skills', exact: true }).click()
  await panel.getByRole('button', { name: 'New skill', exact: true }).click()
  await panel.screenshot({ path: path.join(output, 'skill-editor.png') })
  await panel.getByTitle('Studio Mode', { exact: true }).click()
  await panel.getByRole('heading', { name: 'Selectors', exact: true }).waitFor()
  await panel.screenshot({ path: path.join(output, 'studio.png') })
  await panel.getByTitle('New chat', { exact: true }).click()
  await chat.getByPlaceholder('Ask anything…').waitFor()
  if (!baseline) {
    await page.evaluate(() => { getSelection().removeAllRanges(); const range = document.createRange(); range.selectNodeContents(document.querySelector('h1')); getSelection().addRange(range) })
    await chat.locator('.selection-chip').waitFor()
    assert.ok((await chat.textContent()).includes('Native WebMCP fixture'), 'live selection must reach the visible chat')
  }
  for (const width of [320, 520, 900]) {
    await panel.setViewportSize({ width, height: 844 })
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `chat overflows at ${width}px`)
    await panel.screenshot({ path: path.join(output, `chat-${width}.png`) })
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2))
  console.log('PASS onboarding, six Settings tabs, three Library tabs, skill editor, Studio, and responsive chat')
  console.log(JSON.stringify(metrics, null, 2))
} finally {
  await context?.close()
  await new Promise(resolve => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
