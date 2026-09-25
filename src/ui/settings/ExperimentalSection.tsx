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
  type System1State,
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

/**
 * The one in-flight download, owned at module scope rather than by any single
 * mounted `ExperimentalSection` — closing Settings (unmounting this
 * component) must not kill an 800 MB download, and reopening Settings (or a
 * second panel instance) must see it still running rather than guess "off"
 * and let a stray click start a second, concurrent one. `startJob` is the
 * only place allowed to create one; every component instance just subscribes
 * to whatever `activeJob` currently is.
 */
interface DownloadJob {
  promise: Promise<System1State>
  abort: () => void
  /** Most recent progress event, so a component that subscribes late (a
   *  reopened panel) can render current state immediately instead of waiting
   *  for the next chunk. */
  latestProgress: DownloadProgress | null
  listeners: Set<(p: DownloadProgress) => void>
  signal: AbortSignal
}

let activeJob: DownloadJob | null = null
/**
 * The most recent non-abort failure of a job nobody was subscribed to when it
 * happened — without this, closing Settings while a download fails leaves no
 * trace: the next mount finds `activeJob` gone and `readState()` null, and
 * (before this) fell back to `Off` with the checkbox still checked and no
 * Retry button to recover with. Cleared whenever a new job starts (so a
 * fresh attempt doesn't inherit a stale reason) and on that job's success.
 */
let lastJobError: string | null = null

function startJob(): DownloadJob {
  lastJobError = null
  const ac = new AbortController()
  const listeners = new Set<(p: DownloadProgress) => void>()
  const job: DownloadJob = {
    signal: ac.signal,
    abort: () => ac.abort(),
    latestProgress: null,
    listeners,
    promise: (async () => {
      try {
        const state = await downloadWeights(WEIGHTS_PIN, {
          fetch: (u, init) => fetch(u, init),
          cache: await caches.open(CACHE_NAME),
          signal: ac.signal,
          onProgress: (p) => {
            job.latestProgress = p
            for (const l of listeners) l(p)
          },
        })
        await writeState(state)
        lastJobError = null
        return state
      } catch (err) {
        if (!ac.signal.aborted) lastJobError = err instanceof Error ? err.message : String(err)
        throw err
      }
    })(),
  }
  activeJob = job
  // Free the module slot once this job settles (success, failure or abort) so
  // a later start() creates a fresh one rather than reusing a dead job.
  // Guarded by identity in case a newer job has already taken the slot.
  void job.promise.catch(() => {}).finally(() => { if (activeJob === job) activeJob = null })
  return job
}

export default function ExperimentalSection({ draft, commit }: { draft: Settings; commit: (next: Settings) => void }) {
  const on = system1Enabled(draft)
  const [status, setStatus] = useState<Status>({ kind: 'off' })
  const [stored, setStored] = useState<number | null>(null)
  const [test, setTest] = useState<string | null>(null)
  // Mirrors the `draft` prop every render so an async continuation (a
  // download that finishes or is cancelled well after the click that started
  // it) commits on top of whatever the user has edited *since*, rather than
  // reverting it — `commit` is a full-overwrite, so building it from a
  // closed-over `draft` would silently undo unrelated edits made mid-download.
  // Same pattern as Settings.tsx's draftRef.
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Unsubscribe from whatever DownloadJob this instance is currently
  // listening to, if any — set by subscribeTo, cleared on unmount.
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    void readState().then(async (s) => {
      if (cancelled) return
      setStored(s ? s.bytes : null)
      // Don't stomp a live download's status with a stale on-disk read — the
      // job-subscribe effect below owns status while one is active.
      if (activeJob) return
      if (on && s) { setStatus(await resolveReadyStatus(s.bytes)); return }
      // Nothing on disk and nothing running: if the last attempt failed while
      // no instance was mounted to see it (e.g. Settings was closed), surface
      // that now instead of silently reporting "Off" with the box still checked.
      if (on && !s && lastJobError) setStatus({ kind: 'failed', reason: lastJobError })
    })
    return () => { cancelled = true }
  }, [on])

  // Attach to whatever's already downloading when this instance mounts, so
  // reopening Settings mid-download shows real progress instead of "Off".
  useEffect(() => {
    if (activeJob) subscribeTo(activeJob)
    return () => { unsubRef.current?.(); unsubRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Track `job`'s progress/outcome into this instance's state until unmount or a re-subscribe. */
  function subscribeTo(job: DownloadJob) {
    unsubRef.current?.()
    let cancelled = false
    const onProgress = (p: DownloadProgress) => {
      if (p.phase === 'file') setStatus({ kind: 'downloading', received: p.overallReceived, total: p.overallTotal })
      else if (p.phase === 'verifying') setStatus({ kind: 'verifying' })
    }
    if (job.latestProgress) onProgress(job.latestProgress)
    job.listeners.add(onProgress)
    job.promise
      .then(async (state) => {
        if (cancelled) return
        setStored(state.bytes)
        setStatus(await resolveReadyStatus(state.bytes))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (job.signal.aborted) { setStatus({ kind: 'off' }); return }
        setStatus({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) })
      })
    unsubRef.current = () => { cancelled = true; job.listeners.delete(onProgress) }
  }

  // A job that's mid-abort is still `activeJob` for a tick (aborting a
  // fetch/reader isn't synchronous) — reusing it here would subscribe to a
  // job that's about to reject and immediately flip status back to `off`
  // right after the user asked to turn the feature back *on*. Wait for it to
  // actually finish settling (module slot clears itself, see startJob) before
  // deciding whether to reuse or start fresh.
  const settleIfAborting = async () => {
    if (activeJob?.signal.aborted) await activeJob.promise.catch(() => {})
  }

  const start = async () => {
    await settleIfAborting()
    if (activeJob) { subscribeTo(activeJob); return }
    // The model's own f16 requirement isn't known until its manifest is
    // downloaded, so this pre-flight only checks that WebGPU exists at all.
    if (!(await hasWebGpu(false))) { setStatus({ kind: 'no-webgpu', needsF16: false }); return }
    // The awaits above leave room for the user to switch the feature back off;
    // starting a download now would be one they just declined.
    if (!system1Enabled(draftRef.current)) return
    subscribeTo(startJob())
  }

  /** The one path for every user-initiated stop: the checkbox going off AND
   *  the Cancel button — both must leave the setting, the job and the status
   *  in agreement, or the UI shows "Off" while `experimental.system1` is
   *  still `true` with no control left to fix it. */
  const stop = () => {
    commit({ ...draftRef.current, experimental: { ...draftRef.current.experimental, system1: false } })
    activeJob?.abort()
    // Release the worker and its GPU session now rather than at panel close.
    getSystem1Engine().dispose()
    unsubRef.current?.()
    unsubRef.current = null
    setStatus({ kind: 'off' })
  }

  const toggle = async (next: boolean) => {
    if (!next) { stop(); return }
    commit({ ...draftRef.current, experimental: { ...draftRef.current.experimental, system1: true } })
    await settleIfAborting()
    if (activeJob) { subscribeTo(activeJob); return }
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
      <p className="hint" aria-live="polite">
        Runs a small local decision model (Von, several hundred MB download) on your GPU so page control can take
        several routine steps without waiting on your chat model. Submits, payments and leaving the site still ask
        you every time. Status: {line}
      </p>
      {status.kind === 'downloading' && (
        <>
          <progress max={status.total} value={status.received} />
          <button className="btn ghost small" onClick={() => stop()}>Cancel</button>
        </>
      )}
      {status.kind === 'failed' && <button className="btn ghost small" onClick={() => void start()}>Retry</button>}
      {status.kind === 'ready' && <button className="btn ghost small" onClick={() => void runTest()}>Run a test decision</button>}
      {test && <p className="hint">{test}</p>}
      {!on && stored !== null && (
        <button className="btn small danger-solid" onClick={() => {
          getSystem1Engine().dispose()
          void deleteWeights().then(() => setStored(null))
        }}>
          Delete model ({mb(stored)})
        </button>
      )}
    </Section>
  )
}
