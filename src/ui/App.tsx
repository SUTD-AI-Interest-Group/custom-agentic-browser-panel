import { useCallback, useEffect, useRef, useState } from 'react'
import { listConversations, type ConversationSummary } from '../data/conversations'
import { dreamIfDue } from '../agent/dream'
import { seedBuiltinSkills } from '../data/builtinSkills'
import { loadSettings, saveSettings, type Settings } from '../data/settings'
import type { ResearchTask } from '../data/researchTasks'
import { relativeTime } from '../platform/time'
import Chat from './Chat'
import Library, { type LibraryTab } from './library/Library'
import Onboarding from './Onboarding'
import SettingsView from './settings/Settings'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // The Library overlay's open tab, or null when closed. Opened to
  // 'conversations' from the archival-box icon, or 'skills' from the "browse
  // skills" affordances (slash menu / Settings link).
  const [libraryTab, setLibraryTab] = useState<LibraryTab | null>(null)
  // A conversation id keys the Chat: changing it loads a different chat, while
  // toggling settings leaves it untouched so the transcript is never lost.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  // Set when a research row in the Library is clicked: after Chat (re)mounts on
  // the research's conversation, it reveals that task (live sheet or report
  // card) and clears this back to null. See openResearch / Chat's effect.
  const [pendingResearchId, setPendingResearchId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refreshConversations = useCallback(() => {
    void listConversations()
      .then(setConversations)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadSettings().then(setSettings)
    void seedBuiltinSkills().catch(() => {})
    // Dreaming is fully automatic: besides the background alarm, check on
    // panel open too (covers browsers that were closed overnight). dreamIfDue
    // is self-guarding — it only runs when consolidation is actually due and
    // the user has been away.
    void dreamIfDue().catch(() => {})
    refreshConversations()
  }, [refreshConversations])

  // Dismiss the history menu when clicking anywhere outside it.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  function updateSettings(next: Settings) {
    setSettings(next)
    void saveSettings(next)
  }

  function newChat() {
    setConversationId(crypto.randomUUID())
    setShowSettings(false)
    setLibraryTab(null)
    setMenuOpen(false)
  }

  function openConversation(id: string) {
    if (id !== conversationId) setConversationId(id)
    setShowSettings(false)
    setLibraryTab(null)
    setMenuOpen(false)
  }

  function openSkills() {
    setLibraryTab('skills')
    setShowSettings(false)
  }

  // Navigate to the research's originating conversation, then hand Chat the task
  // id so it reveals the live sheet (running) or scrolls to the report card
  // (finished). Library only surfaces this for tasks that have a conversationId.
  function openResearch(task: ResearchTask) {
    if (task.conversationId && task.conversationId !== conversationId) {
      setConversationId(task.conversationId)
    }
    setPendingResearchId(task.id)
    setShowSettings(false)
    setLibraryTab(null)
    setMenuOpen(false)
  }

  if (!settings) return null

  // First run: walk through endpoint setup + test + tab-access choice before
  // showing the chat at all.
  if (!settings.onboarded) {
    return (
      <div className="app">
        <Onboarding settings={settings} onComplete={updateSettings} />
      </div>
    )
  }

  const current = conversations.find((c) => c.id === conversationId)
  const title = current?.title ?? 'New chat'

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title-wrap" ref={menuRef}>
          <button
            className="topbar-title"
            title="Chat history"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="topbar-title-text">{title}</span>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 4.5l3 3 3-3"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {menuOpen && (
            <div className="chat-menu">
              {conversations.length === 0 ? (
                <div className="chat-menu-empty">No previous chats yet</div>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    className={`chat-menu-item ${c.id === conversationId ? 'active' : ''}`}
                    onClick={() => openConversation(c.id)}
                  >
                    <span className="chat-menu-title">{c.title ?? 'New chat'}</span>
                    <span className="chat-menu-time">{relativeTime(c.updatedAt)}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" title="New chat" onClick={newChat}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`icon-btn ${libraryTab ? 'active' : ''}`}
            title="Library"
            onClick={() => {
              setLibraryTab((t) => (t ? null : 'conversations'))
              setShowSettings(false)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <path d="M3 6v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6.5 8.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`icon-btn ${showSettings ? 'active' : ''}`}
            title="Settings"
            onClick={() => {
              setShowSettings((s) => !s)
              setLibraryTab(null)
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>

      <div className={`view-host ${showSettings || libraryTab ? 'is-hidden' : ''}`}>
        <Chat
          key={conversationId}
          conversationId={conversationId}
          settings={settings}
          onUpdateSettings={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
          onOpenSkills={openSkills}
          onConversationsChanged={refreshConversations}
          pendingResearchId={pendingResearchId}
          onPendingResearchHandled={() => setPendingResearchId(null)}
        />
      </div>
      {showSettings && (
        <SettingsView
          settings={settings}
          onChange={updateSettings}
          onOpenSkills={openSkills}
          onClose={() => setShowSettings(false)}
          onErased={() => {
            // eraseAllData() has already emptied chrome.storage.local, so re-reading
            // yields an un-onboarded config and the gate above renders the wizard.
            // The stale conversation is dropped too, or onboarding would finish into
            // a transcript whose stored copy no longer exists.
            setShowSettings(false)
            setLibraryTab(null)
            setConversations([])
            setConversationId(crypto.randomUUID())
            void loadSettings().then(setSettings)
          }}
        />
      )}
      {libraryTab && (
        <Library
          initialTab={libraryTab}
          currentConversationId={conversationId}
          onOpenConversation={openConversation}
          onOpenResearch={openResearch}
          onConversationsChanged={refreshConversations}
          onClose={() => setLibraryTab(null)}
        />
      )}
    </div>
  )
}
