// Stage 1 — pages → element snapshots. Read-only: it navigates (GET) and
// scrolls, never clicks, types or submits. Each page is snapshotted at several
// scroll offsets with the REAL domIndex walker (viewport-only, exactly what Act
// sees), so the labeler can tell "visible now" from "below the fold".
//
//   node scripts/von-finetune/collect.mjs [--pages pages.txt] [--follow 2] [--viewports 3] [--limit N]
//
// Output: data/pages.jsonl, one record per page, resumable (a page already in
// the file is skipped). Needs a Playwright install: VFT_PLAYWRIGHT=/path/to/node_modules/playwright.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { DATA, appendJsonl, bundle, env, here, log, readJsonl, rng, sha, shuffle, siteOf, splitOf } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    pages: { type: 'string', default: path.join(here, 'pages.txt') },
    follow: { type: 'string', default: '2' },
    viewports: { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    headed: { type: 'boolean', default: false },
  },
})
const FOLLOW = Number(args.follow)
const VIEWPORTS = Number(args.viewports)
const OUT = path.join(DATA, 'pages.jsonl')
// The eval's fixtures are the held-out test set: never train on them.
const FORBIDDEN = /system1-eval\/fixtures/
const SKIP_LINK = /logout|log-out|signout|sign-out|delete|remove|unsubscribe|cancel-account|\.(pdf|zip|dmg|exe|jpg|png|mp4)(\?|$)/i

const require = createRequire(import.meta.url)
const { chromium } = require(env.VFT_PLAYWRIGHT ?? 'playwright')

function findChromium() {
  if (env.VFT_CHROMIUM) return env.VFT_CHROMIUM
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (fs.existsSync(p)) return p
  }
  return undefined // let Playwright use its own default
}

function seeds() {
  return fs.readFileSync(args.pages, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [category, url] = l.split(/\s+/); return { category, url } })
}

const slim = (e) => ({
  index: e.index, tag: e.tag, role: e.role, name: e.name, type: e.type, value: e.value, checked: e.checked,
  sensitive: e.sensitive, href: e.href, y: Math.round(e.rect?.y ?? 0),
})

async function snapshotViewports(page, snapJs) {
  const out = []
  const dims = await page.evaluate(() => ({ h: innerHeight, sh: document.documentElement.scrollHeight }))
  for (let k = 0; k < VIEWPORTS; k++) {
    const y = Math.round(k * dims.h * 0.9)
    if (k > 0 && y >= dims.sh - dims.h * 0.3) break
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y)
    await page.waitForTimeout(k === 0 ? 300 : 700) // lazy content
    // A string evaluates over CDP, outside the page's CSP (an in-page eval() would not).
    if (!(await page.evaluate(() => typeof globalThis.__vonSnap === 'function'))) await page.evaluate(snapJs)
    const s = await page.evaluate(() => globalThis.__vonSnap())
    out.push({ scrollY: await page.evaluate(() => Math.round(scrollY)), title: s.title, origin: s.origin, url: s.url,
      truncated: s.truncated, elements: s.elements.map(slim) })
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  return { viewports: out, innerHeight: dims.h, scrollHeight: dims.sh }
}

async function main() {
  const snapJs = fs.readFileSync(await bundle('snapshot-entry.ts', 'iife'), 'utf8')
  const done = new Set(readJsonl(OUT).map((r) => r.pageId))
  const browser = await chromium.launch({ headless: !args.headed, executablePath: findChromium() })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 }, locale: 'en-US', bypassCSP: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  const queue = seeds().map((s) => ({ ...s, depth: 0 }))
  let visited = 0, saved = 0
  const limit = Number(args.limit) || Infinity
  while (queue.length && saved < limit) {
    const item = queue.shift()
    if (FORBIDDEN.test(item.url)) throw new Error(`refusing to collect a held-out eval fixture: ${item.url}`)
    const pageId = sha(item.url).slice(0, 16)
    if (done.has(pageId)) continue
    done.add(pageId)
    visited++
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {})
      // A page can wedge an evaluate forever (busy main thread); never let one stall the crawl.
      const snap = await Promise.race([snapshotViewports(page, snapJs),
        new Promise((_, rej) => setTimeout(() => rej(new Error('snapshot timed out')), 60_000))])
      const n = snap.viewports[0]?.elements.length ?? 0
      if (n < 3) { log(`skip (${n} elements) ${item.url}`); continue }
      const finalUrl = page.url()
      appendJsonl(OUT, { pageId, url: item.url, finalUrl, site: siteOf(finalUrl), split: splitOf(finalUrl),
        category: item.category, depth: item.depth, ...snap })
      saved++
      log(`${saved} saved · ${snap.viewports.map((v) => v.elements.length).join('/')} el · ${item.category} ${finalUrl}`)
      if (item.depth < 1 && FOLLOW > 0) {
        // A few same-site links per seed: product/detail/sign-up pages are where
        // forms and dense button grids live, and landing pages alone are samey.
        const site = siteOf(finalUrl)
        const links = [...new Set(snap.viewports.flatMap((v) => v.elements).map((e) => e.href)
          .filter((h) => h && /^https?:/.test(h) && !SKIP_LINK.test(h) && siteOf(h) === site && h.split('#')[0] !== finalUrl.split('#')[0]))]
        for (const h of shuffle(links, rng(pageId)).slice(0, FOLLOW))
          queue.push({ category: item.category, url: h.split('#')[0], depth: item.depth + 1 })
      }
    } catch (err) {
      log(`fail ${item.url}: ${String(err.message ?? err).split('\n')[0].slice(0, 120)}`)
    }
  }
  await browser.close()
  log(`done: ${saved} pages saved of ${visited} visited → ${OUT}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
