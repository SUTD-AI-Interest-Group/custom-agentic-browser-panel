/** Offscreen inference survives actual panel destruction; local scripted model only. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
let context, release, requests = 0, mode = 'text'
async function assertHostCloses(worker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await worker.evaluate(() => chrome.offscreen.hasDocument()))) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('The idle offscreen document was not released')
}
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
    release = () => {
      if (mode === 'tool') {
        send({ tool_calls: [{ index: 0, id: 'closed-tool', type: 'function', function: { name: 'ToolSearch', arguments: JSON.stringify({ query: 'tabs' }) } }] })
        send({}, 'tool_calls')
      } else { send({ content: 'Background answer complete.' }); send({}, 'stop') }
      res.end('data: [DONE]\n\n')
    }
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
  if (process.env.LOSE_CHAT_ACK) await panel.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (...args) => {
      const reply = original(...args)
      return args[0]?.type === 'chat.start' ? Promise.resolve(reply).then(() => undefined) : reply
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
  await visible.getByText('Generating in the background.', { exact: false }).waitFor()
  await worker.evaluate(() => {
    chrome.notifications.create = async (id, options) => {
      const { capturedNotifications = [] } = await chrome.storage.session.get('capturedNotifications')
      await chrome.storage.session.set({ capturedNotifications: [...capturedNotifications, { id, options }] })
      return id
    }
  })
  await panel.close()
  assert.equal(requests, 1)
  release()
  let notices = []
  for (let i = 0; i < 200; i++) {
    notices = await worker.evaluate(async () => (await chrome.storage.session.get('capturedNotifications')).capturedNotifications ?? [])
    if (notices.length) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(notices.filter(n => n.options.title === 'Lychee finished').length, 1, JSON.stringify(notices))
  console.log('PASS panel destroyed, generation finished and notification dispatched once')
  await assertHostCloses(worker)
  console.log('PASS completed background chat releases the offscreen document')
  const reopened = await context.newPage()
  await one.bringToFront()
  await reopened.goto(`chrome-extension://${id}/sidepanel.html`)
  await one.bringToFront()
  const chat = reopened.locator('.view-host:not(.is-hidden)')
  await chat.getByText('Background answer complete.', { exact: false }).waitFor()
  assert.equal(requests, 1)
  console.log('PASS reopening restores the saved reply without another inference request')
  await chat.getByPlaceholder('Ask anything…').fill('Keep writing while the panel reopens.')
  await chat.getByTitle('Send', { exact: true }).click()
  for (let i = 0; requests < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 2)
  await reopened.close()
  const live = await context.newPage()
  await live.goto(`chrome-extension://${id}/sidepanel.html`)
  await one.bringToFront()
  await live.locator('.view-host:not(.is-hidden)').getByTitle('Stop', { exact: true }).waitFor()
  release()
  await live.waitForFunction(() => document.body.innerText.split('Background answer complete.').length >= 3)
  assert.equal(requests, 2)
  console.log('PASS reopening during generation reconnects to the existing run')

  const liveChat = live.locator('.view-host:not(.is-hidden)')
  await liveChat.getByPlaceholder('Ask anything…').fill('Stop this run after reopening.')
  await liveChat.getByTitle('Send', { exact: true }).click()
  for (let i = 0; requests < 3 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 3)
  await live.close()
  const stopped = await context.newPage()
  await stopped.goto(`chrome-extension://${id}/sidepanel.html`); await one.bringToFront()
  const stopChat = stopped.locator('.view-host:not(.is-hidden)')
  await stopChat.getByTitle('Stop', { exact: true }).click()
  await stopChat.getByTitle('Stop', { exact: true }).waitFor({ state: 'hidden' })
  release()
  assert.equal(requests, 3)
  console.log('PASS Stop in a reopened panel cancels the background run')
  await assertHostCloses(worker)
  console.log('PASS cancelled background chat releases the offscreen document')
  mode = 'tool'
  await stopChat.getByPlaceholder('Ask anything…').fill('Request a tool after the panel closes.')
  await stopChat.getByTitle('Send', { exact: true }).click()
  for (let i = 0; requests < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 4)
  await stopped.close(); release()
  for (let i = 0; requests < 5 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 5)
  mode = 'text'; release()
  const parked = await context.newPage()
  await parked.goto(`chrome-extension://${id}/sidepanel.html`); await one.bringToFront()
  await parked.locator('.view-host:not(.is-hidden)').getByTitle('Stop', { exact: true }).waitFor({ state: 'hidden' })
  console.log('PASS tool call while closed continues automatically')

  mode = 'text'
  await parked.locator('.view-host:not(.is-hidden)').getByPlaceholder('Ask anything…').fill('Keep the partial text if the host is interrupted.')
  await parked.locator('.view-host:not(.is-hidden)').getByTitle('Send', { exact: true }).click()
  for (let i = 0; requests < 6 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 6)
  await new Promise(resolve => setTimeout(resolve, 300))
  await parked.close()
  await worker.evaluate(() => chrome.offscreen.closeDocument())
  await new Promise(resolve => setTimeout(resolve, 5500))
  const interrupted = await context.newPage()
  await interrupted.goto(`chrome-extension://${id}/sidepanel.html`); await one.bringToFront()
  await interrupted.getByText('Generation was interrupted because its background host closed.', { exact: false }).waitFor()
  assert.equal(requests, 6)
  console.log('PASS host interruption preserves partial text without silently replaying inference')

} finally {
  release?.(); await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
