// Reproducible synthetic browser microbenchmark; no model/provider/network calls.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/benchmark-shadow.mjs
import { chromium } from 'playwright'
import { transformSync } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { JSDOM } from 'jsdom'

const baseline = process.env.BASELINE_REF || 'ff3b750daa30534fb04507354c68be82d17a7e44'
const before = execFileSync('git', ['show', `${baseline}:src/platform/pageActions.ts`], { encoding: 'utf8' })
const after = readFileSync('src/platform/pageActions.ts', 'utf8')
function injected(source) {
  // Compile the actual file, then expose its private self-contained injections.
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  return `(() => { const exports = {}; const module = {exports}; ${code}; return {injClick,injType,injSelect,injScroll,injPress}; })()`
}
const simulated = process.env.DOM_BACKEND === 'jsdom'
const dom = simulated ? new JSDOM('<!doctype html><body></body>', {runScripts:'outside-only', pretendToBeVisual:true}) : null
if (dom) dom.window.Element.prototype.scrollIntoView = () => {}
const browser = simulated ? null : await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const page = simulated ? { evaluate: async (fn, arg) => dom.window.eval(`(${fn.toString()})(${JSON.stringify(arg)})`) } : await browser.newPage({ viewport: {width: 1280, height: 800} })
const cdp = simulated ? { send: async name => {
  if(name === 'HeapProfiler.collectGarbage') { global.gc?.(); return {} }
  return process.memoryUsage()
}} : await page.context().newCDPSession(page)
const scenarios = [
  {name: 'light-100', nodes: 100, roots: 0},
  {name: 'light-1000', nodes: 1000, roots: 0},
  {name: 'light-10000', nodes: 10000, roots: 0},
  {name: 'shadow-10x100', nodes: 100, roots: 10},
  {name: 'shadow-100x100', nodes: 100, roots: 100},
  {name: 'nested-20', nodes: 100, roots: 20, nested: true},
  {name: 'missing-10000', nodes: 10000, roots: 0, missing: true},
  {name: 'missing-shadow-100x100', nodes: 100, roots: 100, missing: true},
]
const warmup = simulated ? 10 : 100, batches = simulated ? 20 : 40, iterations = simulated ? 20 : 50
const records = []
try {
  await page.evaluate(({before,after}) => { window.variants = {before: eval(before), after: eval(after)} }, {before: injected(before), after: injected(after)})
  for (const scenario of scenarios) {
    await page.evaluate(s => {
      document.body.innerHTML = ''
      const fill = root => {
        const fragment = document.createDocumentFragment()
        for(let i=0;i<s.nodes;i++) fragment.appendChild(document.createElement('span'))
        root.appendChild(fragment)
      }
      fill(document.body)
      let targetRoot = document.body
      for(let i=0;i<s.roots;i++) {
        const host = (s.nested ? targetRoot : document.body).appendChild(document.createElement('div'))
        const root = host.attachShadow({mode:'open'})
        fill(root)
        // First sibling root is searched last by the stack, so this is the
        // expensive sibling lookup; nested case searches all ancestors.
        if(s.nested || i===0) targetRoot = root
      }
      if (!s.missing) {
        const button = targetRoot.appendChild(document.createElement('button'))
        button.setAttribute('data-agent-idx','7')
        button.textContent = 'Target'
        button.onclick = () => { window.clicks++ }
      }
      window.clicks = 0
    }, scenario)
    await cdp.send('HeapProfiler.collectGarbage')
    const heapBefore = await cdp.send('Runtime.getHeapUsage')
    const data = await page.evaluate(({warmup,batches,iterations}) => {
      const samples = {before: [], after: []}
      const success = {before: 0, after: 0}
      const clickEvents = {before: 0, after: 0}
      for (const variant of ['before','after']) for(let i=0;i<warmup;i++) window.variants[variant].injClick('data-agent-idx',7)
      for(let batch=0;batch<batches;batch++) {
        // Counterbalance order to reduce temperature/JIT/drift bias.
        for(const variant of batch%2 ? ['after','before'] : ['before','after']) {
          const clicks = window.clicks
          const start = performance.now()
          for(let i=0;i<iterations;i++) if(window.variants[variant].injClick('data-agent-idx',7).ok) success[variant]++
          samples[variant].push((performance.now()-start)/iterations)
          clickEvents[variant] += window.clicks-clicks
        }
      }
      return {samples,success,clickEvents}
    }, {warmup,batches,iterations})
    const heapAfter = await cdp.send('Runtime.getHeapUsage')
    await cdp.send('HeapProfiler.collectGarbage')
    const retainedHeap = await cdp.send('Runtime.getHeapUsage')
    const summarize = values => {
      const sorted = [...values].sort((a,b)=>a-b)
      return {meanMs: values.reduce((a,b)=>a+b)/values.length, p50BatchMeanMs: sorted[Math.floor(sorted.length*.5)], p95BatchMeanMs: sorted[Math.floor(sorted.length*.95)]}
    }
    records.push({scenario, ...data, summary: {before:summarize(data.samples.before),after:summarize(data.samples.after)}, heap: {before:heapBefore, afterBothVariants:heapAfter, retainedAfterGC:retainedHeap}})
  }
  const report = {timestamp:new Date().toISOString(), baseline, source:'src/platform/pageActions.ts', browser:browser?.version() ?? 'NOT RUN: jsdom simulation', backend: simulated ? 'jsdom 29; no rendering or browser' : 'Chromium', platform:os.platform(), release:os.release(), arch:os.arch(), cpu:os.cpus()[0].model, logicalCPUs:os.cpus().length, totalMemoryBytes:os.totalmem(), node:process.version, warmup,batches,iterations, samplesPerVariantPerScenario:batches*iterations, records, caveats:[...(simulated ? ['JSDOM fallback: Chrome launch was blocked by OS socket restrictions. These timings are NOT browser latency. scrollIntoView is a no-op; heap metrics are whole Node process memory.'] : []), 'Synthetic headless Chromium fixtures; no extension messaging, model inference, screenshot or real website workload.', 'p95 is the p95 of batch means, not per-call tail latency; timing resolution is amortized across 50 calls.', 'Baseline shadow lookups fail, so their low latency is not equivalent successful work.', 'Heap snapshots cover both variants together: diagnostic retained/allocated browser heap, not isolated per-variant peak memory.']}
  mkdirSync('docs/benchmarks',{recursive:true})
  writeFileSync(`docs/benchmarks/shadow-${simulated ? 'jsdom' : 'browser'}-results.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
} finally { await browser?.close(); dom?.window.close() }
