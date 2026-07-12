import { useCallback, useEffect, useState } from 'react'
import { deleteConversation, listConversations, type ConversationSummary } from '../../data/conversations'
import { relativeTime } from '../../platform/time'

// The Library's Chats tab: the full conversation history as a list. Clicking a
// row opens that chat; the hover-trash deletes it (with confirm). This is the
// fuller archive view; the topbar title keeps its own quick-switch dropdown.

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

  const refresh = useCallback(() => {
    void listConversations()
      .then(setItems)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

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

  if (items.length === 0) {
    return <div className="library-empty">No conversations yet.</div>
  }

  return (
    <div className="library-list">
      {items.map((c) => (
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
            <span className="library-row-title">{c.title ?? 'New chat'}</span>
            <span className="library-row-meta">
              {relativeTime(c.updatedAt)} · {c.messageCount} msg{c.messageCount === 1 ? '' : 's'}
            </span>
          </div>
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
      ))}
    </div>
  )
}
