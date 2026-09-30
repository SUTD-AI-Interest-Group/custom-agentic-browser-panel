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
import { DATA, log, promptLib, readJsonl, resolveSplits, rng, shuffle, writeJsonl } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    'done-per-act': { type: 'string', default: '0.6' },
    head: { type: 'string', default: 'act' },
    // Extra corpora under DATA/<name>/{pages,episodes}.jsonl (e.g. `--corpus mind2web`, from mind2web.mjs), merged with the teacher corpus.
    corpus: { type: 'string', multiple: true, default: [] },
    // The typed-instruction heads (spec §3, first batch): t1 done, t2 missing field, t4 submit, t5 committing. `none` skips them.
    typed: { type: 'string', default: 't1,t2,t4,t5' },
    // Per-head row caps after balancing, applied per split. A value ≤ 1 is a fraction of that split's act-head rows (so val
    // keeps train's composition); > 1 is an absolute count. t2/t4 are uncapped unless named.
    'typed-cap': { type: 'string', default: 't1=0.1,t5=0.2' },
  },
})
if (!['act', 'lazy'].includes(args.head)) throw new Error(`--head must be act or lazy, got ${args.head}`)
const lib = await promptLib()
const pages = new Map(readJsonl(path.join(DATA, 'pages.jsonl')).map((p) => [p.pageId, { corpus: 'teacher', ...p }]))
const episodes = readJsonl(path.join(DATA, 'episodes.jsonl')).map((e) => ({ corpus: 'teacher', goalKind: 'step', ...e }))
for (const name of args.corpus) {
  for (const p of readJsonl(path.join(DATA, name, 'pages.jsonl'))) pages.set(p.pageId, p)
  episodes.push(...readJsonl(path.join(DATA, name, 'episodes.jsonl')))
  log(`corpus ${name}: ${pages.size} pages, ${episodes.length} episodes so far`)
}
// The split is site-level across corpora: a val page whose site is a train site anywhere moves to train (val loses, never the reverse).
const moved = resolveSplits(pages)
for (const ep of episodes) ep.split = pages.get(ep.pageId)?.split ?? ep.split
if (moved) log(`site-level split: ${moved} val pages moved to train (their site is a train site in another corpus)`)

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) ?? [])
const overlap = (goal, c) => { const g = words(goal); let n = 0; for (const w of words(`${c.name} ${c.group ?? ''}`)) if (g.has(w)) n++; return n }
const toOptions = (q) => Object.entries(q.options).map(([id, description]) => ({ id, description }))
const OP_OF_ACTION = { click: 'CLICK', type: 'TYPE_TEXT', select: 'SELECT_OPTION' }
const ACTION_OF_OP = { CLICK: 'click', TYPE_TEXT: 'type', SELECT_OPTION: 'select' }

// ---- The typed-instruction heads (spec §3). Yes/no heads use Von's own noul
// packing: two options with explicit affirmative/negative descriptions. ----
const T1 = {
  question: 'Is the task complete on this page, with no further action needed?',
  options: [
    { id: 'yes', description: 'Yes: the goal is already achieved on this page and nothing more needs to be done.' },
    { id: 'no', description: 'No: at least one more action is still needed to reach the goal.' },
  ],
}
const T2_QUESTION = 'Which of these fields still needs a value to complete the task?'
const T4_QUESTION = 'Which of these controls submits the form?'
const T5_QUESTION = 'Is taking this action reversible, or does it commit to something (submit, payment, navigating away)?'
// No `uncertain` option: an option with no labels is dead weight exactly like WAIT; the confidence gate expresses uncertainty.
const T5_OPTIONS = [
  { id: 'reversible', description: 'Reversible: it only changes what is shown on the page and can be backed out of.' },
  { id: 'committing', description: 'Committing: it submits, pays, deletes, sends, signs in, or leaves the page.' },
]
const TYPED = new Set(args.typed === 'none' ? [] : args.typed.split(',').filter(Boolean))
const CAPS = Object.fromEntries(args['typed-cap'].split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)] }))
/** T4/T5 are page facts, rendered once per (page, viewport) whatever the number of episodes on it. */
const seenTyped = new Set()
const typedRng = rng('typed')
const metaOf = (ep) => ({ kind: ep.kind, pageId: ep.pageId, site: ep.site, split: ep.split, category: ep.category, writer: ep.writer, composed: !!ep.composed, corpus: ep.corpus, goalKind: ep.goalKind })

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
  targetsByKey.set(`${ep.pageId}|${ep.vp}|${ep.goalKind}|${ep.goal}|${ep.steps.length}`, ep)
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
  // A step may carry its own label/valueKey (a Mind2Web trajectory: the prior
  // step happened on ANOTHER page, so its index means nothing in this registry
  // and may be absent); a teacher step is resolved against this page as before.
  const steps = ep.steps.map((s) => ({
    operation: OP_OF_ACTION[s.action] ?? 'CLICK', targetId: s.index,
    label: s.label ?? lib.clip(byId.get(s.index)?.name || '(unnamed)', 60),
    valueKey: s.valueKey ?? (s.action === 'type' || s.action === 'select' ? keyOf(s.index) : undefined),
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
    const op = ep.op ?? operationFor(target, valueKeys) // a human-labelled op (Mind2Web) wins over the inferred one
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
  const head = headRowsFor(ep, c)
  const wantsTyped = ep.kind === 'target' || (ep.kind === 'move' && ep.label === 'DONE')
  return wantsTyped ? [...head, ...typedRowsFor(ep, c)] : head
}

/**
 * The typed-instruction heads for one episode's state. T1 (done) for every
 * target episode (no) and every teacher DONE move (yes); T2 (missing field)
 * for a Mind2Web task-goal field step; T4 (submit) and T5 (committing) once
 * per (page, viewport). T5's label IS the shipped isPointOfNoReturn over the
 * raw element; anchors are excluded because a link's reversibility is a
 * cross-origin fact the state text never shows.
 */
function typedRowsFor(ep, c) {
  const { ctx, space } = c
  const meta = metaOf(ep)
  const rows = []
  const withControls = lib.renderState(ctx, space.shown)
  const withoutControls = lib.renderState(ctx, space.shown, { controls: false })
  const vp = pages.get(ep.pageId)?.viewports[ep.vp]
  const rawById = new Map((vp?.elements ?? []).map((e) => [e.index, { ...e, rect: { x: 0, y: e.y ?? 0, width: 1, height: 1 } }]))
  const origin = ctx.observation.page.origin
  if (TYPED.has('t1')) {
    const label = ep.kind === 'move' && ep.label === 'DONE' ? 'yes' : 'no'
    rows.push({ state: withControls, question: T1.question, options: T1.options, label, meta: { ...meta, kind: 't1_done', label } })
  }
  if (ep.kind !== 'target') return rows
  if (TYPED.has('t2') && ep.goalKind === 'task' && lib.isFieldOperation(ep.op ?? '')) {
    const fields = ctx.observation.controls.filter((x) => x.actions.includes('type_text') || x.actions.includes('select_option'))
    if (fields.length >= 2 && fields.some((x) => x.id === ep.label) && (fields.some((x) => x.value) || ep.steps.length))
      rows.push({ state: withoutControls, question: T2_QUESTION, options: fields.map((x) => ({ id: String(x.id), description: lib.renderControl(x) })), label: String(ep.label), meta: { ...meta, kind: 't2_field' } })
  }
  const once = `${ep.pageId}|${ep.vp}`
  if (seenTyped.has(once)) return rows
  seenTyped.add(once)
  if (TYPED.has('t4')) {
    const byForm = new Map()
    for (const x of ctx.observation.controls) {
      const f = rawById.get(x.id)?.form
      if (!f || x.role !== 'button' || !x.actions.length) continue
      if (!byForm.has(f)) byForm.set(f, [])
      byForm.get(f).push(x)
    }
    for (const buttons of byForm.values()) {
      const submitters = buttons.filter((x) => x.fingerprint.type === 'submit' || x.fingerprint.type === 'image')
      if (buttons.length >= 2 && submitters.length === 1)
        rows.push({ state: withoutControls, question: T4_QUESTION, options: buttons.map((x) => ({ id: String(x.id), description: lib.renderControl(x) })), label: String(submitters[0].id), meta: { ...meta, kind: 't4_submit' } })
    }
  }
  if (TYPED.has('t5')) {
    const cands = []
    for (const x of ctx.observation.controls) {
      if (!x.actions.length || x.fingerprint.tag === 'a') continue
      for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT_OPTION']) {
        if (op === 'TYPE_TEXT' && !x.actions.includes('type_text')) continue
        if (op === 'SELECT_OPTION' && !x.actions.includes('select_option')) continue
        const el = rawById.get(x.id)
        if (!el) continue
        const committing = lib.isPointOfNoReturn({ action: ACTION_OF_OP[op], index: x.id }, el, origin)
        cands.push({ x, op, label: committing ? 'committing' : 'reversible' })
      }
    }
    const take = (label) => shuffle(cands.filter((k) => k.label === label), typedRng).slice(0, 2)
    for (const k of [...take('committing'), ...take('reversible')])
      rows.push({ state: withoutControls, question: `${T5_QUESTION}\nAction: ${lib.renderControlAction(k.x, k.op)}`, options: T5_OPTIONS, label: k.label, meta: { ...meta, kind: 't5_commit', op: k.op, label: k.label } })
  }
  return rows
}

function headRowsFor(ep, c) {
  const { ctx, space, byId, valueKeys } = c
  const meta = metaOf(ep)
  const withControls = lib.renderState(ctx, space.shown)
  const withoutControls = lib.renderState(ctx, space.shown, { controls: false })

  if (args.head === 'act' && ep.kind !== 'value') return actRowsFor(ep, ctx, space, byId, valueKeys, meta, withoutControls)

  if (ep.kind === 'move') {
    let label
    if (ep.label === 'act') {
      const sibling = targetsByKey.get(`${ep.pageId}|${ep.vp}|${ep.goalKind}|${ep.goal}|${ep.steps.length}`)
      const target = sibling ? byId.get(sibling.label) : undefined
      if (!target || !target.actions.length) return []
      label = sibling.op ?? operationFor(target, valueKeys)
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
  const op = ep.op ?? operationFor(target, valueKeys)
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
  let out = [...rows.filter((x) => !isDone(x)), ...done]
  // T1: every yes, at most 2× as many no (nearly every state is a "no").
  const t1yes = out.filter((x) => x.meta.kind === 't1_done' && x.label === 'yes').length
  const t1no = shuffle(out.filter((x) => x.meta.kind === 't1_done' && x.label === 'no'), r).slice(0, 2 * t1yes)
  out = [...out.filter((x) => !(x.meta.kind === 't1_done' && x.label === 'no')), ...t1no]
  // Per-head caps, so a head with tens of thousands of candidate rows cannot dominate an epoch. A fractional cap is
  // relative to this split's act-head rows, so val's composition mirrors train's whatever their sizes.
  const actRows = out.filter(isMoveRow).length
  for (const [head, cap] of Object.entries(CAPS)) {
    const kind = { t1: 't1_done', t2: 't2_field', t4: 't4_submit', t5: 't5_commit' }[head] ?? head
    const n = cap <= 1 ? Math.round(cap * actRows) : cap
    const mine = shuffle(out.filter((x) => x.meta.kind === kind), r).slice(0, n)
    out = [...out.filter((x) => x.meta.kind !== kind), ...mine]
  }
  return shuffle(out, r)
}

function stats(rows) {
  const out = {}
  for (const x of rows) {
    const k = x.meta.kind === 'operation' ? `operation:${x.meta.op}` : x.meta.kind === 'target' ? `target:${x.meta.op}:${x.meta.round}` : x.meta.kind === 'act' ? `act:${x.meta.op}:${x.meta.round}`
      : x.meta.kind === 't1_done' || x.meta.kind === 't5_commit' ? `${x.meta.kind}:${x.label}` : x.meta.kind
    out[k] = (out[k] ?? 0) + 1
  }
  for (const x of rows) {
    out[`corpus:${x.meta.corpus}`] = (out[`corpus:${x.meta.corpus}`] ?? 0) + 1
    out[`goalKind:${x.meta.goalKind}`] = (out[`goalKind:${x.meta.goalKind}`] ?? 0) + 1
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
