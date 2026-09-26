// Stage 2 — snapshots → labeled decisions ("episodes"), using the LM Studio
// teachers. The teachers never label Von's questions blind; labels come from
// construction and are cross-checked:
//
//   1. HINDSIGHT: a writer model sees a viewport's elements and writes goals,
//      each fulfilled by ONE element it names — so the target label is known.
//   2. ROUND TRIP: the other model gets the goals (not the indices) and must
//      ground each back to the same element. Disagreement drops the goal.
//   3. MOVE labels are structural: act (target visible), scroll_down (the goal
//      was written for an element further down the page, and the verifier
//      confirms nothing on screen serves it), DONE (the step is in "Done so
//      far" / the field now holds the value), BLOCKED (the goal needs a value
//      that was not provided).
//
//   node scripts/von-finetune/label.mjs [--concurrency 2] [--limit N] [--goals 6]
//
// Output: data/episodes.jsonl (+ data/label-log.jsonl per page, incl. rejects).
// Resumable per page. Writer/verifier alternate between the two teachers by page.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DATA, TEACHERS, appendJsonl, askJson, log, promptLib, readJsonl, rng, sha, shuffle } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '2' },
    limit: { type: 'string', default: '0' },
    goals: { type: 'string', default: '6' },
    below: { type: 'string', default: '2' },
  },
})
const PAGES = path.join(DATA, 'pages.jsonl')
const OUT = path.join(DATA, 'episodes.jsonl')
const LOG = path.join(DATA, 'label-log.jsonl')
const lib = await promptLib()

// Distractor values for the value question: plausible keys a chat model might
// pass to Act alongside the real one.
const VALUE_POOL = {
  email: 'alex.tan@example.com', full_name: 'Alex Tan', first_name: 'Alex', last_name: 'Tan', phone: '+65 8123 4567',
  street_address: '12 Kent Ridge Road', city: 'Singapore', postcode: '119077', company: 'Acme Pte Ltd',
  search_query: 'wireless headphones', message: 'Hi, I would like more information.', quantity: '2',
  date: '2026-11-14', username: 'alextan', country: 'Singapore', website: 'https://alextan.dev',
}

const key = (e) => `${e.tag}|${e.role ?? ''}|${e.name ?? ''}|${e.href ?? ''}`
const lines = (els) => els.map((e) => lib.describe(e, lib.opFor(e))).join('\n')
const actionable = (els) => els.filter((e) => !e.sensitive)

const WRITER_SYSTEM = `You write training data for a browser assistant that acts on web pages.
You get the interactive elements currently visible on one page, one per line: [index] kind "name" (current value) → action.
Write goals a real user might give the assistant, each accomplished by acting on exactly ONE listed element.
Rules:
- Phrase each goal naturally, the way a user would ask ("add the blue mug to my cart", "open the pricing page", "switch the site to dark mode"). Do not just copy the element's label, but the goal must pick out that one element unambiguously among ALL listed elements.
- Skip elements whose purpose you cannot tell (unnamed, icon-only, cryptic).
- For "→ type" or "→ select" elements also give "valueKey" (short snake_case, e.g. email, search_query, first_name) and a realistic "value". Do NOT put the value in the goal ("enter my email", not the address) — except for search queries, where the goal may say what to search for.
- Prefer a diverse mix: navigation links, buttons, toggles/checkboxes, form fields.
Think as long as you need, then end your reply with ONE JSON object:
{"pageKind": "normal" | "cookie_wall" | "login_wall" | "captcha" | "error", "goals": [{"index": <int>, "goal": "<text>", "valueKey": "<key or omit>", "value": "<value or omit>"}]}`

const VERIFY_SYSTEM = `You operate a web browser for a user. You see the interactive elements currently visible on the page, one per line: [index] kind "name" (current value) → action.
For EACH numbered goal, answer the index of the ONE listed element that should be used next to progress toward that goal.
If no listed element serves the goal (for example it is further down the page and not visible yet), answer null.
Think as long as you need, then end your reply with ONE JSON object:
{"answers": [{"goal": <goal number>, "index": <int or null>}]}`

async function write(model, vp, n, only) {
  const pool = only ?? actionable(vp.elements)
  const user = `Page: ${vp.title} (${vp.origin})\nElements:\n${lines(pool)}\n\nWrite up to ${n} goals.`
  const { json } = await askJson(model, WRITER_SYSTEM, user)
  const valid = new Set(pool.map((e) => e.index))
  const goals = (Array.isArray(json.goals) ? json.goals : [])
    .filter((g) => Number.isInteger(g.index) && valid.has(g.index) && typeof g.goal === 'string' && g.goal.length >= 6)
    .slice(0, n)
  return { pageKind: String(json.pageKind ?? 'normal'), goals }
}

async function verify(model, vp, goals) {
  if (!goals.length) return []
  const user = `Page: ${vp.title} (${vp.origin})\nElements:\n${lines(actionable(vp.elements))}\n\nGoals:\n${goals.map((g, i) => `${i + 1}. ${g.goal}`).join('\n')}`
  const { json } = await askJson(model, VERIFY_SYSTEM, user)
  const byGoal = new Map((Array.isArray(json.answers) ? json.answers : []).map((a) => [Number(a.goal), a.index]))
  return goals.map((_, i) => (byGoal.has(i + 1) ? byGoal.get(i + 1) : undefined))
}

function distractors(r, needKey, n) {
  const stem = needKey.split('_')[0]
  const keys = shuffle(Object.keys(VALUE_POOL).filter((k) => k !== needKey && !k.includes(stem) && !needKey.includes(k.split('_')[0])), r)
  return Object.fromEntries(keys.slice(0, n).map((k) => [k, VALUE_POOL[k]]))
}

function episodesFor(page, g, vpIdx, el, r) {
  const base = { pageId: page.pageId, split: page.split, site: page.site, category: page.category, goal: g.goal, vp: vpIdx, writer: g.writer, verifier: g.verifier }
  const op = lib.opFor(el)
  const out = []
  if (op === 'click') {
    out.push({ ...base, kind: 'target', values: {}, steps: [], label: el.index })
    out.push({ ...base, kind: 'move', values: {}, steps: [], label: 'act' })
    out.push({ ...base, kind: 'move', values: {}, steps: [{ action: 'click', index: el.index }], label: 'DONE' })
    return out
  }
  if (!g.valueKey || typeof g.value !== 'string' || !g.value) return out
  const k = String(g.valueKey).replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 30)
  const others = distractors(r, k, Math.floor(r() * 4))
  const values = Object.fromEntries(shuffle(Object.entries({ [k]: g.value, ...others }), r))
  const action = op === 'select' ? 'select' : 'type'
  out.push({ ...base, kind: 'target', values, steps: [], label: el.index })
  out.push({ ...base, kind: 'value', values, field: el.index, steps: [], label: k })
  out.push({ ...base, kind: 'move', values, steps: [], label: 'act' })
  out.push({ ...base, kind: 'move', values, steps: [{ action, index: el.index }], mutate: [{ index: el.index, value: g.value }], label: 'DONE' })
  // Only when the goal itself doesn't carry the value (a search goal usually does).
  if (!g.goal.toLowerCase().includes(g.value.toLowerCase()))
    out.push({ ...base, kind: 'move', values: others, steps: [], label: 'BLOCKED' })
  return out
}

async function labelPage(page) {
  const r = rng(page.pageId)
  const flip = parseInt(sha(page.pageId).slice(0, 2), 16) % 2
  const writer = TEACHERS[flip % TEACHERS.length]
  const verifier = TEACHERS[(flip + 1) % TEACHERS.length]
  const v0 = page.viewports[0]
  const stats = { pageId: page.pageId, url: page.finalUrl, writer, verifier, written: 0, kept: 0, below: 0, belowKept: 0, rejects: [] }
  const eps = []

  const w0 = await write(writer, v0, Number(args.goals))
  stats.pageKind = w0.pageKind
  const visible = w0.goals.map((g) => ({ ...g, writer, verifier }))

  // Goals for elements that exist only further down: the scroll_down source.
  const onScreen = new Set(v0.elements.map(key))
  let belowGoals = []
  let belowVp = -1
  const lower = page.viewports.slice(1).map((vp, i) => ({ vp, i: i + 1 }))
    .map(({ vp, i }) => ({ i, vp, fresh: actionable(vp.elements).filter((e) => !onScreen.has(key(e)) && e.name) }))
    .filter((x) => x.fresh.length >= 3)
  if (lower.length && Number(args.below) > 0) {
    const pick = lower[Math.floor(r() * lower.length)]
    belowVp = pick.i
    const wb = await write(writer, pick.vp, Number(args.below), pick.fresh)
    belowGoals = wb.goals.map((g) => ({ ...g, writer, verifier, below: true }))
  }

  // One verifier pass over viewport 0 with both sets, shuffled so the below-fold
  // goals aren't recognisable by position.
  const mixed = shuffle([...visible, ...belowGoals], r)
  const picks = await verify(verifier, v0, mixed)
  const byIndex0 = new Map(v0.elements.map((e) => [e.index, e]))
  const confirmedBelow = []
  mixed.forEach((g, i) => {
    const got = picks[i]
    if (!g.below) {
      stats.written++
      if (got === g.index) { stats.kept++; eps.push(...episodesFor(page, g, 0, byIndex0.get(g.index), r)) }
      else stats.rejects.push({ goal: g.goal, want: g.index, got })
    } else {
      stats.below++
      if (got === null) confirmedBelow.push(g)
      else stats.rejects.push({ goal: g.goal, below: true, got })
    }
  })

  // A below-fold goal must also ground on ITS viewport, or it may be unsatisfiable anywhere.
  if (confirmedBelow.length) {
    const vpB = page.viewports[belowVp]
    const byIndexB = new Map(vpB.elements.map((e) => [e.index, e]))
    const back = await verify(verifier, vpB, confirmedBelow)
    confirmedBelow.forEach((g, i) => {
      if (back[i] !== g.index) { stats.rejects.push({ goal: g.goal, below: true, lowerGot: back[i], want: g.index }); return }
      stats.belowKept++
      const el = byIndexB.get(g.index)
      const lowerEps = episodesFor(page, g, belowVp, el, r).filter((e) => e.kind !== 'move' || e.label === 'act')
      eps.push(...lowerEps)
      const moveVals = lowerEps.find((e) => e.kind === 'target')?.values ?? {}
      eps.push({ pageId: page.pageId, split: page.split, site: page.site, category: page.category, goal: g.goal, vp: 0,
        writer, verifier, kind: 'move', values: moveVals, steps: [], label: 'scroll_down' })
    })
  }

  // Two-field fills: the kept type goals on viewport 0, in document order.
  const typed = eps.filter((e) => e.kind === 'value' && e.vp === 0)
  if (typed.length >= 2) {
    const [a, b] = typed.slice(0, 2).sort((x, y) => byIndex0.get(x.field).y - byIndex0.get(y.field).y)
    const va = a.values[a.label], vb = b.values[b.label]
    const goal = `${a.goal.replace(/[.!]$/, '')}, and ${b.goal.charAt(0).toLowerCase()}${b.goal.slice(1)}`
    const values = Object.fromEntries(shuffle(Object.entries({ ...a.values, ...b.values }), r))
    const base = { pageId: page.pageId, split: page.split, site: page.site, category: page.category, goal, vp: 0, writer, verifier, composed: true }
    const s1 = [{ action: 'type', index: a.field }]
    const m1 = [{ index: a.field, value: va }]
    eps.push({ ...base, kind: 'target', values, steps: [], label: a.field })
    eps.push({ ...base, kind: 'target', values, steps: s1, mutate: m1, label: b.field })
    eps.push({ ...base, kind: 'value', values, field: b.field, steps: s1, mutate: m1, label: b.label })
    eps.push({ ...base, kind: 'move', values, steps: s1, mutate: m1, label: 'act' })
    eps.push({ ...base, kind: 'move', values, steps: [...s1, { action: 'type', index: b.field }],
      mutate: [...m1, { index: b.field, value: vb }], label: 'DONE' })
  }

  for (const e of eps) appendJsonl(OUT, e)
  appendJsonl(LOG, { ...stats, episodes: eps.length, at: new Date().toISOString() })
  return stats
}

async function main() {
  const pages = readJsonl(PAGES)
  const done = new Set(readJsonl(LOG).map((r) => r.pageId))
  const todo = pages.filter((p) => !done.has(p.pageId)).slice(0, Number(args.limit) || undefined)
  log(`${todo.length} pages to label (${done.size} done) · teachers ${TEACHERS.join(' ⇄ ')}`)
  let i = 0, kept = 0, written = 0
  const worker = async () => {
    while (i < todo.length) {
      const page = todo[i++]
      const t0 = Date.now()
      try {
        const s = await labelPage(page)
        kept += s.kept; written += s.written
        log(`${page.pageId} ${s.kept}/${s.written} kept, below ${s.belowKept}/${s.below} · ${Math.round((Date.now() - t0) / 1000)}s · running agreement ${(kept / Math.max(1, written)).toFixed(2)} · ${page.finalUrl}`)
      } catch (err) {
        log(`fail ${page.pageId}: ${String(err.message ?? err).slice(0, 160)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker))
  log(`done → ${OUT}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
