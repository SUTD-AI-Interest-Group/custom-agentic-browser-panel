/** Verify extraction under the real MV3 extension CSP, including hostile markup. */
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { build } from 'esbuild'
const temp = await mkdtemp(path.join(os.tmpdir(), 'lychee-html-extraction-'))
let context
const requests = []
const server = http.createServer((req, res) => {
  requests.push(req.url)
  res.end('resource')
})
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const extension = path.join(temp, 'extension')
  await cp('dist', extension, { recursive: true })
  await writeFile(
    path.join(extension, 'extraction-probe.html'),
    '<!doctype html><script type="module" src="extraction-probe.js"></script>',
  )
  await build({
    stdin: {
      contents: `export { extractReadableText, parseDuckDuckGoLite, parseDuckDuckGoHtml } from './src/platform/webFetch'; export { parseImgTags } from './src/platform/researchSources'; export { parseOpenGraph } from './src/platform/linkPreview';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    outfile: path.join(extension, 'extraction-probe.js'),
  })
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  })
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const page = await context.newPage()
  const violations = []
  page.on('console', (message) => {
    if (
      /Content Security Policy|inline event handler|Refused to/i.test(
        message.text(),
      )
    )
      violations.push(message.text())
  })
  page.on('pageerror', (error) => violations.push(error.message))
  await page.goto(`chrome-extension://${id}/extraction-probe.html`)
  const result = await page.evaluate(async (origin) => {
    const api = await import('./extraction-probe.js')
    const html = `<html><head><title>Safe &amp; readable</title><meta property="og:title" content="Preview title"><meta property="og:description" content="Preview description"><meta http-equiv="refresh" content="0;url=${origin}/refresh"><link rel="stylesheet" href="${origin}/style"></head><body onload="globalThis.executed = true"><script>globalThis.executed = true</script><main onclick="globalThis.executed = true"><h1>Readable heading</h1><p>First paragraph.</p><p>Second paragraph.</p><img src="${origin}/image" onerror="globalThis.executed = true" width="600" height="400" alt="Research image"><iframe src="${origin}/frame" onload="globalThis.executed = true"></iframe><svg onload="globalThis.executed = true"></svg></main></body></html>`
    const lite = `<table><tr><td><a class="result-link" onclick="globalThis.executed=true" href="https://example.com/result">Result</a></td></tr><tr><td class="result-snippet">Snippet.</td></tr></table>`
    const full = `<div class="result"><a class="result__a" onfocus="globalThis.executed=true" href="https://example.com/result">Result</a><span class="result__snippet">Snippet.</span></div>`
    const readable = api.extractReadableText(html)
    const images = api.parseImgTags(html, 'https://example.com')
    const preview = api.parseOpenGraph(html, 'https://example.com')
    const liteRows = api.parseDuckDuckGoLite(lite)
    const htmlRows = api.parseDuckDuckGoHtml(full)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return {
      readable,
      images,
      preview,
      liteRows,
      htmlRows,
      executed: globalThis.executed === true,
    }
  }, origin)
  assert.equal(result.readable.title, 'Safe & readable')
  assert.match(
    result.readable.text,
    /Readable heading\s+First paragraph\.\s+Second paragraph\./,
  )
  assert.equal(result.images[0].url, `${origin}/image`)
  assert.equal(result.images[0].caption, 'Research image')
  assert.equal(result.preview.title, 'Preview title')
  assert.equal(result.liteRows[0].snippet, 'Snippet.')
  assert.equal(result.htmlRows[0].url, 'https://example.com/result')
  assert.equal(result.executed, false)
  assert.deepEqual(
    violations,
    [],
    'HTML extraction must not emit CSP violations',
  )
  assert.deepEqual(requests, [], 'parsing must not load embedded resources')
  console.log(
    'PASS: readable text, both search parsers, image metadata and link previews; no inline-handler CSP violations, execution or resource requests',
  )
} finally {
  await context?.close()
  server.close()
  await rm(temp, { recursive: true, force: true })
}
