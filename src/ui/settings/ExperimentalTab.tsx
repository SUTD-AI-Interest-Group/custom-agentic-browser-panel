import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../../data/settings'
import { formatBytes } from '../../data/usage'
import {
  DEFAULT_ACT_THRESHOLD,
  MODEL_ID,
  MODEL_STATUS_KEY,
  normalizeDecider,
  type DeciderMode,
} from '../../decider/config'
import { getDeciderEngine } from '../../decider/engine'
import type { DecisionRequest } from '../../decider/request'
import { clearShadow, listShadow, type ShadowRecord } from '../../decider/shadowStore'
import { summarize } from '../../decider/stats'
import { deleteModel, getModelStatus, importModel, type ImportSource, type ModelStatus } from '../../decider/storage'
import { Section, Select } from './primitives'

/** The self-test bar the exporter's own verify run is held to. */
const SELFTEST_MAX_DP = 0.05
const THRESHOLD_MIN = 0.4
const THRESHOLD_MAX = 0.95

interface SelfTestRow {
  request: DecisionRequest
  expected: Record<string, number[]>
}

interface SelfTestSummary {
  rows: number
  maxDp: number
  flips: number
  backend: string
  medianMs: number
  firstMs: number
  loadMs: number
}

const argmax = (xs: number[]): number => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0)

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function readSelfTest(): Promise<SelfTestRow[]> {
  let dir = await navigator.storage.getDirectory()
  for (const part of ['decider', MODEL_ID]) dir = await dir.getDirectoryHandle(part)
  const raw: unknown = JSON.parse(await (await (await dir.getFileHandle('selftest.json')).getFile()).text())
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('selftest.json has no rows')
  return raw.map((row, i) => {
    const r = row as Partial<SelfTestRow> | null
    if (!r || typeof r.request !== 'object' || typeof r.expected !== 'object' || !r.expected) {
      throw new Error(`selftest.json row ${i} is malformed`)
    }
    return r as SelfTestRow
  })
}

/** Runs every self-test row through the real engine and compares each question's probabilities. */
async function runSelfTest(onRow: (i: number, n: number) => void): Promise<SelfTestSummary> {
  const rows = await readSelfTest()
  const engine = getDeciderEngine()
  const t0 = performance.now()
  await engine.warm()
  const loadMs = Math.round(performance.now() - t0)
  let maxDp = 0
  let flips = 0
  const ms: number[] = []
  const backends = new Set<string>()
  for (const [i, row] of rows.entries()) {
    onRow(i, rows.length)
    const result = await engine.decide(row.request)
    if (!result) throw new Error('the self-test was cancelled')
    ms.push(result.ms)
    backends.add(result.backend)
    for (const [name, want] of Object.entries(row.expected)) {
      const got = result.answers[name]?.probs
      if (!got) throw new Error(`row ${i}: the model gave no answer for "${name}"`)
      if (got.length !== want.length) {
        throw new Error(`row ${i}: "${name}" has ${got.length} options, expected ${want.length}`)
      }
      got.forEach((p, k) => {
        maxDp = Math.max(maxDp, Math.abs(p - want[k]))
      })
      if (argmax(got) !== argmax(want)) flips++
    }
  }
  return {
    rows: rows.length,
    maxDp,
    flips,
    backend: [...backends].join('+'),
    medianMs: Math.round(median(ms)),
    firstMs: ms[0],
    loadMs,
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const pct = (x: number) => `${Math.round(x * 100)}%`

/**
 * What the Shadow log section shows. Every agreement figure is a rate over JUDGED decisions only
 * (summarize() leaves `agree: null` out — an action the decider had no option for), so each one is
 * shown with that judged count as its denominator, and as "—" when there is none: "0%" over zero
 * judged decisions would read as "always wrong" when it means "never asked".
 */
export interface ShadowSummary {
  decisions: number
  skipped: number
  agreement: string
  next: string
  fill: string
  /** Decisions driver mode acted on: counted, never judged (nothing to compare them with). */
  driven: number
  coverage: string
  latency: { p50: number; p95: number; coldP50: number | null }
  calibration: { range: string; decisions: number; judged: number; agreement: string }[]
}

/** Pure: the records → the strings the Shadow log renders. */
export function shadowSummary(records: ShadowRecord[], threshold: number): ShadowSummary {
  const all = summarize(records, threshold)
  // The same bucketing and per-kind split, over judged decisions alone: their `n`s are the
  // denominators of `all`'s agreement rates.
  const judged = summarize(
    records.filter((r) => r.agree !== null),
    threshold,
  )
  const rate = (agreement: number, n: number) => (n ? `${pct(agreement)} of ${n}` : '—')
  return {
    decisions: all.n,
    skipped: all.skipped,
    agreement: judged.n ? `${pct(all.agreement)} of ${judged.n} judged` : '—',
    next: rate(all.byKind.next.agreement, judged.byKind.next.n),
    fill: rate(all.byKind.fill.agreement, judged.byKind.fill.n),
    driven: all.byKind.drive.n,
    coverage: pct(all.coverage),
    latency: { p50: all.p50, p95: all.p95, coldP50: all.coldP50 },
    calibration: all.calibration.flatMap((b, i) =>
      b.n === 0
        ? []
        : [
            {
              range: `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`,
              decisions: b.n,
              judged: judged.calibration[i].n,
              agreement: judged.calibration[i].n ? pct(b.agreement) : '—',
            },
          ],
    ),
  }
}

async function loadShadowView(threshold: number): Promise<ShadowSummary> {
  return shadowSummary(await listShadow(), threshold)
}

const cell = { padding: '2px 8px 2px 0', textAlign: 'left' as const }

/**
 * The shadow log, summarized: how often the decision model would have done what the chat model
 * did, how well its confidence predicts that, how much it would take over at the current
 * threshold, and what it costs in time. The records are op names, indices and timings only
 * (shadowStore.ts), so nothing here can show page content or what was typed.
 */
function ShadowStats({ threshold }: { threshold: number }) {
  const [view, setView] = useState<ShadowSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    loadShadowView(threshold)
      .then((v) => {
        if (!live) return
        setView(v)
        setError(null)
      })
      .catch((e) => live && setError(`Could not read the shadow log: ${errorText(e)}`))
    return () => {
      live = false
    }
  }, [threshold, nonce])

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  async function doClear() {
    setArmed(false)
    setBusy(true)
    try {
      await clearShadow()
    } catch (e) {
      setError(`Could not clear the shadow log: ${errorText(e)}`)
    } finally {
      setBusy(false)
      setNonce((n) => n + 1)
    }
  }

  const s = view
  const empty = !!s && s.decisions === 0 && s.skipped === 0

  return (
    <Section
      title="Shadow log"
      hint="What the decision model would have done at each page-control step, next to what the chat model did. Kept on this device: actions, indices and timings — never page content or anything typed."
    >
      {!view && !error && <p className="hint">Loading…</p>}
      {empty && <p className="hint">Nothing recorded yet. Set Mode to Shadow, then let the agent control a page.</p>}
      {s && !empty && (
        <>
          <p className="hint" role="status" data-testid="decider-stats">
            {s.decisions} decision{s.decisions === 1 ? '' : 's'} · {s.skipped} skipped
            <br />
            Agreement {s.agreement} · next steps {s.next} · form fills {s.fill}
            {s.driven > 0 && <> · driver decisions {s.driven}</>}
            <br />
            Would act at {threshold}: {s.coverage} of decisions
            <br />
            Latency p50 {s.latency.p50} ms · p95 {s.latency.p95} ms · cold p50{' '}
            {s.latency.coldP50 === null ? '—' : `${s.latency.coldP50} ms`}
          </p>
          {s.calibration.length > 0 && (
            <table className="hint" style={{ borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={cell}>Confidence</th>
                  <th style={cell}>Decisions</th>
                  <th style={cell}>Judged</th>
                  <th style={cell}>Agreement</th>
                </tr>
              </thead>
              <tbody>
                {s.calibration.map((b) => (
                  <tr key={b.range}>
                    <td style={cell}>{b.range}</td>
                    <td style={cell}>{b.decisions}</td>
                    <td style={cell}>{b.judged}</td>
                    <td style={cell}>{b.agreement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">Agreement counts only steps the decision model has an option for (clicks, typing, selects, scrolling down).</p>
        </>
      )}
      <div className="field-row">
        <button className="btn small ghost" disabled={busy} onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </button>
        <button
          className={`btn small ${armed ? 'danger-solid' : 'ghost'}`}
          disabled={busy || empty || !view}
          onClick={() => (armed ? void doClear() : setArmed(true))}
        >
          {armed ? 'Sure?' : 'Clear'}
        </button>
      </div>
      {error && (
        <p className="hint" role="alert">
          {error}
        </p>
      )}
    </Section>
  )
}

function statusLine(s: ModelStatus | null): string {
  if (!s) return 'Checking…'
  switch (s.state) {
    case 'absent':
      return 'No model imported.'
    case 'importing':
      return s.total ? `Importing… ${formatBytes(s.done)} of ${formatBytes(s.total)}` : 'Importing…'
    case 'failed':
      return `Import failed: ${s.message}`
    case 'ready':
      return s.modelId === MODEL_ID
        ? `Ready · ${s.modelId} · ${formatBytes(s.bytes)} · imported ${new Date(s.importedAt).toLocaleString()}`
        : `The imported model (${s.modelId}) is not the one this version expects (${MODEL_ID}). Import it again.`
  }
}

/**
 * Experimental tab: the in-browser decision model. Mode and threshold are settings (they ride
 * `commit` like every other control); the model itself lives in OPFS and is managed here —
 * imported from a folder or a URL, deleted, and checked end to end by the self-test, which runs
 * the exporter's reference rows through the real worker and reports how far the probabilities
 * drifted.
 */
export default function ExperimentalTab({
  draft,
  buffer,
  commit,
  commitDraft,
}: {
  draft: Settings
  buffer: (next: Settings) => void
  commit: (next: Settings) => void
  commitDraft: () => void
}) {
  const mode: DeciderMode = draft.decider?.mode ?? 'off'
  const threshold = draft.decider?.actThreshold ?? DEFAULT_ACT_THRESHOLD
  const [thresholdText, setThresholdText] = useState(String(threshold))
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [busy, setBusy] = useState<'import' | 'delete' | 'selftest' | null>(null)
  const [armed, setArmed] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selfTest, setSelfTest] = useState<SelfTestSummary | null>(null)
  const [selfTestRow, setSelfTestRow] = useState<string | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => setThresholdText(String(threshold)), [threshold])

  // The status record is the source of truth, written by importModel from whichever context runs
  // it; re-reading on every change keeps the line live even after this tab remounts mid-import.
  useEffect(() => {
    let live = true
    const refresh = () => void getModelStatus().then((s) => live && setStatus(s)).catch(() => {})
    refresh()
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && MODEL_STATUS_KEY in changes) refresh()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      live = false
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  // An armed Delete left sitting there is a trap for the next click.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  function setMode(next: string) {
    const decider = normalizeDecider({ ...draft.decider, mode: next })
    if (decider) commit({ ...draft, decider })
  }

  function onThresholdChange(text: string) {
    setThresholdText(text)
    const v = Number(text)
    if (text.trim() === '' || !Number.isFinite(v) || v < THRESHOLD_MIN || v > THRESHOLD_MAX) return
    const decider = normalizeDecider({ ...draft.decider, mode, actThreshold: Math.round(v * 100) / 100 })
    if (decider) buffer({ ...draft, decider })
  }

  function onThresholdBlur() {
    commitDraft()
    setThresholdText(String(threshold))
  }

  async function refreshStatus() {
    setStatus(await getModelStatus())
  }

  async function runImport(src: ImportSource) {
    setBusy('import')
    setError(null)
    setSelfTest(null)
    setProgress(null)
    try {
      // A booted worker holds the model files open; they must be released before being replaced.
      await getDeciderEngine().dispose()
      await importModel(src, (done, total) => setProgress({ done, total }))
      setStatus(await getModelStatus())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setProgress(null)
      setBusy(null)
    }
  }

  function importFromUrl() {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setError('Enter the address of the folder that holds manifest.json.')
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('Only http and https addresses can be imported.')
      return
    }
    void runImport({ kind: 'url', baseUrl: parsed.href })
  }

  function importFromFolder(list: FileList | null) {
    const files = list ? Array.from(list) : []
    if (folderInput.current) folderInput.current.value = ''
    if (files.length) void runImport({ kind: 'files', files })
  }

  async function doDelete() {
    setArmed(false)
    setBusy('delete')
    setError(null)
    setSelfTest(null)
    try {
      await getDeciderEngine().dispose()
      await deleteModel()
    } catch (e) {
      setError(`Could not delete the model: ${errorText(e)}`)
    } finally {
      await refreshStatus().catch(() => {})
      setBusy(null)
    }
  }

  async function doSelfTest() {
    setBusy('selftest')
    setError(null)
    setSelfTest(null)
    setSelfTestRow('Loading the model…')
    try {
      setSelfTest(await runSelfTest((i, n) => setSelfTestRow(`Row ${i + 1} of ${n}…`)))
    } catch (e) {
      setError(`Self-test failed: ${errorText(e)}`)
    } finally {
      setSelfTestRow(null)
      setBusy(null)
    }
  }

  const ready = status?.state === 'ready' && status.modelId === MODEL_ID
  const bar = progress ?? (status?.state === 'importing' && status.total ? status : null)
  const pct = bar && bar.total ? Math.min(100, (bar.done / bar.total) * 100) : null
  const importing = busy === 'import' || status?.state === 'importing'
  const passed = selfTest && selfTest.flips === 0 && selfTest.maxDp <= SELFTEST_MAX_DP

  return (
    <div className="settings-tabpane">
      <Section
        title="Decision model"
        hint="A small on-device model that watches page steps, in Assist fills forms, and in Driver takes routine page steps itself (risky steps still ask you)."
      >
        <div className="field-row">
          <Select label="Mode" value={mode} onChange={setMode}>
            <option value="off">Off</option>
            <option value="shadow">Shadow — record only</option>
            <option value="assist">Assist — record + decider fills forms</option>
            <option value="driver">Driver — Assist + decider takes page steps</option>
          </Select>
          <label className="field">
            Act threshold
            <input
              type="number"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step="0.05"
              inputMode="decimal"
              value={thresholdText}
              onChange={(e) => onThresholdChange(e.target.value)}
              onBlur={onThresholdBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </label>
        </div>
        {mode !== 'off' && !ready && status && (
          <p className="hint">Nothing runs until the model is imported.</p>
        )}

        <p className="hint" role="status" data-testid="decider-status">
          {statusLine(status)}
        </p>
        {pct !== null && (
          <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="usage-fill" style={{ width: `${Math.max(pct, 0.5)}%` }} />
          </div>
        )}

        <div className="field-row">
          <input
            ref={(el) => {
              folderInput.current = el
              // Not in React's typings; the attribute is what turns the picker into a folder picker.
              el?.setAttribute('webkitdirectory', '')
            }}
            type="file"
            multiple
            hidden
            onChange={(e) => importFromFolder(e.target.files)}
          />
          <button className="btn small" disabled={busy !== null || importing} onClick={() => folderInput.current?.click()}>
            Import model folder…
          </button>
          <button
            className={`btn small ${armed ? 'danger-solid' : 'ghost'}`}
            disabled={busy !== null || importing || status?.state === 'absent'}
            onClick={() => (armed ? void doDelete() : setArmed(true))}
          >
            {armed ? 'Sure?' : 'Delete'}
          </button>
        </div>
        <div className="erase-confirm">
          <input
            type="url"
            aria-label="Model folder URL"
            placeholder="http://127.0.0.1:8790"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim() && busy === null && !importing) importFromUrl()
            }}
          />
          <button className="btn small" disabled={busy !== null || importing || !url.trim()} onClick={importFromUrl}>
            Import from URL…
          </button>
        </div>

        <div className="field-row" style={{ marginTop: 10 }}>
          <button className="btn small" disabled={busy !== null || !ready} onClick={() => void doSelfTest()}>
            Run self-test
          </button>
          {selfTestRow && (
            <span className="hint" role="status">
              {selfTestRow}
            </span>
          )}
        </div>
        {selfTest && (
          <p className="hint" role="status" data-testid="decider-selftest">
            {passed ? 'Pass' : 'Fail'} · {selfTest.rows} rows · max|Δp| {selfTest.maxDp.toFixed(4)} · flips{' '}
            {selfTest.flips} · {selfTest.backend} · median {selfTest.medianMs} ms
            <br />
            Model load {(selfTest.loadMs / 1000).toFixed(1)} s · first decision {selfTest.firstMs} ms
          </p>
        )}
        {error && (
          <p className="hint" role="alert">
            {error}
          </p>
        )}
      </Section>
      <ShadowStats threshold={threshold} />
    </div>
  )
}
