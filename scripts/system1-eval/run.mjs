#!/usr/bin/env node
// Real-browser evaluation of the experimental System-1 (Von) feature. See
// README.md for how to build the eval extension and what each phase measures.
// Follows CLAUDE.md's "Browser-automation testing of agent capabilities"
// harness: a persistent, headed Chromium with the unpacked build, LM Studio's
// google/gemma-4-26b-a4b as the only model endpoint.
//
// Phases (EVAL_PHASES, comma-separated; default all):
//   download  — turn the toggle on in Settings → General → Experimental, wait
//               for Ready (the pinned Hugging Face URLs are 302'd to a local
//               server over scripts/export-von/out), click
//               "Run a test decision".
//   parity    — the exporter's golden cases through the real worker on WebGPU,
//               vs the golden fp32 probabilities.
//   grounding — cases.json through the real actLoop target question.
//   llm       — the same candidate lists put to gemma (one completion each).
//   e2e       — three composer-driven tasks × EVAL_E2E_REPS (default 3) ×
//               EVAL_E2E_MODES (default off,on,forced; forced = toggle on + the
//               prompt asks for Act).
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeReport } from './report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const env = process.env
const require = createRequire(import.meta.url)

const DIST = path.resolve(env.EVAL_DIST ?? path.join(repo, 'dist'))
const MODEL_DIR = path.resolve(env.EVAL_MODEL_DIR ?? path.join(repo, 'scripts/export-von/out'))
const PIN_REPO = env.EVAL_PIN_REPO ?? 'local/von'
const PIN_REV = env.EVAL_PIN_REV ?? 'local'
const LM_URL = env.EVAL_LM_URL ?? 'http://127.0.0.1:1234/v1'
const LM_MODEL = env.EVAL_LM_MODEL ?? 'google/gemma-4-26b-a4b'
const PHASES = new Set((env.EVAL_PHASES ?? 'download,parity,grounding,llm,e2e').split(','))
const OUT_DIR = path.resolve(env.EVAL_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'system1-eval-')))
const PROFILE = env.EVAL_PROFILE ? path.resolve(env.EVAL_PROFILE) : fs.mkdtempSync(path.join(os.tmpdir(), 'system1-profile-'))
const CHROMIUM = env.EVAL_CHROMIUM ?? findChromium()
const { chromium } = require(env.EVAL_PLAYWRIGHT ?? 'playwright')

function findChromium() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (fs.existsSync(p)) return p
  }
  throw new Error('No Playwright Chromium found — set EVAL_CHROMIUM (branded Chrome ignores --load-extension).')
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
const round = (x, n = 4) => (x == null ? x : Math.round(x * 10 ** n) / 10 ** n)

// ---------------------------------------------------------------------------
// Fixture server
function serveFixtures() {
  // Also serves the exported model under /model/ — the pinned Hugging Face
  // URLs are 302'd here, since Playwright's route.fulfill base64-encodes its
  // body and cannot carry a 600 MB file.
  const root = path.join(here, 'fixtures')
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname
    const isModel = u.startsWith('/model/')
    const p = path.join(isModel ? MODEL_DIR : root, path.basename(u))
    if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': isModel ? 'application/octet-stream' : 'text/html; charset=utf-8', 'content-length': fs.statSync(p).size })
    fs.createReadStream(p).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

// ---------------------------------------------------------------------------
// Harness bundle: the real src/ modules, evaluated inside an extension page.
function bundleHarness() {
  const pin = JSON.stringify({ repo: PIN_REPO, revision: PIN_REV, manifestSha256: 'eval' })
  const out = path.join(OUT_DIR, 'harness.js')
  execFileSync(path.join(repo, 'node_modules/.bin/esbuild'), [
    path.join(here, 'harness.ts'), '--bundle', '--format=iife', '--platform=browser', '--target=es2022',
    // MODE too: weightsManifest.ts honours the pin override only in this mode.
    `--define:import.meta.env.MODE=${JSON.stringify('system1-eval')}`,
    `--define:import.meta.env.VITE_SYSTEM1_PIN=${JSON.stringify(pin)}`, `--outfile=${out}`, '--log-level=warning',
  ])
  return fs.readFileSync(out, 'utf8')
}

// ---------------------------------------------------------------------------
async function main() {
  if (PHASES.has('rederive')) return rederive()
  log('dist', DIST)
  log('out', OUT_DIR, '| profile', PROFILE)
  const startedAt = new Date().toISOString()
  const report = { env: {}, skipped: [] }
  const lmUp = await fetch(`${LM_URL}/models`).then((r) => r.ok, () => false)
  report.env.lmStudio = lmUp ? 'up' : 'down'
  if (!lmUp) {
    for (const p of ['llm', 'e2e']) if (PHASES.has(p)) { PHASES.delete(p); report.skipped.push(`${p}: LM Studio at ${LM_URL} is not reachable`) }
  }

  const { server, port } = await serveFixtures()
  const fixtureUrl = (p) => `http://127.0.0.1:${port}/${p}`
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROMIUM,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      // The panel is driven as a background tab during e2e (the fixture tab
      // must be the active one); keep its timers and renderer at full speed.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ],
  })
  try {
    // Serve the pinned Hugging Face URLs from the local export.
    await ctx.route(`https://huggingface.co/${PIN_REPO}/resolve/${PIN_REV}/**`, (route) => {
      const name = path.basename(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${port}/model/${name}` } })
    })

    const extId = await findExtensionId(ctx)
    log('extension', extId)
    const panel = await ctx.newPage()
    const panelUrl = `chrome-extension://${extId}/sidepanel.html`
    await panel.goto(panelUrl)
    await sleep(500)
    const gpu = await panel.evaluate(async () => {
      if (!navigator.gpu) return { available: false, reason: 'navigator.gpu undefined' }
      const a = await navigator.gpu.requestAdapter()
      if (!a) return { available: false, reason: 'requestAdapter() returned null' }
      return { available: true, vendor: a.info?.vendor, architecture: a.info?.architecture, shaderF16: a.features.has('shader-f16') }
    })
    report.env.webgpu = gpu
    // Version only — the binary path would put the local username in a committed file.
    report.env.userAgent = await panel.evaluate(() => navigator.userAgent)
    report.env.chromium = `${path.basename(CHROMIUM)} ${report.env.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? ''}`.trim()
    log('webgpu', JSON.stringify(gpu))
    await seedSettings(panel, { system1: false })

    if (PHASES.has('download')) report.download = await phaseDownload(panel)
    const ready = await panel.evaluate(async () => !!(await chrome.storage.local.get('system1State')).system1State)
    if (!ready) throw new Error('System-1 weights are not ready — run the download phase (or reuse a profile that has them).')

    let lab = null
    const harness = bundleHarness()
    const needLab = PHASES.has('parity') || PHASES.has('grounding')
    if (needLab) {
      if (!gpu.available) throw new Error(`WebGPU unavailable: ${gpu.reason}`)
      lab = await ctx.newPage()
      await lab.goto(`chrome-extension://${extId}/research-tab.html`)
      await lab.evaluate(harness)
      const wasm = fs.readdirSync(path.join(DIST, 'assets')).find((f) => /^ort-wasm-simd-threaded\.asyncify-.*\.wasm$/.test(f))
      const manifest = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'manifest.json'), 'utf8'))
      const model = manifest.files.find((f) => f.path.endsWith('.onnx')).path
      report.model = { model: manifest.model, variant: manifest.variant, file: model, bytes: manifest.files.find((f) => f.path === model).bytes, cpuParity: manifest.parity }
      const bootMs = await lab.evaluate(([w, m]) => globalThis.__s1eval.boot(`assets/${w}`, m), [wasm, model])
      report.bootMs = bootMs
      log('worker booted in', bootMs, 'ms')
    }
    if (PHASES.has('parity')) report.parity = await phaseParity(lab)
    let grounding = null
    if (PHASES.has('grounding')) {
      grounding = await phaseGrounding(ctx, lab, fixtureUrl)
      report.grounding = summarizeGrounding(grounding)
    }
    if (PHASES.has('llm')) {
      if (!grounding) report.skipped.push('llm: needs the grounding phase in the same run (it reuses its candidate lists)')
      else report.llm = await phaseLlm(grounding)
    }
    if (lab) await lab.close()
    if (PHASES.has('e2e')) report.e2e = await phaseE2e(ctx, panel, panelUrl, fixtureUrl)

    const measured = ['download', 'parity', 'grounding', 'llm', 'e2e'].filter((k) => PHASES.has(k))
    const { skipped, ...sections } = report
    const written = writeReport({ phases: measured, startedAt, finishedAt: new Date().toISOString(), skipped }, sections)
    if (grounding) fs.writeFileSync(path.join(OUT_DIR, 'grounding-raw.json'), JSON.stringify(grounding, null, 1))
    printSummary(written, skipped)
  } finally {
    await ctx.close().catch(() => {})
    server.close()
  }
}

// EVAL_PHASES=rederive: no browser, no model. Recomputes the grounding and e2e
// summaries (and the verdict) from the per-case/per-run rows already in
// report.json — for when only the aggregation code changed.
function rederive() {
  const r = JSON.parse(fs.readFileSync(path.join(here, 'report.json'), 'utf8'))
  const startedAt = new Date().toISOString()
  const sections = {}
  if (r.grounding?.rows) sections.grounding = summarizeGrounding(r.grounding.rows)
  if (r.e2e?.rows) sections.e2e = { rows: r.e2e.rows, summary: summarizeE2e(r.e2e.rows) }
  const written = writeReport({ phases: ['rederive'], startedAt, finishedAt: new Date().toISOString() }, sections)
  printSummary(written, [])
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
  throw new Error('extension service worker not found — did --load-extension take?')
}

async function seedSettings(panel, { system1 }) {
  // Omit every optional field not under test (CLAUDE.md: a malformed optional
  // field unmounts the whole panel). turnTrace records tool NAMES per step,
  // which is how e2e knows whether Act was offered and used.
  await panel.evaluate(async (system1) => {
    const prev = (await chrome.storage.local.get('settings')).settings
    const base = {
      providers: [{ id: 'p1', kind: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'x', models: ['google/gemma-4-26b-a4b'] }],
      selected: { providerId: 'p1', modelId: 'google/gemma-4-26b-a4b' },
      systemPrompt: prev?.systemPrompt ?? 'You are Lychee, a browser agent. Be concise.',
      tabAccess: 'active-tab',
      onboarded: true,
      turnTrace: true,
      modelConfigs: { 'google/gemma-4-26b-a4b': { contextLimit: 262144 } },
    }
    if (system1 !== null) base.experimental = { system1 }
    await chrome.storage.local.set({ settings: base })
  }, system1)
  await panel.reload()
  await sleep(1500)
  const mounted = await panel.evaluate(() => document.getElementById('root')?.childElementCount ?? 0)
  if (!mounted) throw new Error('panel React tree did not mount after seeding settings')
}

// ---------------------------------------------------------------------------
async function phaseDownload(panel) {
  log('download: opening Settings → General → Experimental')
  await panel.locator('button[title*="Settings" i]').first().click()
  await sleep(300)
  await panel.locator('button:has-text("General")').first().click()
  await sleep(300)
  const status = async () => (await panel.locator('p.hint:has-text("Status:")').first().textContent())?.replace(/.*Status:\s*/s, '').trim()
  const box = panel.locator('label.check:has-text("Fast page control") input[type=checkbox]')
  const t0 = Date.now()
  if (!(await box.isChecked())) await box.check()
  let s = ''
  let last = ''
  while (Date.now() - t0 < 30 * 60_000) {
    s = (await status()) ?? ''
    if (s !== last && !/^Downloading/.test(s)) log('download status:', s)
    if (/^Downloading/.test(s) && Date.now() % 15000 < 1000) log('download status:', s)
    last = s
    if (/^Ready|^Failed|unavailable/.test(s)) break
    await sleep(1000)
  }
  const downloadMs = Date.now() - t0
  if (!/^Ready/.test(s)) throw new Error(`download did not reach Ready: ${s}`)
  log('ready after', downloadMs, 'ms — running the Settings test decision')
  const t1 = Date.now()
  await panel.locator('button:has-text("Run a test decision")').click()
  let test = ''
  while (Date.now() - t1 < 180_000) {
    test = (await panel.locator('text=/^(Picked|Failed)/').first().textContent().catch(() => '')) ?? ''
    if (test) break
    await sleep(500)
  }
  log('test decision:', test)
  return { status: s, downloadMs, testDecision: test, testDecisionWallMs: Date.now() - t1 }
}

// ---------------------------------------------------------------------------
async function phaseParity(lab) {
  const golden = JSON.parse(fs.readFileSync(path.join(repo, 'src/system1/__fixtures__/von-golden.json'), 'utf8'))
  const rows = []
  for (const [i, c] of golden.cases.entries()) {
    const options = Object.fromEntries(c.options.map((o, k) => [String(k), o]))
    const r = await lab.evaluate((req) => globalThis.__s1eval.decide(req), { state: c.state, questions: { q: { instructions: c.instructions, options } } })
    const a = r.answers.q
    const got = c.options.map((_, k) => a.probabilities[String(k)])
    const goldArg = c.probs.indexOf(Math.max(...c.probs))
    const deltas = got.map((p, k) => Math.abs(p - c.probs[k]))
    // `probabilities` are rounded to 1e-4 by the worker; `top` is unrounded.
    const topDelta = Math.abs(a.top - c.probs[goldArg])
    rows.push({ case: i, nOptions: c.options.length, tokens: c.ids.length, maxDeltaP: round(Math.max(...deltas, topDelta), 5), argmaxFlip: Number(a.choice) !== goldArg, golden: c.probs.map((p) => round(p)), webgpu: got, ms: r.ms })
    log(`parity case ${i}: max|Δp|=${round(Math.max(...deltas, topDelta), 5)} flip=${Number(a.choice) !== goldArg} ms=${r.ms}`)
  }
  return { cases: rows.length, maxDeltaP: Math.max(...rows.map((r) => r.maxDeltaP)), argmaxFlips: rows.filter((r) => r.argmaxFlip).length, rows }
}

// ---------------------------------------------------------------------------
async function phaseGrounding(ctx, lab, fixtureUrl) {
  const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'))
  const tab = await ctx.newPage()
  const out = []
  for (const [i, c] of cases.entries()) {
    await tab.goto(fixtureUrl(c.page))
    await tab.bringToFront()
    for (const sel of c.setup ?? []) await tab.click(sel)
    await sleep(150)
    const tabId = await lab.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, tab.url())
    const expected = [].concat(c.expect.name)
    const r = await lab.evaluate(([id, goal, values, exp]) => globalThis.__s1eval.groundCase(id, goal, values, exp), [tabId, c.goal, c.values, expected])
    const targets = r.calls.filter((k) => k.kind === 'target')
    const last = targets.at(-1)
    const final = last?.res?.answers?.[last.key]
    const byIdx = new Map(r.elements.map((e) => [String(e.index), e]))
    const picked = final ? byIdx.get(final.choice) : undefined
    const operation = r.calls.find((k) => k.kind === 'operation')?.res?.answers?.operation
    const value = r.calls.find((k) => k.kind === 'value')?.res?.answers?.value
    const expectedPresent = r.elements.some((e) => expected.includes(e.name))
    const candidateOptions = targets.length > 1 ? Object.assign({}, ...targets.slice(0, -1).map((k) => k.req.questions[k.key].options)) : targets[0]?.req.questions[targets[0].key].options
    // Candidate-generation metrics (doc §52): was the right control in the
    // forced operation's target list at all, at what rank, and was it among
    // the controls the state block showed? A miss here is the candidate
    // builder's error, not the policy's.
    const space = r.transitions?.[0]?.space
    const expectedId = r.elements.find((e) => expected.includes(e.name))?.index
    const targetList = space && r.forced ? space.targets[r.forced] ?? [] : []
    const expectedInSpace = expectedId !== undefined && targetList.includes(expectedId)
    const row = {
      i, page: c.page, goal: c.goal, expected, expectedPresent, expectedInSpace,
      candidateRank: expectedInSpace ? targetList.indexOf(expectedId) + 1 : null,
      expectedShown: expectedId !== undefined && !!space?.shown.includes(expectedId),
      nElements: r.elements.length, nCandidates: candidateOptions ? Object.keys(candidateOptions).length : 0,
      space: space ? { operations: space.operations, stats: space.stats } : null,
      tournament: targets.length > 1,
      // Every target round: the tournament's chunk rounds, then the final one.
      rounds: targets.map((k) => {
        const a = k.res?.answers?.[k.key]
        const opts = Object.keys(k.req.questions[k.key].options)
        const hasExpected = opts.some((o) => expected.includes(byIdx.get(o)?.name))
        return { options: opts.length, hasExpected, choice: a ? byIdx.get(a.choice)?.name : null, top: round(a?.top, 3) }
      }),
      picked: picked?.name ?? null, correct: !!picked && expected.includes(picked.name), top: final?.top ?? null,
      status: r.status,
      // The operation head's REAL answer (it was forced to `forced` for the target measurement).
      operation: operation ? { choice: operation.choice, top: round(operation.top), forced: r.forced, correct: operation.choice === r.forced } : null,
      value: value ? { choice: value.choice, top: round(value.top), correct: c.expect.valueKey ? value.choice === c.expect.valueKey : null } : null,
      expectedValueKey: c.expect.valueKey ?? null,
      decideMs: r.calls.filter((k) => k.res).map((k) => ({ kind: k.kind, ms: k.res.ms, wallMs: k.res.wallMs })),
      targetMs: targets.reduce((a, k) => a + (k.res?.ms ?? 0), 0),
      errors: r.calls.filter((k) => k.error).map((k) => k.error),
      // For the LLM baseline: the same state block and the same full candidate list.
      llmInput: targets[0] ? { state: targets[0].req.state, instructions: targets[0].req.questions[targets[0].key].instructions, options: candidateOptions } : null,
    }
    out.push(row)
    log(`ground ${i} ${c.page} "${c.goal}" → ${row.picked} p=${round(row.top, 3)} ${row.correct ? 'OK' : 'WRONG'}${row.tournament ? ' (tournament)' : ''} op=${operation?.choice}/${round(operation?.top, 2)}${operation?.correct ? '' : ` (expected ${r.forced})`} rank=${row.candidateRank} ${row.targetMs}ms`)
  }
  await tab.close()
  return out
}

function summarizeGrounding(rows) {
  const all = rows.flatMap((r) => r.decideMs)
  const byKind = (k) => all.filter((d) => d.kind === k).map((d) => d.ms)
  const warm = rows.slice(3).flatMap((r) => r.decideMs).map((d) => d.ms)
  const thresholds = [0.4, 0.5, 0.6, 0.7, 0.8].map((t) => {
    const answered = rows.filter((r) => r.top != null && r.top >= t)
    return { threshold: t, coverage: round(answered.length / rows.length, 3), answered: answered.length, accuracyOnAnswered: answered.length ? round(answered.filter((r) => r.correct).length / answered.length, 3) : null, wrongButConfident: answered.filter((r) => !r.correct).length }
  })
  const valueRows = rows.filter((r) => r.value && r.value.correct !== null)
  return {
    cases: rows.length,
    accuracyTop1: round(rows.filter((r) => r.correct).length / rows.length, 3),
    correct: rows.filter((r) => r.correct).length,
    byPage: Object.fromEntries([...new Set(rows.map((r) => r.page))].map((p) => {
      const rs = rows.filter((r) => r.page === p)
      return [p, { cases: rs.length, correct: rs.filter((r) => r.correct).length }]
    })),
    tournamentCases: rows.filter((r) => r.tournament).length,
    tournamentCorrect: rows.filter((r) => r.tournament && r.correct).length,
    // Candidate generation (doc §52): the right control was a target of the
    // expected operation / was shown in the state block / its rank in the list.
    expectedInSpace: rows.filter((r) => r.expectedInSpace).length,
    expectedShown: rows.filter((r) => r.expectedShown).length,
    candidateRank: { p50: pct(rows.filter((r) => r.candidateRank).map((r) => r.candidateRank), 50), max: Math.max(0, ...rows.filter((r) => r.candidateRank).map((r) => r.candidateRank)) },
    operationCorrect: rows.filter((r) => r.operation?.correct).length,
    operationCorrectAboveGate: rows.filter((r) => r.operation?.correct && r.operation.top >= 0.6).length,
    // The loop's FIRST gate: an operation below ACT_CONFIDENCE returns
    // `uncertain` before any target is chosen, so this is how often the shipped
    // loop would get past its first question on these pages at all.
    operationAboveGate: rows.filter((r) => r.operation && r.operation.top >= 0.6).length,
    operationTop: { p50: pct(rows.filter((r) => r.operation).map((r) => r.operation.top), 50), max: Math.max(...rows.filter((r) => r.operation).map((r) => r.operation.top)) },
    operationChoices: rows.reduce((a, r) => { const k = r.operation?.choice ?? 'none'; a[k] = (a[k] ?? 0) + 1; return a }, {}),
    // Tournament diagnosis: did the chunk containing the right element pick it?
    tournamentChunkWins: rows.filter((r) => r.tournament).filter((r) => r.rounds.slice(0, -1).some((x) => x.hasExpected && r.expected.includes(x.choice))).length,
    valueKey: { asked: valueRows.length, correct: valueRows.filter((r) => r.value.correct).length },
    decideMs: {
      all: { n: all.length, p50: pct(all.map((d) => d.ms), 50), p95: pct(all.map((d) => d.ms), 95), max: Math.max(...all.map((d) => d.ms)) },
      warm: { n: warm.length, p50: pct(warm, 50), p95: pct(warm, 95) },
      operation: { p50: pct(byKind('operation'), 50), p95: pct(byKind('operation'), 95) },
      target: { p50: pct(byKind('target'), 50), p95: pct(byKind('target'), 95) },
      value: { p50: pct(byKind('value'), 50), p95: pct(byKind('value'), 95) },
      targetPickPerCase: { p50: pct(rows.map((r) => r.targetMs), 50), p95: pct(rows.map((r) => r.targetMs), 95) },
      wallP50: pct(all.map((d) => d.wallMs), 50),
    },
    thresholds,
    rows: rows.map(({ llmInput, ...r }) => r),
  }
}

// ---------------------------------------------------------------------------
async function phaseLlm(grounding) {
  const rows = []
  for (const g of grounding) {
    if (!g.llmInput) { rows.push({ i: g.i, correct: false, error: 'no candidate list' }); continue }
    const { state, instructions, options } = g.llmInput
    const lines = Object.values(options).join('\n')
    const prompt = `${state}\n\n${instructions}\nVisible page elements:\n${lines}\n\nAnswer with only the number in square brackets of the element to use next.`
    const t0 = Date.now()
    let content = ''
    let error
    try {
      const res = await fetch(`${LM_URL}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify({ model: LM_MODEL, temperature: 0, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
      })
      const j = await res.json()
      content = j.choices?.[0]?.message?.content ?? ''
      if (!res.ok) error = JSON.stringify(j).slice(0, 200)
    } catch (err) { error = String(err) }
    const ms = Date.now() - t0
    const idx = content.match(/\d+/)?.[0]
    const line = idx !== undefined ? options[idx] : undefined
    // The option text is describe()'s `[i] kind "name" → op`; recover the name.
    const name = line?.match(/"(.*)"/)?.[1]
    const correct = !!name && g.expected.some((e) => name === e || name.startsWith(e.slice(0, 59)))
    rows.push({ i: g.i, answer: content.slice(0, 40), picked: name ?? null, correct, ms, error })
    log(`llm ${g.i} → ${name} ${correct ? 'OK' : 'WRONG'} ${ms}ms`)
  }
  const ms = rows.filter((r) => !r.error).map((r) => r.ms)
  return { model: LM_MODEL, cases: rows.length, correct: rows.filter((r) => r.correct).length, accuracyTop1: round(rows.filter((r) => r.correct).length / rows.length, 3), ms: { p50: pct(ms, 50), p95: pct(ms, 95) }, rows }
}

// ---------------------------------------------------------------------------
const TASKS = [
  {
    id: 'form', page: 'form.html',
    prompt: 'On this page, fill in the contact form with my details — name Ada Lovelace, email ada@example.com, topic Billing, message "My last invoice was charged twice." — tick the box agreeing to be contacted, and send it.',
    check: () => { const d = window.__submitted; return !!d && d.fullname === 'Ada Lovelace' && d.email === 'ada@example.com' && d.topic === 'Billing' && d.consent === 'on' },
    state: () => window.__submitted,
  },
  {
    id: 'shop', page: 'shop.html',
    prompt: 'Add the blue Aurora mug to my cart on this page.',
    check: () => JSON.stringify(window.__cart) === JSON.stringify(['Aurora mug (blue)']),
    state: () => window.__cart,
  },
  {
    id: 'dialog', page: 'dialog.html',
    prompt: 'On this page, get past the cookie banner (reject the non-essential cookies) and then add the green Nimbus tote to my cart.',
    check: () => window.__consent !== null && JSON.stringify(window.__cart) === JSON.stringify(['Nimbus tote (green)']),
    state: () => ({ consent: window.__consent, cart: window.__cart }),
  },
]
const E2E_TIMEOUT_MS = Number(env.EVAL_E2E_TIMEOUT_MS ?? 8 * 60_000)

// Counts the System-1 worker's traffic from the panel side without touching
// src/: installed before the panel's scripts run, it wraps `Worker` so the
// engine's own worker (system1Worker.js) reports decides, Von ms and boot time.
const VON_SPY = () => {
  const W = window.Worker
  window.__von = { decides: 0, failed: 0, ms: 0, boots: [] }
  window.Worker = class extends W {
    constructor(url, opts) {
      super(url, opts)
      if (!String(url).includes('system1Worker')) return
      let initAt = 0
      const post = this.postMessage.bind(this)
      this.postMessage = (m, t) => { if (m && m.type === 'init') initAt = performance.now(); return post(m, t) }
      this.addEventListener('message', (e) => {
        const d = e.data
        if (!d) return
        if (d.type === 'result') { window.__von.decides++; window.__von.ms += d.result.ms }
        if (d.type === 'failed') window.__von.failed++
        if (d.type === 'ready' && initAt) window.__von.boots.push(Math.round(performance.now() - initAt))
      })
    }
  }
}

async function phaseE2e(ctx, panel, panelUrl, fixtureUrl) {
  const rows = []
  // `forced` = toggle on AND the prompt tells the model to use Act — the only
  // way to see Act's own end-to-end behaviour when the chat model would
  // otherwise never pick it. `on` = toggle on, model free to choose.
  const modes = (env.EVAL_E2E_MODES ?? 'off,on,forced').split(',')
  const reps = Number(env.EVAL_E2E_REPS ?? 3)
  await panel.addInitScript(VON_SPY)
  for (let rep = 0; rep < reps; rep++) {
    for (const task of TASKS) {
      // Interleave arms per task so drift in LM Studio (load, heat) hits every arm alike.
      for (const mode of modes) rows.push(await runE2e(ctx, panel, fixtureUrl, task, mode, rep))
    }
  }
  return { rows, summary: summarizeE2e(rows) }
}

async function runE2e(ctx, panel, fixtureUrl, task, mode, rep) {
  await seedSettings(panel, { system1: mode !== 'off' })
  const fixture = await ctx.newPage()
  await fixture.goto(fixtureUrl(task.page))
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, fixture.url())
  // The fixture must be the ACTIVE tab (the panel binds its chat to the
  // active tab of its window); the panel keeps running as a background tab.
  await panel.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId)
  await panel.reload()
  await sleep(2500)
  const since = Date.now()
  const approvals = []
  log(`e2e ${task.id} [${mode}] rep ${rep} start`)
  const composer = panel.locator('textarea').first()
  await composer.fill(mode === 'forced' ? `${task.prompt} Use the Act tool for the page actions.` : task.prompt)
  await composer.press('Enter')
  let seenStreaming = false
  let idleSince = 0
  let ended = 'timeout'
  while (Date.now() - since < E2E_TIMEOUT_MS) {
    await sleep(500)
    const card = panel.locator('.approval-card').first()
    if (await card.count()) {
      const head = ((await card.locator('.approval-header').textContent().catch(() => '')) ?? '').trim()
      // A card can outlive the click that settled it by a render or two; the
      // same header again within 5 s is that card, not a new request.
      const prev = approvals.at(-1)
      if (!(prev && prev.head === head && Date.now() - prev.at < 5000)) {
        approvals.push({ head, at: Date.now() })
        log(`  approve: ${head}`)
      }
      await card.locator('button.btn.primary, button.btn.danger-solid').last().click().catch(() => {})
      // Wait for that card to leave, so one card is never counted twice.
      for (let k = 0; k < 20; k++) {
        await sleep(150)
        const still = await panel.locator('.approval-card .approval-header').first().textContent({ timeout: 200 }).catch(() => null)
        if (still?.trim() !== head) break
      }
      idleSince = 0
      continue
    }
    const streaming = (await panel.locator('button.send-btn.stop').count()) > 0
    if (streaming) { seenStreaming = true; idleSince = 0; continue }
    if (seenStreaming) {
      if (!idleSince) idleSince = Date.now()
      if (Date.now() - idleSince > 4000) { ended = 'turn-ended'; break }
    }
  }
  // Submit → the moment the turn stopped streaming (the final answer).
  const wallMs = (ended === 'turn-ended' ? idleSince : Date.now()) - since
  if (ended === 'timeout') await panel.locator('button.send-btn.stop').click().catch(() => {})
  // Success is the PAGE's state, never the model's claim.
  const success = await fixture.evaluate(task.check).catch(() => false)
  const pageState = await fixture.evaluate(task.state).catch(() => null)
  await sleep(1500) // let the final transcript save land
  const traces = await readTraces(panel, since)
  const traceSteps = traces.flatMap((t) => t.steps)
  const toolCalls = traceSteps.flatMap((s) => s.toolCalls.map((c) => c.name))
  const tools = await readToolParts(panel, since)
  const acts = tools.filter((t) => t.toolName === 'Act')
  const actSteps = acts.reduce((a, t) => a + (Array.isArray(t.output?.steps) ? t.output.steps.length : 0), 0)
  const controlActions = tools.filter((t) => t.toolName === 'ControlPage' && t.output && !t.output.error && !t.output.denied).length
  const von = await panel.evaluate(() => window.__von ?? null).catch(() => null)
  const lastReply = await panel.evaluate(() => {
    const ms = document.querySelectorAll('.msg.assistant, .message.assistant, [data-role="assistant"]')
    return ms.length ? ms[ms.length - 1].textContent.slice(0, 300) : null
  }).catch(() => null)
  const row = {
    task: task.id, arm: mode, rep, success, ended, wallMs,
    llmSteps: traceSteps.length,
    inputTokens: traceSteps.reduce((a, s) => a + (s.usage?.inputTokens ?? 0), 0),
    outputTokens: traceSteps.reduce((a, s) => a + (s.usage?.outputTokens ?? 0), 0),
    actOffered: traceSteps.some((s) => s.activeTools.includes('Act')),
    pageActions: controlActions + actSteps,
    controlPageCalls: toolCalls.filter((n) => n === 'ControlPage').length,
    actCalls: acts.length,
    actSteps,
    actStatuses: acts.map((t) => t.output?.status ?? (t.output?.error ? `error: ${t.output.error}` : 'none')),
    actMessages: acts.map((t) => t.output?.message).filter(Boolean),
    vonDecides: von?.decides ?? 0, vonFailed: von?.failed ?? 0, vonMs: von?.ms ?? 0, vonBootMs: von?.boots ?? [],
    approvals: approvals.map((a) => a.head), toolCalls, pageState, lastReply,
  }
  log(`e2e ${task.id} [${mode}] rep ${rep} success=${success} ${ended} ${Math.round(wallMs / 1000)}s llmSteps=${row.llmSteps} tok=${row.inputTokens}+${row.outputTokens} actions=${row.pageActions} Act×${row.actCalls} ${JSON.stringify(row.actStatuses)} von=${row.vonDecides}/${row.vonMs}ms`)
  await fixture.close()
  return row
}

async function readToolParts(panel, since) {
  // The saved transcript's UI tool parts ({type:'tool', toolCallId, toolName,
  // input, output}) for this run's conversation, deduped by call id.
  return panel.evaluate((since) => new Promise((resolve) => {
    const req = indexedDB.open('lychee-conversations')
    req.onerror = () => resolve([])
    req.onsuccess = () => {
      const all = req.result.transaction('conversations').objectStore('conversations').getAll()
      all.onsuccess = () => {
        const seen = new Map()
        for (const c of all.result) {
          if ((c.updatedAt ?? 0) < since) continue
          for (const m of c.messages ?? []) for (const p of m.parts ?? []) {
            if (p && p.type === 'tool' && p.toolName && p.toolCallId && !seen.has(p.toolCallId)) seen.set(p.toolCallId, { toolName: p.toolName, input: p.input, output: p.output })
          }
        }
        resolve([...seen.values()])
      }
      all.onerror = () => resolve([])
    }
  }), since).catch(() => [])
}

function summarizeE2e(rows) {
  const arms = [...new Set(rows.map((r) => r.arm))]
  const tasks = [...new Set(rows.map((r) => r.task))]
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  const agg = (rs) => ({
    runs: rs.length, success: rs.filter((r) => r.success).length,
    wallMsMedian: pct(rs.map((r) => r.wallMs), 50), wallMsMean: mean(rs.map((r) => r.wallMs)),
    llmStepsMean: round(rs.reduce((a, r) => a + r.llmSteps, 0) / rs.length, 1),
    // Medians alongside means: one runaway turn (an auto-continued loop) can
    // multiply a 3-run mean without saying anything about the typical run.
    llmStepsMedian: pct(rs.map((r) => r.llmSteps), 50),
    tokensMedian: pct(rs.map((r) => r.inputTokens + r.outputTokens), 50),
    tokensMean: mean(rs.map((r) => r.inputTokens + r.outputTokens)),
    inputTokensMean: mean(rs.map((r) => r.inputTokens)), outputTokensMean: mean(rs.map((r) => r.outputTokens)),
    pageActionsMean: round(rs.reduce((a, r) => a + r.pageActions, 0) / rs.length, 1),
    actCalls: rs.reduce((a, r) => a + r.actCalls, 0), actSteps: rs.reduce((a, r) => a + r.actSteps, 0),
    actNonDone: rs.flatMap((r) => r.actStatuses).filter((s) => s !== 'done').length,
    actStatuses: rs.flatMap((r) => r.actStatuses).reduce((a, s) => { a[s] = (a[s] ?? 0) + 1; return a }, {}),
    vonDecides: rs.reduce((a, r) => a + r.vonDecides, 0), vonMs: rs.reduce((a, r) => a + r.vonMs, 0),
    approvalsMean: round(rs.reduce((a, r) => a + r.approvals.length, 0) / rs.length, 1),
  })
  return {
    byArm: Object.fromEntries(arms.map((a) => [a, agg(rows.filter((r) => r.arm === a))])),
    byTaskArm: Object.fromEntries(tasks.map((t) => [t, Object.fromEntries(arms.map((a) => [a, agg(rows.filter((r) => r.task === t && r.arm === a))]))])),
  }
}

async function readTraces(panel, since) {
  return panel.evaluate((since) => new Promise((resolve) => {
    const req = indexedDB.open('lychee-traces')
    req.onerror = () => resolve([])
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('traces')) return resolve([])
      const all = db.transaction('traces').objectStore('traces').getAll()
      all.onsuccess = () => resolve(all.result.filter((t) => t.createdAt >= since - 1000).sort((a, b) => a.createdAt - b.createdAt))
      all.onerror = () => resolve([])
    }
  }), since)
}

// ---------------------------------------------------------------------------
function printSummary(r, skipped) {
  console.log('\n================ System-1 eval ================')
  console.log('WebGPU:', JSON.stringify(r.env.webgpu), '| LM Studio:', r.env.lmStudio)
  if (r.download) console.log('Download:', r.download.status, `${Math.round(r.download.downloadMs / 1000)}s`, '| test:', r.download.testDecision)
  if (r.bootMs != null) console.log('Worker boot (cache → session → warm-up):', r.bootMs, 'ms')
  if (r.parity) console.log(`Parity (${r.parity.cases} golden cases): max|Δp| ${r.parity.maxDeltaP}, argmax flips ${r.parity.argmaxFlips}`)
  if (r.grounding) {
    const g = r.grounding
    console.log(`Grounding: ${g.correct}/${g.cases} = ${g.accuracyTop1}  (tournament ${g.tournamentCorrect}/${g.tournamentCases})`, JSON.stringify(g.byPage))
    console.log(`Tournament: the chunk holding the right element picked it in ${g.tournamentChunkWins}/${g.tournamentCases}`)
    console.log(`Candidate set: expected control a target in ${g.expectedInSpace}/${g.cases}, shown in the state block in ${g.expectedShown}/${g.cases}, rank p50 ${g.candidateRank.p50} max ${g.candidateRank.max}`)
    console.log(`Operation question: correct ${g.operationCorrect}/${g.cases}, above ACT_CONFIDENCE ${g.operationAboveGate}/${g.cases}, correct AND above ${g.operationCorrectAboveGate}/${g.cases} (p50 top ${g.operationTop.p50}, max ${g.operationTop.max})`, JSON.stringify(g.operationChoices))
    console.log(`Value key: ${g.valueKey.correct}/${g.valueKey.asked} (asked only when the target cleared the gate)`)
    console.log('decide ms:', JSON.stringify(g.decideMs))
    console.table(g.thresholds)
  }
  if (r.llm) console.log(`LLM baseline (${r.llm.model}): ${r.llm.correct}/${r.llm.cases} = ${r.llm.accuracyTop1}, p50 ${r.llm.ms.p50} ms, p95 ${r.llm.ms.p95} ms`)
  if (r.e2e?.summary) console.table(Object.fromEntries(Object.entries(r.e2e.summary.byArm).map(([a, x]) => [a, { runs: x.runs, success: x.success, wallMedS: Math.round(x.wallMsMedian / 1000), llmStepsMed: x.llmStepsMedian, tokensMed: x.tokensMedian, tokensMean: x.tokensMean, actions: x.pageActionsMean, actCalls: x.actCalls, actNonDone: x.actNonDone, vonMs: x.vonMs }])))
  for (const s of skipped) console.log('SKIPPED', s)
  for (const v of r.verdict) console.log('VERDICT', v)
}

main().catch((err) => { console.error(err); process.exit(1) })
