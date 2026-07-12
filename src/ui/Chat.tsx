import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelMessage } from 'ai'
import { generateText } from 'ai'
import Markdown from './Markdown'
import ImageCarousel from './ImageCarousel'
import LinkCardStack from './LinkCard'
import JsonTree from './JsonTree'
import { splitBlocks } from './blocks'
import { citationsToPlain } from './citations'
import { runAgentTurn, type Checkpoint, type MessageSource, type QueuedImage, type UIMessage, type UIPart } from '../agent/agent'
import { validateMath } from './mathValidate'
import { repairMessageText, type Complete } from '../agent/mathRepair'
import { captureRegion, type CapturedImage } from '../platform/capture'
import { ensureVisionCapability } from '../agent/vision'
import { copyElementAsPng } from '../platform/domImage'
import { getConversation, renameConversation, saveConversation } from '../data/conversations'
import { getShot, getShotThumb, type ShotThumb } from '../data/screenshots'
import { downloadImage } from '../platform/download'
import { appendToEpisode, getMemoryContext } from '../data/memory'
import { createModel, generateChatTitle } from '../agent/provider'
import { getObserver, type ModelUsage } from '../agent/observability'
import { formatTokens, hasTokens, sumUsage, totalTokens } from '../agent/usage'
import {
  getSelectedProvider,
  observabilityConfig,
  toolPolicy,
  TOOL_CATALOG,
  GROUP_ORDER,
  GROUP_LABELS,
  type ProviderConfig,
  type Settings,
} from '../data/settings'
import { getActiveTab, listOpenTabs, readTabContent, type TabContent, type TabSummary } from '../platform/tabs'
import { createAgentTools, type ApprovalRequest, type PageControlGate } from '../tools/tools'
import { type ControlSession } from '../tools/pageControl'
import { clearIndex } from '../platform/domIndex'
import { unmountPresence, unmountAllPresence } from '../platform/presence'
import { grantedCapabilities, type BrowsingCapability } from '../platform/permissions'
import { getSkill, listSkillMetas, listSkills } from '../data/skills'
import { listTasks, type ResearchTask, type ResearchStatus, type ResearchMsg, type ResearchVerification } from '../data/researchTasks'

// How long a finished research task lingers in the composer dock (as a ✓/✕/⊘
// bar) after it completes before auto-dismissing. Its report has already
// dropped into the chat by then, so the bar is just a brief completion cue.
const DOCK_LINGER_MS = 15_000

/** System-prompt suffix naming the QueryBrowserData sources available this turn. */
function browsingInsightsNote(granted: Set<BrowsingCapability>): string {
  const sources = (['history', 'bookmarks', 'topSites', 'downloads'] as const).filter((s) => granted.has(s))
  if (sources.length === 0) {
    return '\n\nThe QueryBrowserData tool (history, bookmarks, top sites, downloads) is currently turned off; do not offer to use it.'
  }
  return `\n\nQueryBrowserData sources available this turn: ${sources.join(', ')}.`
}

// Appended to every system prompt (independent of the user's editable
// settings.systemPrompt) so math renders in the panel even on quick replies
// where the agent doesn't load the writing-math skill. Backslashes are doubled
// for the JS string; the model sees single-backslash LaTeX.
const MATH_FORMATTING_NOTE =
  '\n\nWhen your answer includes mathematical notation, write it in LaTeX: `$…$` for inline math and `$$…$$` on their own lines for display math (these render in the panel). Prefer LaTeX commands over Unicode symbols (e.g. `\\alpha`, `\\leq`, `\\times`). Escape a literal dollar sign as `\\$`.'

// Progressive tool disclosure. Appended to every system prompt as machinery
// (independent of the user's editable settings.systemPrompt) so the protocol
// reaches every install — including ones whose stored prompt predates it. Only
// ReadPage + the ToolSearch/GetTool meta-tools are active by default; everything
// else is loaded on demand (see src/tools/toolDiscovery.ts).
const TOOL_DISCLOSURE_NOTE =
  '\n\nYour tools load on demand. ReadPage is always available — read the current tab with mode "text" (visible text), "dom" (HTML structure), or "elements" (numbered interactive elements, used before controlling a page). For anything else, call ToolSearch to list the available tools (optionally with a query), then GetTool with the names you need; loaded tools stay available for the rest of this turn. Loading a tool does not run it, and tools still ask the user for permission when they run. Capabilities to load when needed: ReadTabs (other open tabs), RequestPageControl/ControlPage/AutofillForm (control a page — click, type, fill), NavigateTab (switch/open/load a tab), ExtractData (structured JSON from the page), SaveMemory/SearchMemory (long-term memory), QueryBrowserData (history/bookmarks/top sites/downloads — only enabled sources), ListAllSkills/ReadSkill/SaveSkill (skills), StartResearch (background web research). If the message needs no tools, just answer.'

interface PendingApproval extends ApprovalRequest {
  resolve: (approved: boolean) => void
}

interface CurrentTabInfo {
  tabId: number
  title: string
  url: string
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

// Entries offered in the "@" popover: open tabs, plus special items — "memory"
// (draw on long-term memory) and "all" (attach every open tab).
type MentionCandidate = { kind: 'tab'; tab: TabSummary } | { kind: 'memory' } | { kind: 'all' }

// The literal token that marks a message as memory-directed. Its presence in
// the sent text (typed or inserted from the popover) is the user's request to
// recall — the agent's SearchMemory tool is auto-approved for that turn.
const MEMORY_TOKEN = '@memory'
const MEMORY_TOKEN_RE = /(^|\s)@memory\b/i

// @all attaches the content of every open tab. Only offered when the user has
// granted all-tabs visibility, mirroring the ReadTabs gate.
const ALL_TOKEN = '@all'
const ALL_TOKEN_RE = /(^|\s)@all\b/i
const MAX_ALL_TABS = 25

// Cap how much highlighted text we forward as context.
const SELECTION_MAX = 4000

// Long-horizon continuation: when a turn ends because the model checkpointed or
// hit the step budget (see runAgentTurn's TurnStopReason), the chat auto-continues
// up to this many times seamlessly before surfacing the Continue card.
const MAX_AUTO_CONTINUES = 3
// Transcript treatment of an auto-continue (swap flag): false = a new assistant
// bubble per cycle with a "↻ Continued automatically" divider; true = append
// every cycle's parts into one continuous bubble.
const MERGE_AUTO_CONTINUES = false

// Auto-approval is now driven by each tool's Never/Ask/Always policy
// (DEFAULT_TOOL_POLICIES / Settings → Permissions). ReadSkill and ListAllSkills
// default to "always" — as benign as SearchMemory — so they still clear the gate
// without a card unless the user changes them. See requestApproval below.

// Deictic references to the page/tab the user is currently viewing — "what
// about this?", "summarize this page", "what's here". Liberal by design: a
// false positive only re-attaches the current tab once (see sharedTabsRef).
const DEICTIC_RE =
  /\b(this|these|here)\b|\b(current|the)\s+(page|tab|site|website|article|post|blog|story|video|content|doc|document|pdf)\b/i

// Identity of a shared tab for de-duplication: the tab plus its URL, so
// navigating the same tab to a new page counts as a different page.
const tabKey = (tabId: number, url: string) => `${tabId}::${url}`

const uid = () => crypto.randomUUID()

// The bare host of a URL (medium.com), or '' for unscriptable/blank URLs.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Remove the first occurrence of `token` (and one trailing space) from `value`.
// Used to detach an @mentioned tab when its composer pill is removed.
function stripToken(value: string, token: string): string {
  const i = value.indexOf(token)
  if (i === -1) return value
  let rest = value.slice(i + token.length)
  if (rest.startsWith(' ')) rest = rest.slice(1)
  return value.slice(0, i) + rest
}

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

// Imported from ./favicon and re-exported so the chat SourceBar and the
// research-report inline citations share one implementation (LinkCard and others
// still import it from here).
import { faviconUrl } from './favicon'
export { faviconUrl }

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

// Composer "/" menu: like @mentions but anchored to the start of the message.
// A leading "/skill-name" token invokes that skill (parsed on send in `send`);
// this popover just autocompletes the name.
type SlashCandidate =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'browse' }

// Active only while the caret is still inside a leading "/token" (no space yet).
function detectSlash(value: string, caret: number): { query: string } | null {
  const before = value.slice(0, caret)
  const m = before.match(/^\/([a-z0-9-]*)$/)
  return m ? { query: m[1] } : null
}

function ToolsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 5.8A1.3 1.3 0 0 1 3.8 4.5h1.3l.83-1.24a1 1 0 0 1 .83-.46h2.48a1 1 0 0 1 .83.46l.83 1.24h1.3a1.3 1.3 0 0 1 1.3 1.3v4.9a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3v-4.9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.2" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * The tool checkboxes + "Open full permissions" footer. Shared by the wide
 * layout's tools popover and the narrow layout's "…" menu, so the two can never
 * drift apart.
 */
function ToolsMenuBody({
  settings,
  toggleTool,
  onOpenFull,
}: {
  settings: Settings
  toggleTool: (name: string, on: boolean) => void
  onOpenFull: () => void
}) {
  return (
    <>
      {GROUP_ORDER.map((group) => {
        const tools = TOOL_CATALOG.filter((t) => t.group === group)
        if (tools.length === 0) return null
        return (
          <div className="tools-group" key={group}>
            <div className="tools-group-title">{GROUP_LABELS[group]}</div>
            {tools.map((t) => {
              const policy = toolPolicy(settings, t.name)
              return (
                <label className="tools-item" key={t.name}>
                  <span className="tools-item-label">
                    {t.label}
                    {policy === 'always' && (
                      <span className="tools-badge" aria-hidden="true">
                        auto
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    checked={policy !== 'never'}
                    onChange={(e) => toggleTool(t.name, e.target.checked)}
                  />
                </label>
              )
            })}
          </div>
        )
      })}
      <button className="tools-popover-foot" onClick={onOpenFull}>
        Open full permissions →
      </button>
    </>
  )
}

/** Close a popover on outside-click or Esc. Listens only while it is open. */
function useDismissOnOutside(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

export default function Chat({
  conversationId,
  settings,
  onUpdateSettings,
  onOpenSettings,
  onOpenSkills,
  onConversationsChanged,
  pendingResearchId,
  onPendingResearchHandled,
}: {
  conversationId: string
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  onConversationsChanged: () => void
  /** A research task the Library asked to reveal in this (now-mounted) chat. */
  pendingResearchId?: string | null
  /** Called once the pending research has been revealed, so App clears it. */
  onPendingResearchHandled?: () => void
}) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  // A long task paused at the auto-continue ceiling: the Continue card shows the
  // model's checkpoint and, on click, resumes with a fresh budget. Ephemeral —
  // the checkpoint itself rides in the message history, so it survives a reload.
  const [continuation, setContinuation] = useState<{ checkpoint: Checkpoint | null } | null>(null)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [currentTab, setCurrentTab] = useState<CurrentTabInfo | null>(null)
  const [attachments, setAttachments] = useState<CapturedImage[]>([])
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [mentions, setMentions] = useState<TabMention[]>([])
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null)
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashQuery, setSlashQuery] = useState<{ query: string } | null>(null)
  const [slashCandidates, setSlashCandidates] = useState<SlashCandidate[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  // The active tab is attached to the first message of a fresh chat so the user
  // can start talking about the page right away; they can dismiss it.
  const [tabDismissed, setTabDismissed] = useState(false)
  // Text the user has highlighted on the active tab, offered as removable
  // context. `dismissedSelection` holds the last selection they removed or sent
  // so it isn't re-attached until they highlight something different.
  const [selection, setSelection] = useState<{ text: string; tabId: number } | null>(null)
  const [dismissedSelection, setDismissedSelection] = useState('')
  // Background research tasks (Task 7). Loaded globally from storage, then
  // filtered to the open conversation (see `myTasks` in render) so a task's
  // dock bar + report card surface only in the chat it was launched from.
  const [researchTasks, setResearchTasks] = useState<ResearchTask[]>([])
  // Which research task's live-workflow bottom sheet is open (null = closed).
  const [openSheetTaskId, setOpenSheetTaskId] = useState<string | null>(null)
  // True once this conversation's persisted transcript has been restored, so the
  // research-report injection effect below runs after (not racing) the restore.
  const [restored, setRestored] = useState(false)
  // A ~1s wall-clock tick that only runs while a finished task is still inside
  // its DOCK_LINGER_MS window, so dock bars can auto-expire without an idle
  // timer when nothing is completing (see effect below).
  const [now, setNow] = useState(() => Date.now())
  // Open tabs resolved for @all, so the composer can preview each attached page
  // as its own pill. Populated only while @all is active (see effect below).
  const [allTabs, setAllTabs] = useState<TabSummary[]>([])
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsMenuRef = useRef<HTMLDivElement>(null)
  // Narrow panels collapse the tools + screenshot buttons into one "…" menu.
  const [moreOpen, setMoreOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Bumped when a turn finishes, to trigger persistence of the transcript.
  const [turnSeq, setTurnSeq] = useState(0)

  const historyRef = useRef<ModelMessage[]>([])
  const messagesRef = useRef<UIMessage[]>([])
  // One episode per conversation: the raw journal that nightly "dreaming"
  // later distills into long-term memories. Sharing the conversation id keeps
  // the journal aligned with the chat it came from.
  const episodeIdRef = useRef(conversationId)
  const abortRef = useRef<AbortController | null>(null)
  // Tabs whose content has already been injected into this conversation, keyed
  // by id+url. Lets a deictic reference re-share the current tab only after the
  // user navigates to a different page. Resets when the chat remounts.
  const sharedTabsRef = useRef<Set<string>>(new Set())
  const approvalRef = useRef<PendingApproval | null>(null)
  const sessionAllowed = useRef<Set<string>>(new Set())
  // Tools pre-authorized for the current turn only (e.g. SearchMemory when the
  // user typed @memory — the mention itself is their consent).
  const turnAllowed = useRef<Set<string>>(new Set())
  // Seamless auto-continuations used in the current chain, reset when the user
  // starts or explicitly continues a task (see runTurnChain / MAX_AUTO_CONTINUES).
  const autoContinuesRef = useRef(0)
  // The open page-control session (RequestPageControl → ControlPage), if any.
  const pageSessionRef = useRef<ControlSession | null>(null)
  const [sessionPlan, setSessionPlan] = useState<{ plan: string; host: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const selected = getSelectedProvider(settings)

  // Restore a persisted conversation on mount. Chat is keyed by conversationId
  // in App, so this runs once per chat and never mid-conversation.
  useEffect(() => {
    let cancelled = false
    setRestored(false)
    void getConversation(conversationId).then((c) => {
      if (cancelled) return
      if (c) {
        setMessages(c.messages)
        historyRef.current = c.history
      }
      setRestored(true)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // Drop a finished research task into THIS conversation's transcript as a
  // message, so its report card scrolls with the chat and later turns follow it
  // (rather than staying pinned at the bottom). Reconstructed from persistent
  // researchTasks storage, deduped by the deterministic `research-<id>` message
  // id, and gated on `restored` so it appends after the restore, never racing
  // it. Display-only: not added to model history.
  useEffect(() => {
    if (!restored) return
    const done = researchTasks
      .filter(
        (t) =>
          t.conversationId === conversationId &&
          ((t.status === 'done' && t.report) || (t.status === 'error' && t.error)),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
    if (done.length === 0) return
    setMessages((prev) => {
      const have = new Set(prev.map((m) => m.id))
      const add = done
        .filter((t) => !have.has(`research-${t.id}`))
        .map((t) => ({
          id: `research-${t.id}`,
          role: 'assistant' as const,
          parts: t.report ? [{ type: 'text' as const, text: t.report }] : [],
          sources: t.sources,
          research: { question: t.question, error: t.error, verification: t.verification },
        }))
      return add.length ? [...prev, ...add] : prev
    })
  }, [restored, researchTasks, conversationId])

  // When the task whose live sheet is open finishes, collapse the sheet back to
  // the chat (its report has just dropped into the transcript above).
  useEffect(() => {
    if (!openSheetTaskId) return
    const t = researchTasks.find((r) => r.id === openSheetTaskId)
    if (t && t.status !== 'running') setOpenSheetTaskId(null)
  }, [researchTasks, openSheetTaskId])

  // A research row clicked in the Library navigates here (App has switched this
  // chat to the research's conversation) and hands over the task id to reveal.
  // A running task opens its live sheet; a finished one scrolls to its report
  // card — but only after that card has been injected into `messages` by the
  // effect above, so we wait for the DOM node before scrolling. Reuses
  // openDockTask (hoisted below), then clears the pending id so it fires once.
  useEffect(() => {
    if (!pendingResearchId) return
    const t = researchTasks.find((r) => r.id === pendingResearchId)
    if (!t) return // task map not loaded yet; re-runs when researchTasks arrives
    const hasCard = (t.status === 'done' && t.report) || (t.status === 'error' && t.error)
    // A card-bearing task must wait for its node so the scroll lands; a running
    // task (opens the sheet) or a cancelled one (no card) resolves immediately.
    if (hasCard && !document.getElementById(`research-${t.id}`)) return
    openDockTask(t)
    onPendingResearchHandled?.()
  }, [pendingResearchId, researchTasks, messages, onPendingResearchHandled])

  // Persist after each finished turn (not on restore or mid-stream), then let
  // App refresh its history list.
  useEffect(() => {
    if (turnSeq === 0) return
    void saveConversation({ id: conversationId, messages, history: historyRef.current }).then(
      onConversationsChanged,
    )
    // Persist is driven solely by turnSeq; messages is read fresh from the
    // render that bumped it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnSeq])

  // Mirror the latest transcript into a ref so the async, fire-and-forget math
  // repair can read final bubble text without racing React state.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Close each composer popover on outside-click or Esc; only listens while open.
  useDismissOnOutside(toolsOpen, toolsMenuRef, () => setToolsOpen(false))
  useDismissOnOutside(moreOpen, moreMenuRef, () => setMoreOpen(false))

  // Passive context pill (Dia-style): shows which tab the agent would see if
  // granted access. Purely informational — access still goes through tools.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!cancelled && tab && tab.id !== undefined) {
        setCurrentTab({
          tabId: tab.id,
          title: tab.title ?? '(untitled)',
          url: tab.url ?? '',
          favIconUrl: tab.favIconUrl,
        })
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

  // Research task cards: load persisted tasks on mount (so a task that
  // finished while the panel was closed still shows), then refresh from
  // storage whenever the persisted 'researchTasks' map changes. Refreshing
  // off storage.onChanged (not chrome.runtime.onMessage) avoids a race where
  // the panel's own message listener fires before the SW has finished
  // persisting the same broadcast.
  useEffect(() => {
    let cancelled = false
    const load = () => listTasks().then((t) => { if (!cancelled) setResearchTasks(t) })
    void load()
    const onChanged = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.researchTasks) void load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      cancelled = true
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  // Drive dock-bar expiry: while any terminal task is still within its linger
  // window, tick `now` once a second so the derived dock list re-filters and
  // drops the bar when it crosses DOCK_LINGER_MS. Depending on `now` re-runs
  // this each tick, which lets it self-stop (clear the interval) once the last
  // lingering task ages out — no idle timer when nothing is finishing.
  useEffect(() => {
    const lingering = researchTasks.some(
      (t) => t.status !== 'running' && now - t.updatedAt < DOCK_LINGER_MS,
    )
    if (!lingering) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [researchTasks, now])

  // @all attaches every open tab; it's only honored when the user has granted
  // all-tabs visibility. The composer previews each attached page as a pill.
  const allTabsActive = settings.tabAccess === 'all-tabs' && ALL_TOKEN_RE.test(input)

  // While @all is active, resolve the open tabs into `allTabs` (and keep them
  // fresh as tabs open/close/navigate) so the pills reflect what will be sent.
  useEffect(() => {
    if (!allTabsActive) {
      setAllTabs([])
      return
    }
    let cancelled = false
    const refresh = async () => {
      const tabs = await listOpenTabs()
      if (!cancelled) setAllTabs(tabs)
    }
    void refresh()
    const onChange = () => void refresh()
    chrome.tabs.onCreated.addListener(onChange)
    chrome.tabs.onRemoved.addListener(onChange)
    chrome.tabs.onUpdated.addListener(onChange)
    return () => {
      cancelled = true
      chrome.tabs.onCreated.removeListener(onChange)
      chrome.tabs.onRemoved.removeListener(onChange)
      chrome.tabs.onUpdated.removeListener(onChange)
    }
  }, [allTabsActive])

  // Watch the active tab for a text selection and surface it as removable
  // context. Reading requires injecting into the page, so we only poll while
  // the panel is visible and refresh eagerly when the user returns to it.
  useEffect(() => {
    let cancelled = false
    const readSelection = async () => {
      if (document.visibilityState !== 'visible') return
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (cancelled || !tab || tab.id === undefined) return
      const tabId = tab.id
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() ?? '',
        })
        const text = (res?.result ?? '').trim()
        if (cancelled) return
        setSelection((prev) =>
          text
            ? prev?.text === text && prev.tabId === tabId
              ? prev
              : { text, tabId }
            : prev === null
              ? prev
              : null,
        )
        // Once the highlight is gone, forget what was dismissed so re-selecting
        // (even the same text) offers it again.
        if (!text) setDismissedSelection('')
      } catch {
        // chrome:// pages, the Web Store, and PDFs cannot be scripted.
        if (!cancelled) {
          setSelection((prev) => (prev === null ? prev : null))
          setDismissedSelection('')
        }
      }
    }
    void readSelection()
    const interval = setInterval(() => void readSelection(), 1000)
    const onFocus = () => void readSelection()
    const onActivated = () => void readSelection()
    window.addEventListener('focus', onFocus)
    chrome.tabs.onActivated.addListener(onActivated)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      chrome.tabs.onActivated.removeListener(onActivated)
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, approval])

  // Tear down any open session: clear the ref, hide the session card, and
  // strip the on-page index stamps. Shared by endSession and by the start of
  // requestSession, which must close out a stale session before opening a
  // new one (otherwise the old tab keeps its data-agent-idx stamps).
  function teardownSession() {
    const s = pageSessionRef.current
    pageSessionRef.current = null
    setSessionPlan(null)
    if (s) {
      void clearIndex(s.tabId)
      void unmountPresence(s.tabId)
    }
  }

  // Real page-control gate: RequestPageControl suspends on a session card
  // (reusing the approval-card machinery, branched to the session variant via
  // sessionPlan); ControlPage reads/mutates the ref-backed session directly.
  const pageControl: PageControlGate = {
    requestSession: ({ plan, host, origin, tabId }) =>
      new Promise<boolean>((resolve) => {
        // Close out any previously-open session before offering a new one.
        if (pageSessionRef.current) teardownSession()
        // Reuse the approval card machinery, but branch the UI to a session card.
        setSessionPlan({ plan, host })
        approvalRef.current = {
          toolName: 'RequestPageControl',
          summary: `Control ${host}`,
          reason: plan,
          resolve: (approved: boolean) => {
            setSessionPlan(null)
            if (approved) {
              pageSessionRef.current = {
                tabId,
                origin,
                plan,
                active: true,
              }
            }
            resolve(approved)
          },
        }
        setApproval(approvalRef.current)
      }),
    session: () => pageSessionRef.current,
    endSession: teardownSession,
  }

  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    // Point-of-no-return steps (form submits, cross-origin nav, passwords) are
    // the safety backstop: they always show a card, ignoring every auto-approve
    // path — including an "Always" policy — so they confirm every single time.
    if (!request.once) {
      if (toolPolicy(settings, request.toolName) === 'always') return Promise.resolve(true)
      if (sessionAllowed.current.has(request.toolName)) return Promise.resolve(true)
      if (turnAllowed.current.has(request.toolName)) return Promise.resolve(true)
    }
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

  // Cancel a running research task. The SW persists status:'cancelled'; the
  // storage.onChanged listener above then refreshes this card.
  function cancelResearchTask(taskId: string) {
    chrome.runtime.sendMessage({ type: 'research.cancel', taskId } satisfies ResearchMsg)
  }

  // Tapping a dock bar: a running task opens its live-workflow sheet; a finished
  // one closes any sheet and scrolls the chat to the report card that dropped in
  // (a cancelled task has no card, so this is a harmless no-op for it).
  function openDockTask(t: ResearchTask) {
    if (t.status === 'running') {
      setOpenSheetTaskId(t.id)
      return
    }
    setOpenSheetTaskId(null)
    document
      .getElementById(`research-${t.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

  // Quick-menu tool switch. Off → 'never' (hidden from the agent). On → delete the
  // override so the tool reverts to its catalog default (ask, or always for the
  // skills tools), which preserves an Always tool instead of downgrading it to ask.
  function toggleTool(name: string, on: boolean) {
    const next = { ...(settings.toolPolicies ?? {}) }
    if (on) delete next[name]
    else next[name] = 'never'
    onUpdateSettings({ ...settings, toolPolicies: next })
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
    const candidates: MentionCandidate[] = []
    // Offer the specials whenever the query is a prefix of their word (incl. empty).
    if ('memory'.startsWith(q)) candidates.push({ kind: 'memory' })
    if (settings.tabAccess === 'all-tabs' && 'all'.startsWith(q)) candidates.push({ kind: 'all' })
    candidates.push(...filtered.slice(0, 8).map((t): MentionCandidate => ({ kind: 'tab', tab: t })))
    setMentionCandidates(candidates)
    setMentionIndex(0)
  }

  async function refreshSlashCandidates(s: { query: string }) {
    const all = await listSkills().catch(() => [])
    const q = s.query.trim().toLowerCase()
    const matched = all
      .filter((sk) => sk.userInvocable && sk.enabled !== false)
      .filter((sk) => !q || sk.name.includes(q) || sk.description.toLowerCase().includes(q))
      .slice(0, 8)
      .map((sk): SlashCandidate => ({ kind: 'skill', name: sk.name, description: sk.description }))
    setSlashCandidates([...matched, { kind: 'browse' }])
    setSlashIndex(0)
  }

  function selectSlash(c: SlashCandidate) {
    if (c.kind === 'browse') {
      setSlashQuery(null)
      onOpenSkills()
      return
    }
    // Replace the leading "/query" token with "/name ", keeping any arguments.
    const rest = input.replace(/^\/[a-z0-9-]*/, '').replace(/^\s+/, '')
    const next = `/${c.name} ${rest}`
    setInput(next)
    setSlashQuery(null)
    const pos = c.name.length + 2
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  function handleInputChange(value: string, caret: number) {
    setInput(value)
    const m = detectMention(value, caret)
    setMentionQuery(m)
    if (m) void refreshMentionCandidates(m)
    const s = detectSlash(value, caret)
    setSlashQuery(s)
    if (s) void refreshSlashCandidates(s)
  }

  function selectMention(candidate: MentionCandidate) {
    if (!mentionQuery) return
    const token =
      candidate.kind === 'memory'
        ? MEMORY_TOKEN
        : candidate.kind === 'all'
          ? ALL_TOKEN
          : `@${candidate.tab.title.trim().slice(0, 48)}`
    const caret = inputRef.current?.selectionStart ?? input.length
    const next = `${input.slice(0, mentionQuery.start)}${token} ${input.slice(caret)}`
    setInput(next)
    if (candidate.kind === 'tab') {
      const tab = candidate.tab
      setMentions((arr) => [
        ...arr.filter((x) => x.tabId !== tab.tabId),
        { tabId: tab.tabId, title: tab.title, url: tab.url, token },
      ])
    }
    setMentionQuery(null)
    const pos = mentionQuery.start + token.length + 1
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  // Detach an @mentioned tab from its composer pill: drop it from `mentions` and
  // strip its token from the input so it no longer syncs on send.
  function removeMention(token: string) {
    setMentions((arr) => arr.filter((m) => m.token !== token))
    setInput((v) => stripToken(v, token))
  }

  async function send() {
    const text = input.trim()
    // A leading "/skill-name" token explicitly invokes that skill for this turn:
    // its full instructions are injected into the system prompt below.
    const slashMatch = text.match(/^\/([a-z0-9-]+)(?:\s|$)/)
    const invokedSkill = slashMatch ? await getSkill(slashMatch[1]) : null
    const activeSkill =
      invokedSkill && invokedSkill.userInvocable && invokedSkill.enabled !== false
        ? invokedSkill
        : null
    const images = attachments
    // Mentions only count if their token survived editing.
    const activeMentions = mentions.filter((m) => text.includes(m.token))
    // A surviving @memory token directs the agent to consult long-term memory.
    const useMemory = MEMORY_TOKEN_RE.test(text)
    // @all attaches every open tab (only honored in all-tabs visibility mode).
    const useAll = settings.tabAccess === 'all-tabs' && ALL_TOKEN_RE.test(text)
    const isFirstMessage = messages.length === 0
    // Attach the tab the user is on to the first message of a fresh chat.
    const includeCurrentTab = isFirstMessage && !tabDismissed && currentTab !== null
    // Later in a chat, a deictic reference ("what about this?", "summarize this
    // page") pulls in the tab the user is now viewing — but only when it isn't
    // already in context, i.e. after they switched to or navigated to a
    // different page since it was last shared.
    const currentTabKey = currentTab ? tabKey(currentTab.tabId, currentTab.url) : null
    const includeDeicticTab =
      !includeCurrentTab &&
      currentTab !== null &&
      currentTabKey !== null &&
      DEICTIC_RE.test(text) &&
      !sharedTabsRef.current.has(currentTabKey)
    // Highlighted text the user chose to share (consumed once sent).
    const activeSelection =
      selection && selection.text !== dismissedSelection ? selection.text : null
    if ((!text && images.length === 0) || streaming || !selected) return
    setInput('')
    setAttachments([])
    setMentions([])
    setMentionQuery(null)
    setSlashQuery(null)
    if (activeSelection) setDismissedSelection(activeSelection)
    setCaptureError(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    // Name the chat from its opening message — fired concurrently with the turn
    // and applied whenever it resolves, so the title fills in on its own.
    if (isFirstMessage && text && selected) {
      const titleModel = createModel(selected.provider, selected.modelId)
      void generateChatTitle(titleModel, text, conversationId)
        .then((t) => (t ? renameConversation(conversationId, t).then(onConversationsChanged) : undefined))
        .catch(() => {})
    }

    setMessages((m) => [
      ...m,
      { id: uid(), role: 'user', parts: [{ type: 'text', text }], images: images.map((i) => i.dataUrl) },
    ])

    // Sync shared tab contents into the model-facing message: any @mentioned
    // tabs, plus the current tab when auto-attached (first message) or pulled in
    // by a deictic reference, de-duplicated by id.
    const tabIds: number[] = []
    for (const m of activeMentions) if (!tabIds.includes(m.tabId)) tabIds.push(m.tabId)
    if ((includeCurrentTab || includeDeicticTab) && currentTab && !tabIds.includes(currentTab.tabId))
      tabIds.push(currentTab.tabId)
    let allTabsOmitted = 0
    if (useAll) {
      const open = await listOpenTabs()
      allTabsOmitted = Math.max(0, open.length - MAX_ALL_TABS)
      for (const t of open.slice(0, MAX_ALL_TABS)) if (!tabIds.includes(t.tabId)) tabIds.push(t.tabId)
    }

    let modelText = text
    let syncedTabs: TabContent[] = []
    if (tabIds.length > 0) {
      syncedTabs = await Promise.all(tabIds.map((id) => readTabContent(id)))
      // Remember which tabs are now in context (successful reads only), keyed by
      // id+url, so a later "this page" re-injects the current tab only once the
      // user has moved to a different page.
      syncedTabs.forEach((c, i) => {
        if (!c.error) sharedTabsRef.current.add(tabKey(tabIds[i], c.url))
      })
      const blocks = syncedTabs.map(
        (c) =>
          `<tab title=${JSON.stringify(c.title)} url=${JSON.stringify(c.url)}>\n${
            c.error ? `(could not read this tab: ${c.error})` : c.text
          }${c.truncated ? '\n[content truncated]' : ''}\n</tab>`,
      )
      const omit =
        allTabsOmitted > 0
          ? `\n\n[Note: ${allTabsOmitted} more open tab${allTabsOmitted > 1 ? 's were' : ' was'} omitted to keep this message manageable.]`
          : ''
      modelText = `${text}\n\n[Current content of the tab${syncedTabs.length > 1 ? 's' : ''} shared with you, synced at send time:]\n${blocks.join('\n\n')}${omit}`
    }
    if (activeSelection) {
      const snippet = activeSelection.slice(0, SELECTION_MAX)
      const more = activeSelection.length > SELECTION_MAX ? '\n…[selection truncated]' : ''
      modelText = `${modelText}\n\n[The user highlighted this text on the current page and shared it as context:]\n"""\n${snippet}${more}\n"""`
    }
    if (useMemory) {
      modelText = `${modelText}\n\n[The user invoked @memory — before answering, use the SearchMemory tool to recall relevant long-term memories (pick query terms from their message, or recall broadly if it is general) and ground your reply in what you find.]`
    }

    if (images.length > 0) {
      historyRef.current.push({
        role: 'user',
        content: [
          // v7: `file` part with an image mediaType replaces the deprecated
          // `{ type: 'image', image }` part (the data URL carries its own type).
          ...images.map((i) => ({ type: 'file' as const, mediaType: 'image', data: i.dataUrl })),
          ...(modelText ? [{ type: 'text' as const, text: modelText }] : []),
        ],
      })
    } else {
      historyRef.current.push({ role: 'user', content: modelText })
    }

    // Tabs attached to this turn become sources on the reply's favicon bar.
    // Pages the model reads via its tools are merged in later, at render time.
    const attachedSources: MessageSource[] = syncedTabs
      .filter((c) => !c.error && isHttpUrl(c.url))
      .map((c) => ({ title: c.title, url: c.url }))
    // Build the journal line for this user turn; the assistant side is appended
    // when the whole continuation chain finishes. Tool calls are noted by name.
    const notes: string[] = []
    if (images.length > 0)
      notes.push(`[attached ${images.length} screenshot${images.length > 1 ? 's' : ''}]`)
    if (syncedTabs.length > 0)
      notes.push(`[synced tabs: ${syncedTabs.map((t) => t.title).join(', ')}]`)
    if (useMemory) notes.push('[asked to recall from memory]')
    if (activeSkill) notes.push(`[invoked skill: ${activeSkill.name}]`)
    if (useAll) notes.push('[shared all open tabs]')
    if (activeSelection) notes.push('[shared a page selection]')
    const journalUserText = [text, ...notes].filter(Boolean).join('\n')

    // @memory is the user's consent to recall, so skip the SearchMemory card for
    // this turn only (it reads local memory — no page or network access).
    turnAllowed.current = useMemory ? new Set(['SearchMemory']) : new Set()
    autoContinuesRef.current = 0
    setContinuation(null)
    await runTurnChain({
      startedAt: Date.now(),
      attachedSources,
      activeSkill: activeSkill ? { name: activeSkill.name, body: activeSkill.body } : null,
      journalUserText,
      droppableTail: true,
    })
  }

  /**
   * Run one logical turn as a continuation *chain*. While the model checkpoints
   * or hits its step budget (see runAgentTurn's TurnStopReason), auto-continue up
   * to MAX_AUTO_CONTINUES seamlessly with a fresh budget each cycle, then surface
   * the Continue card. Teardown (page-control session + on-page presence) lives in
   * this outer finally, so the session and overlay SURVIVE auto-continues and are
   * torn down only when the whole chain ends — completion, abort, error, or the
   * ask-boundary. Point-of-no-return page actions still confirm individually
   * inside each cycle, so auto-continue never bypasses a risky-action gate.
   */
  async function runTurnChain(ctx: {
    startedAt: number
    attachedSources: MessageSource[]
    activeSkill: { name: string; body: string } | null
    journalUserText: string
    /** True when the caller (send) left a trailing user message a total failure
     *  should drop; false for continueTask (history ends on the checkpoint). */
    droppableTail: boolean
  }) {
    if (!selected) return
    const model = selected
    const controller = new AbortController()
    abortRef.current = controller
    setStreaming(true)
    setTurnStartedAt(ctx.startedAt)
    // Observability: one Langfuse trace per continuation chain, grouped into the
    // conversation's session. Each cycle's model steps become generations and its
    // tool calls become spans (wired via runAgentTurn + createAgentTools). No-op
    // when the beta toggle is off.
    const observer = getObserver(observabilityConfig(settings))
    const trace = observer.enabled
      ? observer.startTrace({
          name: ctx.journalUserText.split('\n')[0].slice(0, 80) || 'chat turn',
          sessionId: conversationId,
          input: ctx.journalUserText,
          tags: ['chat'],
          metadata: {
            sources: ctx.attachedSources.length || undefined,
            skill: ctx.activeSkill?.name,
          },
        })
      : undefined

    // System prompt, built once for the chain. Recalled memories are fresh as of
    // the chain start so a mid-conversation SaveMemory shows on the next turn.
    const memoryContext = await getMemoryContext().catch(() => '')
    const granted = await grantedCapabilities().catch(() => new Set<BrowsingCapability>())
    const accessNote =
      settings.tabAccess === 'active-tab'
        ? '\n\nThe user has restricted your tab visibility to the tab they are currently on; ReadTabs is unavailable.'
        : ''
    const skillMetas = await listSkillMetas({ modelInvocableOnly: true }).catch(() => [])
    const skillsCatalog =
      skillMetas.length > 0
        ? `\n\n## Skills\nThese skills are available. When a request matches one, call ReadSkill with its name to load its full instructions before proceeding.\n${skillMetas
            .map((s) => `- ${s.name}: ${s.description}`)
            .join('\n')}`
        : ''
    const activeSkills = ctx.activeSkill
      ? `\n\n## Active skill: ${ctx.activeSkill.name}\nThe user invoked this skill. Follow these instructions for this task:\n\n${ctx.activeSkill.body}`
      : ''
    const system = `${settings.systemPrompt}${TOOL_DISCLOSURE_NOTE}${accessNote}${browsingInsightsNote(granted)}${MATH_FORMATTING_NOTE}${memoryContext ? `\n\n${memoryContext}` : ''}${skillsCatalog}${activeSkills}`

    // Progressive disclosure: the tools the model may call beyond the always-on
    // core (ToolSearch, GetTool, ReadPage). Built once for the chain and shared
    // across auto-continue cycles, so tools the model loads via GetTool stay
    // available. Seeded from context to skip a discovery round-trip: any
    // pre-authorized tool (e.g. @memory → SearchMemory, via turnAllowed) and, if
    // a page-control session is already open, the control cluster.
    const activeNames = new Set<string>(turnAllowed.current)
    const openSession = pageControl.session()
    if (openSession && openSession.active) {
      activeNames.add('RequestPageControl')
      activeNames.add('ControlPage')
      activeNames.add('AutofillForm')
      activeNames.add('Screenshot')
    }

    // Does this model actually read images? Screenshot is useless (worse than
    // useless — it loops) against a text-only endpoint, so it is removed from the
    // toolset entirely when the answer is no. Probed once per provider+model and
    // cached in chrome.storage.local, so this is free after the first turn. A
    // failed probe means "assume blind": better to withhold a camera than to hand
    // one to a model that cannot use it.
    const visionCapable = await ensureVisionCapability(model.provider, model.modelId).catch(() => false)

    // Patch one assistant bubble: its parts are `base` (prior cycles, in merge
    // mode) followed by this cycle's streamed parts.
    const patch = (id: string, base: UIPart[]) => (parts: UIPart[]) =>
      setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, parts: [...base, ...parts] } : msg)))

    const assistantTexts: string[] = []
    const assistantIds = new Set<string>()
    let pushedAny = false
    let assistantId = uid()
    let mergedParts: UIPart[] = []
    setMessages((m) => [...m, { id: assistantId, role: 'assistant', parts: [], sources: ctx.attachedSources }])
    assistantIds.add(assistantId)

    try {
      while (true) {
        // Fresh per cycle: the queue is drained during the turn, and the tools
        // must share the same instance so what they push, prepareStep injects.
        const imageQueue: QueuedImage[] = []
        const base = MERGE_AUTO_CONTINUES ? mergedParts : []
        const result = await runAgentTurn({
          model: createModel(model.provider, model.modelId),
          system,
          history: [...historyRef.current],
          tools: createAgentTools(
            requestApproval,
            settings.tabAccess,
            granted,
            pageControl,
            model,
            visionCapable,
            imageQueue,
            (name) => toolPolicy(settings, name),
            conversationId,
            activeNames,
            trace,
          ),
          abortSignal: controller.signal,
          onUpdate: patch(assistantId, base),
          imageQueue,
          activeNames,
          trace,
        })
        patch(assistantId, base)(result.parts)
        historyRef.current.push(...result.responseMessages)
        pushedAny = true
        // Attribute this cycle's tokens to the bubble it streamed into. When
        // auto-continues merge into one bubble the cycles sum; when they don't,
        // each new bubble carries its own.
        if (result.usage) {
          const id = assistantId
          const cycleUsage = result.usage
          setMessages((m) =>
            m.map((msg) => (msg.id === id ? { ...msg, usage: sumUsage(msg.usage, cycleUsage) } : msg)),
          )
        }
        if (MERGE_AUTO_CONTINUES) mergedParts = [...mergedParts, ...result.parts]
        assistantTexts.push(
          result.parts.map((p) => (p.type === 'text' ? p.text : `[used tool: ${p.toolName}]`)).join('\n'),
        )

        if (result.stop.reason === 'completed') break
        // 'checkpoint' | 'budget' — the task is not done. Auto-continue until the
        // ceiling, then hand off to the user via the Continue card.
        if (autoContinuesRef.current >= MAX_AUTO_CONTINUES) {
          setContinuation({ checkpoint: result.stop.checkpoint ?? null })
          break
        }
        autoContinuesRef.current += 1
        if (!MERGE_AUTO_CONTINUES) {
          assistantId = uid()
          const cycle = autoContinuesRef.current
          setMessages((m) => [...m, { id: assistantId, role: 'assistant', parts: [], autoContinue: cycle }])
          assistantIds.add(assistantId)
        }
      }

      // Journal the whole exchange once (success path only — not on abort/error).
      void appendToEpisode(episodeIdRef.current, [
        { role: 'user', text: ctx.journalUserText, at: ctx.startedAt },
        { role: 'assistant', text: assistantTexts.join('\n').trim(), at: Date.now() },
      ]).catch(() => {})
      trace?.end({ output: assistantTexts.join('\n').trim() })
      // Silent LaTeX self-correction: after the turn settles, repair any math the
      // deterministic render layer could not compile. Fire-and-forget.
      void repairAssistantMath([...assistantIds], model)
    } catch (err) {
      if (controller.signal.aborted) {
        // Keep completed cycles; only drop a dangling trailing user message (a
        // send() turn that produced nothing) so the next request is consistent.
        if (!pushedAny && ctx.droppableTail) historyRef.current.pop()
        trace?.end({ metadata: { aborted: true } })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, parts: [...msg.parts, { type: 'text', text: `**Error:** ${message}` }] }
              : msg,
          ),
        )
        if (!pushedAny && ctx.droppableTail) historyRef.current.pop()
        trace?.end({ metadata: { error: message } })
      }
    } finally {
      settleApproval(false)
      turnAllowed.current = new Set()
      pageControl.endSession()
      // Tear down ambient presence on any tab the chain touched (navigate/inspect
      // mount the frame outside a session, so endSession alone won't clear them).
      void unmountAllPresence()
      abortRef.current = null
      setStreaming(false)
      setTurnStartedAt(null)
      setTurnSeq((n) => n + 1)
      // Observability: deliver this turn's buffered events. Best-effort.
      void observer.flush()
    }
  }

  // For each assistant bubble this turn produced, validate its text and, if any
  // math is uncompilable, silently re-ask the model to fix just those fragments
  // and splice the result in. Never throws; degrades to the deterministic
  // best-effort (inert code) on any failure.
  async function repairAssistantMath(ids: string[], model: { provider: ProviderConfig; modelId: string }) {
    const complete: Complete = (prompt) =>
      generateText({
        model: createModel(model.provider, model.modelId),
        prompt,
        abortSignal: AbortSignal.timeout(20_000),
      }).then((r) => r.text)

    for (const id of ids) {
      const msg = messagesRef.current.find((m) => m.id === id)
      if (!msg) continue
      // A bubble can hold several text parts — a tool call interleaved between
      // prose splits the reply, and merged auto-continues append more — so repair
      // every text part with uncompilable math, not just the first.
      const targets = msg.parts.flatMap((p, i) =>
        p.type === 'text' && validateMath(p.text).invalid.length > 0 ? [{ i, text: p.text }] : [],
      )
      if (targets.length === 0) continue

      setMessages((m) => m.map((x) => (x.id === id ? { ...x, fixingMath: true } : x)))
      const fixes = new Map<number, string>()
      for (const t of targets) {
        let fixed = t.text
        try {
          fixed = await repairMessageText(t.text, complete)
        } catch {
          fixed = t.text
        }
        if (fixed !== t.text) fixes.set(t.i, fixed)
      }
      setMessages((m) =>
        m.map((x) => {
          if (x.id !== id) return x
          const parts =
            fixes.size === 0
              ? x.parts
              : x.parts.map((p, i) => (fixes.has(i) && p.type === 'text' ? { ...p, text: fixes.get(i) as string } : p))
          return { ...x, parts, fixingMath: false }
        }),
      )
    }
  }

  // Resume a checkpointed task from the Continue card. The model's hand-off is
  // already in history, so a fresh chain (new step budget + auto-continue quota)
  // picks up where it left off — no new user message needed.
  async function continueTask() {
    if (streaming) return
    setContinuation(null)
    autoContinuesRef.current = 0
    turnAllowed.current = new Set()
    await runTurnChain({
      startedAt: Date.now(),
      attachedSources: [],
      activeSkill: null,
      journalUserText: '[continued the task]',
      droppableTail: false,
    })
  }

  function selectModel(value: string) {
    const [providerId, ...rest] = value.split('::')
    onUpdateSettings({ ...settings, selected: { providerId, modelId: rest.join('::') } })
  }

  const modelOptions = settings.providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}::${m}`, label: m, provider: p.name })),
  )

  // The pages attached to the next message, rendered as a pill row in the
  // composer: the first MAX_VISIBLE_CONTEXT with favicon + host, the rest
  // collapsed into a "+N" pill whose hover reveals the remainder. @all resolves
  // to every open web page (a live preview of what will be sent; detach by
  // deleting the @all token). Otherwise it's the current tab (auto-attached to a
  // fresh chat, or offered as ambient context later) plus each surviving
  // @mention, both removable via a hover ×.
  const contextTabs: ContextTab[] = []
  if (allTabsActive) {
    const seen = new Set<number>()
    for (const t of allTabs) {
      if (!isHttpUrl(t.url) || seen.has(t.tabId)) continue
      seen.add(t.tabId)
      contextTabs.push({ key: `all:${t.tabId}`, title: t.title, url: t.url, hint: t.title })
      if (contextTabs.length >= MAX_ALL_TABS) break
    }
  } else {
    const shownMentions = mentions.filter((m) => input.includes(m.token))
    const mentionedIds = new Set(shownMentions.map((m) => m.tabId))
    if (currentTab && !mentionedIds.has(currentTab.tabId)) {
      const attachedFirst = messages.length === 0 && !tabDismissed
      contextTabs.push({
        key: `current:${currentTab.tabId}`,
        title: currentTab.title,
        url: currentTab.url,
        favIconUrl: currentTab.favIconUrl,
        hint: attachedFirst
          ? `This page is attached to your first message — ${currentTab.title}`
          : `The agent can ask to view this tab — ${currentTab.title}`,
        onRemove: attachedFirst ? () => setTabDismissed(true) : undefined,
      })
    }
    for (const m of shownMentions) {
      contextTabs.push({
        key: `mention:${m.tabId}:${m.token}`,
        title: m.title,
        url: m.url,
        hint: `Attached to this message — ${m.title}`,
        onRemove: () => removeMention(m.token),
      })
    }
  }

  // Only this conversation's research surfaces here: each task is tagged with
  // the chat it was launched from, so other chats — and brand-new ones — stay
  // clean. Legacy tasks predating tagging have no conversationId and match none.
  const myTasks = researchTasks.filter((t) => t.conversationId === conversationId)
  // Tasks shown in the composer dock: everything still running, plus terminal
  // tasks still inside their linger window. Newest first (listTasks order).
  const dockTasks = myTasks.filter(
    (t) => t.status === 'running' || now - t.updatedAt < DOCK_LINGER_MS,
  )
  // Finished reports are injected into `messages` as research-report cards (see
  // the injection effect), so there's no separate overlay list here.
  const openSheetTask = researchTasks.find((t) => t.id === openSheetTaskId) ?? null

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">How can I help?</div>
            <div className="empty-hint">
              The tab you're on is attached to your first message. @mention another tab to share
              it, type @memory to have me draw on what I remember, type / to run one of your
              skills, or snip a screenshot with the camera.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <Fragment key={msg.id}>
            {msg.autoContinue != null && (
              <div className="auto-continue-divider">
                <span>↻ Continued automatically</span>
              </div>
            )}
            <MessageView
              message={msg}
              streaming={streaming && i === messages.length - 1}
              turnStartedAt={turnStartedAt}
            />
          </Fragment>
        ))}
        {approval && (
          <ApprovalCard
            approval={approval}
            sessionPlan={sessionPlan}
            onDeny={() => settleApproval(false)}
            onAllow={() => settleApproval(true)}
            onAllowSession={() => settleApproval(true, true)}
          />
        )}
        {continuation && !streaming && (
          <ContinuationCard
            checkpoint={continuation.checkpoint}
            onContinue={() => void continueTask()}
            onDismiss={() => setContinuation(null)}
          />
        )}
      </div>

      <div className="composer-area">
        <ContextPills tabs={contextTabs} />
        {selection && selection.text !== dismissedSelection && (
          <div className="selection-chip" title="Highlighted text shared as context">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 2.5h6M3 6h6M3 9.5h4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            <span className="selection-text">{selection.text}</span>
            <button
              className="context-remove"
              title="Don't share this selection"
              onClick={() => setDismissedSelection(selection.text)}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path
                  d="M1.5 1.5l5 5M6.5 1.5l-5 5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        )}
        {captureError && <div className="capture-error">{captureError}</div>}
        {slashQuery && slashCandidates.length > 0 && (
          <div className="mention-popover">
            {slashCandidates.map((c, i) => (
              <button
                key={c.kind === 'skill' ? c.name : 'browse'}
                className={`mention-item ${i === slashIndex ? 'active' : ''} ${c.kind === 'skill' ? 'skill' : 'browse'}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectSlash(c)
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                {c.kind === 'skill' ? (
                  <>
                    <span className="mention-title">/{c.name}</span>
                    <span className="mention-url">{c.description}</span>
                  </>
                ) : (
                  <>
                    <span className="mention-title">Browse skills…</span>
                    <span className="mention-url">Open the Skills Library</span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        {mentionQuery && mentionCandidates.length > 0 && (
          <div className="mention-popover">
            {mentionCandidates.map((c, i) => (
              <button
                key={c.kind === 'tab' ? c.tab.tabId : c.kind}
                className={`mention-item ${i === mentionIndex ? 'active' : ''} ${
                  c.kind !== 'tab' ? c.kind : ''
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(c)
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                {c.kind === 'memory' ? (
                  <>
                    <span className="mention-title">Memory</span>
                    <span className="mention-url">Have me recall from long-term memory</span>
                  </>
                ) : c.kind === 'all' ? (
                  <>
                    <span className="mention-title">All tabs</span>
                    <span className="mention-url">Attach every open tab as context</span>
                  </>
                ) : (
                  <>
                    <span className="mention-title">{c.tab.title}</span>
                    <span className="mention-url">{c.tab.url}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <ResearchDock tasks={dockTasks} onOpen={openDockTask} />
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
              if (slashQuery && slashCandidates.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setSlashIndex((i) => (i + delta + slashCandidates.length) % slashCandidates.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  selectSlash(slashCandidates[slashIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashQuery(null)
                  return
                }
              }
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
            onBlur={() => setTimeout(() => {
              setMentionQuery(null)
              setSlashQuery(null)
            }, 150)}
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
              {/* Wide panel: tools and screenshot as their own buttons. Below the
                  breakpoint these two are hidden and the "…" menu below takes over
                  (see .composer-btns in styles.css) — same actions, one control. */}
              <div className="tools-menu-wrap" ref={toolsMenuRef}>
                <button
                  className="tools-btn"
                  title="Tools & permissions"
                  aria-haspopup="menu"
                  aria-expanded={toolsOpen}
                  onClick={() => setToolsOpen((o) => !o)}
                >
                  <ToolsIcon />
                </button>
                {toolsOpen && (
                  <div className="tools-popover" role="dialog" aria-label="Tools">
                    <div className="tools-popover-head">Tools</div>
                    <ToolsMenuBody
                      settings={settings}
                      toggleTool={toggleTool}
                      onOpenFull={() => {
                        setToolsOpen(false)
                        onOpenSettings()
                      }}
                    />
                  </div>
                )}
              </div>
              <button
                className="cam-btn"
                title="Screenshot part of the page"
                disabled={!selected || capturing}
                onClick={() => void capture()}
              >
                <CameraIcon />
              </button>

              {/* Narrow panel: both of the above collapse into this one menu. */}
              <div className="more-menu-wrap" ref={moreMenuRef}>
                <button
                  className="more-btn"
                  title="Tools & screenshot"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                  </svg>
                </button>
                {moreOpen && (
                  <div className="tools-popover" role="dialog" aria-label="Tools & screenshot">
                    <button
                      className="more-item"
                      disabled={!selected || capturing}
                      onClick={() => {
                        setMoreOpen(false)
                        void capture()
                      }}
                    >
                      <CameraIcon />
                      Screenshot part of the page
                    </button>
                    <div className="tools-popover-head">Tools</div>
                    <ToolsMenuBody
                      settings={settings}
                      toggleTool={toggleTool}
                      onOpenFull={() => {
                        setMoreOpen(false)
                        onOpenSettings()
                      }}
                    />
                  </div>
                )}
              </div>

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
      {openSheetTask && (
        <ResearchSheet
          task={openSheetTask}
          onClose={() => setOpenSheetTaskId(null)}
          onStop={() => cancelResearchTask(openSheetTask.id)}
        />
      )}
    </div>
  )
}

// Whimsical waiting-state words, two registers blended (dry-witty + gen-z) so
// the indicator reads differently turn to turn. Random-per-mount starting word;
// index is `% length`, so ordering doesn't matter.
const THINKING_WORDS = [
  'Thinking', 'Pondering', 'Percolating', 'Noodling', 'Cerebrating',
  'Ruminating', 'Marinating', 'Conjuring', 'Mulling', 'Puzzling', 'Brewing',
  'Simmering', 'Wrangling', 'Untangling', 'Musing', 'Cogitating', 'Scheming',
  'Reticulating splines', 'Computing', 'Contemplating', 'Incubating',
  'Concocting', 'Hatching', 'Churning', 'Crunching', 'Formulating',
  'Deliberating', 'Stewing', 'Tinkering', 'Whirring', 'Spitballing',
  'Ideating', 'Plotting', 'Daydreaming', 'Head-scratching',
  'Cooking', 'Locking in', 'Big braining', 'Galaxy braining', 'Manifesting',
  'Vibing', 'Sussing it out', 'Understanding the assignment', 'Lowkey grinding',
  'Deadass thinking', 'Cracked mode engaged', 'Cooking up something',
  'In my thinking era', 'Brain going brrr', 'Spinning up the neurons',
  'Doing the thing', 'Locking in fr', 'No thoughts just cooking',
  "Chef's kiss incoming", 'Working on the glow-up',
]

// Shown in the gap right after a tool result, while the model reads what came
// back and decides its next move.
const DIGESTING_WORDS = [
  'Reviewing', 'Digesting', 'Parsing', 'Absorbing', 'Interpreting',
  'Synthesizing', 'Processing', 'Distilling', 'Piecing it together',
  'Making sense of it', 'Cross-referencing', 'Sifting', 'Connecting the dots',
  'Untangling the results', 'Weighing it up', 'Sorting it out',
  'Reading the receipts', 'Peeping the results', 'Reading the room',
  'Doing the math', 'Vibe-checking the output', 'Catching up on the tea',
  'Fact-checking the vibes', 'Putting the pieces together fr',
  'Decoding the lore',
]

/**
 * Whimsical waiting-state indicator: three bouncing dots, a rotating word, and
 * a whole-turn elapsed timer. Rendered by MessageView while the turn is
 * streaming but nothing is visibly appearing. `startedAt` is the turn start
 * (ms) so the timer stays continuous across tool steps; `variant` picks the
 * word pool. A fresh random offset per mount makes successive gaps in one turn
 * read differently.
 */
function ThinkingIndicator({
  startedAt,
  variant,
}: {
  startedAt: number
  variant: 'thinking' | 'digesting'
}) {
  const [now, setNow] = useState(() => Date.now())
  const [baseOffset] = useState(() => Math.floor(Math.random() * 1000))

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const pool = variant === 'digesting' ? DIGESTING_WORDS : THINKING_WORDS
  // Rotate roughly every 3s; continuous elapsed keeps it moving across steps.
  const word = pool[(baseOffset + Math.floor(elapsed / 3)) % pool.length]

  return (
    <div className="thinking-indicator" role="status" aria-label="Assistant is working">
      <span className="thinking-dots" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
      <span aria-hidden="true">{word}…</span>
      {elapsed >= 1 && (
        <span className="thinking-elapsed" aria-hidden="true">
          {elapsed}s
        </span>
      )}
    </div>
  )
}

function MessageView({
  message,
  streaming,
  turnStartedAt,
}: {
  message: UIMessage
  streaming: boolean
  turnStartedAt: number | null
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  // A dropped-in background-research report renders as its own card.
  if (message.research) return <ResearchReportMessage message={message} />

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

  // Show the waiting indicator while the turn is live but nothing is visibly
  // streaming: before the first part (thinking), or in the gap right after a
  // tool result while the model decides its next move (digesting). The inline
  // `turnStartedAt != null` also narrows it to a number for the prop.
  const last = message.parts[message.parts.length - 1]
  const digesting = last?.type === 'tool' && last.state === 'done'

  return (
    <div className="msg-assistant">
      <div className="msg-assistant-body" ref={bodyRef}>
        {message.parts.map((part, i) =>
          part.type === 'text' ? (
            <AssistantText key={i} text={part.text} streaming={streaming} />
          ) : (
            <ToolPill key={part.toolCallId} part={part} />
          ),
        )}
        {streaming &&
          turnStartedAt != null &&
          (message.parts.length === 0 || digesting) && (
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
        <MessageToolbar message={message} targetRef={bodyRef} />
      )}
    </div>
  )
}

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

// Actions on a completed assistant message: the shared copy-as-image /
// copy-as-markdown group, plus the message's source favicons.
function MessageToolbar({
  message,
  targetRef,
}: {
  message: UIMessage
  targetRef: React.RefObject<HTMLDivElement>
}) {
  const markdown = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return (
    <div className="msg-toolbar">
      <CopyActions targetRef={targetRef} markdown={markdown} />
      <UsageLine usage={message.usage} />
      <SourceBar sources={deriveSources(message)} />
    </div>
  )
}

/**
 * Tokens used by one reply. Silent when the endpoint reported no usage — an
 * endpoint that omits token counts should show nothing rather than a misleading
 * "0". The in/out split is in the tooltip to keep the toolbar line short. Cost is
 * deliberately not shown here: Langfuse prices generations from its own model
 * table, so pricing lives there rather than being duplicated in the panel.
 */
function UsageLine({ usage }: { usage?: ModelUsage }) {
  if (!hasTokens(usage)) return null
  const inTok = usage?.inputTokens ?? 0
  const outTok = usage?.outputTokens ?? 0
  return (
    <span
      className="usage-line"
      title={`${inTok.toLocaleString('en-US')} in · ${outTok.toLocaleString('en-US')} out`}
    >
      {formatTokens(totalTokens(usage))} tok
    </span>
  )
}

// Copy-as-image (a PNG of `targetRef`'s rendered DOM) and copy-as-markdown
// (`markdown` text) buttons, each with a transient check/error state. Shared by
// assistant replies and research report cards so the clipboard + icon logic
// lives in one place. `targetRef` is HTMLElement so any body ref can pass here.
function CopyActions({
  targetRef,
  markdown,
}: {
  targetRef: React.RefObject<HTMLElement>
  markdown: string
}) {
  const [imageState, setImageState] = useState<'idle' | 'done' | 'error'>('idle')
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'error'>('idle')

  async function copyImage() {
    const el = targetRef.current
    if (!el) return
    try {
      await copyElementAsPng(el)
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
interface ContextTab {
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
function ContextPills({ tabs }: { tabs: ContextTab[] }) {
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

function controlActionLabel(input: any, output: any): string {
  if (output?.denied) return 'Action denied'
  const a = input?.action
  if (a === 'type') return `Typed into element ${input.index}`
  if (a === 'click') return `Clicked element ${input.index}`
  if (a === 'select') return `Selected an option`
  if (a === 'scroll') return input.direction === 'toElement' ? 'Scrolled to an element' : `Scrolled ${input.direction}`
  if (a === 'highlight') return 'Highlighted an element'
  if (a === 'navigate') return `Navigated the page`
  if (a === 'press') return `Pressed ${input.keys}`
  return 'Page action'
}

function ToolPill({ part }: { part: Extract<UIPart, { type: 'tool' }> }) {
  const output = part.output as any
  const denied = output && typeof output === 'object' && output.denied
  let label: string
  if (part.state === 'running') label = 'Waiting for permission…'
  else if (part.state === 'error') label = `${part.toolName} failed`
  else if (denied) label = 'Permission denied'
  else if (part.toolName === 'ReadPage') {
    const mode = (part.input as any)?.mode
    label = output?.error
      ? 'Could not read the page'
      : mode === 'elements'
        ? 'Read the page elements'
        : mode === 'dom'
          ? `Read current tab DOM · ${output?.title ?? ''}`
          : `Viewed current tab · ${output?.title ?? ''}`
  } else if (part.toolName === 'ReadTabs')
    label = output?.contents
      ? `Read ${output.contents.length} tab${output.contents.length > 1 ? 's' : ''}`
      : output?.doms
        ? `Read DOM of ${output.doms.length} tab${output.doms.length > 1 ? 's' : ''}`
        : `Listed ${output?.tabs?.length ?? 0} open tabs`
  else if (part.toolName === 'NavigateTab')
    label = output?.error
      ? 'Navigation failed'
      : output?.action === 'activate'
        ? `Switched to tab · ${output?.title ?? ''}`
        : output?.action === 'open'
          ? `Opened new tab · ${output?.title || output?.url || ''}`
          : `Navigated to · ${output?.title || output?.url || ''}`
  else if (part.toolName === 'SaveMemory') label = 'Saved a memory'
  else if (part.toolName === 'SearchMemory')
    label = `Recalled ${output?.memories?.length ?? 0} memor${(output?.memories?.length ?? 0) === 1 ? 'y' : 'ies'}`
  else if (part.toolName === 'ListAllSkills')
    label = `Listed ${output?.skills?.length ?? 0} skill${(output?.skills?.length ?? 0) === 1 ? '' : 's'}`
  else if (part.toolName === 'ReadSkill')
    label = output?.error ? 'Skill not found' : `Loaded skill · ${output?.name ?? ''}`
  else if (part.toolName === 'SaveSkill')
    label = output?.saved ? `Saved skill · ${output?.name ?? ''}` : 'Skill not saved'
  else if (part.toolName === 'QueryBrowserData')
    label = output?.error ? 'Browser data unavailable' : `Queried your ${(part.input as any)?.source ?? 'browser data'}`
  else if (part.toolName === 'RequestPageControl')
    label = output?.started ? 'Started controlling the page' : 'Asked to control the page'
  else if (part.toolName === 'ControlPage') label = controlActionLabel(part.input, output)
  else if (part.toolName === 'ExtractData')
    label = output?.error ? 'Could not extract data' : 'Extracted structured data'
  else if (part.toolName === 'StartResearch')
    label = output?.started ? 'Started background research' : 'Research not started'
  else if (part.toolName === 'AutofillForm')
    label = output?.error ? 'Autofill stopped' : `Filled ${output?.filled?.length ?? 0} form field${(output?.filled?.length ?? 0) === 1 ? '' : 's'}`
  else if (part.toolName === 'Screenshot')
    label = output?.error
      ? 'Could not take a screenshot'
      : `Took a screenshot · ${output?.label ?? 'the page'}`
  else if (part.toolName === 'Checkpoint') {
    const cp = part.input as Partial<Checkpoint> | undefined
    label = `Checkpointed progress — ${cp?.done?.length ?? 0} done, ${cp?.remaining?.length ?? 0} remaining`
  } else label = part.toolName

  // A screenshot is the one tool result that is worth seeing rather than reading,
  // so the image hangs below the pill instead of hiding inside it.
  const shotId: string | undefined =
    part.toolName === 'Screenshot' && part.state === 'done' && !denied ? output?.shotId : undefined

  return (
    <>
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
      {shotId && <ShotCard shotId={shotId} />}
    </>
  )
}

/**
 * The screenshot the agent took, shown to the user.
 *
 * Only the `shotId` lives in the transcript (an inline image there would also
 * ride in the model's history, costing tokens on every later step for a picture
 * it has already been shown properly). So the preview is read from IndexedDB on
 * mount — the thumbnail store, which is kilobytes, not the full-resolution one,
 * which for a stitched page is megabytes. The full image is fetched only if the
 * user actually clicks to download it.
 */
function ShotCard({ shotId }: { shotId: string }) {
  const [thumb, setThumb] = useState<ShotThumb | null>(null)
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

  const download = async () => {
    setBusy(true)
    try {
      const full = await getShot(shotId)
      if (full) await downloadImage(full.dataUrl)
      else setMissing(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="shot-card"
      onClick={() => void download()}
      disabled={busy}
      title={`Download screenshot — ${thumb.label}`}
      aria-label={`Download screenshot of ${thumb.label}`}
    >
      <img src={thumb.thumb} alt={`Screenshot of ${thumb.label}`} />
      <span className="shot-card-meta">
        <span className="shot-card-label">{thumb.label}</span>
        <span className="shot-card-dim">
          {thumb.width}×{thumb.height}
        </span>
      </span>
    </button>
  )
}

// A finished background-research task dropped into the chat at the end of the
// transcript (done → report, error → error text). Rendered with the same
// treatment as an assistant reply: an AssistantText body (image carousels,
// link cards, JSON, markdown) plus the shared copy-as-image / copy-as-markdown
// actions and a SourceBar. The `id` is the scroll target for its ✓ dock bar.
function ResearchReportMessage({ message }: { message: UIMessage }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Collapsed hides the body + toolbar, leaving just the titled header. Starts
  // expanded so a freshly-dropped report is readable; the header toggles it.
  const [collapsed, setCollapsed] = useState(false)
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
          <span className="research-report__title">{research.question}</span>
          <svg className="research-report__caret" width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        {!collapsed && (
          <div className="research-report__body">
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
function ResearchDock({
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
  return (
    <button className={`research-bar ${task.status}`} onClick={onOpen} title={task.question}>
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
function ResearchSheet({
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
        {task.status === 'running' && (
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

// Dock/sheet status glyph: a spinner while running, then ✓ / ✕ / ⊘ for
// done / error / cancelled.
function ResearchStatusIcon({ status }: { status: ResearchStatus }) {
  if (status === 'running') return <ResearchSpinner />
  return (
    <span className={`research-status research-status--${status}`}>
      {status === 'done' ? (
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

function ApprovalCard({
  approval,
  sessionPlan,
  onDeny,
  onAllow,
  onAllowSession,
}: {
  approval: PendingApproval
  sessionPlan?: { plan: string; host: string } | null
  onDeny: () => void
  onAllow: () => void
  onAllowSession: () => void
}) {
  const isSession = !!sessionPlan
  return (
    <div className={`approval-card ${isSession ? 'session' : ''}`}>
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
      <div className="approval-actions">
        <button className="btn ghost" onClick={onDeny}>
          Deny
        </button>
        {!isSession && !approval.once && (
          <button className="btn ghost" onClick={onAllowSession}>
            Allow this chat
          </button>
        )}
        <button className="btn primary" onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  )
}

// Shown after a long task auto-continues MAX_AUTO_CONTINUES times without
// finishing: surfaces the model's checkpoint (what's done, what's left, what to
// avoid, the next action) and a Continue button that resumes with a fresh budget.
function ContinuationCard({
  checkpoint,
  onContinue,
  onDismiss,
}: {
  checkpoint: Checkpoint | null
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
        <span>Task paused — step budget reached</span>
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
          The agent ran out of steps before finishing. Continue to give it a fresh budget.
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
