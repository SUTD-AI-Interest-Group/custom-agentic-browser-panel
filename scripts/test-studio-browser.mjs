/** Real extension + AI SDK transport, with a deterministic local model endpoint. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { build } from 'esbuild'
const temp = await mkdtemp(path.join(os.tmpdir(), 'lychee-studio-'))
let context
let modelRequests = []
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.end()
    return
  }
  if (req.url === '/v1/chat/completions') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    modelRequests.push(body)
    const proposal = {
      explanation: 'Added a **working counter** and increased heading spacing.',
      css: 'h1 { letter-spacing: 7px !important; }',
      js: `const button = document.createElement('button'); button.id = 'studio-counter'; let count = 0; button.textContent = 'Clicks: 0'; button.addEventListener('click', () => { button.textContent = 'Clicks: ' + (++count) }); document.body.append(button);`,
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        id: 'studio-fixture',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(proposal) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      }),
    )
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'none'; script-src 'none'",
  )
  res.end(
    '<!doctype html><html><body><h1>Studio fixture</h1><aside id="advert">Remove me</aside><p id="description">Body text</p></body></html>',
  )
})
try {
  const extension = path.join(temp, 'extension')
  await cp('dist', extension, { recursive: true })
  // Pregrant the optional permission in this disposable extension only. Chrome's
  // real Allow user scripts switch is exercised below; no APIs are mocked.
  const manifest = JSON.parse(
    await readFile(path.join(extension, 'manifest.json'), 'utf8'),
  )
  manifest.permissions.push('userScripts')
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (p) => p !== 'userScripts',
  )
  await writeFile(
    path.join(extension, 'manifest.json'),
    JSON.stringify(manifest),
  )
  await writeFile(
    path.join(extension, 'probe.html'),
    '<!doctype html><div id="root" style="height:100vh;display:flex;flex-direction:column"></div><link rel="stylesheet" href="probe.css"><script type="module" src="probe.js"></script>',
  )
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Studio from './src/ui/Studio'; import './src/ui/styles.css'; export * from './src/data/studio'; export * from './src/platform/studio'; window.mountStudio = (origin) => createRoot(document.getElementById('root')).render(React.createElement(Studio, {settings:{selected:{providerId:'fixture',modelId:'fixture'}, providers:[{id:'fixture',name:'Local fixture',kind:'custom',baseURL:origin+'/v1',apiKey:'fixture',models:['fixture']}]},onUpdateSettings:()=>{},onOpenSettings:()=>{}}));`,
      resolveDir: process.cwd(),
    },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    bundle: true,
    format: 'esm',
    outfile: path.join(extension, 'probe.js'),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const launch = () =>
    chromium.launchPersistentContext(path.join(temp, 'profile'), {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    })
  context = await launch()
  context.setDefaultTimeout(15000)
  let worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(origin)
  const probe = await context.newPage()
  await probe.goto(`chrome-extension://${id}/probe.html`)
  await page.bringToFront()
  await probe.evaluate(async (origin) => {
    const query = chrome.tabs.query.bind(chrome.tabs)
    chrome.tabs.query = async (options) =>
      options.active
        ? (await query({})).filter((tab) => tab.url === origin + '/')
        : query(options)
    // This harness is a tab, while the real side panel never becomes the active tab.
    chrome.tabs.onActivated.addListener = () => {}
    window.mountStudio(origin)
  }, origin)
  await probe.getByRole('heading', { name: 'Selectors' }).waitFor()
  await probe
    .getByRole('button', { name: 'Georgia, serif', exact: true })
    .click()
  await page.waitForFunction(() =>
    getComputedStyle(document.body).fontFamily.includes('Georgia'),
  )
  await probe.getByLabel('Hue', { exact: true }).fill('140')
  await page.waitForFunction(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--studio-background')
      .trim()
      .startsWith('#'),
  )
  const backgroundPosition = await probe
    .getByLabel('Background color selector')
    .evaluate((el) => el.style.left)
  await probe.getByRole('button', { name: 'Text', exact: true }).click()
  await probe.getByLabel('Hue', { exact: true }).fill('100')
  assert.equal(
    await probe
      .getByLabel('Background color selector')
      .evaluate((el) => el.style.left),
    backgroundPosition,
  )
  const textPosition = await probe
    .getByLabel('Text color selector')
    .evaluate((el) => el.style.left)
  await probe.getByRole('button', { name: 'Background', exact: true }).click()
  await probe.getByLabel('Hue', { exact: true }).fill('200')
  assert.notEqual(
    await probe
      .getByLabel('Text color selector')
      .evaluate((el) => el.style.left),
    textPosition,
  )
  assert.ok(
    parseFloat(await probe.getByLabel('Palette contrast').innerText()) >= 7,
  )
  console.log('PASS linked background/text controls and measured contrast')
  // Real AI SDK request/response against a deterministic local compatible model.
  await probe
    .getByLabel('Describe a site customization')
    .fill('Add a working click counter and increase heading spacing.')
  await probe.getByLabel('Describe a site customization').press('Enter')
  await probe
    .getByRole('button', { name: 'Review changes' })
    .waitFor()
  assert.equal(modelRequests.length, 1)
  assert.ok(
    modelRequests[0].messages.some((m) => m.content.includes('Studio fixture')),
  )
  assert.equal(
    await page.locator('#studio-counter').count(),
    0,
    'proposal is not executed before review',
  )
  await probe
    .getByRole('button', { name: 'Review changes' })
    .click()
  assert.ok(
    (await probe.getByLabel('JS editor').inputValue()).includes(
      'addEventListener',
    ),
  )
  // Enable the browser-owned switch in this test profile, then use actual userScripts.
  const manager = await context.newPage()
  await manager.goto(`chrome://extensions/?id=${id}`)
  const scriptsToggle = manager
    .locator('#allow-user-scripts')
    .locator('cr-toggle')

  if (await scriptsToggle.count()) {
    if (!(await scriptsToggle.evaluate((el) => el.checked)))
      await scriptsToggle.click()
  } else {
    const toggle = manager.getByText('Allow user scripts', { exact: true })
    await toggle.click()
  }

  await probe.evaluate(() => chrome.userScripts.getScripts())
  await manager.close()
  await probe.getByRole('button', { name: 'Save & apply' }).click()
  await probe
    .getByRole('status')
    .filter({ hasText: /Saved/ })
    .or(probe.getByRole('alert'))
    .waitFor()
    .catch(async (e) => {
      console.log('Failed save UI', await probe.locator('body').innerText())
      throw e
    })

  await probe.getByRole('status').filter({ hasText: /Saved/ }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Clicks: 0', exact: true }).click()
  await page.getByRole('button', { name: 'Clicks: 1', exact: true }).waitFor()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('h1')).letterSpacing === '7px',
  )
  console.log(
    'PASS model request, Markdown proposal, review, real userScripts registration and interactive JS',
  )
  await probe.getByRole('button', { name: 'ϟ Zap · 0', exact: true }).click()
  await page.locator('#__lychee_studio_picker').waitFor({ state: 'attached' })
  await page.locator('#advert').click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#advert')).display === 'none',
  )
  // The picker remains active after the first click.
  await page.locator('#description').click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#description')).display ===
      'none',
  )
  await page.keyboard.press('Escape')
  await probe.getByRole('button', { name: 'ϟ Zap · 2', exact: true }).waitFor()
  await probe.getByText('Zapped elements', { exact: true }).click()
  await probe
    .getByRole('button', { name: 'Restore Body text', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#description')).display !==
      'none',
  )
  await probe.getByRole('button', { name: 'ϟ Zap · 1', exact: true }).click()
  await page.locator('#__lychee_studio_picker').waitFor({ state: 'attached' })
  await probe
    .getByRole('button', { name: 'Stop zapping · Esc', exact: true })
    .click()
  await page.locator('#__lychee_studio_picker').waitFor({ state: 'detached' })
  console.log(
    'PASS continuous Zap, Escape, readable previews, restore and toggle-off',
  )
  await probe.getByRole('button', { name: 'On', exact: true }).click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#advert')).display !== 'none',
  )
  assert.equal(
    await probe.evaluate(
      async () =>
        (await chrome.userScripts.getScripts()).filter((s) =>
          s.id.startsWith('studio-'),
        ).length,
    ),
    0,
  )
  await page.reload()
  assert.equal(
    await page.locator('#studio-counter').count(),
    0,
    'disabled JavaScript stays disabled after reload',
  )
  await probe.getByRole('button', { name: 'Off', exact: true }).click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#advert')).display === 'none',
  )
  await probe.setViewportSize({ width: 380, height: 900 })
  await probe.getByRole('button', { name: 'Selectors', exact: true }).click()
  await probe.screenshot({
    path: '/tmp/lychee-studio-preview.png',
    fullPage: true,
  })
  console.log('Disable/enable passed')
  await probe.close()
  await page.reload()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#advert')).display === 'none',
  )
  await page.getByRole('button', { name: 'Clicks: 0', exact: true }).click()
  await page.getByRole('button', { name: 'Clicks: 1', exact: true }).waitFor()
  console.log('Closed-panel reload passed')
  await context.close()
  context = await launch()
  context.setDefaultTimeout(15000)
  worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const restored = await context.newPage()

  await restored.goto(origin)

  await restored.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('h1')).letterSpacing === '7px',
  )
  assert.equal(await restored.locator('#advert').isVisible(), false)
  await restored
    .getByRole('button', { name: 'Clicks: 0', exact: true })
    .click()
    .catch(async (e) => {
      console.log(
        'Restart diagnostics',
        await worker.evaluate(async () => ({
          scripts: await chrome.userScripts.getScripts(),
          session: await chrome.storage.session.get('studioBooted'),
        })),
        await restored.locator('body').innerText(),
      )
      throw e
    })
  await restored
    .getByRole('button', { name: 'Clicks: 1', exact: true })
    .waitFor()
  assert.equal(await restored.locator('#studio-counter').count(), 1)
  const other = await context.newPage()
  await other.goto(origin.replace('127.0.0.1', 'localhost'))
  assert.equal(await other.locator('#advert').isVisible(), true)
  assert.equal(await other.locator('#studio-counter').count(), 0)
  assert.notEqual(
    await other
      .locator('h1')
      .evaluate((el) => getComputedStyle(el).letterSpacing),
    '7px',
  )
  console.log(
    'PASS: Studio controls, palette, font, CSS, zap, disable/enable, closed-panel reload, full browser restart, origin isolation',
  )
} finally {
  await context?.close()
  server.close()
  await rm(temp, { recursive: true, force: true })
}
