/** Actual chat lifecycle, tab switches and notification dispatch; local model only. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
let context, release, requests = 0
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-background-chat-'))
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (!req.url.includes('/chat/completions')) { res.end('<title>Background test</title><p>Local fixture page.</p>'); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const base = { id: 'fixture', model: 'fixture', created: 1 }
  if (body.stream && body.tools?.length) {
    requests++
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant', content: 'Generating in the background. ' })
    release = () => { send({ content: 'Background answer complete.' }); send({}, 'stop'); res.end('data: [DONE]\n\n') }
  } else {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Background test' }, finish_reason: 'stop' }] }))
  }
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(temporary, { executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).host
  const one = await context.newPage(); await one.goto(`${origin}/one`)
  const two = await context.newPage(); await two.goto(`${origin}/two`)
  const panel = await context.newPage()
  panel.on('pageerror', error => console.log('PAGE ERROR', error.message))
  await panel.addInitScript(() => {
    if (chrome.notifications) chrome.notifications.create = async (id, options) => {
      const { capturedNotifications = [] } = await chrome.storage.session.get('capturedNotifications')
      await chrome.storage.session.set({ capturedNotifications: [...capturedNotifications, { id, options }] })
      return id
    }
  })
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.evaluate(async origin => chrome.storage.local.set({ settings: {
    providers: [{ id: 'fixture', name: 'Local fixture', kind: 'custom', baseURL: `${origin}/v1`, apiKey: 'fixture', models: ['fixture'] }],
    selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true, tabAccess: 'all-tabs', systemPrompt: 'Answer the user.',
  } }), origin)
  await one.bringToFront(); await panel.reload(); await one.bringToFront()
  const visible = panel.locator('.view-host:not(.is-hidden)')
  await visible.getByPlaceholder('Ask anything…').fill('Write an answer while I switch to another tab.')
  await visible.getByTitle('Send', { exact: true }).click()
  // Switch immediately: this covers the context-gathering gap before streaming.
  await two.bringToFront()
  await panel.waitForFunction(() => [...document.querySelectorAll('.view-host.is-hidden')].some(el => el.textContent.includes('Generating in the background.')))
  assert.equal(requests, 1)
  console.log('PASS immediate tab switch preserves preparation and generation')
  await one.bringToFront()
  await visible.getByText('Generating in the background.', { exact: false }).waitFor()
  await panel.evaluate(() => { window.originalComposer = document.querySelector('.view-host:not(.is-hidden) textarea') })
  await two.bringToFront()
  release()
  let notices = []
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    notices = await panel.evaluate(async () => (await chrome.storage.session.get('capturedNotifications')).capturedNotifications ?? [])
    if (notices.some(n => n.options.title === 'Lychee finished')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!notices.length) console.log('DIAGNOSTIC', await panel.evaluate(async () => ({ text: document.body.innerText.slice(-4000), session: await chrome.storage.session.get(['tabChats','runningChats']), notifications: chrome.notifications.create.toString() })))
  assert.equal(notices.filter(n => n.options.title === 'Lychee finished').length, 1)
  const firstTab = await panel.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url === `${origin}/one`).id, origin)
  assert.equal(notices.find(n => n.options.title === 'Lychee finished').id, `chat:${firstTab}`)
  console.log('PASS background completion dispatches one notification for the original tab')
  await one.bringToFront()
  await visible.getByText('Background answer complete.', { exact: false }).waitFor()
  assert.equal(await panel.evaluate(() => window.originalComposer === document.querySelector('.view-host:not(.is-hidden) textarea')), true)
  await visible.getByPlaceholder('Ask anything…').fill('My unsent follow-up')
  await two.bringToFront(); await one.bringToFront()
  await panel.waitForFunction(() => document.querySelector('.view-host:not(.is-hidden) textarea')?.value === 'My unsent follow-up')
  assert.equal(requests, 1)
  console.log('PASS returning retains the mounted chat and draft without restarting generation')
} finally {
  release?.(); await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
