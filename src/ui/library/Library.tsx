import { useState } from 'react'
import type { ResearchTask } from '../../data/researchTasks'
import ConversationsList from './ConversationsList'
import ResearchList from './ResearchList'
import SkillsList from './SkillsList'

// The Library: a tabbed archive overlay (Chats / Skills / Research) opened from
// the topbar's archival-box icon. Overlays the mounted Chat exactly like
// Settings does (see App.tsx) — rendered as a sibling of the hidden view-host.

/** Which list the Library is showing. */
export type LibraryTab = 'conversations' | 'skills' | 'researches'

const TABS: { key: LibraryTab; label: string }[] = [
  { key: 'conversations', label: 'Chats' },
  { key: 'skills', label: 'Skills' },
  { key: 'researches', label: 'Research' },
]

export default function Library({
  initialTab,
  currentConversationId,
  onOpenConversation,
  onOpenResearch,
  onConversationsChanged,
  onClose,
}: {
  initialTab: LibraryTab
  /** Highlighted in the Chats list so the open conversation is obvious. */
  currentConversationId: string
  onOpenConversation: (id: string) => void
  onOpenResearch: (task: ResearchTask) => void
  /** Called after a conversation is deleted so App refreshes its history menu. */
  onConversationsChanged: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<LibraryTab>(initialTab)

  return (
    <div className="library">
      <div className="library-header">
        <div className="library-tabs" role="tablist" aria-label="Library">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`library-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {tab === 'conversations' && (
        <ConversationsList
          currentConversationId={currentConversationId}
          onOpen={onOpenConversation}
          onConversationsChanged={onConversationsChanged}
        />
      )}
      {tab === 'skills' && <SkillsList />}
      {tab === 'researches' && <ResearchList onOpen={onOpenResearch} />}
    </div>
  )
}
