// The one writer of report.json, shared by run.mjs and ep-placement.mjs. A
// partial run (EVAL_PHASES, or ep-placement on its own) replaces only the
// sections it measured and keeps the rest, and every invocation appends an
// entry to `runs` naming the phases it produced — so which number came from
// which run is recorded by the code, never reconstructed by hand. The verdict
// is re-derived from whatever sections the file then holds.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// EVAL_REPORT lets a candidate model (e.g. a fine-tune) report beside, not over, the baseline.
export const REPORT_PATH = process.env.EVAL_REPORT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'report.json')
const SECTIONS = ['env', 'download', 'parity', 'bootMs', 'model', 'grounding', 'llm', 'e2e', 'epPlacement']
const round = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n

/**
 * @param run      {phases: string[], startedAt: string, finishedAt: string, skipped?: string[]}
 * @param sections the sections this invocation measured (undefined keys are ignored)
 */
export function writeReport(run, sections) {
  const prev = fs.existsSync(REPORT_PATH) ? JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) : {}
  const report = { runs: [...(Array.isArray(prev.runs) ? prev.runs : []), run] }
  for (const k of SECTIONS) {
    const v = k === 'epPlacement' && sections.epPlacement ? { ...(prev.epPlacement ?? {}), ...sections.epPlacement } : sections[k]
    if (v !== undefined) report[k] = v
    else if (prev[k] !== undefined) report[k] = prev[k]
  }
  report.verdict = verdict(report)
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1))
  return report
}

export function verdict(r) {
  const out = []
  const g = r.grounding
  const ep = r.epPlacement?.webgpu
  if (g) {
    const p50 = g.decideMs.all.p50
    const where = ep ? ` (${ep.summary})` : ' (EP placement not measured)'
    out.push(`p50 decide ${p50} ms ${p50 > 300 ? '> ~300 ms: KILL condition met' : '<= ~300 ms: latency OK'}${where}`)
  }
  if (g && r.llm) {
    const d = g.accuracyTop1 - r.llm.accuracyTop1
    out.push(`grounding Von ${g.accuracyTop1} vs LLM ${r.llm.accuracyTop1} (delta ${round(d)})${d < -0.05 ? ': Von clearly below the LLM: KILL condition met' : ': not clearly below the LLM'}`)
  }
  if (g) {
    const gate = g.operationAboveGate ?? g.moveAboveGate
    let clause = `first-operation gate cleared in ${gate}/${g.cases} grounding cases` +
      (g.operationCorrectAboveGate != null ? ` (correct operation AND above the gate in ${g.operationCorrectAboveGate}; expected control in the candidate set in ${g.expectedInSpace}/${g.cases})` : '')
    const rows = r.e2e?.rows ?? []
    const acts = rows.flatMap((x) => x.actStatuses ?? [])
    if (acts.length) {
      const nonDone = acts.filter((s) => s !== 'done').length
      const steps = rows.reduce((a, x) => a + (x.actSteps ?? 0), 0)
      clause += `; e2e: ${nonDone}/${acts.length} Act calls ended non-done, ${steps} Act actions in total`
    }
    out.push(clause)
  }
  if (r.parity) out.push(`WebGPU parity max|dp| ${r.parity.maxDeltaP}, argmax flips ${r.parity.argmaxFlips} (${r.parity.cases} golden cases)`)
  return out
}
