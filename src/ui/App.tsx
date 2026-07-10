import { useCallback, useEffect, useRef, useState } from 'react'
import { listConversations, type ConversationSummary } from '../data/conversations'
import { dreamIfDue } from '../agent/dream'
import { loadSettings, saveSettings, type Settings } from '../data/settings'
import { relativeTime } from '../platform/time'
import Chat from './Chat'
import Onboarding from './Onboarding'
import SettingsView from './Settings'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // A conversation id keys the Chat: changing it loads a different chat, while
  // toggling settings leaves it untouched so the transcript is never lost.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
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
    setMenuOpen(false)
  }

  function openConversation(id: string) {
    if (id !== conversationId) setConversationId(id)
    setShowSettings(false)
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
            className={`icon-btn ${showSettings ? 'active' : ''}`}
            title="Settings"
            onClick={() => setShowSettings((s) => !s)}
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

      <div className={`view-host ${showSettings ? 'is-hidden' : ''}`}>
        <Chat
          key={conversationId}
          conversationId={conversationId}
          settings={settings}
          onUpdateSettings={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
          onConversationsChanged={refreshConversations}
        />
      </div>
      {showSettings && (
        <SettingsView
          settings={settings}
          onSave={(next) => {
            updateSettings(next)
            setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}
