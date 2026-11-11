/** Offscreen inference survives actual panel destruction; local scripted model only. */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { chromium } from 'playwright'
let context, release, requests = 0
const requestBodies = []
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-background-chat-'))
const pdfText = 'BT /F1 18 Tf 30 150 Td (Background PDF fixture) Tj ET'
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`,
]
let pdf = '%PDF-1.4\n', offsets = [0]
for (const [i, obj] of objects.entries()) { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${obj}\nendobj\n` }
const xref = pdf.length
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (req.url === '/fixture.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return }
  if (!req.url.includes('/chat/completions')) { res.end('<title>Background test</title><p>Local fixture page.</p>'); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const base = { id: 'fixture', model: 'fixture', created: 1 }
  if (body.stream && body.tools?.length) {
    requests++
    requestBodies.push(body)
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    const call = (name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n') }
    if (requests === 1) {
      send({ role: 'assistant', content: 'Starting background tools. ' })
      release = () => call('GetTool', { names: ['RunCode', 'ReadTabs', 'CreateArtifact', 'GetScreenshot'] })
    } else if (requests === 2) call('RunCode', { code: '6 * 7', reason: 'Compute a value' })
    else if (requests === 3) call('ReadTabs', { mode: 'gist', reason: 'Inspect local fixture tabs' })
    else if (requests === 4) call('GetScreenshot', { reason: 'Capture the fixture', fullPage: false })
    else if (requests === 5) call('CreateArtifact', { title: 'Approved fixture', html: '<p>Approved artifact</p>', reason: 'Test approval persistence' })
    else if (requests === 6) call('CreateArtifact', { title: 'Denied fixture', html: '<p>Must not be created</p>', reason: 'Test denial' })
    else { send({ role: 'assistant', content: 'Background tools finished.' }); send({}, 'stop'); res.end('data: [DONE]\n\n') }
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
    selected: { providerId: 'fixture', modelId: 'fixture' }, onboarded: true, tabAccess: 'all-tabs', toolPolicies: { RunCode: 'always', ReadTabs: 'always', GetScreenshot: 'always' }, systemPrompt: 'Answer the user.',
  } }), origin)
  await one.bringToFront(); await panel.reload(); await one.bringToFront()
  const visible = panel.locator('.view-host:not(.is-hidden)')
  await visible.getByPlaceholder('Ask anything…').fill('Write an answer while I switch to another tab.')
  await visible.getByTitle('Send', { exact: true }).click()
  await visible.getByText('Starting background tools.', { exact: false }).waitFor()
  await worker.evaluate(() => {
    chrome.notifications.create = async (id, options) => {
      const { capturedNotifications = [] } = await chrome.storage.session.get('capturedNotifications')
      await chrome.storage.session.set({ capturedNotifications: [...capturedNotifications, { id, options }] })
      return id
    }
  })
  await panel.close(); release()
  const waitFor = async (test, label) => {
    for (let i = 0; i < 400; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(`Timed out: ${label}; requests=${requests}; bodies=${JSON.stringify(requestBodies).slice(-8000)}`)
  }
  await waitFor(() => requests === 5, 'background tools and approval')
  const results = requestBodies.flatMap(b => b.messages.filter(m => m.role === 'tool'))
  assert.ok(results.some(r => r.content.includes('42')), JSON.stringify(results))
  assert.ok(results.some(r => r.content.includes('Background test')), JSON.stringify(results))
  assert.ok(results.some(r => r.content.includes('shotId')), JSON.stringify(results))
  console.log('PASS code sandbox, tab APIs and screenshots execute with the panel destroyed')
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.session.get('capturedNotifications')).capturedNotifications ?? [])).some(n => n.options.title === 'Lychee needs your approval'), 'approval notification')
  assert.equal(requests, 5)
  const documentResult = await worker.evaluate(origin => chrome.runtime.sendMessage({ type: 'chat.dom', operation: 'loadPdf', args: [`${origin}/fixture.pdf`, {}] }), origin)
  assert.ok(documentResult.ok && JSON.stringify(documentResult.value).includes('Background PDF fixture'), JSON.stringify(documentResult))
  console.log('PASS background PDF processing uses the offscreen document')
  let reopened = await context.newPage()
  await reopened.goto(`chrome-extension://${id}/sidepanel.html`); await one.bringToFront()
  await reopened.getByRole('button', { name: 'Allow', exact: true }).waitFor()
  await reopened.close()
  reopened = await context.newPage()
  await reopened.goto(`chrome-extension://${id}/sidepanel.html`); await one.bringToFront()
  await reopened.getByRole('button', { name: 'Allow', exact: true }).waitFor()
  assert.equal(requests, 5)
  await new Promise(r => setTimeout(r, 400))
  await reopened.getByRole('button', { name: 'Allow', exact: true }).click()
  await waitFor(() => requests === 6, 'approved action')
  assert.ok(requestBodies.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('artifactId')))
  console.log('PASS pending approval survives repeated panel closure and resumes the same call')
  await reopened.getByRole('button', { name: 'Deny', exact: true }).waitFor()
  await new Promise(r => setTimeout(r, 400))
  await reopened.getByRole('button', { name: 'Deny', exact: true }).click()
  await waitFor(() => requests === 7, 'denial response')
  assert.ok(requestBodies.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('denied')))
  await reopened.close()
  console.log('PASS denial returns to the model without executing the action')
  await waitFor(async () => !(await worker.evaluate(() => chrome.offscreen.hasDocument())), 'offscreen resource cleanup')
  console.log('PASS tool completion releases the offscreen host, PDF workers and code sandbox')

} finally {
  release?.(); await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
