import { useEffect, useState } from 'react'
import { runDream, type DreamOutcome } from '../agent/dream'
import {
  clearMemory,
  deleteMemory,
  getDreamState,
  listMemories,
  listUnconsolidatedEpisodes,
  type MemoryRecord,
} from '../data/memory'
import {
  DREAM_INTERVAL_OPTIONS,
  resolveDreamIntervalMs,
  type Settings,
} from '../data/settings'
import { Select } from './settings/primitives'

// Memory panel: a window into what the assistant remembers and when it last
// "dreamed", plus the controls that shape dreaming. Dreaming still runs
// automatically (a background alarm fires once the chosen interval has elapsed
// and the user has been idle), but here the user can set how often it runs,
// which model does it, trigger a cycle on demand, and wipe memory entirely.

export default function MemoryView({
  draft,
  commit,
}: {
  draft: Settings
  commit: (next: Settings) => void
}) {
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null)
  const [pendingEpisodes, setPendingEpisodes] = useState(0)
  const [dreaming, setDreaming] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [resetArmed, setResetArmed] = useState(false)

  async function refresh() {
    const [all, state, pending] = await Promise.all([
      listMemories(),
      getDreamState(),
      listUnconsolidatedEpisodes(),
    ])
    setMemories(all)
    setLastDreamAt(state.lastDreamAt)
    setPendingEpisodes(pending.length)
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Disarm the reset button after a few seconds — an armed destructive button
  // left sitting there is a trap for the next click (mirrors the Data tab).
  useEffect(() => {
    if (!resetArmed) return
    const t = setTimeout(() => setResetArmed(false), 4000)
    return () => clearTimeout(t)
  }, [resetArmed])

  async function forget(id: string) {
    await deleteMemory(id)
    setMemories((m) => m.filter((r) => r.id !== id))
  }

  async function dreamNow() {
    setDreaming(true)
    setOutcome(null)
    try {
      const res = await runDream()
      setOutcome(describeOutcome(res))
      await refresh()
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : String(err))
    } finally {
      setDreaming(false)
    }
  }

  async function resetMemory() {
    setResetArmed(false)
    setOutcome(null)
    await clearMemory()
    await refresh()
  }

  const nothingToReset = memories.length === 0 && pendingEpisodes === 0 && lastDreamAt === null
  const dreamModelValue = draft.dreamModel
    ? `${draft.dreamModel.providerId}::${draft.dreamModel.modelId}`
    : ''

  return (
    <div className="memory">
      <h2>Dreaming</h2>
      <p className="hint">
        While you're away, the assistant reviews recent conversations and distills them into the
        long-term memories below. Everything is stored locally in your browser.
      </p>

      <div className="dream-controls">
        <Select
          label="Consolidate at most every"
          value={String(resolveDreamIntervalMs(draft))}
          onChange={(value) => commit({ ...draft, dreamIntervalMs: Number(value) })}
        >
          {DREAM_INTERVAL_OPTIONS.map((o) => (
            <option key={o.ms} value={String(o.ms)}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select
          label="Dreaming model"
          value={dreamModelValue}
          onChange={(value) => {
            const [providerId, ...rest] = value.split('::')
            commit({
              ...draft,
              dreamModel: value ? { providerId, modelId: rest.join('::') } : null,
            })
          }}
        >
          <option value="">Same as chat model</option>
          {draft.providers.flatMap((p) =>
            p.models
              .filter((m) => m.trim())
              .map((m) => (
                <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                  {m} · {p.name || 'Unnamed provider'}
                </option>
              )),
          )}
        </Select>
      </div>

      <div className="dream-card">
        <div className="dream-meta">
          <span>{lastDreamAt ? `Last dreamed ${formatAgo(lastDreamAt)}` : 'Has not dreamed yet'}</span>
          <span>
            {pendingEpisodes > 0
              ? `${pendingEpisodes} conversation${pendingEpisodes === 1 ? '' : 's'} waiting for the next dream`
              : 'All conversations consolidated'}
          </span>
        </div>
        <button className="btn small" disabled={dreaming} onClick={() => void dreamNow()}>
          {dreaming ? 'Dreaming…' : 'Dream now'}
        </button>
      </div>
      {outcome && <p className="dream-status">{outcome}</p>}

      <div className="dream-reset">
        <div className="data-row-main">
          <span className="data-label">Reset memory</span>
          <span className="data-detail">
            Forget every memory, clear the conversation journal, and reset dreaming.
          </span>
        </div>
        <button
          className={`btn small ${resetArmed ? 'danger-solid' : 'ghost'}`}
          disabled={nothingToReset}
          onClick={() => (resetArmed ? void resetMemory() : setResetArmed(true))}
        >
          {resetArmed ? 'Sure?' : 'Reset'}
        </button>
      </div>

      <h2>Memories ({memories.length})</h2>
      {memories.length === 0 && (
        <p className="hint">
          No memories yet. They'll appear here after the assistant dreams over your
          conversations, or when you ask it to remember something.
        </p>
      )}
      {memories.map((m) => (
        <div className="memory-item" key={m.id}>
          <div className="memory-body">
            <div className="memory-meta">
              <span className={`memory-kind kind-${m.kind}`}>{m.kind}</span>
              <span className="memory-date">
                {new Date(m.updatedAt).toLocaleDateString()} · {m.source}
              </span>
            </div>
            <div className="memory-content">{m.content}</div>
          </div>
          <button className="icon-btn danger" title="Forget this memory" onClick={() => void forget(m.id)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

/** One-line summary of a manual dream for the status line. */
function describeOutcome(res: DreamOutcome): string {
  if (res.status === 'skipped') return res.reason
  const parts: string[] = []
  if (res.added) parts.push(`${res.added} added`)
  if (res.updated) parts.push(`${res.updated} updated`)
  if (res.deleted) parts.push(`${res.deleted} forgotten`)
  const changes = parts.length > 0 ? parts.join(', ') : 'no changes'
  return `Dreamed over ${res.episodes} conversation${res.episodes === 1 ? '' : 's'} — ${changes}.`
}

function formatAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
