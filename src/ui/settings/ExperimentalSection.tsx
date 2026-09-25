import { useEffect, useRef, useState } from 'react'
import { system1Enabled, type Settings } from '../../data/settings'
import {
  CACHE_NAME,
  WEIGHTS_PIN,
  deleteWeights,
  downloadWeights,
  loadCachedManifest,
  readState,
  writeState,
  type DownloadProgress,
} from '../../system1/weights'
import { hasWebGpu } from '../../system1/runtime'
import { getSystem1Engine } from '../../system1/engine'
import { Section } from './primitives'

type Status =
  | { kind: 'off' }
  | { kind: 'no-webgpu'; needsF16: boolean }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'verifying' }
  | { kind: 'ready'; bytes: number }
  | { kind: 'failed'; reason: string }

const mb = (n: number) => `${Math.round(n / 1e6)} MB`

/**
 * Whether weights already on disk are actually usable *here*: `requiresShaderF16`
 * is only known once the manifest has been fetched, so the pre-download probe
 * (`hasWebGpu(false)`) can't check it — a variant downloaded on hardware with
 * shader-f16 can leave bytes on disk that this browser (or a later driver/GPU
 * change) can't run. Falls back to `ready` on any read failure: this is only an
 * informational status line, not the gate that decides whether the Act tool is
 * built (that's `resolveSystem1`, which re-verifies from scratch).
 */
async function resolveReadyStatus(bytes: number): Promise<Status> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const manifest = await loadCachedManifest(WEIGHTS_PIN, cache)
    const needsF16 = manifest?.requiresShaderF16 === true
    if (needsF16 && !(await hasWebGpu(true))) return { kind: 'no-webgpu', needsF16: true }
    return { kind: 'ready', bytes }
  } catch {
    return { kind: 'ready', bytes }
  }
}

export default function ExperimentalSection({ draft, commit }: { draft: Settings; commit: (next: Settings) => void }) {
  const on = system1Enabled(draft)
  const [status, setStatus] = useState<Status>({ kind: 'off' })
  const [stored, setStored] = useState<number | null>(null)
  const [test, setTest] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void readState().then(async (s) => {
      setStored(s ? s.bytes : null)
      if (on && s) setStatus(await resolveReadyStatus(s.bytes))
    })
  }, [on])

  const start = async () => {
    // The model's own f16 requirement isn't known until its manifest is
    // downloaded, so this pre-flight only checks that WebGPU exists at all.
    if (!(await hasWebGpu(false))) { setStatus({ kind: 'no-webgpu', needsF16: false }); return }
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const state = await downloadWeights(WEIGHTS_PIN, {
        fetch: (u, init) => fetch(u, init),
        cache: await caches.open(CACHE_NAME),
        signal: ac.signal,
        onProgress: (p: DownloadProgress) => {
          if (p.phase === 'file') setStatus({ kind: 'downloading', received: p.overallReceived, total: p.overallTotal })
          else if (p.phase === 'verifying') setStatus({ kind: 'verifying' })
        },
      })
      await writeState(state)
      setStored(state.bytes)
      setStatus(await resolveReadyStatus(state.bytes))
    } catch (err) {
      setStatus(ac.signal.aborted ? { kind: 'off' } : { kind: 'failed', reason: err instanceof Error ? err.message : String(err) })
      if (ac.signal.aborted) commit({ ...draft, experimental: { ...draft.experimental, system1: false } })
    } finally {
      abortRef.current = null
    }
  }

  const toggle = async (next: boolean) => {
    commit({ ...draft, experimental: { ...draft.experimental, system1: next } })
    if (!next) { abortRef.current?.abort(); setStatus({ kind: 'off' }); return }
    const s = await readState()
    if (s) setStatus(await resolveReadyStatus(s.bytes))
    else void start()
  }

  const runTest = async () => {
    setTest('Running…')
    try {
      const r = await getSystem1Engine().decide({
        state: 'Goal: add the blue mug to the cart\nPage: Acme Shop (shop.example)',
        questions: { target: { instructions: 'Which element should be used next to progress toward the goal?', options: {
          '1': "[1] link 'Home' → click", '2': "[2] button 'Add blue mug to cart' → click", '3': "[3] button 'Add red mug to cart' → click",
        } } },
      })
      const a = r.answers.target
      setTest(`Picked [${a.choice}] with p=${a.top.toFixed(2)} in ${r.ms} ms`)
    } catch (err) {
      setTest(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const line = (() => {
    switch (status.kind) {
      case 'off': return 'Off'
      case 'no-webgpu':
        return status.needsF16 ? 'WebGPU unavailable in this browser (needs shader-f16)' : 'WebGPU unavailable in this browser'
      case 'downloading': return `Downloading ${mb(status.received)} / ${mb(status.total)}`
      case 'verifying': return 'Verifying…'
      case 'ready': return `Ready · ${mb(status.bytes)}`
      case 'failed': return `Failed: ${status.reason}`
    }
  })()

  return (
    <Section title="Experimental">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        Fast page control (System-1)
      </label>
      <p className="hint">
        Runs a small local decision model (Von, several hundred MB download) on your GPU so page control can take
        several routine steps without waiting on your chat model. Submits, payments and leaving the site still ask
        you every time. Status: {line}
      </p>
      {status.kind === 'downloading' && (
        <>
          <progress max={status.total} value={status.received} />
          <button onClick={() => abortRef.current?.abort()}>Cancel</button>
        </>
      )}
      {status.kind === 'failed' && <button onClick={() => void start()}>Retry</button>}
      {status.kind === 'ready' && <button onClick={() => void runTest()}>Run a test decision</button>}
      {test && <p className="hint">{test}</p>}
      {!on && stored !== null && (
        <button onClick={() => void deleteWeights().then(() => setStored(null))}>Delete model ({mb(stored)})</button>
      )}
    </Section>
  )
}
