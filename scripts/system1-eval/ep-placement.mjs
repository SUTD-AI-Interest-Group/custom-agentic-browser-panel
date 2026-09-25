#!/usr/bin/env node
// Which execution provider does each node of the exported Von graph land on
// under onnxruntime-web's WebGPU EP — in particular, do the MatMulNBits nodes
// run on the GPU or silently fall back to CPU/WASM (which would make every
// latency and parity number misleading)? Same ORT build and asyncify wasm as
// src/system1/worker.ts, loaded into a plain localhost page (a secure context,
// so WebGPU is available) with verbose logging, then the golden cases run with
// their exact packed ids so the logits compare directly against the fp32
// reference. Usage: node ep-placement.mjs [webgpu|wasm]
import { createRequire } from 'node:module'
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
const { chromium } = require(env.EVAL_PLAYWRIGHT ?? 'playwright')
const ORT = path.join(repo, 'node_modules/onnxruntime-web/dist')
const MODEL_DIR = path.resolve(env.EVAL_MODEL_DIR ?? path.join(repo, 'scripts/export-von/out'))
const manifest = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'manifest.json'), 'utf8'))
const modelFile = manifest.files.find((f) => f.path.endsWith('.onnx')).path
const golden = JSON.parse(fs.readFileSync(path.join(repo, 'src/system1/__fixtures__/von-golden.json'), 'utf8'))
const EP = process.argv[2] ?? 'webgpu'
const CHROMIUM = env.EVAL_CHROMIUM ?? (() => {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (fs.existsSync(p)) return p
  }
  throw new Error('set EVAL_CHROMIUM')
})()

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname
  const p = u.startsWith('/ort/') ? path.join(ORT, path.basename(u)) : u.startsWith('/model/') ? path.join(MODEL_DIR, path.basename(u)) : null
  if (!p) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>ep</title>') }
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end() }
  const type = p.endsWith('.mjs') ? 'text/javascript' : p.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(p).size })
  fs.createReadStream(p).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-')), { executablePath: CHROMIUM, headless: false })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => logs.push(m.text()))
await page.goto(`http://127.0.0.1:${server.address().port}/`)
const startedAt = new Date().toISOString()
const result = await page.evaluate(async ([ep, file, cases]) => {
  const ort = await import('/ort/ort.webgpu.bundle.min.mjs')
  ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm' }
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'verbose'
  const buf = new Uint8Array(await (await fetch(`/model/${file}`)).arrayBuffer())
  const t0 = performance.now()
  const session = await ort.InferenceSession.create(buf, { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 0, logVerbosityLevel: 0 })
  const createMs = Math.round(performance.now() - t0)
  const i64 = (xs) => BigInt64Array.from(xs, (x) => BigInt(x))
  const runs = []
  for (let rep = 0; rep < 3; rep++) for (const c of cases) {
    const T = c.ids.length
    const t1 = performance.now()
    const out = await session.run({
      input_ids: new ort.Tensor('int64', i64(c.ids), [1, T]),
      option_ids: new ort.Tensor('int64', i64(c.optionIds), [1, T]),
      position_ids: new ort.Tensor('int64', i64(c.positionIds), [1, T]),
      marker_positions: new ort.Tensor('int64', i64(c.markers), [c.markers.length]),
    })
    const logits = Array.from(out.logits.data)
    runs.push({ rep, T, ms: Math.round(performance.now() - t1), maxAbsLogitDelta: Math.max(...logits.map((l, k) => Math.abs(l - c.logits[k]))) })
  }
  return { createMs, runs }
}, [EP, modelFile, golden.cases])
await ctx.close()
server.close()

// ORT prints "Node(s) placed on [EP]. Number of nodes: N" followed by one
// "  OpType (node name)" line per node (VerifyEachNodeIsAssignedToAnEp) —
// or, when a single EP took everything, only "All nodes placed on [EP].
// Number of nodes: N" with no per-node lines.
const placement = {}
const allOn = {}
let cur = null
for (const l of logs) {
  const all = l.match(/All nodes placed on \[(\w+)\]\. Number of nodes: (\d+)/)
  if (all) { allOn[all[1]] = Number(all[2]); continue }
  const head = l.match(/Node\(s\) placed on \[(\w+)\]/)
  if (head) { cur = head[1]; placement[cur] = {}; continue }
  const node = l.match(/VerifyEachNodeIsAssignedToAnEp\]\s{3}(\w+) \(/)
  if (node && cur) placement[cur][node[1]] = (placement[cur][node[1]] ?? 0) + 1
  else if (cur && !l.includes('VerifyEachNodeIsAssignedToAnEp')) cur = null
}
const programs = logs.filter((l) => l.includes('Starting program "MatMulNBits')).length
const byEp = Object.fromEntries([
  ...Object.entries(placement).map(([ep, ops]) => [ep, { total: Object.values(ops).reduce((a, b) => a + b, 0), ops }]),
  ...Object.entries(allOn).map(([ep, n]) => [ep, { total: n, ops: {} }]),
])
const gpu = byEp.WebGpuExecutionProvider
const cpu = byEp.CPUExecutionProvider
const totalNBits = Object.values(byEp).reduce((a, x) => a + (x.ops.MatMulNBits ?? 0), 0)
// The engine lists only the webgpu EP, and ORT appends its CPU EP as the
// implicit fallback: a node the WebGPU EP cannot (or prefers not to) run is
// PARTITIONED onto CPU rather than failing session creation — so the counts
// below are the whole story of what fell back.
const summary = EP === 'webgpu'
  ? `${gpu?.ops.MatMulNBits ?? 0}/${totalNBits} MatMulNBits nodes on WebGPU; ${gpu?.total ?? 0} nodes on WebGPU, ${cpu?.total ?? 0} partitioned to CPU`
  : `${EP} EP: ${Object.entries(byEp).map(([k, v]) => `${v.total} nodes on ${k}`).join(', ')}`
const out = {
  ep: EP, model: modelFile, createMs: result.createMs, summary,
  sessionCreation: 'succeeded (unsupported nodes are partitioned to the implicit CPU EP, not a failure)',
  placement: byEp,
  matMulNBitsWebGpuPrograms: programs,
  runs: result.runs,
  msPerRunMedian: [...result.runs.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(result.runs.length / 2)],
  note: 'verbose logging is on, so run times here are inflated vs the worker',
}
console.log(JSON.stringify(out, null, 1))
writeReport({ phases: [`ep-placement:${EP}`], startedAt, finishedAt: new Date().toISOString() }, { epPlacement: { [EP]: out } })
