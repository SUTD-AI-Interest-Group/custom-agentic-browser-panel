import { useEffect, useState } from 'react'
import { listTasks, type ResearchStatus, type ResearchTask } from '../../data/researchTasks'
import { relativeTime } from '../../platform/time'

// The Library's Research tab: every background-research task across all chats,
// newest first. Clicking a row navigates to the conversation the research was
// launched from and reveals it (App wires this to Chat via pendingResearchId —
// running tasks open their live sheet, finished ones scroll to the report card).
// Legacy tasks with no conversationId can't be navigated to, so they're inert.

const STATUS_LABEL: Record<ResearchStatus, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
}

export default function ResearchList({ onOpen }: { onOpen: (task: ResearchTask) => void }) {
  const [tasks, setTasks] = useState<ResearchTask[]>([])

  // Mirror Chat's loader: read persisted tasks, then refresh off storage
  // changes so a task that finishes while the Library is open updates live.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      listTasks().then((t) => {
        if (!cancelled) setTasks(t)
      })
    void load()
    const onChanged = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.researchTasks) void load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      cancelled = true
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  if (tasks.length === 0) {
    return <div className="library-empty">No research yet — start one with /research in chat.</div>
  }

  return (
    <div className="library-list">
      {tasks.map((t) => {
        const navigable = !!t.conversationId
        const sourceCount = t.sources?.length ?? t.notebook?.sources?.length ?? 0
        return (
          <div
            key={t.id}
            className={`library-row research-row ${navigable ? '' : 'disabled'}`}
            role={navigable ? 'button' : undefined}
            tabIndex={navigable ? 0 : undefined}
            title={navigable ? undefined : 'This research isn’t linked to a conversation.'}
            onClick={navigable ? () => onOpen(t) : undefined}
            onKeyDown={
              navigable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpen(t)
                    }
                  }
                : undefined
            }
          >
            <span className={`research-status research-status--${t.status}`}>
              {STATUS_LABEL[t.status]}
            </span>
            <div className="library-row-main">
              <span className="library-row-title">{t.question}</span>
              <span className="library-row-meta">
                {relativeTime(t.startedAt)}
                {sourceCount > 0 ? ` · ${sourceCount} source${sourceCount === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
