import { useEffect, useRef, useState } from 'react'
import type { ModelMessage } from 'ai'
import Markdown from './Markdown'
import { runAgentTurn, type UIPart } from '../lib/agent'
import { captureRegion, type CapturedImage } from '../lib/capture'
import { appendToEpisode, getMemoryContext } from '../lib/memory'
import { createModel } from '../lib/provider'
import { getSelectedProvider, type Settings } from '../lib/settings'
import { getActiveTab, listOpenTabs, readTabContent, type TabContent, type TabSummary } from '../lib/tabs'
import { createAgentTools, type ApprovalRequest } from '../lib/tools'

interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  parts: UIPart[]
  /** Screenshot data URLs attached to a user message. */
  images?: string[]
}

interface PendingApproval extends ApprovalRequest {
  resolve: (approved: boolean) => void
}

interface CurrentTabInfo {
  title: string
  favIconUrl?: string
}

/** A tab the user @mentioned in the composer; its content syncs on send. */
interface TabMention {
  tabId: number
  title: string
  url: string
  /** The literal token inserted into the input, e.g. `@My Doc Title`. */
  token: string
}

const uid = () => crypto.randomUUID()

// Where does an "@" start a mention? At the start of input or after
// whitespace, with the query running up to the caret on the same line.
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.includes('\n') || query.length > 50) return null
  return { start: at, query }
}

export default function Chat({
  settings,
  onUpdateSettings,
  onOpenSettings,
}: {
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
}) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [currentTab, setCurrentTab] = useState<CurrentTabInfo | null>(null)
  const [attachments, setAttachments] = useState<CapturedImage[]>([])
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [mentions, setMentions] = useState<TabMention[]>([])
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null)
  const [mentionCandidates, setMentionCandidates] = useState<TabSummary[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)

  const historyRef = useRef<ModelMessage[]>([])
  // One episode per conversation: the raw journal that nightly "dreaming"
  // later distills into long-term memories.
  const episodeIdRef = useRef(uid())
  const abortRef = useRef<AbortController | null>(null)
  const approvalRef = useRef<PendingApproval | null>(null)
  const sessionAllowed = useRef<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const selected = getSelectedProvider(settings)

  // Passive context pill (Dia-style): shows which tab the agent would see if
  // granted access. Purely informational — access still goes through tools.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!cancelled && tab) {
        setCurrentTab({ title: tab.title ?? '(untitled)', favIconUrl: tab.favIconUrl })
      }
    }
    void refresh()
    const onActivated = () => void refresh()
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.title || info.status === 'complete') void refresh()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      cancelled = true
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, approval])

  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (sessionAllowed.current.has(request.toolName)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const pending = { ...request, resolve }
      approvalRef.current = pending
      setApproval(pending)
    })
  }

  function settleApproval(approved: boolean, forSession = false) {
    const pending = approvalRef.current
    if (!pending) return
    if (approved && forSession) sessionAllowed.current.add(pending.toolName)
    approvalRef.current = null
    setApproval(null)
    pending.resolve(approved)
  }

  function stop() {
    settleApproval(false)
    abortRef.current?.abort()
  }

  // Arc/Dia-style snipe: tint the page, snap to hovered components, or drag
  // an area. The result lands as a removable thumbnail on the composer.
  async function capture() {
    if (capturing) return
    setCaptureError(null)
    setCapturing(true)
    try {
      const img = await captureRegion()
      if (img) setAttachments((a) => [...a, img])
    } catch (err) {
      setCaptureError(
        `Couldn't capture this page: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setCapturing(false)
    }
  }

  // ---- @mention tabs -------------------------------------------------------
  // Typing "@" opens a tab picker; selecting inserts a literal token into the
  // text and records the tab. On send, each still-present mention has its tab
  // content read and synced into the model-facing message. Mentioning IS the
  // user's consent, so no approval card is involved.

  async function refreshMentionCandidates(m: { start: number; query: string }) {
    let tabs: TabSummary[]
    if (settings.tabAccess === 'all-tabs') {
      tabs = await listOpenTabs()
    } else {
      const tab = await getActiveTab()
      tabs =
        tab?.id !== undefined
          ? [{ tabId: tab.id, title: tab.title ?? '(untitled)', url: tab.url ?? '', active: true }]
          : []
    }
    const q = m.query.trim().toLowerCase()
    const filtered = q
      ? tabs.filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
      : tabs
    setMentionCandidates(filtered.slice(0, 8))
    setMentionIndex(0)
  }

  function handleInputChange(value: string, caret: number) {
    setInput(value)
    const m = detectMention(value, caret)
    setMentionQuery(m)
    if (m) void refreshMentionCandidates(m)
  }

  function selectMention(tab: TabSummary) {
    if (!mentionQuery) return
    const token = `@${tab.title.trim().slice(0, 48)}`
    const caret = inputRef.current?.selectionStart ?? input.length
    const next = `${input.slice(0, mentionQuery.start)}${token} ${input.slice(caret)}`
    setInput(next)
    setMentions((arr) => [
      ...arr.filter((x) => x.tabId !== tab.tabId),
      { tabId: tab.tabId, title: tab.title, url: tab.url, token },
    ])
    setMentionQuery(null)
    const pos = mentionQuery.start + token.length + 1
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  async function send() {
    const text = input.trim()
    const images = attachments
    // Mentions only count if their token survived editing.
    const activeMentions = mentions.filter((m) => text.includes(m.token))
    if ((!text && images.length === 0) || streaming || !selected) return
    setInput('')
    setAttachments([])
    setMentions([])
    setMentionQuery(null)
    setCaptureError(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    setMessages((m) => [
      ...m,
      { id: uid(), role: 'user', parts: [{ type: 'text', text }], images: images.map((i) => i.dataUrl) },
    ])

    // Sync @mentioned tab contents into the model-facing message.
    let modelText = text
    let syncedTabs: TabContent[] = []
    if (activeMentions.length > 0) {
      syncedTabs = await Promise.all(activeMentions.map((m) => readTabContent(m.tabId)))
      const blocks = syncedTabs.map(
        (c) =>
          `<tab title=${JSON.stringify(c.title)} url=${JSON.stringify(c.url)}>\n${
            c.error ? `(could not read this tab: ${c.error})` : c.text
          }${c.truncated ? '\n[content truncated]' : ''}\n</tab>`,
      )
      modelText = `${text}\n\n[Current content of the tab${activeMentions.length > 1 ? 's' : ''} the user @mentioned, synced at send time:]\n${blocks.join('\n\n')}`
    }

    if (images.length > 0) {
      historyRef.current.push({
        role: 'user',
        content: [
          ...images.map((i) => ({ type: 'image' as const, image: i.dataUrl })),
          ...(modelText ? [{ type: 'text' as const, text: modelText }] : []),
        ],
      })
    } else {
      historyRef.current.push({ role: 'user', content: modelText })
    }

    const assistantId = uid()
    setMessages((m) => [...m, { id: assistantId, role: 'assistant', parts: [] }])
    const updateAssistant = (parts: UIPart[]) =>
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, parts } : msg)))

    const controller = new AbortController()
    abortRef.current = controller
    setStreaming(true)
    const turnStartedAt = Date.now()
    try {
      // Recalled memories are injected fresh each turn so mid-conversation
      // saves (SaveMemory) are visible on the very next turn.
      const memoryContext = await getMemoryContext().catch(() => '')
      const accessNote =
        settings.tabAccess === 'active-tab'
          ? '\n\nThe user has restricted your tab visibility to the tab they are currently on; ViewOpenedTabs is unavailable.'
          : ''
      const { parts, responseMessages } = await runAgentTurn({
        model: createModel(selected.provider, selected.modelId),
        system: `${settings.systemPrompt}${accessNote}${memoryContext ? `\n\n${memoryContext}` : ''}`,
        history: [...historyRef.current],
        tools: createAgentTools(requestApproval, settings.tabAccess),
        abortSignal: controller.signal,
        onUpdate: updateAssistant,
      })
      updateAssistant(parts)
      historyRef.current.push(...responseMessages)

      // Journal the exchange for the next dream cycle. Tool calls are noted
      // by name only — page dumps would bloat the journal without adding
      // anything a summary needs.
      const assistantText = parts
        .map((p) => (p.type === 'text' ? p.text : `[used tool: ${p.toolName}]`))
        .join('\n')
        .trim()
      const notes: string[] = []
      if (images.length > 0)
        notes.push(`[attached ${images.length} screenshot${images.length > 1 ? 's' : ''}]`)
      if (syncedTabs.length > 0)
        notes.push(`[synced tabs: ${syncedTabs.map((t) => t.title).join(', ')}]`)
      const journalUserText = [text, ...notes].filter(Boolean).join('\n')
      void appendToEpisode(episodeIdRef.current, [
        { role: 'user', text: journalUserText, at: turnStartedAt },
        { role: 'assistant', text: assistantText, at: Date.now() },
      ]).catch(() => {})
    } catch (err) {
      if (controller.signal.aborted) {
        // Partial turn stays visible in the UI but is dropped from model
        // history so the next request starts from a consistent state.
        historyRef.current.pop()
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, parts: [...msg.parts, { type: 'text', text: `**Error:** ${message}` }] }
              : msg,
          ),
        )
        historyRef.current.pop()
      }
    } finally {
      settleApproval(false)
      abortRef.current = null
      setStreaming(false)
    }
  }

  function selectModel(value: string) {
    const [providerId, ...rest] = value.split('::')
    onUpdateSettings({ ...settings, selected: { providerId, modelId: rest.join('::') } })
  }

  const modelOptions = settings.providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}::${m}`, label: m, provider: p.name })),
  )

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">How can I help?</div>
            <div className="empty-hint">
              Ask about anything — @mention a tab to share its content, snip a screenshot with
              the camera, or let me ask permission to read pages myself.
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageView key={msg.id} message={msg} />
        ))}
        {approval && (
          <ApprovalCard
            approval={approval}
            onDeny={() => settleApproval(false)}
            onAllow={() => settleApproval(true)}
            onAllowSession={() => settleApproval(true, true)}
          />
        )}
      </div>

      <div className="composer-area">
        {currentTab && (
          <div className="context-pill" title="The agent can ask to view this tab">
            {currentTab.favIconUrl ? (
              <img src={currentTab.favIconUrl} alt="" />
            ) : (
              <span className="context-dot" />
            )}
            <span className="context-title">{currentTab.title}</span>
          </div>
        )}
        {captureError && <div className="capture-error">{captureError}</div>}
        {mentionQuery && mentionCandidates.length > 0 && (
          <div className="mention-popover">
            {mentionCandidates.map((t, i) => (
              <button
                key={t.tabId}
                className={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(t)
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <span className="mention-title">{t.title}</span>
                <span className="mention-url">{t.url}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          {attachments.length > 0 && (
            <div className="attachment-row">
              {attachments.map((img) => (
                <div className="attachment-thumb" key={img.id}>
                  <img src={img.dataUrl} alt="Screenshot attachment" />
                  <button
                    className="attachment-remove"
                    title="Remove screenshot"
                    onClick={() => setAttachments((a) => a.filter((x) => x.id !== img.id))}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            placeholder={selected ? 'Ask anything…' : 'Add a provider in settings to start'}
            disabled={!selected}
            rows={1}
            onChange={(e) => {
              handleInputChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              if (mentionQuery && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setMentionIndex(
                    (i) => (i + delta + mentionCandidates.length) % mentionCandidates.length,
                  )
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  selectMention(mentionCandidates[mentionIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionQuery(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            onBlur={() => setTimeout(() => setMentionQuery(null), 150)}
          />
          <div className="composer-row">
            {modelOptions.length > 0 ? (
              <select
                className="model-select"
                value={selected ? `${selected.provider.id}::${selected.modelId}` : ''}
                onChange={(e) => selectModel(e.target.value)}
              >
                {!selected && <option value="">Select model</option>}
                {settings.providers.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {p.models.map((m) => (
                      <option key={m} value={`${p.id}::${m}`}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <button className="link-btn" onClick={onOpenSettings}>
                Set up a provider
              </button>
            )}
            <div className="composer-btns">
              <button
                className="cam-btn"
                title="Screenshot part of the page"
                disabled={!selected || capturing}
                onClick={() => void capture()}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2.5 5.8A1.3 1.3 0 0 1 3.8 4.5h1.3l.83-1.24a1 1 0 0 1 .83-.46h2.48a1 1 0 0 1 .83.46l.83 1.24h1.3a1.3 1.3 0 0 1 1.3 1.3v4.9a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3v-4.9Z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <circle cx="8" cy="8.2" r="2.1" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </button>
              {streaming ? (
                <button className="send-btn stop" title="Stop" onClick={stop}>
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  className="send-btn"
                  title="Send"
                  disabled={(!input.trim() && attachments.length === 0) || !selected}
                  onClick={() => void send()}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5l4 4"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="msg-user">
        {message.images && message.images.length > 0 && (
          <div className="msg-images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt="Attached screenshot" />
            ))}
          </div>
        )}
        {text}
      </div>
    )
  }
  return (
    <div className="msg-assistant">
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          <Markdown key={i} text={part.text} />
        ) : (
          <ToolPill key={part.toolCallId} part={part} />
        ),
      )}
      {message.parts.length === 0 && <div className="thinking-dot" />}
    </div>
  )
}

function ToolPill({ part }: { part: Extract<UIPart, { type: 'tool' }> }) {
  const output = part.output as any
  const denied = output && typeof output === 'object' && output.denied
  let label: string
  if (part.state === 'running') label = 'Waiting for permission…'
  else if (part.state === 'error') label = `${part.toolName} failed`
  else if (denied) label = 'Permission denied'
  else if (part.toolName === 'ViewCurrentTab') label = `Viewed current tab · ${output?.title ?? ''}`
  else if (part.toolName === 'ViewOpenedTabs')
    label = output?.contents
      ? `Read ${output.contents.length} tab${output.contents.length > 1 ? 's' : ''}`
      : `Listed ${output?.tabs?.length ?? 0} open tabs`
  else if (part.toolName === 'SaveMemory') label = 'Saved a memory'
  else if (part.toolName === 'SearchMemory')
    label = `Recalled ${output?.memories?.length ?? 0} memor${(output?.memories?.length ?? 0) === 1 ? 'y' : 'ies'}`
  else label = part.toolName

  return (
    <details className={`tool-pill ${part.state} ${denied ? 'denied' : ''}`}>
      <summary>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M1.5 6s1.7-3.2 4.5-3.2S10.5 6 10.5 6 8.8 9.2 6 9.2 1.5 6 1.5 6Z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="6" cy="6" r="1.4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span>{label}</span>
      </summary>
      <pre>{JSON.stringify({ input: part.input, output: part.output }, null, 2)}</pre>
    </details>
  )
}

function ApprovalCard({
  approval,
  onDeny,
  onAllow,
  onAllowSession,
}: {
  approval: PendingApproval
  onDeny: () => void
  onAllow: () => void
  onAllowSession: () => void
}) {
  return (
    <div className="approval-card">
      <div className="approval-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="2.5" y="6" width="9" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span>{approval.summary}</span>
      </div>
      {approval.reason && <div className="approval-reason">{approval.reason}</div>}
      <div className="approval-actions">
        <button className="btn ghost" onClick={onDeny}>
          Deny
        </button>
        <button className="btn ghost" onClick={onAllowSession}>
          Allow this chat
        </button>
        <button className="btn primary" onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  )
}
