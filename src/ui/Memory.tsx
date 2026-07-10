import { useEffect, useState } from 'react'
import { getDreamState } from '../agent/dream'
import {
  deleteMemory,
  listMemories,
  listUnconsolidatedEpisodes,
  type MemoryRecord,
} from '../data/memory'

// Memory panel: a read-only window into what the assistant remembers and when
// it last "dreamed". Dreaming itself is fully automatic — it runs from the
// background alarm (and a check on panel open) once consolidation is due and
// the user has been away. The only action offered here is forgetting a memory.

export default function MemoryView() {
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null)
  const [pendingEpisodes, setPendingEpisodes] = useState(0)

  useEffect(() => {
    void (async () => {
      const [all, state, pending] = await Promise.all([
        listMemories(),
        getDreamState(),
        listUnconsolidatedEpisodes(),
      ])
      setMemories(all)
      setLastDreamAt(state.lastDreamAt)
      setPendingEpisodes(pending.length)
    })()
  }, [])

  async function forget(id: string) {
    await deleteMemory(id)
    setMemories((m) => m.filter((r) => r.id !== id))
  }

  return (
    <div className="memory">
      <h2>Dreaming</h2>
      <p className="hint">
        While you're away, the assistant automatically reviews the day's conversations and
        distills them into the long-term memories below. Everything is stored locally in your
        browser.
      </p>
      <div className="dream-card">
        <div className="dream-meta">
          <span>{lastDreamAt ? `Last dreamed ${formatAgo(lastDreamAt)}` : 'Has not dreamed yet'}</span>
          <span>
            {pendingEpisodes > 0
              ? `${pendingEpisodes} conversation${pendingEpisodes === 1 ? '' : 's'} waiting for the next dream`
              : 'All conversations consolidated'}
          </span>
        </div>
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

function formatAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
