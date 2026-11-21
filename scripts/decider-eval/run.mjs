// The decider eval: drives the built extension (dist/) through answer-keyed fixture tasks with a
// real chat model, per arm (decider off / shadow / assist), and scores the chat model's and the
// decider's step choices against each state's answer key (keys.mjs, report.mjs).
//
//   node scripts/decider-eval/run.mjs --arms shadow,assist [--tasks id,…] [--reps 1]
//        [--provider lmstudio|anthropic] [--cap 10] [--threshold 0.6] [--dry-run]
//
// LM Studio (google/gemma-4-26b-a4b at 127.0.0.1:1234) is the default, per CLAUDE.md.
// --provider anthropic is the explicit opt-in: claude-sonnet-5-5 with the key read from
// ~/.config/lychee-eval/key (never printed), under a spend cap; the run's `finally` overwrites
// `settings` with the LM Studio provider so the key never persists in the profile.
//
// The profile is persistent (~/.cache/lychee-decider-eval/profile) so the ~4.6 GB OPFS model
// import happens once. See README.md.
import { chromium } from 'playwright'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_IDS } from './keys.mjs'
import { DEFAULT_THRESHOLD, scoreRow, summarize, taskCost, usageOf, writeReport } from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const FIX = join(HERE, 'fixtures')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`)

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const [k, inline] = a.slice(2).split('=', 2)
    if (k === 'dry-run' || k === 'help') out[k] = true
    else out[k] = inline ?? argv[++i]
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(readFileSync(join(HERE, 'README.md'), 'utf8'))
  process.exit(0)
}
const ARMS = (args.arms ?? 'shadow').split(',').map((s) => s.trim()).filter(Boolean)
const ONLY = args.tasks ? args.tasks.split(',').map((s) => s.trim()).filter(Boolean) : null
const REPS = Number(args.reps ?? 1)
const PROVIDER_KIND = args.provider ?? (process.env.PROVIDER === 'anthropic' ? 'anthropic' : 'lmstudio')
const CAP = Number(args.cap ?? 10)
const THRESHOLD = args.threshold === undefined ? undefined : Number(args.threshold)
const DRY = !!args['dry-run']
const PROFILE = resolve(args.profile ?? join(homedir(), '.cache', 'lychee-decider-eval', 'profile'))
const DIST = resolve(args.dist ?? join(REPO, 'dist'))
const EXPORT_DIR = resolve(args['export-dir'] ?? join(homedir(), 'lychee-decider', 'strands-decider-E2B-gemma4-v2-2611'))
const OUT = resolve(args.out ?? join(HERE, 'out'))
const PORT = Number(args.port ?? 8770)
const TIMEOUT = Number(args['timeout-min'] ?? 8) * 60_000

for (const arm of ARMS) if (!['off', 'shadow', 'assist'].includes(arm)) throw new Error(`unknown arm "${arm}" (off, shadow, assist)`)
if (!['lmstudio', 'anthropic'].includes(PROVIDER_KIND)) throw new Error(`unknown provider "${PROVIDER_KIND}" (lmstudio, anthropic)`)
if (!(REPS >= 1)) throw new Error('--reps must be ≥ 1')
if (!(CAP > 0)) throw new Error('--cap must be > 0')
if (THRESHOLD !== undefined && !(THRESHOLD >= 0.4 && THRESHOLD <= 0.95)) throw new Error('--threshold must be within 0.4–0.95')
if (ONLY) for (const id of ONLY) if (!TASK_IDS.includes(id)) throw new Error(`unknown task "${id}"; known: ${TASK_IDS.join(', ')}`)
if (!existsSync(join(DIST, 'manifest.json'))) throw new Error(`no built extension at ${DIST} — run npm run build`)

// ── providers ─────────────────────────────────────────────────────────────────────────────────
const LMSTUDIO = { id: 'p1', kind: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'x', models: ['google/gemma-4-26b-a4b'] }
function anthropicProvider() {
  const file = resolve(args['key-file'] ?? join(homedir(), '.config', 'lychee-eval', 'key'))
  if (!existsSync(file)) throw new Error(`--provider anthropic needs the API key in ${file} (mode 0600)`)
  if (statSync(file).mode & 0o077) log(`warning: ${file} is readable by other users; chmod 600 it`)
  const apiKey = readFileSync(file, 'utf8').trim()
  if (!apiKey) throw new Error(`${file} is empty`)
  return { id: 'p1', kind: 'anthropic', name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', apiKey, models: ['claude-sonnet-5-5'] }
}
const PROVIDER = PROVIDER_KIND === 'anthropic' ? anthropicProvider() : LMSTUDIO
const MODEL = PROVIDER.models[0]

/** Only fields under test, per CLAUDE.md: a malformed optional field unmounts the whole panel. */
function settingsFor(provider, arm) {
  const s = {
    providers: [provider],
    selected: { providerId: provider.id, modelId: provider.models[0] },
    tabAccess: 'active-tab',
    onboarded: true,
    turnTrace: true,
  }
  // The profile's 32k default would start compacting a long task at 24k tokens.
  if (provider.kind === 'lmstudio') s.modelConfigs = { [provider.models[0]]: { contextLimit: 262144 } }
  if (arm && arm !== 'off') s.decider = THRESHOLD === undefined ? { mode: arm } : { mode: arm, actThreshold: THRESHOLD }
  return s
}

// The five profile memories (Task 11), at fixed timestamps so the decider's lookup cache is stable.
const MEMORY_AT = Date.UTC(2026, 10, 1)
const PROFILE_MEMORIES = [
  "The user's full name is Ada Lovelace.",
  "The user's email address is ada@example.com.",
  "The user's work email is ada@analytical-engines.co.uk.",
  "The user's phone number is +44 20 7946 0958.",
  "The user's home address is 12 St James's Square, London SW1Y 4JH, United Kingdom.",
].map((content, i) => ({
  id: `eval-profile-${i + 1}`, kind: 'profile', content, tags: ['profile'],
  createdAt: MEMORY_AT, updatedAt: MEMORY_AT, lastRecalledAt: null, recallCount: 0, source: 'user',
}))

// ── tasks ─────────────────────────────────────────────────────────────────────────────────────
const cartOf = (fx) => fx.evaluate(() => JSON.parse(localStorage.getItem('cart') || '[]'))
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const submittedOf = (fx) => fx.evaluate(() => window.__submitted ?? null)
const n = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
/** "12 December", "12th of Dec", "December 12", "Dec. 12th". */
const DATE = (day, month) => new RegExp(`(\\b${day}(st|nd|rd|th)?\\s+(of\\s+)?${month}\\b|\\b${month}\\.?\\s+${day}(st|nd|rd|th)?\\b)`, 'i')

/** ◆ `assist: true` marks the tasks the assist arm runs on (its AutofillForm path is form-only). */
const TASKS = [
  { id: 'shop-cheapest', family: 'store', page: 'store/index.html',
    prompt: 'Search this store for wireless headphones and add the cheapest wireless headphones under $100 to my cart.',
    check: async ({ fx }) => sameJSON(await cartOf(fx), ['Arc wireless headphones']) },
  { id: 'shop-qty', family: 'store', page: 'store/index.html',
    prompt: 'Find the Orbit wireless speaker and add 2 of them to my cart.',
    check: async ({ fx }) => sameJSON(await cartOf(fx), ['Orbit wireless speaker', 'Orbit wireless speaker']) },
  { id: 'shop-mug', family: 'store', page: 'store/index.html',
    prompt: 'Add the blue Aurora mug to my cart.',
    check: async ({ fx }) => sameJSON(await cartOf(fx), ['Aurora mug (blue)']) },
  { id: 'shop-price', family: 'store', page: 'store/index.html',
    prompt: 'How much are the Pulse wireless earbuds here?',
    check: async ({ reply }) => reply.includes('$39') },
  { id: 'dense-catalog', family: 'store', page: 'store/catalog.html',
    prompt: 'Add the Halo noise-cancelling wireless headphones to my cart.',
    check: async ({ fx }) => sameJSON(await cartOf(fx), ['Halo noise-cancelling wireless headphones']) },
  { id: 'form-contact', family: 'form', assist: true, page: 'form.html',
    prompt: 'On this page, fill in the contact form with my details — name Ada Lovelace, email ada@example.com, topic Billing, message "My last invoice was charged twice." — tick the box agreeing to be contacted, and send it.',
    check: async ({ fx }) => { const d = await submittedOf(fx); return !!d && d.fullname === 'Ada Lovelace' && d.email === 'ada@example.com' && d.topic === 'Billing' && d.consent === 'on' } },
  { id: 'form-sales', family: 'form', assist: true, page: 'form.html',
    prompt: 'Fill in the contact form with name Ada Lovelace, email ada@example.com, topic Sales, message "Do you offer volume discounts?". Don\'t include my phone number. Send it.',
    check: async ({ fx }) => { const d = await submittedOf(fx); return !!d && d.topic === 'Sales' && (d.phone ?? '') === '' } },
  { id: 'form-shipping', family: 'form', assist: true, page: 'shipping.html',
    prompt: 'Fill in the shipping form with my details, choose express delivery, accept the terms and continue.',
    check: async ({ fx }) => {
      const d = await submittedOf(fx)
      return !!d && n(d.full_name) === 'ada lovelace' && n(d.street) === "12 st james's square" && n(d.city) === 'london' &&
        n(d.postcode) === 'sw1y 4jh' && d.country === 'United Kingdom' && d.delivery === 'express' && d.terms === 'on'
    } },
  { id: 'form-newsletter', family: 'form', assist: true, page: 'signup.html',
    prompt: 'Sign me up for the newsletter with my personal email, interested in Audio only.',
    check: async ({ fx }) => {
      const d = await submittedOf(fx)
      return !!d && n(d.email) === 'ada@example.com' && n(d.first) === 'ada' && n(d.last) === 'lovelace' && sameJSON(d.interests, ['audio'])
    } },
  { id: 'nav-returns', family: 'nav', page: 'help/index.html',
    prompt: 'Using this help site, find the returns policy page and tell me how many days I have to return an item.',
    check: async ({ reply }) => /\b45\b/.test(reply) },
  { id: 'nav-warranty', family: 'nav', page: 'help/index.html',
    prompt: 'How long is the warranty on headphones? Use this help site.',
    check: async ({ reply }) => /\b2[- ]year/i.test(reply) },
  { id: 'nav-express', family: 'nav', page: 'help/index.html',
    prompt: 'What does express delivery cost, according to this help site?',
    check: async ({ reply }) => reply.includes('12.99') },
  { id: 'inbox-bill', family: 'inbox', page: 'inbox.html',
    prompt: 'Check my inbox and tell me how much my Acme Energy bill is and when it is due.',
    check: async ({ reply }) => reply.includes('84.20') && DATE(12, 'Dec(ember)?').test(reply) },
  { id: 'inbox-order', family: 'inbox', page: 'inbox.html',
    prompt: 'When is my Northwind Store order expected to arrive?',
    check: async ({ reply }) => DATE(25, 'Nov(ember)?').test(reply) },
  { id: 'inbox-library', family: 'inbox', page: 'inbox.html',
    prompt: 'Which book is due back at the library, and when?',
    check: async ({ reply }) => reply.includes('Analytical Engine') && DATE(28, 'Nov(ember)?').test(reply) },
  // "Not $10 as the answer": the offer's $10 must not appear at all (a whole-dollar $10, not $10.5x).
  { id: 'inbox-lookalike', family: 'inbox', page: 'inbox.html',
    prompt: 'What amount is due on my latest Acme Energy bill?',
    check: async ({ reply }) => reply.includes('84.20') && !/\$\s?10\b(?!\.\d*[1-9])/.test(reply) },
]
if (TASKS.map((t) => t.id).join() !== TASK_IDS.join()) throw new Error('run.mjs TASKS and keys.mjs TASK_IDS disagree')

// ── servers ───────────────────────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' }
/** A static file server bound to 127.0.0.1; `port` 0 picks a free one. Resolves {server, port}. */
function serveDir(root, port, { cors = false } = {}) {
  const base = resolve(root) + sep
  const server = createServer((req, res) => {
    const headers = cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } : {}
    if (req.method === 'OPTIONS') return res.writeHead(204, headers).end()
    const p = normalize(join(base, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    if (!p.startsWith(base)) return res.writeHead(403, headers).end()
    let st
    try {
      st = statSync(p)
      if (!st.isFile()) throw new Error('not a file')
    } catch {
      return res.writeHead(404, headers).end()
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(p).pipe(res)
  })
  return new Promise((ok, fail) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && port !== 0) {
        log(`port ${port} is busy; using a free one`)
        ok(serveDir(root, 0, { cors }))
      } else fail(e)
    })
    server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port }))
  })
}

// ── browser helpers ───────────────────────────────────────────────────────────────────────────
/**
 * Chrome for Testing: $CHROME_BIN, else Playwright's own build, else the newest Chromium in the
 * Playwright cache (the repo's Playwright may expect a build that was never downloaded). Branded
 * Chrome ignores --load-extension, so it is never a fallback.
 */
function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const own = chromium.executablePath()
  if (existsSync(own)) return own
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : []
  const inside = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
  ]
  for (const b of builds) for (const rel of inside) if (existsSync(join(cache, b, rel))) return join(cache, b, rel)
  throw new Error(`no Chrome for Testing found (looked for ${own} and ${cache}/chromium-*); set CHROME_BIN`)
}

async function findExtensionId(ctx) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const sw of ctx.serviceWorkers()) {
      const name = await sw.evaluate(() => chrome.runtime.getManifest().name).catch(() => null)
      if (name && /lychee/i.test(name)) return new URL(sw.url()).host
    }
    await ctx.waitForEvent('serviceworker', { timeout: 2000 }).catch(() => {})
  }
  throw new Error('extension service worker not found')
}

/**
 * Run `fn(page)` on research-tab.html: a static extension page with full chrome.storage and
 * IndexedDB access but none of the app's code. Settings written from the live panel instead could
 * race the app's own secret-sealing migration write (settings.ts `migrateSecretsToSealed`).
 */
async function onQuietPage(ctx, extId, fn) {
  const page = await ctx.newPage()
  try {
    await page.goto(`chrome-extension://${extId}/research-tab.html`)
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
  }
}

const writeSettings = (page, settings) => page.evaluate((s) => chrome.storage.local.set({ settings: s }), settings)
const readSettings = (page) => page.evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings ?? null))

/** Replace every memory with exactly the five profile memories; suppress dreaming for the run. */
async function seedMemories(page) {
  await page.evaluate(async (records) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('lychee-memory', 1)
      // Same schema as src/data/memory.ts, so the app's own open never needs an upgrade.
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('memories')) r.result.createObjectStore('memories', { keyPath: 'id' })
        if (!r.result.objectStoreNames.contains('episodes')) r.result.createObjectStore('episodes', { keyPath: 'id' })
      }
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    await new Promise((res, rej) => {
      const tx = db.transaction(['memories', 'episodes'], 'readwrite')
      tx.objectStore('memories').clear()
      tx.objectStore('episodes').clear()
      for (const m of records) tx.objectStore('memories').put(m)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    // A dream would rewrite these memories (and spend the chat model) mid-run: mark one as just done.
    await chrome.storage.local.set({ dreamState: { lastDreamAt: Date.now(), lastSummary: null, consecutiveParseFailures: 0 } })
  }, PROFILE_MEMORIES)
}

const modelStatus = (page) => page.evaluate(() => chrome.storage.local.get('deciderModel').then((r) => r.deciderModel ?? null))

/** Import the decider into OPFS through the Experimental tab, unless it is already `ready`. */
async function ensureModel(ctx, panelUrl) {
  const manifest = JSON.parse(readFileSync(join(EXPORT_DIR, 'manifest.json'), 'utf8'))
  const page = await ctx.newPage()
  try {
    await page.goto(panelUrl)
    const before = await modelStatus(page)
    if (before?.state === 'ready' && before.modelId === manifest.modelId) {
      log(`decider model ready (${before.modelId}, imported ${new Date(before.importedAt).toISOString()})`)
      return before
    }
    log(`decider model ${before ? before.state : 'absent'} — importing ${EXPORT_DIR} through the Experimental tab`)
    const { server, port } = await serveDir(EXPORT_DIR, 0, { cors: true })
    try {
      await page.reload()
      await page.locator('button[title="Settings"]').click({ timeout: 15_000 })
      await page.locator('#settings-experimental').click()
      await page.locator('input[aria-label="Model folder URL"]').fill(`http://127.0.0.1:${port}/`)
      const t0 = Date.now()
      await page.getByRole('button', { name: 'Import from URL…' }).click()
      let lastLog = 0
      for (;;) {
        await sleep(500)
        const s = await modelStatus(page)
        if (s?.state === 'ready') {
          if (s.modelId !== manifest.modelId) throw new Error(`imported ${s.modelId}, expected ${manifest.modelId}`)
          log(`decider model imported in ${Math.round((Date.now() - t0) / 1000)} s`)
          return s
        }
        if (s?.state === 'failed') throw new Error(`decider import failed: ${s.message}`)
        const alert = page.locator('.settings-tabpane [role="alert"]')
        if (await alert.count()) throw new Error(`decider import failed: ${await alert.innerText()}`)
        if (Date.now() - lastLog > 10_000) {
          lastLog = Date.now()
          log(`  importing… ${s?.total ? `${Math.round((100 * s.done) / s.total)}%` : s?.state ?? '—'}`)
        }
        if (Date.now() - t0 > 30 * 60_000) throw new Error('decider import timed out after 30 min')
      }
    } finally {
      server.close()
    }
  } finally {
    await page.close()
  }
}

/** Read what one task left in the app's own stores. Never creates a database the app owns. */
const readStores = (panel, since, promptHead) =>
  panel.evaluate(
    async ({ since, promptHead }) => {
      const names = new Set((await indexedDB.databases()).map((d) => d.name))
      const open = (name) =>
        new Promise((res) => {
          if (!names.has(name)) return res(null)
          const r = indexedDB.open(name)
          r.onupgradeneeded = () => r.transaction.abort()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res(null)
        })
      const all = (db, store) =>
        new Promise((res) => {
          try {
            const r = db.transaction(store).objectStore(store).getAll()
            r.onsuccess = () => res(r.result)
            r.onerror = () => res([])
          } catch {
            res([])
          }
        })
      const cdb = await open('lychee-conversations')
      const tdb = await open('lychee-traces')
      const ddb = await open('lychee-decider')
      const recent = (cdb ? await all(cdb, 'conversations') : []).filter((c) => (c.updatedAt ?? 0) >= since)
      const mine = recent.filter((c) => JSON.stringify(c.messages ?? []).includes(promptHead))
      const convs = (mine.length ? mine : recent).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      const convIds = new Set(convs.map((c) => c.id))
      const traces = (tdb ? await all(tdb, 'traces') : [])
        .filter((t) => (t.createdAt ?? 0) >= since && (!convIds.size || convIds.has(t.conversationId)))
        .sort((a, b) => a.createdAt - b.createdAt)
      let shadow = (ddb ? await all(ddb, 'shadow') : []).filter((r) => (r.at ?? 0) >= since)
      if (shadow.some((r) => convIds.has(r.conversationId))) shadow = shadow.filter((r) => convIds.has(r.conversationId))
      for (const db of [cdb, tdb, ddb]) db?.close()
      const tools = []
      const seen = new Set()
      let reply = ''
      for (const c of convs)
        for (const m of c.messages ?? []) {
          for (const p of m.parts ?? [])
            if (p?.type === 'tool' && p.toolCallId && !seen.has(p.toolCallId)) {
              seen.add(p.toolCallId)
              tools.push({ toolName: p.toolName, input: p.input, output: p.output, state: p.state })
            }
          if (m.role === 'assistant') {
            const t = (m.parts ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
            if (t.trim()) reply = t
          }
        }
      const steps = traces.flatMap((t) => [...(t.steps ?? [])].sort((a, b) => a.index - b.index))
      const traceCalls = steps.flatMap((s) => (s.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.ok, at: s.startedAt })))
      return { conversationIds: [...convIds], tools, reply, steps, traceCalls, shadow: shadow.sort((a, b) => a.seq - b.seq || a.at - b.at) }
    },
    { since, promptHead },
  )

/** Shadow writes are fire-and-forget; give a slow (WASM) decision time to land before reading. */
async function settleShadow(panel, since) {
  const count = () =>
    panel.evaluate(async (since) => {
      if (!(await indexedDB.databases()).some((d) => d.name === 'lychee-decider')) return 0
      const db = await new Promise((res) => {
        const r = indexedDB.open('lychee-decider')
        r.onupgradeneeded = () => r.transaction.abort()
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(null)
      })
      if (!db) return 0
      const rows = await new Promise((res) => {
        try {
          const r = db.transaction('shadow').objectStore('shadow').getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res([])
        } catch {
          res([])
        }
      })
      db.close()
      return rows.filter((r) => (r.at ?? 0) >= since).length
    }, since)
  let last = -1
  let stableSince = Date.now()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const c = await count().catch(() => last)
    if (c !== last) {
      last = c
      stableSince = Date.now()
    } else if (Date.now() - stableSince > 2500) break
    await sleep(500)
  }
}

let interrupted = false

/** `progress.sentAt` is set the moment the prompt is about to go out (see the error path in main). */
async function runTask(ctx, extId, origin, task, arm, rep, progress = {}) {
  const panelUrl = `chrome-extension://${extId}/sidepanel.html`
  await onQuietPage(ctx, extId, (p) => writeSettings(p, settingsFor(PROVIDER, arm)))
  const panel = await ctx.newPage()
  const fx = await ctx.newPage()
  try {
    await panel.goto(panelUrl)
    const timeline = []
    fx.on('framenavigated', (f) => {
      if (f === fx.mainFrame()) timeline.push({ at: Date.now(), url: f.url() })
    })
    const startUrl = `${origin}/${task.page}`
    await fx.goto(startUrl)
    await fx.evaluate(() => localStorage.clear())
    await fx.reload()
    const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, fx.url())
    if (tabId === undefined) throw new Error(`fixture tab ${fx.url()} not found`)
    await panel.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId)
    await panel.reload()
    const composer = panel.locator('textarea').first()
    await composer.waitFor({ timeout: 20_000 })
    await sleep(2500)
    const live = await readSettings(panel)
    if ((live?.decider?.mode ?? 'off') !== arm || live?.selected?.modelId !== MODEL)
      throw new Error(`settings did not take: decider ${JSON.stringify(live?.decider)}, model ${live?.selected?.modelId}`)

    if (DRY) {
      await composer.fill(task.prompt)
      const held = await composer.inputValue()
      if (held !== task.prompt) throw new Error('the composer did not take the prompt')
      const fields = task.family === 'form' ? await fx.evaluate(() => (typeof window.__fields === 'function' ? Object.keys(window.__fields()) : null)) : null
      if (task.family === 'form' && !fields?.length) throw new Error(`${task.page} has no window.__fields()`)
      log(`dry-run ${task.id}/${arm}: composer ready, fixture ${fx.url()} (tab ${tabId}), decider ${JSON.stringify(live.decider ?? 'omitted')}${fields ? `, fields [${fields.join(' | ')}]` : ''} — not sent`)
      await composer.fill('')
      return null
    }

    const since = Date.now()
    log(`${task.id}/${arm}/${rep}: start`)
    await composer.fill(task.prompt)
    // Set just before the prompt can leave: from here on a harness error may have cost money.
    progress.sentAt = since
    await composer.press('Enter')
    const approvals = []
    let seen = false
    let idle = 0
    let ended = 'timeout'
    while (Date.now() - since < TIMEOUT) {
      if (interrupted) {
        ended = 'interrupted'
        break
      }
      await sleep(400)
      const card = panel.locator('.approval-card').first()
      if (await card.count()) {
        const head = ((await card.locator('.approval-header').textContent().catch(() => '')) ?? '').trim()
        if (!(approvals.at(-1)?.head === head && Date.now() - approvals.at(-1).at < 5000)) {
          approvals.push({ head, at: Date.now() })
          log(`  approve: ${head.slice(0, 90)}`)
        }
        await card.locator('button.btn.primary, button.btn.danger-solid').last().click().catch(() => {})
        for (let k = 0; k < 20; k++) {
          await sleep(150)
          const still = await panel.locator('.approval-card .approval-header').first().textContent({ timeout: 200 }).catch(() => null)
          if (still?.trim() !== head) break
        }
        idle = 0
        continue
      }
      if (await panel.locator('button.send-btn.stop').count()) {
        seen = true
        idle = 0
        continue
      }
      // The Stop button shows the moment a turn starts, however slowly the model then loads.
      if (!seen && Date.now() - since > 60_000) {
        ended = 'never-started'
        break
      }
      if (seen) {
        idle ||= Date.now()
        if (Date.now() - idle > 4000) {
          ended = 'turn-ended'
          break
        }
      }
    }
    const wallMs = (ended === 'turn-ended' ? idle : Date.now()) - since
    if (ended !== 'turn-ended') await panel.locator('button.send-btn.stop').click().catch(() => {})
    if (arm !== 'off') await settleShadow(panel, since)
    await sleep(1500)
    const db = await readStores(panel, since, task.prompt.slice(0, 20))
    const reply = db.reply
    let success = false
    try {
      success = !!(await task.check({ fx, reply }))
    } catch {
      success = false
    }
    const form = task.family === 'form'
    const fields = form ? await fx.evaluate(() => (typeof window.__fields === 'function' ? window.__fields() : null)).catch(() => null) : null
    const submitted = form ? await submittedOf(fx).catch(() => null) : null
    return {
      task: task.id, family: task.family, arm, rep, assist: !!task.assist, provider: PROVIDER.kind, model: MODEL, prompt: task.prompt,
      success, ended, wallMs, startUrl, finalUrl: fx.url(),
      llmSteps: db.steps.length, llmStepMs: db.steps.map((s) => s.durationMs), ...usageOf(db.steps),
      // A stopped turn may have written no trace: then the cap is charged the reserve.
      cost: taskCost(db.steps, { providerKind: PROVIDER.kind, sent: true }),
      approvals: approvals.map((a) => a.head), reply, conversationIds: db.conversationIds,
      tools: db.tools, traceCalls: db.traceCalls, urlTimeline: timeline, shadow: db.shadow, fields, submitted,
    }
  } finally {
    await fx.close().catch(() => {})
    await panel.close().catch(() => {})
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString()
const tasks = TASKS.filter((t) => !ONLY || ONLY.includes(t.id))
const needsModel = ARMS.some((a) => a !== 'off')
log(`provider ${PROVIDER.kind} (${MODEL}); arms ${ARMS.join(',')}; ${tasks.length} task(s) × ${REPS} rep(s); cap $${CAP}${DRY ? '; DRY RUN' : ''}`)
log(`profile ${PROFILE}; dist ${DIST}`)

const { server: fixtureServer, port } = await serveDir(FIX, PORT)
const origin = `http://127.0.0.1:${port}`
let ctx
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: chromeBinary(),
    headless: false,
    viewport: { width: 1280, height: 900 },
    // We handle Ctrl-C ourselves: the browser must stay up long enough to scrub the API key.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
} catch (e) {
  fixtureServer.close()
  const busy = /ProcessSingleton|already in use|SingletonLock/i.test(String(e?.message))
  throw new Error(busy ? `the profile ${PROFILE} is in use by another Chrome — close it, or pass --profile <dir>` : String(e?.message ?? e))
}
const onSignal = () => {
  if (interrupted) process.exit(130)
  interrupted = true
  log('interrupted — finishing the current step, then scrubbing settings (Ctrl-C again to force)')
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const rows = []
const skipped = []
let spent = 0
let capReached = false
let deciderModel = null
let extId
let fatal = null
try {
  extId = await findExtensionId(ctx)
  const panelUrl = `chrome-extension://${extId}/sidepanel.html`
  await onQuietPage(ctx, extId, async (p) => {
    // Scrub first: a crashed earlier anthropic run may have left its key here.
    await writeSettings(p, settingsFor(LMSTUDIO, 'off'))
    await seedMemories(p)
  })
  log(`extension ${extId}; settings scrubbed to LM Studio; ${PROFILE_MEMORIES.length} profile memories seeded`)
  if (needsModel) deciderModel = await ensureModel(ctx, panelUrl)

  outer: for (let rep = 1; rep <= REPS; rep++)
    for (const task of tasks)
      for (const arm of ARMS) {
        if (interrupted) break outer
        if (arm === 'assist' && !task.assist) {
          if (rep === 1) skipped.push({ task: task.id, arm, reason: 'assist runs on ◆ form tasks only' })
          continue
        }
        if (spent + 0.5 > CAP) {
          capReached = true
          log(`cap reached: spent $${spent.toFixed(3)} + $0.50 margin > $${CAP}; stopping before ${task.id}/${arm}/${rep}`)
          break outer
        }
        let row
        const progress = { sentAt: null }
        try {
          row = await runTask(ctx, extId, origin, task, arm, rep, progress)
        } catch (e) {
          log(`${task.id}/${arm}/${rep}: harness error: ${e?.message ?? e}`)
          if (DRY) throw e
          // The turn may have run (and been paid for) before the harness broke: charge the cap
          // from whatever trace usage is readable, else the reserve (taskCost).
          let steps = null
          if (progress.sentAt)
            steps = await onQuietPage(ctx, extId, async (p) => (await readStores(p, progress.sentAt, task.prompt.slice(0, 20))).steps).catch(() => null)
          const cost = taskCost(steps, { providerKind: PROVIDER.kind, sent: !!progress.sentAt })
          row = { task: task.id, family: task.family, arm, rep, assist: !!task.assist, provider: PROVIDER.kind, model: MODEL, prompt: task.prompt,
            success: false, ended: 'harness-error', error: String(e?.message ?? e), wallMs: progress.sentAt ? Date.now() - progress.sentAt : 0,
            llmSteps: steps?.length ?? 0, ...usageOf(steps ?? []), cost, tools: [], traceCalls: [], urlTimeline: [], shadow: [] }
          log(`  charged $${cost.high.toFixed(3)} against the cap (${cost.estimated})`)
        }
        if (!row) continue // dry run
        spent += row.cost.high
        row.score = scoreRow(row, THRESHOLD ?? DEFAULT_THRESHOLD)
        rows.push(row)
        const s = row.score
        log(
          `${task.id}/${arm}/${rep}: success=${row.success} ${row.ended} ${Math.round(row.wallMs / 1000)}s steps=${row.llmSteps} ` +
            `ControlPage=${s.controlCalls} keyed=${s.keyed} chat✓=${s.chatCorrect} decider✓=${s.decider.correct}/${s.decider.keyed} ` +
            `records=${s.decider.records} unpaired=${s.unpaired.calls}/${s.unpaired.records} cost≈$${row.cost.low.toFixed(3)}–$${row.cost.high.toFixed(3)} spent=$${spent.toFixed(3)}`,
        )
      }
} catch (e) {
  // Keep what already ran (a hosted run's tasks cost money): the report is written below.
  fatal = String(e?.stack ?? e)
  log(`FATAL: ${e?.message ?? e}`)
} finally {
  if (PROVIDER.kind === 'anthropic') {
    try {
      // Every panel page is closed by now (runTask's finally), so nothing can write the key back.
      const kinds = await onQuietPage(ctx, extId ?? (await findExtensionId(ctx)), async (p) => {
        await writeSettings(p, settingsFor(LMSTUDIO, 'off'))
        await sleep(1000)
        return (await readSettings(p))?.providers?.map((x) => x.kind)
      })
      if (JSON.stringify(kinds) !== '["lmstudio"]') throw new Error(`providers after scrub: ${JSON.stringify(kinds)}`)
      log('settings scrubbed: the Anthropic key is no longer in the profile')
    } catch (e) {
      log(`WARNING: could not scrub the Anthropic key from ${PROFILE} (${e?.message ?? e}); the next run scrubs it at startup, or delete the profile`)
    }
  }
  await ctx.close().catch(() => {})
  fixtureServer.close()
}

if (DRY) {
  log(fatal ? 'dry run FAILED' : 'dry run complete — nothing sent, no report written')
} else if (rows.length || !fatal) {
  const results = {
    meta: {
      startedAt, finishedAt: new Date().toISOString(), provider: PROVIDER.kind, model: MODEL, arms: ARMS, reps: REPS,
      tasks: tasks.map((t) => t.id), threshold: THRESHOLD ?? DEFAULT_THRESHOLD, cap: CAP, spent: +spent.toFixed(4), capReached, interrupted,
      skipped, deciderModel: deciderModel ? `${deciderModel.modelId} (${deciderModel.bytes} bytes)` : null, fixtureOrigin: origin, fatal,
    },
    summary: summarize(rows),
    rows,
  }
  const dir = writeReport(results, OUT)
  log(`report: ${join(dir, 'report.md')}`)
  if (capReached) log('cap reached')
}
process.exit(fatal ? 1 : interrupted ? 130 : 0)
