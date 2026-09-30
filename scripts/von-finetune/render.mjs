// Stage 3 — episodes → Von training rows, through the SHIPPED candidate-action
// builders (observation.ts / candidates.ts / vonPolicy.ts, bundled via
// prompt-entry.ts). A rendered row is exactly the DecideRequest createVonPolicy
// would send for that state, in the record format of Von's own trainer:
// {state, question, options:[{id, description}], label}.
//
//   node scripts/von-finetune/render.mjs [--done-per-act 0.6] [--head act|lazy]
//
// `--head act` (default, 2026-09-30): the single-pass act head — one `act`
// question per decision whose options are every (control, action) pair plus
// the global moves (createVonActPolicy), state WITHOUT the control list. A
// target episode → label `<id>:<op>`; a move episode → the move (`act` moves
// are covered by their sibling target episode, which renders the identical
// row). Above ACT_CHUNK element options: chunk rows (element options only,
// only when the label is an element) and a final row (chunk winners + moves).
// `--head lazy`: the previous heads — `operation` (state WITH the control
// list), `target_<OP>` (state without it; incl. the TARGET_CHUNK tournament's
// chunk and final rounds). Both: `value` rows; `blocked_reason` has no labels
// and stays zero-shot. Episode labels transfer by construction: move `act` →
// the sibling target's own operation (CLICK, or TYPE_TEXT / SELECT_OPTION when
// values exist), `scroll_down` → SCROLL_DOWN, DONE/BLOCKED unchanged.
//
// Output: data/train.jsonl, data/val.jsonl, data/render-stats.json.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DATA, log, promptLib, readJsonl, rng, shuffle, writeJsonl } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    'done-per-act': { type: 'string', default: '0.6' },
    head: { type: 'string', default: 'act' },
  },
})
if (!['act', 'lazy'].includes(args.head)) throw new Error(`--head must be act or lazy, got ${args.head}`)
const lib = await promptLib()
const pages = new Map(readJsonl(path.join(DATA, 'pages.jsonl')).map((p) => [p.pageId, p]))
const episodes = readJsonl(path.join(DATA, 'episodes.jsonl'))

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) ?? [])
const overlap = (goal, c) => { const g = words(goal); let n = 0; for (const w of words(`${c.name} ${c.group ?? ''}`)) if (g.has(w)) n++; return n }
const toOptions = (q) => Object.entries(q.options).map(([id, description]) => ({ id, description }))
const OP_OF_ACTION = { click: 'CLICK', type: 'TYPE_TEXT', select: 'SELECT_OPTION' }

/** The operation a control's own nature implies for this task (candidates.ts's gating, mirrored). */
function operationFor(control, valueKeys) {
  if (control.kind === 'type' && valueKeys.length) return 'TYPE_TEXT'
  if (control.kind === 'select' && valueKeys.length) return 'SELECT_OPTION'
  return 'CLICK'
}

/** The sibling target episode of a move:act row (same page, goal, viewport and history). */
const targetsByKey = new Map()
for (const ep of episodes) {
  if (ep.kind !== 'target') continue
  targetsByKey.set(`${ep.pageId}|${ep.vp}|${ep.goal}|${ep.steps.length}`, ep)
}

function contextOf(ep) {
  const page = pages.get(ep.pageId)
  const vp = page?.viewports[ep.vp]
  if (!vp) return null
  const edits = new Map((ep.mutate ?? []).map((m) => [m.index, m.value]))
  // The collected elements predate domIndex's disabled/readonly/checked/value
  // facts (collect.mjs stores index/tag/role/name/type/href/sensitive/y), so a
  // rendered control carries no state decoration unless a composed episode
  // typed a value into it. Scroll state comes from the viewport's offset.
  const elements = vp.elements.map((e) => ({
    ...e, rect: { x: 0, y: e.y ?? 0, width: 1, height: 1 },
    value: edits.has(e.index) ? edits.get(e.index) : e.value,
  }))
  const snapshot = {
    url: vp.url ?? page.finalUrl ?? page.url, title: vp.title, origin: vp.origin, dpr: 1, elements, text: '', truncated: !!vp.truncated,
    scroll: { y: vp.scrollY ?? 0, max: Math.max(0, (page.scrollHeight ?? 0) - (page.innerHeight ?? 0)) },
  }
  const observation = lib.buildObservation(snapshot)
  const byId = new Map(observation.controls.map((c) => [c.id, c]))
  const values = ep.values ?? {}
  const valueKeys = Object.keys(values)
  const keyOf = (index) => valueKeys.find((k) => values[k] === edits.get(index))
  const steps = ep.steps.map((s) => ({
    operation: OP_OF_ACTION[s.action] ?? 'CLICK', targetId: s.index,
    label: lib.clip(byId.get(s.index)?.name || '(unnamed)', 60),
    valueKey: s.action === 'type' || s.action === 'select' ? keyOf(s.index) : undefined,
    result: 'success',
  }))
  const space = lib.buildCandidateSpace({ goal: ep.goal, observation, values, history: steps })
  const ctx = { goal: ep.goal, observation, space, values, steps }
  return { ctx, space, byId, valueKeys }
}

/**
 * The single-pass head's rows for one episode: the act question over every
 * (control, action) pair + the moves, mirroring createVonActPolicy — one row
 * when the element options fit ACT_CHUNK; above it, a chunk row (element
 * options only, only when the label is an element option) and a final row
 * (the target or the other chunks' most goal-like control, plus the moves).
 */
function actRowsFor(ep, ctx, space, byId, valueKeys, meta, state) {
  let label
  let target
  if (ep.kind === 'move') {
    if (ep.label === 'act') return [] // its sibling target episode renders the identical row
    label = ep.label === 'scroll_down' ? 'SCROLL_DOWN' : ep.label // DONE | BLOCKED
    if (!space.operations.includes(label)) return []
  } else {
    target = byId.get(ep.label)
    if (!target || !target.actions.length) return []
    const op = operationFor(target, valueKeys)
    if (!space.targets[op].includes(target.id)) return []
    label = `${target.id}:${op}`
  }
  const elements = lib.actElementOptions(space, byId)
  const moves = lib.actMoveOptions(space)
  const row = (options, round) => {
    const q = lib.actQuestion(options)
    return { state, question: q.instructions, options: toOptions(q), label, meta: { ...meta, kind: 'act', op: target ? label.split(':')[1] : label, round, pool: options.length } }
  }
  const chunks = lib.balancedChunks(elements, lib.ACT_CHUNK)
  if (chunks.length === 1) return [row([...elements, ...moves], 'single')]
  const has = (ch) => target && ch.some((o) => o.control?.id === target.id && o.id === label)
  const best = (ch) => [...ch].sort((a, b) => overlap(ep.goal, b.control) - overlap(ep.goal, a.control))[0]
  const winners = chunks.map((ch) => (has(ch) ? ch.find((o) => o.id === label) : best(ch)))
  const rows = [row([...winners, ...moves], 'final')]
  if (target) rows.unshift(row(chunks.find(has), 'chunk'))
  return rows
}

function rowsFor(ep) {
  const c = contextOf(ep)
  if (!c) return []
  const { ctx, space, byId, valueKeys } = c
  const meta = { kind: ep.kind, pageId: ep.pageId, site: ep.site, split: ep.split, category: ep.category, writer: ep.writer, composed: !!ep.composed }
  const withControls = lib.renderState(ctx, space.shown)
  const withoutControls = lib.renderState(ctx, space.shown, { controls: false })

  if (args.head === 'act' && ep.kind !== 'value') return actRowsFor(ep, ctx, space, byId, valueKeys, meta, withoutControls)

  if (ep.kind === 'move') {
    let label
    if (ep.label === 'act') {
      const sibling = targetsByKey.get(`${ep.pageId}|${ep.vp}|${ep.goal}|${ep.steps.length}`)
      const target = sibling ? byId.get(sibling.label) : undefined
      if (!target || !target.actions.length) return []
      label = operationFor(target, valueKeys)
      if (!space.targets[label].includes(target.id)) return []
    } else if (ep.label === 'scroll_down') label = 'SCROLL_DOWN'
    else label = ep.label // DONE | BLOCKED
    const q = lib.operationQuestion(space)
    if (!(label in q.options)) return []
    return [{ state: withControls, question: q.instructions, options: toOptions(q), label, meta: { ...meta, kind: 'operation', op: label } }]
  }
  if (ep.kind === 'value') {
    const control = byId.get(ep.field)
    if (!control || !(ep.label in ctx.values)) return []
    const q = lib.valueQuestion(control, ctx.values)
    return [{ state: withoutControls, question: q.instructions, options: toOptions(q), label: ep.label, meta }]
  }
  // target — mirror createVonPolicy: one question over the operation's pool, or the TARGET_CHUNK tournament.
  const target = byId.get(ep.label)
  if (!target || !target.actions.length) return []
  const op = operationFor(target, valueKeys)
  const pool = space.targets[op].map((id) => byId.get(id))
  if (!pool.includes(target)) return []
  const chunks = lib.targetChunks(pool)
  const row = (p, round) => {
    const q = lib.targetQuestion(op, p)
    return { state: withoutControls, question: q.instructions, options: toOptions(q), label: String(target.id), meta: { ...meta, op, round, pool: p.length } }
  }
  if (chunks.length === 1) return [row(chunks[0], 'single')]
  // Final round: the target plus each other chunk's most goal-like control — the
  // hard negative a real first round is most likely to have promoted.
  const winners = chunks.map((ch) => (ch.includes(target) ? target : [...ch].sort((a, b) => overlap(ep.goal, b) - overlap(ep.goal, a))[0]))
  return [row(chunks.find((ch) => ch.includes(target)), 'chunk'), row(winners, 'final')]
}

/**
 * The labeler emits a DONE for nearly every act (the same goal, one step
 * later), so DONE is capped relative to the element operations. Those are never
 * cut: they are the commonest real decision and the one the base model never
 * clears the gate on (eval 2026-09-27: 8/54).
 */
function balance(rows, r) {
  const isMoveRow = (x) => x.meta.kind === 'operation' || x.meta.kind === 'act'
  const isDone = (x) => isMoveRow(x) && x.meta.op === 'DONE'
  const acts = rows.filter((x) => isMoveRow(x) && lib.isElementOperation(x.meta.op)).length
  const done = shuffle(rows.filter(isDone), r).slice(0, Math.round(acts * Number(args['done-per-act'])))
  return shuffle([...rows.filter((x) => !isDone(x)), ...done], r)
}

function stats(rows) {
  const out = {}
  for (const x of rows) {
    const k = x.meta.kind === 'operation' ? `operation:${x.meta.op}` : x.meta.kind === 'target' ? `target:${x.meta.op}:${x.meta.round}` : x.meta.kind === 'act' ? `act:${x.meta.op}:${x.meta.round}` : x.meta.kind
    out[k] = (out[k] ?? 0) + 1
  }
  out.total = rows.length
  out.sites = new Set(rows.map((x) => x.meta.site)).size
  out.meanChars = Math.round(rows.reduce((a, x) => a + x.state.length + x.question.length + x.options.reduce((b, o) => b + o.description.length + 8, 0), 0) / Math.max(1, rows.length))
  return out
}

const all = episodes.flatMap(rowsFor)
const r = rng('render')
const train = balance(all.filter((x) => x.meta.split === 'train'), r)
const val = balance(all.filter((x) => x.meta.split === 'val'), r)
writeJsonl(path.join(DATA, 'train.jsonl'), train)
writeJsonl(path.join(DATA, 'val.jsonl'), val)
const summary = { head: args.head, episodes: episodes.length, rendered: all.length, train: stats(train), val: stats(val) }
fs.writeFileSync(path.join(DATA, 'render-stats.json'), JSON.stringify(summary, null, 2))
log(JSON.stringify(summary, null, 2))
