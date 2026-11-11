/** Run after `npm --prefix site run build`; no account or remote services. */
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = path.resolve('test-results/site-surfaces')
await mkdir(output, { recursive: true })
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.woff2': 'font/woff2' }
const server = http.createServer(async (req, res) => {
  try {
    const relative = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html'
    const root = path.resolve('site/dist')
    const file = path.resolve(root, relative)
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
    const bytes = await readFile(file)
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' })
    res.end(bytes)
  } catch { res.writeHead(404); res.end() }
})
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || chromium.executablePath() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.goto(origin)
  await page.getByRole('heading', { name: 'Lychee AI', exact: true }).waitFor()
  assert.equal(await page.locator('.hero video').count(), 0)
  assert.equal(requests.some(url => url.includes('lychee-film.mp4')), false)
  await page.screenshot({ path: path.join(output, 'home-desktop.png') })
  const play = page.getByRole('button', { name: 'Watch the film', exact: true })
  await play.click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await play.evaluate(element => element === document.activeElement), true)
  await page.locator('nav').getByRole('link', { name: 'Engineering log', exact: true }).click()
  await page.locator('.log__item').first().click()
  await page.locator('article.prose, article .prose').waitFor()
  await page.screenshot({ path: path.join(output, 'article-desktop.png') })
  await page.locator('nav').getByRole('link', { name: 'Privacy', exact: true }).click()
  await page.waitForFunction(() => Math.abs(document.getElementById('privacy-band')?.getBoundingClientRect().top ?? Infinity) < 200)
  await page.goto(`${origin}/#/log/%E0%A4%A`)
  await page.getByRole('heading', { name: 'Engineering log', exact: true }).waitFor()
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const route of ['#/', '#/log', '#/privacy']) {
      await page.goto(`${origin}/${route}`)
      await page.locator('h1').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${route} overflows at ${width}px`)
      if (route === '#/' && width <= 768) {
        const columns = await page.locator('.hero').evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length)
        assert.equal(columns, 1, 'mobile hero uses a full-width column')
      }
      if (width === 390) await page.screenshot({ path: path.join(output, `mobile-${route.slice(2) || 'home'}.png`) })
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS homepage, articles, privacy, section links, malformed routes, modal focus/Escape, no autoplay, and four viewport widths')
} finally {
  await browser?.close()
  server.closeAllConnections(); server.close()
}
