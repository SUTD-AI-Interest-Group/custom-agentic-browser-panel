import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteConversation,
  listConversations,
  renameConversation,
  togglePin,
  type ConversationSummary,
} from '../../data/conversations'
import { relativeTime } from '../../platform/time'

// The Library's Chats tab: the full conversation history as a list. Clicking a
// row opens that chat; the hover-trash deletes it (with confirm). This is the
// fuller archive view; the topbar title keeps its own quick-switch dropdown.
// A title-only search filters the list, rows can be pinned to the top, and the
// title itself can be renamed inline (pencil -> input).

/** Display title with the same "New chat" fallback used elsewhere, so the
 * fallback is searchable too (a null title shouldn't be an unsearchable row). */
function displayTitle(c: ConversationSummary): string {
  return c.title ?? 'New chat'
}

export default function ConversationsList({
  currentConversationId,
  onOpen,
  onConversationsChanged,
}: {
  currentConversationId: string
  onOpen: (id: string) => void
  onConversationsChanged: () => void
}) {
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [query, setQuery] = useState('')
  // Id of the row currently showing the rename input, plus its live draft text.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const refresh = useCallback(() => {
    void listConversations()
      .then(setItems)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((c) => displayTitle(c).toLowerCase().includes(q))
  }, [items, query])

  // stopPropagation runs synchronously (before the confirm) so the delete never
  // also triggers the row's open handler.
  async function remove(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    if (!window.confirm('Delete this conversation? This can’t be undone.')) return
    try {
      await deleteConversation(id)
    } finally {
      refresh()
      onConversationsChanged()
    }
  }

  async function togglePinned(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    try {
      await togglePin(id)
    } finally {
      refresh()
    }
  }

  function startRename(e: React.MouseEvent, c: ConversationSummary) {
    e.stopPropagation()
    setRenamingId(c.id)
    setRenameValue(displayTitle(c))
  }

  async function commitRename(id: string) {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title) return
    try {
      await renameConversation(id, title)
    } finally {
      refresh()
      onConversationsChanged()
    }
  }

  if (items.length === 0) {
    return <div className="library-empty">No conversations yet.</div>
  }

  return (
    // Mirrors the SkillsList pattern: this wrapper is the tab's own scroll
    // container (like .library-skills), with a static top bar (the search
    // input) above a non-scrolling .library-list — see styles.css's comment
    // on `.library > .library-list, .library-skills`.
    <div className="library-conversations">
      <div className="library-conversations-top">
        <input
          className="library-search"
          type="text"
          placeholder="Search conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search conversations"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="library-empty">No conversations match.</div>
      ) : (
        <div className="library-list">
          {filtered.map((c) => (
            <div
              key={c.id}
              className={`library-row ${c.id === currentConversationId ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(c.id)
                }
              }}
            >
              <div className="library-row-main">
                {renamingId === c.id ? (
                  <input
                    className="library-rename-input"
                    autoFocus
                    value={renameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename(c.id)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setRenamingId(null)
                      }
                    }}
                    onBlur={() => setRenamingId(null)}
                  />
                ) : (
                  <span className="library-row-title">{displayTitle(c)}</span>
                )}
                <span className="library-row-meta">
                  {relativeTime(c.updatedAt)} · {c.messageCount} msg{c.messageCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="library-row-actions">
                <button
                  className={`icon-btn library-row-pin ${c.pinned ? 'active pinned' : ''}`}
                  title={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                  onClick={(e) => void togglePinned(e, c.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M7 1.5l1.4 3.2 3.4.4-2.5 2.4.6 3.5L7 9.2l-2.9 1.8.6-3.5-2.5-2.4 3.4-.4L7 1.5z"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill={c.pinned ? 'currentColor' : 'none'}
                    />
                  </svg>
                </button>
                <button
                  className="icon-btn library-row-rename"
                  title="Rename conversation"
                  onClick={(e) => startRename(e, c)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M9.5 2.1l2.4 2.4-6.6 6.6-3 .6.6-3 6.6-6.6z"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  className="icon-btn library-row-del"
                  title="Delete conversation"
                  onClick={(e) => void remove(e, c.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M2.5 3.5h9M5.5 3.5V2.5h3v1M4 3.5l.5 8h5l.5-8"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
