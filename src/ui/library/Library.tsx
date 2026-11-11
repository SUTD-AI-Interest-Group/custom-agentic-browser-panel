import { TabStrip } from '../TabStrip'
import type { ResearchTask } from '../../data/researchTasks'
import ConversationsList from './ConversationsList'
import ResearchList from './ResearchList'
import RemoteSkills from './RemoteSkills'
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
  onLoadRemoteSkill,
  tab,
  onTabChange,
  currentConversationId,
  onOpenConversation,
  onOpenResearch,
  onConversationsChanged,
  onClose,
}: {
  onLoadRemoteSkill?: (text: string) => void
  tab: LibraryTab
  onTabChange: (tab: LibraryTab) => void
  /** Highlighted in the Chats list so the open conversation is obvious. */
  currentConversationId: string
  onOpenConversation: (id: string) => void
  onOpenResearch: (task: ResearchTask) => void
  /** Called after a conversation is deleted so App refreshes its history menu. */
  onConversationsChanged: () => void
  onClose: () => void
}) {
  return (
    <div className="library">
      <div className="library-header">
        <TabStrip id="library" label="Library" tabs={TABS} value={tab} onChange={onTabChange} className="library-tabs" tabClassName="library-tab" />
        <button className="icon-btn" title="Close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="library-panel" id="library-panel" role="tabpanel" aria-labelledby={`library-${tab}`}>
      {tab === 'conversations' && (
        <ConversationsList
          currentConversationId={currentConversationId}
          onOpen={onOpenConversation}
          onConversationsChanged={onConversationsChanged}
        />
      )}
      {tab === 'skills' && <><SkillsList /><RemoteSkills onLoad={onLoadRemoteSkill}/></>}
      {tab === 'researches' && <ResearchList onOpen={onOpenResearch} />}
      </div>
    </div>
  )
}
