// Re-score a finished run with the current report.mjs, optionally merging the rows of other runs
// (a re-run of the tasks a harness failure broke). No browser, no model: results.json keeps every
// row's raw data (tools, traces, URL timeline, shadow records, captured driver requests).
//
//   node scripts/decider-eval/rescore.mjs <run-dir> [--merge <run-dir>]… [--out <dir>]
//
// A merged row replaces the base run's row for the same (task, arm, rep). Without --out the base
// run's results.json and report.md are rewritten in place (the raw rows are kept as they were).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_THRESHOLD, renderMarkdown, scoreRow, summarize, summaryLine } from './report.mjs'

const argv = process.argv.slice(2)
const base = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : null
if (!base) {
  console.error('usage: node scripts/decider-eval/rescore.mjs <run-dir> [--merge <run-dir>]… [--out <dir>]')
  process.exit(2)
}
const merges = []
let out = base
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--merge') merges.push(resolve(argv[++i]))
  else if (argv[i] === '--out') out = resolve(argv[++i])
  else throw new Error(`unexpected argument ${argv[i]}`)
}

const load = (dir) => JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
const results = load(base)
const id = (r) => `${r.task}/${r.arm}/${r.rep}`
for (const dir of merges) {
  const extra = load(dir)
  const replace = new Map(extra.rows.map((r) => [id(r), r]))
  results.rows = [...results.rows.filter((r) => !replace.has(id(r))), ...replace.values()]
  results.meta.spent = +((results.meta.spent ?? 0) + (extra.meta.spent ?? 0)).toFixed(4)
  ;(results.meta.mergedFrom ??= []).push({ dir, startedAt: extra.meta.startedAt, rows: [...replace.keys()] })
}
const order = new Map(results.meta.tasks.map((t, i) => [t, i]))
results.rows.sort((a, b) => a.rep - b.rep || (order.get(a.task) ?? 99) - (order.get(b.task) ?? 99) || results.meta.arms.indexOf(a.arm) - results.meta.arms.indexOf(b.arm))

const threshold = results.meta.threshold ?? DEFAULT_THRESHOLD
for (const r of results.rows) r.score = scoreRow(r, threshold)
results.summary = summarize(results.rows)
results.meta.rescoredAt = new Date().toISOString()
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1))
writeFileSync(join(out, 'report.md'), renderMarkdown(results))
console.error(`rescored ${results.rows.length} row(s) → ${join(out, 'report.md')}`)
console.log(summaryLine(results.summary, threshold))
