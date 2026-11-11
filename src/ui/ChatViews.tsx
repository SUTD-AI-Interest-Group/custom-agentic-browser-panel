import { faviconUrl } from './favicon'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from './Markdown'
import ImageCarousel from './ImageCarousel'
import LinkCardStack from './LinkCard'
import JsonTree from './JsonTree'
import { splitBlocks } from './blocks'
import { citationsToPlain } from './citations'
import { type Checkpoint, type MessageSource, type UIMessage, type UIPart } from '../agent/agent'
import { copyElementAsPng } from '../platform/domImage'
import { formatBytes } from '../data/usage'
import { getShot, getShotThumb, type ShotThumb, type StoredShot } from '../data/screenshots'
import { downloadImage } from '../platform/download'
import type { ModelPrice } from '../agent/pricing'
import type { ModelUsage } from '../agent/observability'
import { conversationUsage, usageLabel } from './usageDisplay'
import { type InFlightTurn } from '../data/conversations'
import { relativeTime } from '../platform/time'
import TraceDrawer from './TraceDrawer'
import { openPdfAtPage } from '../platform/tabs'
import { type ApprovalRequest } from '../tools/tools'
import { getMcpManager } from '../mcp/manager'
import McpContentCard from './McpContentCard'
import McpAppCard, { type McpAppRef } from './McpAppCard'
import { ArtifactCard } from './ArtifactCard'
import {
  isActiveStatus,
  type ResearchProposal,
  type ResearchStatus,
  type ResearchTask,
  type ResearchVerification
} from '../data/researchTasks'
import ResearchLaunchCard from './ResearchLaunchCard'
import { ResearchLiveCard } from './ResearchLiveCard'
import { hostOfLink as hostOf } from './linkHost'
// ---- Source favicons -----------------------------------------------------
// The pages an assistant reply drew on, shown as a favicon avatar bar beside
// the copy actions. Only real web pages count: tabs attached to the user's
// turn (stored on the message) plus pages the model read via ReadPage /
// ReadTabs (derived from the reply's tool parts).

const MAX_VISIBLE_SOURCES = 3

// The composer mirrors the reply source bar: at most this many attached-context
// pills are shown inline, with the remainder collapsed into a "+N" pill.
const MAX_VISIBLE_CONTEXT = 3

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)


/**
 * The de-duplicated web sources behind one assistant reply: pages attached to
 * the preceding user turn (message.sources) plus pages the model read via its
 * tools this turn (from tool parts). Keyed by URL, first title wins, encounter
 * order preserved. Non-http(s), errored and denied results are dropped.
 */
function deriveSources(message: UIMessage): MessageSource[] {
  const collected: MessageSource[] = [...(message.sources ?? [])]
  for (const part of message.parts) {
    if (part.type !== 'tool' || part.state !== 'done') continue
    const output = part.output as any
    if (!output || typeof output !== 'object' || output.denied) continue
    if (part.toolName === 'ReadPage' && !output.error && output.url) {
      collected.push({ title: output.title ?? '', url: output.url ?? '' })
    } else if (part.toolName === 'ReadTabs') {
      const items = Array.isArray(output.contents)
        ? output.contents
        : Array.isArray(output.doms)
          ? output.doms
          : []
      for (const c of items) {
        if (c && !c.error) collected.push({ title: c.title ?? '', url: c.url ?? '' })
      }
    }
  }
  const seen = new Set<string>()
  const sources: MessageSource[] = []
  for (const s of collected) {
    if (!isHttpUrl(s.url) || seen.has(s.url)) continue
    seen.add(s.url)
    sources.push({ title: s.title || hostOf(s.url) || s.url, url: s.url })
  }
  return sources
}

export function FileKindIcon({ kind }: { kind: 'pdf' | 'text' | 'document' }) {
  if (kind === 'document') {
    return (
      <svg className="attachment-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4 1.8h5.2L12.8 5v9.2a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M5.6 7.4h4.8M5.6 9.6h4.8M5.6 11.8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  return kind === 'pdf' ? (
    <svg className="attachment-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.8h5.2L12.8 5v9.2a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 1.8V5h3.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg className="attachment-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The tool checkboxes + "Open full permissions" footer. Shared by the wide
 * layout's tools popover and the narrow layout's "…" menu, so the two can never
 * drift apart.
 */
function ThinkingIndicator({ variant }: { startedAt: number; variant: 'thinking' | 'digesting' }) {
  return <div className="thinking-indicator" role="status">
    <span className="working-spinner" aria-hidden="true" />
    {variant === 'digesting' ? 'Reading results…' : 'Thinking…'}
  </div>
}

/**
 * The stored `shotId` of a *successful* shot-saving part, else undefined. Drives
 * grouping consecutive captures into one carousel (see MessageView) — errored or
 * denied calls return undefined and fall through to a trace entry.
 * Name-agnostic on purpose: `shotId` in a done output IS the contract for "a
 * user-facing image was saved" (GetScreenshot, GetElementScreenshot, ReadPdf
 * mode:"view", HighlightContent's marked PDF page — and any future tool), so a
 * new shot-saving tool can never silently save an image the chat never shows.
 */
function shotIdOf(part: UIPart): string | undefined {
  if (part.type !== 'tool') return undefined
  if (part.state !== 'done') return undefined
  const out = part.output as any
  if (out && typeof out === 'object' && out.denied) return undefined
  return typeof out?.shotId === 'string' ? out.shotId : undefined
}

// Memoized: without this, every streamed token re-renders EVERY message in the
// conversation (setMessages always produces a new `messages` array — required
// by React — which re-invokes MessageView for all messages, not just the one
// being patched). React.memo's default shallow-prop comparison is sufficient
// here because every setMessages call site in this file preserves object
// identity for any message it isn't touching (`m.map((msg) => msg.id === id ?
// {...} : msg)` returns the SAME `msg` reference for every other message, and
// the two call sites that append return `[...prev, ...add]` — verified across
// every setMessages call site in this file). The other props: `streaming` is
// stably `false` for every non-last message regardless of the chat's own
// streaming state, `turnStartedAt` only changes twice per turn (start/end),
// and `conversationId` is stable for a mounted Chat — none of them defeat
// memoization for the (many) messages that aren't the one currently streaming.
export const MessageView = memo(function MessageView({
  message,
  streaming,
  turnStartedAt,
  onRegenerate,
  conversationId,
  onProposeResearch,
  proposalActions,
  liveResearch,
  price,
}: {
  message: UIMessage
  streaming: boolean
  turnStartedAt: number | null
  /** Rates for the model currently selected, used to cost this reply's tokens.
   *  Memoized by the caller: `resolveModelPrice` builds a fresh object per call,
   *  and passing that straight through would defeat this component's memo on
   *  every single render. */
  price: ModelPrice
  /** Set only on the transcript's last reply, and only when it can be re-run. */
  onRegenerate?: () => void
  /** Threaded down to McpAppCard so an app card's tool calls are scoped to
   *  THIS conversation's approval/session state (see mcpAppHostRegistry.ts). */
  conversationId: string
  /** Stages a ProposeResearch chip's question for framing into a launch card
   *  (drained by an effect in Chat, via the same call Send uses). Threaded
   *  down to ToolOutput. Always a stable setState setter (see its declaration
   *  in Chat) — unlike proposalActions below, passing it is never what
   *  defeats this component's own memoization. */
  onProposeResearch: (text: string) => void
  /** Only set for a message carrying `.proposal` (see the call site) — undefined
   *  is a stable reference, so a message with no proposal never loses
   *  memoization over this prop; a proposal message's own re-renders are
   *  accepted the same way onRegenerate already accepts them for the last reply. */
  proposalActions?: {
    onChange: (p: ResearchProposal) => void
    onStart: (p: ResearchProposal) => void
    onCancel: (p: ResearchProposal) => void
  }
  /** Set only for the slot of a task that is still in flight — see the call site.
   *  `task` can still be undefined for a beat after a reload, when the message has
   *  been restored but researchTasks storage has not loaded yet; the routing below
   *  falls back to the report card rather than rendering a card with no data. */
  liveResearch?: {
    task?: ResearchTask
    now: number
    onStop: (taskId: string) => void
    onOpen: (taskId: string) => void
  }
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  // THE SLOT, in its three faces. Order is the contract: a task always wins over
  // the proposal that spawned it (the draft is spent once real work carries its
  // id), and a running task wins over the report view (which assumes a finished
  // report and would render an empty body mid-flight).
  if (liveResearch?.task)
    return (
      <ResearchLiveCard
        task={liveResearch.task}
        now={liveResearch.now}
        onStop={() => liveResearch.onStop(liveResearch.task!.id)}
        onOpen={() => liveResearch.onOpen(liveResearch.task!.id)}
      />
    )

  // A finished (or errored/cancelled) background-research report.
  if (message.research) return <ResearchReportMessage message={message} />

  // An unstarted launch card — the editable question before anything runs.
  if (message.proposal && proposalActions)
    return (
      <ResearchLaunchCard
        proposal={message.proposal}
        onChange={proposalActions.onChange}
        onStart={proposalActions.onStart}
        onCancel={proposalActions.onCancel}
      />
    )

  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="msg-user-wrap">
        <div className="msg-user">
          {message.images && message.images.length > 0 && (
            <div className="msg-images">
              {message.images.map((src, i) => (
                <img key={i} src={src} alt="Attached screenshot" />
              ))}
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="msg-attachments">
              {message.attachments
                .filter((a) => a.kind === 'image' && a.thumbDataUrl)
                .map((a) => (
                  <img key={a.id} src={a.thumbDataUrl} alt={a.name} title={a.name} />
                ))}
              {message.attachments
                .filter((a) => a.kind !== 'image')
                .map((a) => (
                  <span className="msg-attachment-chip" key={a.id} title={a.name}>
                    <FileKindIcon kind={a.kind === 'pdf' ? 'pdf' : a.kind === 'document' ? 'document' : 'text'} />
                    <span className="attachment-file-name">{a.name}</span>
                    <span className="attachment-file-sub">
                      {a.kind === 'pdf' && a.pageCount !== undefined
                        ? `${a.pageCount} page${a.pageCount === 1 ? '' : 's'}`
                        : a.kind === 'document' && a.docSummary
                          ? a.docSummary
                          : formatBytes(a.byteSize)}
                    </span>
                  </span>
                ))}
            </div>
          )}
          {text}
        </div>
        {text && <CopyTextButton text={text} label="Copy message" />}
      </div>
    )
  }

  // Show the waiting indicator while the turn is live and no *reply* is visibly
  // streaming: before the first part (thinking), in the gap right after a tool
  // result while the model decides its next move (digesting), and while a
  // reasoning part streams — the collapsible "Thinking" block is muted preamble,
  // not the reply, so the mascot keeps exercising beneath it until real response
  // text starts. The inline `turnStartedAt != null` also narrows it to a number
  // for the prop.
  const last = message.parts[message.parts.length - 1]
  const digesting = last?.type === 'tool' && last.state === 'done'
  const reasoningLive = last?.type === 'reasoning'

  // Group successful screenshots taken back-to-back into one image carousel
  // instead of a stack of raw tool cards. A run of screenshot shots spans
  // intervening reasoning ("Thinking") parts — a reasoning model emits one
  // between shots — but is broken by a text part or any other tool, so shots
  // merge only where they are genuinely consecutive and narrative order is kept.
  // A run is identified by its first shot's index; that slot renders the whole
  // run (a ShotCard for one shot, a ShotCarousel for several) and the run's later
  // shot parts render nothing.
  const parts = message.parts
  const runOf = parts.map(() => -1)
  let curRun = -1
  let runOpen = false
  for (let i = 0; i < parts.length; i++) {
    if (shotIdOf(parts[i]) !== undefined) {
      if (!runOpen) {
        curRun = i
        runOpen = true
      }
      runOf[i] = curRun
    } else if (parts[i].type !== 'reasoning') {
      runOpen = false
      curRun = -1
    }
  }
  const runShots = new Map<number, string[]>()
  parts.forEach((part, i) => {
    if (runOf[i] < 0) return
    const arr = runShots.get(runOf[i]) ?? []
    arr.push(shotIdOf(part) as string)
    runShots.set(runOf[i], arr)
  })
  const emittedRuns = new Set<number>()

  return (
    <div className="msg-assistant">
      {(message.hasTrace || parts.some(part => part.type === 'tool')) && (
        <TraceDrawer turnId={message.id} parts={parts} recorded={!!message.hasTrace} streaming={streaming} />
      )}
      <div className="msg-assistant-body" ref={bodyRef}>
        {parts.map((part, i) => {
          const run = runOf[i]
          if (run >= 0) {
            if (emittedRuns.has(run)) return null
            emittedRuns.add(run)
            const ids = runShots.get(run) as string[]
            return ids.length === 1 ? (
              <ShotCard key={`shots-${run}`} shotId={ids[0]} />
            ) : (
              <ShotCarousel key={`shots-${run}`} shotIds={ids} />
            )
          }
          return part.type === 'text' ? (
            <AssistantText key={i} text={part.text} streaming={streaming} />
          ) : part.type === 'reasoning' ? (
            <ReasoningBlock key={i} text={part.text} active={streaming && i === parts.length - 1} />
          ) : (
            <ToolOutput
              key={part.toolCallId}
              part={part}
              conversationId={conversationId}
              onProposeResearch={onProposeResearch}
            />
          )
        })}
        {streaming &&
          turnStartedAt != null &&
          (message.parts.length === 0 || digesting || reasoningLive) && (
            <ThinkingIndicator
              startedAt={turnStartedAt}
              variant={digesting ? 'digesting' : 'thinking'}
            />
          )}
        {message.fixingMath && !streaming && (
          <div className="fixing-math" aria-live="polite">
            <span className="fixing-math-spinner" aria-hidden="true" />
            fixing math…
          </div>
        )}
      </div>
      {message.parts.length > 0 && !streaming && (
        <MessageToolbar message={message} targetRef={bodyRef} onRegenerate={onRegenerate} price={price} />
      )}
    </div>
  )
})

// Renders one assistant text part as ordered blocks: image runs → carousel,
// standalone links → cards, standalone JSON → collapsible tree, else markdown.
// `citations` (research reports) turns inline [[n]] into favicon chips.
function AssistantText({
  text,
  streaming,
  citations,
}: {
  text: string
  streaming: boolean
  citations?: MessageSource[]
}) {
  const blocks = useMemo(() => splitBlocks(text), [text])
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'images') return <ImageCarousel key={i} urls={b.urls} />
        if (b.type === 'links') return <LinkCardStack key={i} links={b.links} />
        if (b.type === 'json') return <JsonTree key={i} value={b.value} />
        return <Markdown key={i} text={b.text} streaming={streaming} citations={citations} />
      })}
    </>
  )
}

// The model's reasoning for one reply, as a collapsible "Thinking" block.
// Reasoning is display-only: it is captured from the stream into UI parts but
// stripped from the model-replay history (see toValidModelMessages in agent.ts).
// `active` is true only while the model is *currently* emitting this reasoning
// (it's the last part and the turn is streaming). Open state follows `active` —
// expanded while it thinks, then auto-collapsed the moment the response starts
// (active → false) or on reload — until the user toggles it, which takes over.
function ReasoningBlock({ text, active }: { text: string; active: boolean }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? active
  return (
    <div className={`reasoning-block ${open ? 'open' : ''}`}>
      <button className="reasoning-head" aria-expanded={open} onClick={() => setUserToggled(!open)}>
        <svg className="reasoning-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="reasoning-label">Thinking</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

// Actions on a completed assistant message: the shared copy-as-image /
// copy-as-markdown group, plus the message's source favicons. `onRegenerate` is
// supplied only for the last reply in the transcript (see the message map), and
// adds a third button to the copy group.
function MessageToolbar({
  message,
  targetRef,
  onRegenerate,
  price,
}: {
  message: UIMessage
  targetRef: React.RefObject<HTMLDivElement>
  onRegenerate?: () => void
  price: ModelPrice
}) {
  const markdown = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return (
    <div className="msg-toolbar">
      {/* Picture only the response prose — drop the reasoning + tool-use blocks. */}
      <CopyActions
        targetRef={targetRef}
        markdown={markdown}
        excludeFromImage=".reasoning-block, .tool-pill"
        trailing={onRegenerate && <RegenerateButton onClick={onRegenerate} />}
      />
      <SourceBar sources={deriveSources(message)} />
      {message.usage && <UsageChip usage={message.usage} price={price} />}
    </div>
  )
}

/**
 * The conversation's running total, under the last message.
 *
 * Deliberately a footer inside the transcript rather than a top-bar figure: the
 * top bar is App's, and a chat's cost belongs with the chat it accrued in — a
 * per-tab panel can switch conversations under you, and a total that stayed put
 * in the chrome would look like it described whatever you were now reading.
 *
 * Renders nothing at all when no reply reported usage, rather than a zero.
 */
export function ConversationUsageLine({ messages, price }: { messages: UIMessage[]; price: ModelPrice }) {
  const total = useMemo(() => conversationUsage(messages), [messages])
  if (!total) return null
  const label = usageLabel(total, price)
  return (
    <div className="conversation-usage" title={label.detail}>
      This chat: {label.tokens} tokens
      {label.cost && ` · ${label.cost}`}
    </div>
  )
}

/**
 * What one reply cost, in tokens and (when rates are configured) dollars.
 *
 * Rendered only when the endpoint actually reported usage — a streaming endpoint
 * with usage reporting off gives us nothing, and a chip reading "0 → 0" would
 * look like a bug rather than an absence.
 */
function UsageChip({ usage, price }: { usage: ModelUsage; price: ModelPrice }) {
  const label = usageLabel(usage, price)
  return (
    <span className="usage-chip" title={label.detail}>
      {label.tokens}
      {label.cost && <span className="usage-chip-cost"> · {label.cost}</span>}
    </span>
  )
}

// Discard this reply and re-run the turn that produced it. Sits third in the
// copy group; only ever rendered for the transcript's last reply.
function RegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="msg-tool-btn"
      data-tooltip="Regenerate response"
      aria-label="Regenerate response"
      onClick={onClick}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path
          d="M13 8a5 5 0 1 1-1.6-3.7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <path
          d="M13.2 2.3v2.6h-2.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

// Copy-as-image (a PNG of `targetRef`'s rendered DOM) and copy-as-markdown
// (`markdown` text) buttons, each with a transient check/error state. Shared by
// assistant replies and research report cards so the clipboard + icon logic
// lives in one place. `targetRef` is HTMLElement so any body ref can pass here.
function CopyActions({
  targetRef,
  markdown,
  excludeFromImage,
  trailing,
}: {
  targetRef: React.RefObject<HTMLElement>
  markdown: string
  // CSS selector for blocks to leave out of the copied PNG (e.g. reasoning and
  // tool-use pills under an assistant reply). Omitted → the whole element.
  excludeFromImage?: string
  // Extra buttons rendered after the two copy buttons, inside the same group.
  // Assistant replies pass Regenerate here; research report cards pass nothing.
  trailing?: React.ReactNode
}) {
  const [imageState, setImageState] = useState<'idle' | 'done' | 'error'>('idle')
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'error'>('idle')

  async function copyImage() {
    const el = targetRef.current
    if (!el) return
    try {
      await copyElementAsPng(el, excludeFromImage)
      setImageState('done')
    } catch {
      setImageState('error')
    }
    setTimeout(() => setImageState('idle'), 1500)
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('done')
    } catch {
      setCopyState('error')
    }
    setTimeout(() => setCopyState('idle'), 1500)
  }

  return (
    <div className="msg-toolbar-actions">
      <button
        className={`msg-tool-btn ${imageState}`}
        data-tooltip={imageState === 'error' ? "Couldn't copy image" : 'Copy response as image'}
        aria-label={imageState === 'error' ? "Couldn't copy image" : 'Copy response as image'}
        onClick={() => void copyImage()}
      >
        {imageState === 'done' ? (
          <CheckIcon />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="5.8" cy="6.5" r="1.1" stroke="currentColor" strokeWidth="1.1" />
            <path d="M3 11.5l3-2.6 2.2 1.8 2.4-2.4 2.4 2.2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <button
        className={`msg-tool-btn ${copyState}`}
        data-tooltip={copyState === 'error' ? "Couldn't copy text" : 'Copy response as Markdown'}
        aria-label={copyState === 'error' ? "Couldn't copy text" : 'Copy response as Markdown'}
        onClick={() => void copyMarkdown()}
      >
        {copyState === 'done' ? (
          <CheckIcon />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        )}
      </button>
      {trailing}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Copy plain text to the clipboard with a transient check, matching the assistant
// toolbar's copy button. Shown under user messages.
function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch {
      setState('error')
    }
    setTimeout(() => setState('idle'), 1500)
  }
  return (
    <button
      className={`msg-tool-btn user-copy-btn ${state}`}
      data-tooltip={state === 'error' ? "Couldn't copy" : label}
      aria-label={state === 'error' ? "Couldn't copy" : label}
      onClick={() => void copy()}
    >
      {state === 'done' ? (
        <CheckIcon />
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  )
}

// The small "×" on a removable context pill.
function RemoveGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * A page shown in the composer's attached-context row — the current tab, an
 * @mentioned tab, or @all. When `onRemove` is set, the pill reveals a remove
 * "×" on hover that detaches the page from the next message.
 */
export interface ContextTab {
  key: string
  title: string
  url: string
  favIconUrl?: string
  /** Native tooltip text for the pill. */
  hint: string
  onRemove?: () => void
}

// The composer's attached-context row: a labelled pill per page (favicon + host,
// with a hover-revealed remove "×" when detachable). Beyond MAX_VISIBLE_CONTEXT
// the remainder collapse into a "+N" pill whose hover reveals a removable list —
// the same overflow behaviour as the reply SourceBar.
export function ContextPills({ tabs }: { tabs: ContextTab[] }) {
  if (tabs.length === 0) return null
  const visible = tabs.slice(0, MAX_VISIBLE_CONTEXT)
  const overflow = tabs.slice(MAX_VISIBLE_CONTEXT)
  return (
    <div className="context-pills">
      {visible.map((t) => (
        <div key={t.key} className={`context-pill${t.onRemove ? ' attached' : ''}`} title={t.hint}>
          <ContextFavicon tab={t} />
          <span className="context-title">{hostOf(t.url) || t.title}</span>
          {t.onRemove && (
            <button className="context-remove" title="Remove from this message" onClick={t.onRemove}>
              <RemoveGlyph />
            </button>
          )}
        </div>
      ))}
      {overflow.length > 0 && (
        <div className="context-pill context-more" tabIndex={0} aria-label={`${overflow.length} more attached`}>
          <span className="context-more-chip">+{overflow.length}</span>
          <div className="context-more-popover">
            {overflow.map((t) => (
              <div key={t.key} className="context-more-row" title={t.hint}>
                <span className="source-card-icon">
                  <ContextFavicon tab={t} />
                </span>
                <span className="source-card-text">
                  <span className="source-card-title">{t.title}</span>
                  {t.url && <span className="source-card-url">{hostOf(t.url) || t.url}</span>}
                </span>
                {t.onRemove && (
                  <button className="context-remove" title="Remove from this message" onClick={t.onRemove}>
                    <RemoveGlyph />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Favicon for a context pill: the tab's own icon when known, else Chrome's
// on-device cache for the URL, else a neutral dot.
function ContextFavicon({ tab }: { tab: ContextTab }) {
  const [failed, setFailed] = useState(false)
  const src = tab.favIconUrl || (isHttpUrl(tab.url) ? faviconUrl(tab.url) : '')
  if (!src || failed) return <span className="context-dot" />
  return <img src={src} alt="" onError={() => setFailed(true)} />
}

// The favicon avatar bar shown beside the copy actions: up to
// MAX_VISIBLE_SOURCES overlapping page icons, then a "+N" chip. Hovering an
// avatar reveals a card (favicon, title, url); hovering the chip reveals a
// stacked list of the remaining sources. Each opens the page in a new tab.
function SourceBar({ sources }: { sources: MessageSource[] }) {
  if (sources.length === 0) return null
  const visible = sources.slice(0, MAX_VISIBLE_SOURCES)
  const overflow = sources.slice(MAX_VISIBLE_SOURCES)
  return (
    <div className="source-bar" role="list" aria-label="Sources for this reply">
      {visible.map((s) => (
        <div className="source-avatar" role="listitem" key={s.url}>
          <a
            className="source-favicon"
            href={s.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${s.title}`}
          >
            <Favicon source={s} />
          </a>
          <a
            className="source-popover source-card-link"
            href={s.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
          >
            <SourceCard source={s} />
          </a>
        </div>
      ))}
      {overflow.length > 0 && (
        <div className="source-avatar source-more">
          <button
            type="button"
            className="source-more-chip"
            aria-label={`${overflow.length} more source${overflow.length > 1 ? 's' : ''}`}
          >
            +{overflow.length}
          </button>
          <div className="source-popover source-popover-list">
            {overflow.map((s) => (
              <a
                className="source-card-link"
                href={s.url}
                target="_blank"
                rel="noreferrer"
                key={s.url}
              >
                <SourceCard source={s} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// A page favicon from Chrome's on-device cache, falling back to a neutral dot
// when no icon is cached or the image fails to load.
function Favicon({ source }: { source: MessageSource }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="source-favicon-fallback" aria-hidden />
  return <img src={faviconUrl(source.url)} alt="" onError={() => setFailed(true)} />
}

// Popover body: favicon, page title, and url — shared by the single-source
// hover card and each row of the overflow list.
function SourceCard({ source }: { source: MessageSource }) {
  return (
    <>
      <span className="source-card-icon">
        <Favicon source={source} />
      </span>
      <span className="source-card-text">
        <span className="source-card-title">{source.title}</span>
        <span className="source-card-url">{source.url}</span>
      </span>
    </>
  )
}

function ToolOutput({
  part,
  conversationId,
  onProposeResearch,
}: {
  part: Extract<UIPart, { type: 'tool' }>
  /** Threaded down to McpAppCard — see mcpAppHostRegistry.ts. */
  conversationId: string
  /** Stages a ProposeResearch chip's question — see MessageView's doc comment
   *  on this same prop for why it's always a stable setState setter. */
  onProposeResearch: (text: string) => void
}) {
  const output = part.output as any
  // Stable identity for the app card's init context: a fresh object literal
  // here would be a changed effect dep in McpAppCard on every transcript
  // render, remounting the app iframe each keystroke.
  const appOutput = useMemo(() => ({ text: output?.text, structured: output?.structured }), [output])
  // Why the in-chat Authorize attempt failed (popup cancelled, network, state
  // mismatch) — silence here would leave the user retrying blind.
  const [authError, setAuthError] = useState<string | null>(null)
  const artifactIds: string[] = Array.isArray(output?.artifactIds) ? output.artifactIds : []
  const needsAuthServer: string | null =
    output?.needsAuth && typeof output?.server === 'string' ? output.server : null
  // Tool execution details live in the trace above the answer. Keep actionable
  // controls and produced artifacts in the transcript itself.
  return (
    <>
      {/* The model proposed research but did not start it (createProposeResearchTool
          has no side effect — see its own doc comment). Clicking this chip runs the
          IDENTICAL framing call the armed composer's Send uses (proposeResearch in
          Chat.tsx), seeded from the model's own suggested question instead of the
          user's typed one, and appends the same kind of editable launch card. */}
      {part.toolName === 'ProposeResearch' && output?.proposed && typeof output.question === 'string' && (
        <button
          type="button"
          className="research-propose-chip"
          onClick={() => onProposeResearch(output.question)}
        >
          ◈ Research this properly · usually 10–20 min
        </button>
      )}
      {needsAuthServer && (
        <button
          className="btn ghost small"
          onClick={() => {
            setAuthError(null)
            getMcpManager()
              .authorize(needsAuthServer)
              .catch((err) => setAuthError(err instanceof Error ? err.message : String(err)))
          }}
        >
          Authorize {needsAuthServer}
        </button>
      )}
      {authError && <p className="mcp-error">Authorization failed: {authError}</p>}
      {artifactIds.map((id) => (
        <McpContentCard key={id} artifactId={id} />
      ))}
      {output?.app && typeof output.app === 'object' && typeof output.app.server === 'string' && (
        <McpAppCard
          app={output.app as McpAppRef}
          toolInput={part.input}
          toolOutput={appOutput}
          conversationId={conversationId}
        />
      )}
      {typeof output?.artifactId === 'string' && (
        <ArtifactCard
          artifactId={output.artifactId}
          revision={typeof output?.revision === 'number' ? output.revision : undefined}
        />
      )}
    </>
  )
}

/**
 * A single screenshot the agent took, shown to the user in the transcript
 * (one-shot runs; several consecutive shots become a ShotCarousel instead).
 *
 * Only the `shotId` lives in the transcript (an inline image there would also
 * ride in the model's history, costing tokens on every later step for a picture
 * it has already been shown properly). So the preview is read from IndexedDB on
 * mount — the thumbnail store, which is kilobytes, not the full-resolution one,
 * which for a stitched page is megabytes. The full-resolution PNG is fetched
 * lazily, only when the user actually enlarges or downloads it.
 *
 * Collapsed, this is a compact thumbnail card; clicking it enlarges the
 * full-resolution capture in place. Download is a secondary action in the
 * enlarged view.
 */
function ShotCard({ shotId }: { shotId: string }) {
  const [thumb, setThumb] = useState<ShotThumb | null>(null)
  const [full, setFull] = useState<StoredShot | null>(null)
  const [enlarged, setEnlarged] = useState(false)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getShotThumb(shotId)
      .then((t) => {
        if (!alive) return
        if (t) setThumb(t)
        else setMissing(true)
      })
      .catch(() => alive && setMissing(true))
    return () => {
      alive = false
    }
  }, [shotId])

  // Shots are pruned by age and total size, so an old chat can outlive its images.
  // Say so plainly rather than rendering a broken frame.
  if (missing) return <div className="shot-card-missing">This screenshot is no longer stored.</div>
  if (!thumb) return null

  // Pull the multi-megabyte full-resolution PNG only the first time it is
  // actually needed (enlarge or download); the thumbnail alone drives the
  // collapsed preview. Cached in state so a second enlarge/download is instant.
  const loadFull = async (): Promise<StoredShot | null> => {
    if (full) return full
    setBusy(true)
    try {
      const f = await getShot(shotId)
      if (f) setFull(f)
      else setMissing(true)
      return f
    } finally {
      setBusy(false)
    }
  }

  const enlarge = async () => {
    if (await loadFull()) setEnlarged(true)
  }

  const download = async () => {
    const f = await loadFull()
    if (f) await downloadImage(f.dataUrl)
  }

  // A rendered PDF page carries its page number + source URL in the thumb, so
  // the card can take the user's viewer to that exact page on click. Human-
  // initiated, so no approval gate (same footing as the camera button).
  const jump =
    thumb.page !== undefined && thumb.url
      ? () => void openPdfAtPage(thumb.url!, thumb.page!)
      : null

  if (enlarged && full) {
    return (
      <figure className="shot-figure">
        <figcaption className="shot-figure-meta">
          <span className="shot-card-label">{thumb.label}</span>
          <span className="shot-card-dim">
            {full.width}×{full.height}
          </span>
          {jump && (
            <button type="button" className="shot-figure-btn" onClick={jump} title="Jump the PDF viewer to this page">
              Open page {thumb.page}
            </button>
          )}
          <button type="button" className="shot-figure-btn" onClick={() => setEnlarged(false)}>
            Shrink
          </button>
          <button
            type="button"
            className="shot-figure-btn"
            onClick={() => void download()}
            disabled={busy}
          >
            Download
          </button>
        </figcaption>
        <button
          type="button"
          className="shot-figure-img"
          onClick={() => setEnlarged(false)}
          title="Click to shrink"
          aria-label={`Collapse screenshot of ${thumb.label}`}
        >
          <img src={full.dataUrl} alt={`Screenshot of ${thumb.label}`} />
        </button>
      </figure>
    )
  }

  return (
    <span className="shot-card-wrap">
      <button
        type="button"
        className="shot-card"
        onClick={() => void enlarge()}
        disabled={busy}
        title={`Click to enlarge — ${thumb.label}`}
        aria-label={`Enlarge screenshot of ${thumb.label}`}
      >
        <img src={thumb.thumb} alt={`Screenshot of ${thumb.label}`} />
        <span className="shot-card-meta">
          <span className="shot-card-label">{thumb.label}</span>
          <span className="shot-card-dim">
            {thumb.width}×{thumb.height}
          </span>
        </span>
      </button>
      {/* Sibling, not nested — the card is itself a <button>. */}
      {jump && (
        <button type="button" className="shot-jump-btn" onClick={jump} title="Jump the PDF viewer to this page">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 2H2.5A1.5 1.5 0 0 0 1 3.5v5A1.5 1.5 0 0 0 2.5 10h5A1.5 1.5 0 0 0 9 8.5V6.5M6.5 1H11m0 0v4.5M11 1L5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Open page {thumb.page}
        </button>
      )}
    </span>
  )
}

/**
 * A run of screenshots the agent took back-to-back, shown as one horizontal
 * carousel instead of a stack of raw tool cards. Each tile is a thumbnail read
 * from IndexedDB (kilobytes); clicking one enlarges that capture in place below
 * the strip — the multi-megabyte full-resolution PNG is fetched only then — with
 * Download as a secondary action. Clicking the open tile again shrinks it. Shots
 * pruned by age/size drop out of the strip; if every one is gone the carousel
 * says so rather than rendering broken frames.
 */
function ShotCarousel({ shotIds }: { shotIds: string[] }) {
  const [thumbs, setThumbs] = useState<(ShotThumb | null)[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [full, setFull] = useState<StoredShot | null>(null)
  const [busy, setBusy] = useState(false)

  // MessageView rebuilds `shotIds` on every render, so key the load on the id
  // list itself, not the array's identity, or the effect would refetch endlessly.
  const idsKey = shotIds.join('|')
  useEffect(() => {
    let alive = true
    Promise.all(shotIds.map((id) => getShotThumb(id).catch(() => null))).then((ts) => {
      if (alive) setThumbs(ts)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  // Pull the multi-megabyte full-resolution PNG only when a tile is opened.
  const open = async (id: string) => {
    setOpenId(id)
    setFull(null)
    setBusy(true)
    try {
      setFull(await getShot(id))
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    setOpenId(null)
    setFull(null)
  }
  const download = async () => {
    if (full) await downloadImage(full.dataUrl)
  }

  if (!thumbs) return null
  const tiles = shotIds
    .map((id, i) => ({ id, thumb: thumbs[i] }))
    .filter((t): t is { id: string; thumb: ShotThumb } => !!t.thumb)
  if (tiles.length === 0)
    return <div className="shot-card-missing">These screenshots are no longer stored.</div>

  return (
    <div className="shot-carousel">
      <div className="shot-carousel-head">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M1.5 6s1.7-3.2 4.5-3.2S10.5 6 10.5 6 8.8 9.2 6 9.2 1.5 6 1.5 6Z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="6" cy="6" r="1.4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span>Took {tiles.length} screenshots</span>
      </div>
      <div className="shot-carousel-strip">
        {tiles.map(({ id, thumb }) => (
          <button
            key={id}
            type="button"
            className={`shot-tile${id === openId ? ' active' : ''}`}
            onClick={() => (id === openId ? close() : void open(id))}
            title={`${thumb.label} · ${thumb.width}×${thumb.height}`}
            aria-label={`Enlarge screenshot of ${thumb.label}`}
          >
            <img src={thumb.thumb} alt={`Screenshot of ${thumb.label}`} loading="lazy" />
          </button>
        ))}
      </div>
      {openId && full && (
        <figure className="shot-figure">
          <figcaption className="shot-figure-meta">
            <span className="shot-card-label">{full.label}</span>
            <span className="shot-card-dim">
              {full.width}×{full.height}
            </span>
            <button type="button" className="shot-figure-btn" onClick={close}>
              Shrink
            </button>
            <button
              type="button"
              className="shot-figure-btn"
              onClick={() => void download()}
              disabled={busy}
            >
              Download
            </button>
          </figcaption>
          <button
            type="button"
            className="shot-figure-img"
            onClick={close}
            title="Click to shrink"
            aria-label={`Collapse screenshot of ${full.label}`}
          >
            <img src={full.dataUrl} alt={`Screenshot of ${full.label}`} />
          </button>
        </figure>
      )}
    </div>
  )
}

// A finished background-research task dropped into the chat at the end of the
// transcript (done → report, error → error text). Rendered with the same
// treatment as an assistant reply: an AssistantText body (image carousels,
// link cards, JSON, markdown) plus the shared copy-as-image / copy-as-markdown
// actions and a SourceBar. The `id` is the scroll target for its ✓ dock bar.
function ResearchReportMessage({ message }: { message: UIMessage }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Collapsed hides the body + toolbar, leaving just the titled header.
  //
  // STARTS COLLAPSED, deliberately. A report can land twenty minutes after it was
  // asked for, and the previous behaviour — arriving fully expanded — dropped two
  // thousand words into the transcript unbidden, on top of an answer the user had
  // already accepted. Collapsed, the arrival states what it is and what question
  // it answered, and expands only when the user asks for it. This is the same
  // instinct as Gemini's, whose finished report also announces itself rather than
  // pushing itself into the conversation.
  const [collapsed, setCollapsed] = useState(true)
  const research = message.research!
  const reportText = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  return (
    <div className={`research-report${collapsed ? ' collapsed' : ''}`} id={message.id}>
      {/* bodyRef wraps header + body so a copied PNG carries the research title. */}
      <div className="research-report__content" ref={bodyRef}>
        <button
          className="research-report__header"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <ResearchGlyph />
          <span className="research-report__head-text">
            <span className="research-report__title">{research.question}</span>
            {/* The stamp is what stops a collapsed row reading as a reply to the
                message above it: it names the question this answered and how many
                sources stand behind it. */}
            <span className="research-report__stamp">
              {research.error
                ? 'Research failed'
                : `${message.sources?.length ?? 0} source${(message.sources?.length ?? 0) === 1 ? '' : 's'}`}
              {research.verification && !research.error ? ' · verified' : ''}
              {research.partial ? ' · partial' : ''}
            </span>
          </span>
          <svg className="research-report__caret" width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        {!collapsed && (
          <div className="research-report__body">
            {research.partial && (
              <div className="research-report__partial" role="note">
                Partial report — research reached its 24-hour limit before fully converging.
              </div>
            )}
            {research.verification && <VerificationBadge v={research.verification} />}
            {reportText ? (
              <AssistantText text={reportText} streaming={false} citations={message.sources} />
            ) : (
              <div className="research-card__error">{research.error}</div>
            )}
          </div>
        )}
      </div>
      {!collapsed && reportText && (
        <div className="msg-toolbar research-report__toolbar">
          <CopyActions targetRef={bodyRef} markdown={citationsToPlain(reportText)} />
          {message.sources && message.sources.length > 0 && <SourceBar sources={message.sources} />}
        </div>
      )}
    </div>
  )
}

// A compact "verified" strip above a finished report: how many cited claims
// held up in the grounding + adversarial pass. Hover reveals what was changed.
function VerificationBadge({ v }: { v: ResearchVerification }) {
  const flagged = v.hedged + v.removed
  const title = v.notes && v.notes.length ? v.notes.join('\n') : 'No issues found.'
  return (
    <div className={`research-verify ${flagged ? 'has-flags' : 'clean'}`} title={title}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1.5l5 2v3.2c0 3.2-2.1 5.6-5 6.8-2.9-1.2-5-3.6-5-6.8V3.5l5-2z" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M5.5 8l1.8 1.8L10.8 6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        Verified · {v.confirmed} confirmed
        {v.hedged > 0 && ` · ${v.hedged} hedged`}
        {v.removed > 0 && ` · ${v.removed} removed`}
      </span>
    </div>
  )
}

// The dock of live / just-finished research tasks, stacked directly above the
// composer. Each bar taps through to `onOpen`. Renders nothing when empty so
// the composer sits flush with no gap.
export function ResearchDock({
  tasks,
  onOpen,
}: {
  tasks: ResearchTask[]
  onOpen: (t: ResearchTask) => void
}) {
  if (tasks.length === 0) return null
  return (
    <div className="research-dock">
      {tasks.map((t) => (
        <ResearchBar key={t.id} task={t} onOpen={() => onOpen(t)} />
      ))}
    </div>
  )
}

// One thin dock bar: status icon + question + expand chevron.
function ResearchBar({ task, onOpen }: { task: ResearchTask; onOpen: () => void }) {
  const title =
    task.status === 'paused' && task.pauseReason ? `${task.question}\n${task.pauseReason}` : task.question
  return (
    <button className={`research-bar ${task.status}`} onClick={onOpen} title={title}>
      <ResearchStatusIcon status={task.status} />
      <span className="research-bar__title">{task.question}</span>
      <svg className="research-bar__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M2 6.5L5 3.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </button>
  )
}

// The bottom sheet (~85% height) for one task's live workflow: question header,
// full step log (each marked done/active), sources gathered so far, and a Stop
// button while running. A scrim behind it closes on click.
export function ResearchSheet({
  task,
  onClose,
  onStop,
}: {
  task: ResearchTask
  onClose: () => void
  onStop: () => void
}) {
  // Which step rows are expanded to show their input/result detail.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  return (
    <>
      <div className="research-sheet__scrim" onClick={onClose} />
      <div className="research-sheet" role="dialog" aria-label={`Research: ${task.question}`}>
        <div className="research-sheet__head">
          <ResearchStatusIcon status={task.status} />
          <span className="research-sheet__question">{task.question}</span>
          <button className="research-sheet__close" onClick={onClose} aria-label="Collapse">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </div>
        <div className="research-sheet__body">
          {task.notebook && task.notebook.plan.subQuestions.length > 0 && (
            <div className="research-sheet__plan">
              <div className="research-sheet__plan-title">Plan</div>
              <ul className="research-sheet__plan-list">
                {task.notebook.plan.subQuestions.map((q, i) => {
                  const c = task.notebook!.coverage[q]
                  const state = !c ? 'pending' : c.supported ? 'done' : 'gap'
                  return (
                    <li key={i} className={`research-plan__item ${state}`} title={c?.gap || undefined}>
                      <span className="research-plan__mark" aria-hidden />
                      <span className="research-plan__text">{q}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <ul className="research-sheet__steps">
            {task.steps.map((step, i) => {
              const open = expanded.has(i)
              // 'thought' rows are the model's reasoning between calls; 'phase'
              // rows are the pipeline's own beats. Both read very differently from
              // a tool call, so they get their own styling.
              const kind = step.kind ?? 'tool'
              const nested = (step.depth ?? 0) > 0
              return (
                <li
                  key={i}
                  className={`${step.status} kind-${kind}${nested ? ' nested' : ''}${open ? ' open' : ''}`}
                >
                  <button className="research-step__row" onClick={() => toggle(i)} aria-expanded={open}>
                    <span className="research-step__mark" aria-hidden />
                    <span className="research-step__text">{step.summary}</span>
                    <svg className="research-step__caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </button>
                  {open && <pre className="research-step__detail">{step.detail}</pre>}
                </li>
              )
            })}
            {task.steps.length === 0 && <li className="muted">Starting…</li>}
          </ul>
          <ResearchFindings task={task} />
          <ResearchSources task={task} />
        </div>
        {task.status === 'paused' && (
          <div className="research-sheet__paused" role="status">
            <ResearchSpinner />
            <span>{task.pauseReason || 'Waiting to retry — will resume automatically.'}</span>
          </div>
        )}
        {isActiveStatus(task.status) && (
          <div className="research-sheet__foot">
            <button className="btn ghost" onClick={onStop}>
              Stop
            </button>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * What the research has actually LEARNED so far — the whole point of the run.
 * The notebook streams to the panel throughout, but the sheet never rendered it,
 * so a running task showed a wall of searches and nothing else.
 */
function ResearchFindings({ task }: { task: ResearchTask }) {
  const nb = task.notebook
  if (!nb || nb.findings.length === 0) return null
  const sourceOf = (n?: number) => (n ? nb.sources.find((s) => s.n === n) : undefined)
  return (
    <div className="research-sheet__findings">
      <div className="research-sheet__section-title">
        Findings <span className="research-sheet__count">{nb.findings.length}</span>
      </div>
      <ul className="research-findings">
        {nb.findings.map((f) => {
          const src = sourceOf(f.sourceN)
          return (
            <li key={f.id} className={`research-finding conf-${f.confidence}`}>
              <div className="research-finding__claim">{f.claim}</div>
              {f.quote && <blockquote className="research-finding__quote">{f.quote}</blockquote>}
              {src && (
                <a className="research-finding__source" href={src.url} target="_blank" rel="noreferrer">
                  [{src.n}] {src.title || src.url}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Sources, live. `task.sources` is only written when the task COMPLETES, so it is
 * empty for the entire run — read the notebook (which streams) while it is going
 * and fall back to the persisted list afterwards.
 */
function ResearchSources({ task }: { task: ResearchTask }) {
  const live = task.notebook?.sources.map((s) => ({ title: s.title, url: s.url, n: s.n })) ?? []
  const sources = live.length ? live : (task.sources ?? []).map((s, i) => ({ ...s, n: i + 1 }))
  if (sources.length === 0) return null
  return (
    <div className="research-sheet__sources">
      <div className="research-sheet__section-title">
        Sources <span className="research-sheet__count">{sources.length}</span>
      </div>
      {sources.map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
          {s.title || s.url}
        </a>
      ))}
    </div>
  )
}

// Dock/sheet status glyph: a spinner while running, a pause bars glyph while
// paused/waiting-to-retry, then ✓ / ✕ / ⊘ for done / error / cancelled.
function ResearchStatusIcon({ status }: { status: ResearchStatus }) {
  if (status === 'running') return <ResearchSpinner />
  return (
    <span className={`research-status research-status--${status}`}>
      {status === 'paused' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M6 4v8M10 4v8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
        </svg>
      ) : status === 'done' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      ) : status === 'error' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </span>
  )
}

// A CSS-animated ring spinner for running research.
function ResearchSpinner() {
  return (
    <svg className="research-spinner" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" fill="none" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

// The small search glyph beside a report card's title.
function ResearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 9l3.2 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function ApprovalCard({
  approval,
  sessionPlan,
  onDeny,
  onAllow,
  onAllowSession,
}: {
  approval: ApprovalRequest
  sessionPlan?: { plan: string; host: string } | null
  onDeny: () => void
  onAllow: () => void
  onAllowSession: () => void
}) {
  const isSession = !!sessionPlan
  const items = approval.items ?? []
  return (
    <div className={`approval-card ${isSession ? 'session' : ''} ${approval.danger ? 'danger' : ''}`}>
      <div className="approval-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="2.5" y="6" width="9" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span>{isSession ? `Let the agent control ${sessionPlan!.host}?` : approval.summary}</span>
      </div>
      {(isSession ? sessionPlan!.plan : approval.reason) && (
        <div className="approval-reason">{isSession ? sessionPlan!.plan : approval.reason}</div>
      )}
      {/* A headline count is not consent — for a batch the user has to be able to
          see exactly which tabs are affected before deciding. */}
      {items.length > 0 && (
        <ul className="approval-items">
          {items.map((it, i) => (
            <li key={i}>
              <span className="approval-item-title" title={it.title}>
                {it.title}
              </span>
              {it.host && <span className="approval-item-host">{it.host}</span>}
              {it.note && <span className="approval-item-note">{it.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {approval.needsPermissions?.length && (
        <div className="approval-permission-hint">
          Chrome will ask for one extra permission the first time.
        </div>
      )}
      <div className="approval-actions">
        <button className="btn ghost" onClick={onDeny}>
          Deny
        </button>
        {!isSession && !approval.once && (
          <button className="btn ghost" onClick={onAllowSession}>
            Allow this chat
          </button>
        )}
        <button className={`btn ${approval.danger ? 'danger-solid' : 'primary'}`} onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  )
}

// Shown after a long task auto-continues MAX_AUTO_CONTINUES times without
// finishing: surfaces the model's checkpoint (what's done, what's left, what to
// avoid, the next action) and a Continue button that resumes with a fresh budget.
/**
 * A turn that was cut off when the panel closed, offered back to the user.
 *
 * Deliberately states what resuming does NOT carry over. A user who left mid
 * page-control has every reason to expect the agent to pick up where it left
 * off with the same permission, and it will not — saying so on the card is
 * cheaper than letting them discover it from a second approval prompt.
 */
export function RecoveryCard({
  record,
  onResume,
  onDiscard,
}: {
  record: InFlightTurn
  onResume: () => void
  onDiscard: () => void
}) {
  const asked = record.ctx.journalUserText.split('\n')[0].slice(0, 120)
  return (
    <div className="recovery-card" role="status">
      <div className="recovery-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 3.5v3.5l2.5 1.5M12 7A5 5 0 1 1 7 2a5 5 0 0 1 3.6 1.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>This turn was interrupted</span>
        <span className="recovery-when">{relativeTime(record.updatedAt)}</span>
      </div>
      {asked && <div className="recovery-asked">“{asked}”</div>}
      <div className="recovery-note">
        Resuming re-runs it from where it stopped. It won't keep any page-control
        permission from before — it will ask again if it needs it.
      </div>
      <div className="recovery-actions">
        <button className="btn primary small" onClick={onResume}>
          Resume
        </button>
        <button className="btn ghost small" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  )
}

export function ContinuationCard({
  checkpoint,
  needsPanel,
  onContinue,
  onDismiss,
}: {
  checkpoint: Checkpoint | null
  needsPanel?: boolean
  onContinue: () => void
  onDismiss: () => void
}) {
  const section = (title: string, cls: string, items: string[]) =>
    items.length > 0 ? (
      <div className={`continuation-section ${cls}`}>
        <div className="continuation-section-title">{title}</div>
        <ul>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </div>
    ) : null

  return (
    <div className="continuation-card">
      <div className="continuation-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2.5 2.5v9M6 2.5v9M10.5 7l-4-2.5v5z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <span>{needsPanel ? 'Task paused — panel required' : 'Task paused — step budget reached'}</span>
      </div>
      {checkpoint ? (
        <div className="continuation-body">
          {section('Done', 'done', checkpoint.done)}
          {section('Still to do', 'remaining', checkpoint.remaining)}
          {section('Avoid', 'avoid', checkpoint.avoid)}
          {checkpoint.nextAction && (
            <div className="continuation-next">
              <span className="continuation-next-label">Next</span>
              {checkpoint.nextAction}
            </div>
          )}
        </div>
      ) : (
        <div className="continuation-reason">
          {needsPanel ? 'Continue to resume tool use with the usual permission checks.' : 'The agent ran out of steps before finishing. Continue to give it a fresh budget.'}
        </div>
      )}
      <div className="continuation-actions">
        <button className="btn ghost" onClick={onDismiss}>
          Dismiss
        </button>
        <button className="btn primary" onClick={onContinue}>
          Continue task
        </button>
      </div>
    </div>
  )
}
