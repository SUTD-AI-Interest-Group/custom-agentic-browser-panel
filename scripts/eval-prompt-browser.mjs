/**
 * Prompt evaluation: which tools does the model actually reach for? Drives the built extension in a
 * real browser against a REAL local model (LM Studio, per CLAUDE.md — never a hosted provider),
 * through a recording proxy, over six fixed scenarios: a greeting, a page summary, a data question
 * with no page, a comparison on a shop page, a task the shop page exposes as a WebMCP action, and a
 * question a connected MCP server answers. Each scenario runs in a fresh chat; approval cards are
 * allowed automatically. It prints, per scenario, the tool calls in order, the model steps, and
 * whether the expected route was taken.
 *
 *   npm run build && node scripts/eval-prompt-browser.mjs
 *   DIST=dist  MODEL_URL=http://127.0.0.1:1234  MODEL=google/gemma-4-26b-a4b  RUNS=3  ONLY=webmcp,mcp
 *   OUT=eval.json  writes every result;  PROMPT_OUT=prompt.txt  writes the system prompt the model saw.
 *   STUB=1  replaces the model with a stub that answers in plain text: no model needed, for checking
 *           the harness and capturing the exact system prompt (tool expectations then fail, by design).
 *
 * Compare two builds by running it once per DIST. Local sampling varies: use RUNS for pass rates.
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const DIST = path.resolve(process.env.DIST || 'dist')
const MODEL_URL = (process.env.MODEL_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')
const MODEL = process.env.MODEL || 'google/gemma-4-26b-a4b'
const RUNS = Number(process.env.RUNS || 1)
const STUB = process.env.STUB === '1'
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 240_000)

// ── Fixture pages ──────────────────────────────────────────────────────────────────────────────
const ARTICLE = `<!doctype html><meta charset="utf-8"><title>How megacities grew</title>
<article><h1>How megacities grew</h1>
<p>In 1950 only New York and Tokyo had more than ten million people. By 2020 there were more than thirty such cities, most of them in Asia.</p>
<p>Tokyo's metropolitan population peaked at about 37 million and has begun to shrink slowly. Delhi, at roughly 32 million and still growing by close to a million a year, is expected to overtake it within the decade.</p>
<p>Shanghai grew from about 6 million in 1980 to almost 29 million, driven by migration from inland provinces. São Paulo, at about 22 million, has grown more slowly since 2000 as birth rates fell.</p>
<p>Planners argue that transit, housing supply and water management matter more than headline size: cities that invested early in rail coped better with growth than those that did not.</p></article>`

const LAPTOPS = [
  { sku: 'AX14', name: 'Aero 14', price: 899, cpu: 'R7 7840U', ram: 16, battery: 11, weight: 1.3 },
  { sku: 'BK15', name: 'Bolt 15', price: 1249, cpu: 'i7-13700H', ram: 32, battery: 7, weight: 2.0 },
  { sku: 'CL13', name: 'Cirrus 13', price: 1099, cpu: 'M3', ram: 16, battery: 18, weight: 1.2 },
  { sku: 'DN16', name: 'Dyna 16', price: 1599, cpu: 'i9-13900H', ram: 32, battery: 6, weight: 2.4 },
  { sku: 'EV14', name: 'Evo 14', price: 749, cpu: 'i5-1335U', ram: 8, battery: 9, weight: 1.4 },
]
const HEADPHONES = [
  { sku: 'HN1', name: 'Hush One noise-cancelling headphones', price: 249 },
  { sku: 'QT2', name: 'Quiet Tide 2 noise-cancelling earbuds', price: 179 },
]
const SHOP = `<!doctype html><meta charset="utf-8"><title>Northwind Electronics — Laptops</title>
<h1>Northwind Electronics</h1><form id="search"><input name="q" placeholder="Search products"><button>Search</button></form>
<h2>Laptops</h2><table border="1"><tr><th>Model</th><th>Price</th><th>CPU</th><th>RAM (GB)</th><th>Battery (h)</th><th>Weight (kg)</th><th></th></tr>
${LAPTOPS.map((l) => `<tr><td>${l.name}</td><td>$${l.price}</td><td>${l.cpu}</td><td>${l.ram}</td><td>${l.battery}</td><td>${l.weight}</td><td><button>Add to cart</button></td></tr>`).join('')}
</table><p id="results"></p>
<script>
// Native WebMCP: the shop's own search and cart actions (needs Chrome's WebMCP testing flags).
const catalog = ${JSON.stringify([...LAPTOPS, ...HEADPHONES])};
window.webmcpCalls = [];
document.modelContext?.registerTool({
  name: 'searchProducts', title: 'Search products', description: 'Search the Northwind catalog by keyword. Returns matching products with sku, name and price.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => {
    window.webmcpCalls.push({ name: 'searchProducts', query });
    const words = String(query).toLowerCase().split(/\\s+/).filter(Boolean);
    const hits = catalog.filter((p) => words.some((w) => p.name.toLowerCase().includes(w.replace(/s$/, ''))));
    document.getElementById('results').textContent = hits.map((p) => p.name).join(', ') || 'No results';
    return JSON.stringify(hits.map(({ sku, name, price }) => ({ sku, name, price })));
  },
});
document.modelContext?.registerTool({
  name: 'addToCart', title: 'Add to cart', description: 'Add one product to the cart by sku.',
  inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  execute: async ({ sku }) => { window.webmcpCalls.push({ name: 'addToCart', sku }); return JSON.stringify({ added: sku }); },
});
</script>`

// ── MCP server: an issue tracker ──────────────────────────────────────────────────────────────
const ISSUES = [
  { id: 'TRK-12', title: 'Checkout fails on Safari', status: 'open', priority: 'high' },
  { id: 'TRK-15', title: 'Dark mode contrast on settings page', status: 'open', priority: 'low' },
  { id: 'TRK-18', title: 'Export to CSV drops the last row', status: 'open', priority: 'medium' },
]
const mcpCalls = []
function mcp(body) {
  const result = (data) => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...data } })
  switch (body.method) {
    case 'server/discover': return result({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } })
    case 'tools/list': return result({ tools: [
      { name: 'list_issues', description: 'List issues in the team tracker, optionally filtered by status (open or closed).', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed'] } } } },
      { name: 'get_issue', description: 'Get one tracker issue by id, with its full description.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    ] })
    case 'resources/list': return result({ resources: [] })
    case 'tools/call':
      mcpCalls.push(body.params.name)
      return result({ content: [{ type: 'text', text: JSON.stringify(body.params.name === 'get_issue' ? ISSUES.find((i) => i.id === body.params.arguments?.id) ?? null : ISSUES) }] })
    default: return result({})
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────────────────────
const has = (calls, name) => calls.some((c) => c === name)
const SCENARIOS = [
  { id: 'greet', page: '/article', message: 'hi! how are you?', expect: 'no tools',
    check: (calls) => calls.length === 0 },
  // The panel attaches the tab the user is on to the message, so an attached page needs no read.
  { id: 'summarize', page: '/article', message: 'Summarize this page in two sentences.', expect: 'the page (attached or read), no WebMCP detour',
    check: (calls, attached) => (attached || has(calls, 'ReadPage')) && !has(calls, 'DiscoverWebMcp') },
  { id: 'visual-data', page: '/article', message: 'Compare the populations of Tokyo, Delhi, Shanghai and São Paulo for me.', expect: 'CreateArtifact',
    check: (calls) => has(calls, 'CreateArtifact') },
  { id: 'visual-page', page: '/shop', message: 'Which of these laptops is the best value for a student? Show me how they compare.', expect: 'the page (attached or read), then CreateArtifact',
    check: (calls, attached) => (attached || has(calls, 'ReadPage') || has(calls, 'ExtractData')) && has(calls, 'CreateArtifact') },
  { id: 'webmcp', page: '/shop', message: 'Search this shop for noise-cancelling headphones.', expect: 'DiscoverWebMcp → RunWebMcp, no page control',
    check: (calls) => has(calls, 'DiscoverWebMcp') && has(calls, 'RunWebMcp') && !has(calls, 'RequestPageControl') && !has(calls, 'ControlPage') },
  { id: 'mcp', page: '/article', message: 'What issues are still open in our tracker? Which should we fix first?', expect: 'mcp_tracker_list_issues',
    check: (calls) => calls.some((c) => c.startsWith('mcp_tracker_list_issues')) },
].filter((s) => !ONLY || ONLY.has(s.id))

// ── Model: a recording proxy to the local model, or a stub ────────────────────────────────────
let recording = null // the current scenario's agent requests (the ones that carry tools)
let systemPrompt = ''
function stubModel(body, res) {
  const base = { id: 'stub', model: 'stub', created: 1 }
  const text = body.tools?.length ? 'Stub reply.' : '[]'
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
  }
}
let lastReply = '' // the visible text of the most recent agent response
async function proxy(req, raw, res, agent) {
  const upstream = await fetch(`${MODEL_URL}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' }, body: req.method === 'GET' ? undefined : raw })
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
  if (!upstream.body) return res.end()
  let text = '', pending = ''
  const decoder = new TextDecoder()
  for await (const chunk of upstream.body) {
    res.write(chunk)
    if (!agent) continue
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try { text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '' } catch { /* partial */ }
    }
  }
  if (agent) lastReply = text
  res.end()
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  try {
    if (req.url === '/mcp') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(mcp(JSON.parse(raw)))); return }
    if (req.url.startsWith('/v1/') || req.url.startsWith('/api/')) {
      const body = raw ? JSON.parse(raw) : {}
      if (req.url.includes('/chat/completions') && body.tools?.length) {
        recording?.push(body)
        const system = body.messages?.find((m) => m.role === 'system')
        if (system && !systemPrompt) systemPrompt = typeof system.content === 'string' ? system.content : JSON.stringify(system.content)
      }
      if (STUB) {
        if (req.url.includes('/chat/completions')) return stubModel(body, res)
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: MODEL, type: 'vlm', capabilities: ['tool_use'] }] })); return
      }
      return await proxy(req, raw, res, req.url.includes('/chat/completions') && !!body.tools?.length)
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(req.url.startsWith('/shop') ? SHOP : ARTICLE)
  } catch (error) {
    res.statusCode = 500; res.end(String(error))
  }
})

/** The tool calls of one turn, in order: every assistant tool call in its last agent request. */
function toolCalls(requests) {
  const last = requests.at(-1)
  return (last?.messages ?? []).flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : [])).map((c) => c.function.name)
}
function loaded(requests) {
  const last = requests.at(-1)
  return (last?.messages ?? []).flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : []))
    .filter((c) => c.function.name === 'GetTool').flatMap((c) => { try { return JSON.parse(c.function.arguments).names ?? [] } catch { return [] } })
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'lychee-eval-'))
let context
const results = []
try {
  if (!STUB) {
    const ping = await fetch(`${MODEL_URL}/v1/models`).catch(() => null)
    if (!ping?.ok) throw new Error(`No model server at ${MODEL_URL}. Start LM Studio (or set STUB=1 to check the harness).`)
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: process.env.HEADED !== '1',
    args: ['--enable-features=WebMCPTesting', '--enable-blink-features=WebMCP,WebMCPTesting', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const first = await context.newPage(); await first.goto(`${origin}/article`)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.evaluate(async ({ origin, model }) => chrome.storage.local.set({ settings: {
    providers: [{ id: 'local', kind: 'lmstudio', name: 'LM Studio', baseURL: `${origin}/v1`, apiKey: 'x', models: [model] }],
    // No systemPrompt: the shipped default applies, as on a fresh install.
    selected: { providerId: 'local', modelId: model }, onboarded: true, tabAccess: 'all-tabs',
    // The lmstudio profile's 32k default would start compaction early (CLAUDE.md); this model reports 262144.
    modelConfigs: { [model]: { contextLimit: 262144 } },
    mcp: { servers: { tracker: { url: `${origin}/mcp` } } },
  } }), { origin, model: MODEL })
  await panel.reload()

  for (let run = 1; run <= RUNS; run++) {
    for (const scenario of SCENARIOS) {
      const tab = await context.newPage()
      await tab.goto(`${origin}${scenario.page}`)
      await tab.bringToFront()
      await panel.waitForTimeout(800)
      const visible = panel.locator('.view-host:not(.is-hidden)')
      await visible.getByPlaceholder('Ask anything…').waitFor({ timeout: 20000 })
      recording = []
      const started = Date.now()
      await visible.getByPlaceholder('Ask anything…').fill(scenario.message)
      await visible.getByTitle('Send', { exact: true }).click()
      await tab.bringToFront()
      let sawStop = false, approvals = 0, timedOut = false
      while (true) {
        if (Date.now() - started > TURN_TIMEOUT_MS) { timedOut = true; break }
        const card = visible.locator('.approval-card').first()
        if (await card.isVisible().catch(() => false)) {
          await panel.waitForTimeout(700) // the card's double-click guard
          await card.getByRole('button', { name: 'Allow', exact: true }).click().catch(() => {})
          approvals++
          continue
        }
        const stopping = await visible.locator('.send-btn.stop').isVisible().catch(() => false)
        if (stopping) sawStop = true
        else if (sawStop || Date.now() - started > 8000) break
        await panel.waitForTimeout(400)
      }
      const calls = toolCalls(recording)
      const webmcp = scenario.page === '/shop' ? await tab.evaluate(() => window.webmcpCalls ?? []) : []
      // Did the page arrive with the message (a <tab> block) rather than through a tool?
      const opener = recording[0]?.messages?.find((m) => m.role === 'user')
      const attached = /<tab[\s>]/.test(typeof opener?.content === 'string' ? opener.content : JSON.stringify(opener?.content ?? ''))
      const result = {
        run, id: scenario.id, expect: scenario.expect, pass: !timedOut && scenario.check(calls, attached), attached,
        calls, loaded: loaded(recording), steps: recording.length, approvals, seconds: Math.round((Date.now() - started) / 1000),
        timedOut, webmcp, mcp: [...mcpCalls], reply: lastReply.slice(0, 600),
      }
      lastReply = ''
      mcpCalls.length = 0
      results.push(result)
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${scenario.id.padEnd(12)} ${String(result.steps).padStart(2)} steps ${String(result.seconds).padStart(4)}s  ${calls.join(' → ') || '(no tools)'}${attached ? '  [page attached]' : ''}${timedOut ? '  [timed out]' : ''}`)
      await tab.close()
    }
  }
  const byScenario = SCENARIOS.map((s) => {
    const rows = results.filter((r) => r.id === s.id)
    return `${s.id.padEnd(12)} ${rows.filter((r) => r.pass).length}/${rows.length} passed  (expect: ${s.expect})`
  })
  console.log(`\n${STUB ? 'STUB model' : MODEL} — ${DIST}\n${byScenario.join('\n')}`)
  console.log(`System prompt: ${systemPrompt.length} chars (~${Math.round(systemPrompt.length / 4)} tokens)`)
  if (process.env.OUT) await writeFile(process.env.OUT, JSON.stringify({ model: STUB ? 'stub' : MODEL, dist: DIST, results }, null, 2))
  if (process.env.PROMPT_OUT) await writeFile(process.env.PROMPT_OUT, systemPrompt)
} finally {
  await context?.close().catch(() => {})
  server.close()
  await rm(temporary, { recursive: true, force: true })
}
