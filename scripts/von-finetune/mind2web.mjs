// Stage M2 — Mind2Web raw rows → pages.jsonl + episodes.jsonl in the pipeline's
// shape, one task at a time (the raw files are sorted by task, so only one
// task's rows are ever in memory). The conversion rules live in
// mind2web-lib.mjs (pure, tested); this is the file plumbing.
//
//   node scripts/von-finetune/mind2web.mjs [--splits train,test_task,test_website,test_domain] [--limit N tasks] [--raw-suffix limit]
//
// Output: DATA/mind2web/{pages,episodes}.jsonl (rewritten each run — it is a
// deterministic function of the raw files) and mind2web-stats.json, whose
// `skipped` block names every step that produced no page and why.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { parseArgs } from 'node:util'
import { DATA, log, rng, writeJsonl } from './lib.mjs'
import { convertTask } from './mind2web-lib.mjs'

const { values: args } = parseArgs({
  options: {
    splits: { type: 'string', default: 'train,test_task,test_website,test_domain' },
    limit: { type: 'string', default: '0' },
    'raw-suffix': { type: 'string', default: '' },
  },
})
const DIR = path.join(DATA, 'mind2web')
const limit = Number(args.limit) || Infinity

async function* tasksOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity })
  let cur = []
  let id
  for await (const line of rl) {
    if (!line) continue
    const row = JSON.parse(line)
    if (id !== undefined && row.annotation_id !== id) {
      yield cur
      cur = []
    }
    id = row.annotation_id
    cur.push(row)
  }
  if (cur.length) yield cur
}

const add = (m, k, n = 1) => {
  m[k] = (m[k] ?? 0) + n
}
const pages = []
const episodes = []
const stats = { splits: {}, episodes: { byKind: {}, byGoalKind: {}, byLabel: {} }, skipped: {}, warnings: {}, websites: 0, valSites: [] }
const sites = new Set()
const valSites = new Set()
let tasks = 0
for (const split of args.splits.split(',').filter(Boolean)) {
  const file = path.join(DIR, 'raw', `${split}.${args['raw-suffix'] ? `${args['raw-suffix']}.` : ''}jsonl.gz`)
  if (!fs.existsSync(file)) {
    log(`missing ${file} — run mind2web-fetch.py first`)
    continue
  }
  const s = { rows: 0, tasks: 0, pages: 0, episodes: 0 }
  const t0 = Date.now()
  for await (const rows of tasksOf(file)) {
    if (tasks >= limit) break
    tasks++
    const out = convertTask(rows, { rng: rng(rows[0].annotation_id) })
    s.rows += rows.length
    s.tasks++
    s.pages += out.pages.length
    s.episodes += out.episodes.length
    pages.push(...out.pages)
    episodes.push(...out.episodes)
    for (const [k, v] of Object.entries(out.skipped)) add(stats.skipped, k, v)
    for (const [k, v] of Object.entries(out.warnings)) add(stats.warnings, k, v)
    for (const p of out.pages) {
      sites.add(p.site)
      if (p.split === 'val') valSites.add(p.site)
    }
    if (s.tasks % 100 === 0) log(`${split}: ${s.tasks} tasks · ${s.pages} pages · ${s.episodes} episodes · ${Math.round((Date.now() - t0) / 1000)}s`)
  }
  stats.splits[split] = s
  log(`${split}: ${JSON.stringify(s)} in ${Math.round((Date.now() - t0) / 1000)}s`)
}
for (const e of episodes) {
  add(stats.episodes.byKind, e.kind)
  add(stats.episodes.byGoalKind, e.goalKind)
  add(stats.episodes.byLabel, e.kind === 'move' ? e.label : e.kind === 'target' ? e.op : 'value')
}
stats.websites = sites.size
stats.valSites = [...valSites].sort()
writeJsonl(path.join(DIR, 'pages.jsonl'), pages)
writeJsonl(path.join(DIR, 'episodes.jsonl'), episodes)
fs.writeFileSync(path.join(DIR, 'mind2web-stats.json'), JSON.stringify(stats, null, 2))
log(JSON.stringify({ tasks, pages: pages.length, episodes: episodes.length, skipped: stats.skipped, warnings: stats.warnings, websites: stats.websites, valSites: stats.valSites.length }))
