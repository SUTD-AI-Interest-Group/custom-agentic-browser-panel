import { useEffect, useState } from 'react'
import { dreamIfDue } from '../lib/dream'
import { loadSettings, saveSettings, type Settings } from '../lib/settings'
import Chat from './Chat'
import MemoryView from './Memory'
import Onboarding from './Onboarding'
import SettingsView from './Settings'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [view, setView] = useState<'chat' | 'settings' | 'memory'>('chat')
  // Bumping this key remounts Chat = new conversation.
  const [chatKey, setChatKey] = useState(0)

  useEffect(() => {
    loadSettings().then(setSettings)
    // Dreaming is fully automatic: besides the background alarm, check on
    // panel open too (covers browsers that were closed overnight). dreamIfDue
    // is self-guarding — it only runs when consolidation is actually due and
    // the user has been away.
    void dreamIfDue().catch(() => {})
  }, [])

  function updateSettings(next: Settings) {
    setSettings(next)
    void saveSettings(next)
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-title">Agent Chat</span>
        <div className="topbar-actions">
          <button
            className="icon-btn"
            title="New chat"
            onClick={() => {
              setChatKey((k) => k + 1)
              setView('chat')
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Memory & dreaming"
            onClick={() => setView(view === 'memory' ? 'chat' : 'memory')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {view === 'chat' ? (
        <Chat
          key={chatKey}
          settings={settings}
          onUpdateSettings={updateSettings}
          onOpenSettings={() => setView('settings')}
        />
      ) : view === 'memory' ? (
        <MemoryView />
      ) : (
        <SettingsView
          settings={settings}
          onSave={(next) => {
            updateSettings(next)
            setView('chat')
          }}
        />
      )}
    </div>
  )
}
