import type { ResearchTask } from '../data/researchTasks'

/**
 * The running face of a research slot: the same transcript message that was the
 * launch card, and that will become the finished report, while the task is in
 * flight.
 *
 * It exists because "I noticed it was still loading something" is not a progress
 * indicator. Everything here answers a question the old thin dock bar could not:
 * what phase is it in, how long has it been, which sub-questions are settled,
 * how many sources has it actually read — and, when it applies, why a private
 * browsing window just appeared.
 *
 * Reads entirely from the persisted `ResearchTask`; it holds no state of its own,
 * so it repaints purely from the researchTasks storage subscription that already
 * drives the transcript.
 */
export function ResearchLiveCard({
  task,
  now,
  onStop,
  onOpen,
}: {
  task: ResearchTask
  /** Ticking clock from the parent, so every live card shares one interval. */
  now: number
  onStop: () => void
  /** Opens the full step log — the bottom sheet is still where the detail lives. */
  onOpen: () => void
}) {
  const nb = task.notebook
  const subQuestions = nb?.plan.subQuestions ?? []
  const covered = subQuestions.filter((q) => nb?.coverage[q]?.supported).length
  // Before the plan exists there is nothing to divide by; show an indeterminate
  // sliver rather than a bar that sits at a misleading 100%.
  const pct = subQuestions.length > 0 ? Math.round((covered / subQuestions.length) * 100) : 0
  const sources = nb?.sources ?? []
  // The private window is used for exactly one thing — fetches that needed a real
  // browser — so a tab-fetched source IS the evidence that one was opened. Saying
  // it any other way would be guessing.
  const usedPrivateWindow = sources.some((s) => s.fetchedVia === 'tab')
  const active = [...task.steps].reverse().find((s) => s.status === 'running')
  const paused = task.status === 'paused'

  return (
    <div className="research-live" id={`research-${task.id}`}>
      <button className="research-live__head" onClick={onOpen} aria-label="Open the full research log">
        <span className="research-live__spinner" aria-hidden />
        <span className="research-live__phase">{paused ? 'Waiting to retry' : 'Researching'}</span>
        <span className="research-live__elapsed">{formatElapsed(now - task.startedAt)}</span>
      </button>

      <p className="research-live__question">{task.question}</p>

      <div
        className="research-live__bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Sub-questions covered"
      >
        <i style={{ width: `${pct}%` }} />
      </div>

      {subQuestions.length > 0 && (
        <ul className="research-live__coverage">
          {subQuestions.map((q, i) => {
            const done = nb?.coverage[q]?.supported === true
            // The active row is the deepest one still open — a reasonable stand-in
            // for "what it is working on" without threading per-sub-question state
            // through the whole pipeline.
            const isActive = !done && i === subQuestions.findIndex((s) => !nb?.coverage[s]?.supported)
            return (
              <li key={q} className={done ? 'done' : isActive ? 'active' : 'pending'}>
                <span className="research-live__mark" aria-hidden />
                <span className="research-live__text">{q}</span>
                {isActive && active && <span className="research-live__doing">{active.summary}</span>}
              </li>
            )
          })}
        </ul>
      )}

      {usedPrivateWindow && (
        <p className="research-live__window" title="Some pages only render in a real browser, so research reads them in a separate private window. It closes itself when idle.">
          ↳ in a private window
        </p>
      )}

      {paused && task.pauseReason && (
        <p className="research-live__paused" role="status">
          {task.pauseReason}
        </p>
      )}

      <div className="research-live__foot">
        <span className="research-live__sources">
          {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
        <button className="research-live__stop" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  )
}

/**
 * Elapsed time in the coarsest unit that is still honest: seconds under a minute,
 * whole minutes under an hour, then `1h 4m`. A research task runs for tens of
 * minutes, so a ticking seconds counter would be noise rather than information.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
