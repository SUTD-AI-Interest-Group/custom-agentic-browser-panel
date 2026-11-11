import { useEffect, useRef } from 'react'
import type { Settings } from '../data/settings'
import Markdown from './Markdown'
import ModelPicker from './ModelPicker'

export interface StudioMessage {
  role: 'user' | 'assistant'
  content: string
  proposal?: boolean
}
export function StudioTranscript({
  messages,
  busy,
  onReview,
  onSuggest,
}: {
  messages: StudioMessage[]
  busy: boolean
  onReview: () => void
  onSuggest: (text: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (messages.length)
      end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [messages, busy])
  return (
    <section className="studio-chat" aria-label="Agent Chat">

      <div
        className="messages studio-messages"
        aria-live="polite"
        aria-busy={busy}
      >
        {!messages.length && (
          <div className="studio-chat-empty">
            <div className="studio-suggestions">
              {[
                'Make this page easier to read',
                'Give this site a calmer layout',
              ].map((text) => (
                <button key={text} onClick={() => onSuggest(text)}>
                  {text}
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div className="msg-user-wrap" key={index}>
              <div className="msg-user">{message.content}</div>
            </div>
          ) : (
            <div className="msg-assistant" key={index}>
              <div className="msg-assistant-body">
                <Markdown text={message.content} />
              </div>
              {message.proposal && index === messages.length - 1 && (
                <button className="studio-proposal" onClick={onReview}>
                  <span className="studio-proposal-icon">{'{ }'}</span>
                  <span>
                    <strong>Review changes</strong>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="studio-thinking" role="status">
            <span className="studio-thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Drafting changes
          </div>
        )}
        <div ref={end} />
      </div>
    </section>
  )
}
export function StudioComposer({
  input,
  setInput,
  busy,
  onSend,
  onStop,
  settings,
  onUpdateSettings,
  onOpenSettings,
  host,
}: {
  input: string
  setInput: (value: string) => void
  busy: boolean
  onSend: () => void
  onStop: () => void
  settings: Settings
  onUpdateSettings: (settings: Settings) => void
  onOpenSettings: () => void
  host: string
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = textarea.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(140, el.scrollHeight)}px`
    }
  }, [input])
  return (
    <div className="composer-area studio-composer-area">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) onSend()
        }}
      >
        <div
          className="studio-context"
          title="Page structure is shared with the selected model when you send."
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
          >
            <rect x="2" y="2" width="12" height="12" rx="3" />
            <path d="M2 6h12" />
          </svg>
          {host}
        </div>
        <textarea
          ref={textarea}
          rows={2}
          aria-label="Describe a site customization"
          placeholder="Ask for a change…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              if (!busy && input.trim()) onSend()
            }
          }}
        />
        <div className="composer-row">
          <ModelPicker
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            onOpenSettings={onOpenSettings}
          />
          <div className="composer-btns">
            {busy ? (
              <button
                className="send-btn stop"
                type="button"
                aria-label="Stop generating"
                title="Stop generating"
                onClick={onStop}
              >
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <rect
                    x="2"
                    y="2"
                    width="8"
                    height="8"
                    rx="2"
                    fill="currentColor"
                  />
                </svg>
              </button>
            ) : (
              <button
                className="send-btn"
                type="submit"
                aria-label="Send"
                title="Send"
                disabled={!input.trim() || !settings.selected}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 12V4m-4 4 4-4 4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
