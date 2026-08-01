import { useCallback, useEffect, useRef, useState } from 'react'
import { listConversations, type ConversationSummary } from '../data/conversations'
import { dreamIfDue } from '../agent/dream'
import { seedBuiltinSkills } from '../data/builtinSkills'
import { loadSettings, saveSettings, type Settings } from '../data/settings'
import { getMcpManager } from '../mcp/manager'
import type { ResearchTask } from '../data/researchTasks'
import { relativeTime } from '../platform/time'
import Chat from './Chat'
import Library, { type LibraryTab } from './library/Library'
import Onboarding from './Onboarding'
import SettingsView from './settings/Settings'
import {
  bindTab,
  boundTabFor,
  liveChatIds,
  loadTabChats,
  needsAttention,
  resolveBinding,
  saveRunningChats,
  saveTabChats,
  shouldAnnounceAttention,
  shouldToast,
  unbindTab,
  type ChatStatus,
  type TabChatMap,
} from './tabChats'

/**
 * The in-panel half of announcing a background chat: a quiet bar the user can
 * act on or dismiss. The 'running' case is the odd one out — it isn't an
 * announcement but a refusal, shown when the user tries to open a chat that is
 * still mid-turn on another tab.
 */
function LandedBar({
  landed,
  onOpen,
  onDismiss,
}: {
  landed: { conversationId: string; status: ChatStatus }
  onOpen: () => void
  onDismiss: () => void
}) {
  const text =
    landed.status === 'running'
      ? 'That chat is still working on another tab.'
      : landed.status === 'idle'
        ? 'A chat on another tab finished.'
        : 'A chat on another tab needs you.'
  return (
    <div className="landed-bar" role="status">
      <span className="landed-bar-text">{text}</span>
      <button className="landed-bar-open" onClick={onOpen}>
        Go to it
      </button>
      <button className="landed-bar-close" title="Dismiss" onClick={onDismiss}>
        <svg width="10" height="10" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

/** What the toast says a background chat is now waiting on. */
const LANDED_TITLE: Record<ChatStatus, string> = {
  idle: 'Lychee finished',
  parked: 'Lychee needs that tab',
  'needs-you': 'Lychee needs your go-ahead',
  running: '',
}

/**
 * Announce a background chat outside the panel. The notification id carries the
 * chat's tab, so background.ts can put the user back on it in one click without
 * the panel having to be open (or alive) to route it.
 */
async function notifyChatLanded(
  conversationId: string,
  status: ChatStatus,
  map: TabChatMap,
  detail?: string,
): Promise<void> {
  const tabId = boundTabFor(map, conversationId)
  if (tabId === undefined) return
  let host = 'a page'
  try {
    const tab = await chrome.tabs.get(tabId)
    host = new URL(tab.url ?? '').host || tab.title || 'a page'
  } catch {
    // Tab closed between finishing and announcing — still worth telling the
    // user their answer is ready, just without naming where it came from.
  }
  // Name the tool being requested. A permission prompt the user has to walk to
  // another tab to find should at least say what it is about to do, or the only
  // way to judge whether it is worth the trip is to take it.
  const message =
    status === 'needs-you'
      ? detail
        ? `Wants to use ${detail} on ${host}. Click to review.`
        : `Your chat about ${host} is waiting for your approval.`
      : status === 'parked'
        ? `Your chat needs ${host} in front to carry on. Click to go back.`
        : `Your answer about ${host} is ready.`
  try {
    chrome.notifications.create(`chat:${tabId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: LANDED_TITLE[status],
      message,
      priority: status === 'needs-you' ? 2 : 1,
      // Approval blocks the turn until answered, so it stays on screen rather
      // than timing out into a notification centre the user may never open.
      requireInteraction: status === 'needs-you',
    })
  } catch {}
}

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
  // Which chat belongs to which tab, and what each mounted chat is doing. The
  // map is the panel's copy of the session-storage mirror in tabChats.ts; the
  // statuses drive both what stays mounted and what gets announced.
  const [tabChats, setTabChats] = useState<TabChatMap>({})
  const [statuses, setStatuses] = useState<Record<string, ChatStatus>>({})
  // A background chat that just stopped, offered as a bar until dismissed.
  const [landed, setLanded] = useState<{ conversationId: string; status: ChatStatus } | null>(null)
  // This panel's window. Tab events fire for every window, and a panel must only
  // ever re-bind on its own — otherwise activity in a second window would swap
  // this panel's chat out from under the user.
  const windowIdRef = useRef<number | null>(null)
  // Mirrored into refs so the tab listeners — registered once, never re-bound —
  // read current values without being torn down on every state change.
  const tabChatsRef = useRef<TabChatMap>({})
  const statusesRef = useRef<Record<string, ChatStatus>>({})
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    tabChatsRef.current = tabChats
  }, [tabChats])
  useEffect(() => {
    statusesRef.current = statuses
  }, [statuses])
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // What each chat is blocked on (the tool awaiting approval), for the toast.
  const detailsRef = useRef<Record<string, string | undefined>>({})
  // The attention state each chat was last announced in, so one blocked chat
  // produces one notification rather than one per re-render or tab switch.
  const announcedRef = useRef<Map<string, ChatStatus>>(new Map())

  /** Commit a new binding map: ref first (listeners read it synchronously, and
   *  two tab events can land before React re-renders), then state, then disk. */
  const commitTabChats = useCallback((next: TabChatMap) => {
    tabChatsRef.current = next
    setTabChats(next)
    void saveTabChats(next)
  }, [])
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

  /**
   * Show whichever chat belongs to `tab`, minting a fresh one when the tab has
   * no binding or has navigated to another site since it was bound.
   *
   * A *running* chat is never re-pointed at the tab being activated: its tools
   * are pinned to the tab it was started on, and moving the binding mid-turn
   * would leave it reading a page nobody asked about. The new tab still gets its
   * own chat — the running one simply keeps the tab it already had.
   */
  const showChatForTab = useCallback(
    (tab: chrome.tabs.Tab) => {
      if (tab.id === undefined) return
      const tabId = tab.id
      const url = tab.url ?? ''
      const found = resolveBinding(tabChatsRef.current, tabId, url)
      const id = found.kind === 'existing' ? found.conversationId : crypto.randomUUID()
      setConversationId(id)
      // Re-binding an existing match would only rewrite boundAt, which matters
      // solely for the reverse lookup — and doing it while that chat is running
      // is exactly the mid-turn move described above.
      if (found.kind === 'existing' && statusesRef.current[id] === 'running') return
      commitTabChats(bindTab(tabChatsRef.current, tabId, id, url, Date.now()))
    },
    [commitTabChats],
  )

  // Bind the panel to the tab it opened on, restoring the map first so a panel
  // reopened mid-session lands back on the chat that tab was using rather than
  // minting a duplicate.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [win, map] = await Promise.all([
        chrome.windows.getCurrent().catch(() => null),
        loadTabChats(),
      ])
      if (cancelled) return
      windowIdRef.current = win?.id ?? null
      // Ref before state: showChatForTab reads the ref synchronously below, and
      // the sync effect won't have run yet — leaving it empty would ignore the
      // restored map and mint a duplicate chat for a tab that already has one.
      tabChatsRef.current = map
      setTabChats(map)
      const [tab] = await chrome.tabs.query({ active: true, windowId: win?.id })
      if (!cancelled && tab) showChatForTab(tab)
    })()
    return () => {
      cancelled = true
    }
  }, [showChatForTab])

  // The tab↔chat binding, driven by the browser rather than the UI: switching
  // tabs swaps the chat, navigating a tab across origins starts a new one, and
  // closing a tab forgets its binding (the conversation itself stays in history).
  useEffect(() => {
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (windowIdRef.current !== null && info.windowId !== windowIdRef.current) return
      void chrome.tabs.get(info.tabId).then(showChatForTab).catch(() => {})
    }
    // Only a committed URL change matters, and only on the tab this panel is
    // showing. Firing on every onUpdated (title, favicon, loading state) would
    // re-resolve constantly, and firing for background tabs would swap the
    // visible chat because some other tab navigated.
    const onUpdated = (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (!info.url) return
      if (windowIdRef.current !== null && tab.windowId !== windowIdRef.current) return
      if (!tab.active) return
      showChatForTab(tab)
    }
    const onRemoved = (tabId: number) => {
      const next = unbindTab(tabChatsRef.current, tabId)
      if (next !== tabChatsRef.current) commitTabChats(next)
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
  }, [showChatForTab])

  /**
   * A mounted chat reporting in. Besides driving what stays mounted, this is
   * where a background chat's turn ending becomes visible to the user: the bar
   * below, and a system toast when they aren't looking at the panel at all.
   */
  const handleStatusChange = useCallback((id: string, status: ChatStatus, detail?: string) => {
    detailsRef.current[id] = detail
    const before = statusesRef.current[id] ?? 'idle'
    if (before === status) return
    // Leaving an attention state ends that episode, so the next time this chat
    // gets blocked it is announced again rather than suppressed as a repeat.
    if (!needsAttention(status)) announcedRef.current.delete(id)
    const next = { ...statusesRef.current, [id]: status }
    statusesRef.current = next
    setStatuses(next)
    // Shared across windows so a second panel's Library can refuse to open a
    // conversation this one is still running — two panels mounting the same chat
    // would race on its transcript row.
    void saveRunningChats(Object.keys(next).filter((k) => next[k] === 'running'))
    const visible = id === conversationIdRef.current
    if (shouldToast(before, status, { visible, panelFocused: document.hasFocus() })) {
      if (!visible) setLanded({ conversationId: id, status })
      void notifyChatLanded(id, status, tabChatsRef.current)
    }
  }, [])

  /**
   * Announce any chat that is blocked on the user and out of sight.
   *
   * Runs on state, not on a transition, and re-checks whenever the visible chat
   * changes — which is what catches the case a transition cannot see: an
   * approval card that appeared while the user was watching (rightly silent),
   * and only became invisible because they switched tabs afterwards. Nothing
   * changes about the chat's status at that moment, so there is no transition to
   * hang a notification on; without this the chat would sit blocked in silence.
   *
   * The window `blur` listener covers the same thing one level up: the card is
   * on screen but the user has clicked back into the page and is no longer
   * looking at the panel at all.
   */
  useEffect(() => {
    const announce = () => {
      for (const [id, status] of Object.entries(statusesRef.current)) {
        const view = {
          visible: id === conversationIdRef.current,
          panelFocused: document.hasFocus(),
        }
        if (!shouldAnnounceAttention(status, announcedRef.current.get(id), view)) continue
        announcedRef.current.set(id, status)
        if (!view.visible) setLanded({ conversationId: id, status })
        void notifyChatLanded(id, status, tabChatsRef.current, detailsRef.current[id])
      }
    }
    announce()
    window.addEventListener('blur', announce)
    return () => window.removeEventListener('blur', announce)
  }, [statuses, conversationId])

  // Retire the bar once the user is looking at the chat it announces — however
  // they got there. Clicking "Go to it" is only one route; switching to the tab
  // by hand is the likelier one, and the bar must not still be advertising a
  // chat that is now on screen.
  useEffect(() => {
    if (landed && landed.conversationId === conversationId) setLanded(null)
  }, [landed, conversationId])

  // MCP: reconcile server connections with settings — on load and every save.
  // The manager lives in this panel context and dies with it; refresh() is
  // cheap when nothing changed.
  useEffect(() => {
    if (settings) void getMcpManager().refresh(settings).catch(() => {})
  }, [settings])

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

  /**
   * Point the current tab at a conversation and show it. Used by "new chat" and
   * by every "open this one" affordance, so a chat the user picked deliberately
   * behaves exactly like one the tab already had: it belongs to the tab they are
   * on now, and switching away will bring it back when they return.
   *
   * Other tabs still pointing at the same conversation are deliberately left
   * alone — reopening an old chat here shouldn't blank out the tab it came from.
   * boundTabFor resolves the ambiguity in favour of the most recent claim.
   */
  const adoptConversation = useCallback(
    (id: string) => {
      setConversationId(id)
      void (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          windowId: windowIdRef.current ?? undefined,
        })
        if (!tab || tab.id === undefined) return
        commitTabChats(bindTab(tabChatsRef.current, tab.id, id, tab.url ?? '', Date.now()))
      })()
    },
    [commitTabChats],
  )

  function newChat() {
    adoptConversation(crypto.randomUUID())
    setShowSettings(false)
    setLibraryTab(null)
    setMenuOpen(false)
  }

  function openConversation(id: string) {
    // A chat that is mid-turn stays where it is: it is pinned to its own tab
    // until it finishes, and mounting it here as well would race two components
    // on one transcript row.
    if (statuses[id] === 'running') {
      setLanded({ conversationId: id, status: 'running' })
      setMenuOpen(false)
      return
    }
    if (id !== conversationId) adoptConversation(id)
    setShowSettings(false)
    setLibraryTab(null)
    setMenuOpen(false)
  }

  /**
   * Jump to the chat the bar is announcing by activating its tab, rather than by
   * setting conversationId directly. The tab listener then swaps the panel over
   * through the same path a manual tab switch takes — one route to "show me that
   * chat", and the user ends up looking at the page it is about.
   */
  function openLanded() {
    const target = landed
    setLanded(null)
    if (!target) return
    const tabId = boundTabFor(tabChats, target.conversationId)
    if (tabId === undefined) {
      // Its tab is gone, so there is nothing to activate — adopt it here instead.
      adoptConversation(target.conversationId)
      return
    }
    void (async () => {
      try {
        const tab = await chrome.tabs.get(tabId)
        await chrome.tabs.update(tabId, { active: true })
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
      } catch {
        adoptConversation(target.conversationId)
      }
    })()
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
      adoptConversation(task.conversationId)
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

      {landed && <LandedBar landed={landed} onOpen={openLanded} onDismiss={() => setLanded(null)} />}

      {/* Every chat that is still working stays mounted alongside the visible
          one — that is what lets a turn survive the user switching tabs. Idle
          chats unmount as before, so the usual cost is one chat, not one per
          tab. Each is keyed by its conversation id, so switching chats never
          re-mounts (and never restarts) a turn that is already running. */}
      {liveChatIds(conversationId, statuses).map((id) => {
        const isVisible = id === conversationId
        return (
          <div
            key={id}
            className={`view-host ${!isVisible || showSettings || libraryTab ? 'is-hidden' : ''}`}
          >
            <Chat
              conversationId={id}
              settings={settings}
              onUpdateSettings={updateSettings}
              onOpenSettings={() => setShowSettings(true)}
              onOpenSkills={openSkills}
              onConversationsChanged={refreshConversations}
              // Only the chat on screen can act on a reveal request.
              pendingResearchId={isVisible ? pendingResearchId : null}
              onPendingResearchHandled={() => setPendingResearchId(null)}
              hidden={!isVisible}
              boundTabId={boundTabFor(tabChats, id)}
              onStatusChange={handleStatusChange}
            />
          </div>
        )
      })}
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
