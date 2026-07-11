import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelMessage } from 'ai'
import Markdown from './Markdown'
import ImageCarousel from './ImageCarousel'
import { splitImageBlocks } from './imageBlocks'
import { runAgentTurn, type MessageSource, type UIMessage, type UIPart } from '../agent/agent'
import { captureRegion, type CapturedImage } from '../platform/capture'
import { copyElementAsPng } from '../platform/domImage'
import { getConversation, renameConversation, saveConversation } from '../data/conversations'
import { appendToEpisode, getMemoryContext } from '../data/memory'
import { createModel, generateChatTitle } from '../agent/provider'
import { getSelectedProvider, toolPolicy, type Settings } from '../data/settings'
import { getActiveTab, listOpenTabs, readTabContent, type TabContent, type TabSummary } from '../platform/tabs'
import { createAgentTools, type ApprovalRequest, type PageControlGate } from '../tools/tools'
import { MAX_SESSION_ACTIONS, type ControlSession } from '../tools/pageControl'
import { clearIndex } from '../platform/domIndex'
import { unmountPresence, unmountAllPresence } from '../platform/presence'
import { grantedCapabilities, type BrowsingCapability } from '../platform/permissions'
import { getSkill, listSkillMetas, listSkills } from '../data/skills'

// Which browsing-insight tool each capability exposes — used to tell the model,
// each turn, exactly which are usable so it never calls a disabled one.
const BROWSING_TOOL_NAMES: Record<BrowsingCapability, string> = {
  history: 'GetBrowsingHistory',
  bookmarks: 'GetBookmarks',
  topSites: 'GetTopSites',
  downloads: 'GetDownloads',
}

/** System-prompt suffix naming the browsing-insight tools available this turn. */
function browsingInsightsNote(granted: Set<BrowsingCapability>): string {
  const available = (Object.keys(BROWSING_TOOL_NAMES) as BrowsingCapability[])
    .filter((cap) => granted.has(cap))
    .map((cap) => BROWSING_TOOL_NAMES[cap])
  if (available.length === 0) {
    return '\n\nThe browsing-insight tools (history, bookmarks, top sites, downloads) are currently turned off; do not offer to use them.'
  }
  return `\n\nBrowsing-insight tools available this turn: ${available.join(', ')}.`
}

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
// granted all-tabs visibility, mirroring the ViewOpenedTabs gate.
const ALL_TOKEN = '@all'
const ALL_TOKEN_RE = /(^|\s)@all\b/i
const MAX_ALL_TABS = 25

// Cap how much highlighted text we forward as context.
const SELECTION_MAX = 4000

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

// ---- Source favicons -----------------------------------------------------
// The pages an assistant reply drew on, shown as a favicon avatar bar beside
// the copy actions. Only real web pages count: tabs attached to the user's
// turn (stored on the message) plus pages the model read via ViewCurrentTab /
// ViewOpenedTabs / GetActiveTabDOM / GetAllDOM (derived from the reply's tool parts).

const MAX_VISIBLE_SOURCES = 3

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

// Chrome's built-in, on-device favicon cache — keeps visited URLs local rather
// than shipping them to a third-party favicon service. Needs the "favicon"
// manifest permission.
function faviconUrl(pageUrl: string, size = 32): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'))
  u.searchParams.set('pageUrl', pageUrl)
  u.searchParams.set('size', String(size))
  return u.toString()
}

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
    if ((part.toolName === 'ViewCurrentTab' || part.toolName === 'GetActiveTabDOM') && !output.error) {
      collected.push({ title: output.title ?? '', url: output.url ?? '' })
    } else if (part.toolName === 'ViewOpenedTabs' && Array.isArray(output.contents)) {
      for (const c of output.contents) {
        if (c && !c.error) collected.push({ title: c.title ?? '', url: c.url ?? '' })
      }
    } else if (part.toolName === 'GetAllDOM' && Array.isArray(output.doms)) {
      for (const d of output.doms) {
        if (d && !d.error) collected.push({ title: d.title ?? '', url: d.url ?? '' })
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

export default function Chat({
  conversationId,
  settings,
  onUpdateSettings,
  onOpenSettings,
  onOpenSkills,
  onConversationsChanged,
}: {
  conversationId: string
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  onConversationsChanged: () => void
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

  // Bumped when a turn finishes, to trigger persistence of the transcript.
  const [turnSeq, setTurnSeq] = useState(0)

  const historyRef = useRef<ModelMessage[]>([])
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
    void getConversation(conversationId).then((c) => {
      if (cancelled || !c) return
      setMessages(c.messages)
      historyRef.current = c.history
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

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
                actionsUsed: 0,
                maxActions: MAX_SESSION_ACTIONS,
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
      void generateChatTitle(titleModel, text)
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
          ...images.map((i) => ({ type: 'image' as const, image: i.dataUrl })),
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
    const assistantId = uid()
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'assistant', parts: [], sources: attachedSources },
    ])
    const updateAssistant = (parts: UIPart[]) =>
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, parts } : msg)))

    const controller = new AbortController()
    abortRef.current = controller
    // @memory is the user's consent to recall, so skip the SearchMemory card
    // for this turn only (it reads local memory — no page or network access).
    turnAllowed.current = useMemory ? new Set(['SearchMemory']) : new Set()
    setStreaming(true)
    const turnStartedAt = Date.now()
    try {
      // Recalled memories are injected fresh each turn so mid-conversation
      // saves (SaveMemory) are visible on the very next turn.
      const memoryContext = await getMemoryContext().catch(() => '')
      const granted = await grantedCapabilities().catch(() => new Set<BrowsingCapability>())
      const accessNote =
        settings.tabAccess === 'active-tab'
          ? '\n\nThe user has restricted your tab visibility to the tab they are currently on; ViewOpenedTabs and GetAllDOM are unavailable.'
          : ''
      // Level-1 progressive disclosure: name+description of every model-invocable
      // skill, so the agent knows what it can load via ReadSkill.
      const skillMetas = await listSkillMetas({ modelInvocableOnly: true }).catch(() => [])
      const skillsCatalog =
        skillMetas.length > 0
          ? `\n\n## Skills\nThese skills are available. When a request matches one, call ReadSkill with its name to load its full instructions before proceeding.\n${skillMetas
              .map((s) => `- ${s.name}: ${s.description}`)
              .join('\n')}`
          : ''
      // Level-2: an explicitly invoked skill's body is injected directly (the
      // user asked for it, so no ReadSkill round-trip is needed).
      const activeSkills = activeSkill
        ? `\n\n## Active skill: ${activeSkill.name}\nThe user invoked this skill. Follow these instructions for this task:\n\n${activeSkill.body}`
        : ''
      // Marked screenshots from InspectPage/RequestPageControl land here; the
      // turn loop's prepareStep drains it and injects them as user image
      // messages, since the OpenAI-compatible adapter can't carry images in a
      // tool result. Fresh per turn — nothing should linger past it.
      const imageQueue: string[] = []
      const { parts, responseMessages } = await runAgentTurn({
        model: createModel(selected.provider, selected.modelId),
        system: `${settings.systemPrompt}${accessNote}${browsingInsightsNote(granted)}${memoryContext ? `\n\n${memoryContext}` : ''}${skillsCatalog}${activeSkills}`,
        history: [...historyRef.current],
        tools: createAgentTools(
          requestApproval,
          settings.tabAccess,
          granted,
          pageControl,
          selected,
          imageQueue,
          (name) => toolPolicy(settings, name),
        ),
        abortSignal: controller.signal,
        onUpdate: updateAssistant,
        imageQueue,
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
      if (useMemory) notes.push('[asked to recall from memory]')
      if (activeSkill) notes.push(`[invoked skill: ${activeSkill.name}]`)
      if (useAll) notes.push('[shared all open tabs]')
      if (activeSelection) notes.push('[shared a page selection]')
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
      turnAllowed.current = new Set()
      pageControl.endSession()
      // Tear down ambient presence on any tab the turn touched (navigate/inspect
      // mount the frame outside a session, so endSession alone won't clear them).
      void unmountAllPresence()
      abortRef.current = null
      setStreaming(false)
      setTurnSeq((n) => n + 1)
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
              The tab you're on is attached to your first message. @mention another tab to share
              it, type @memory to have me draw on what I remember, type / to run one of your
              skills, or snip a screenshot with the camera.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageView
            key={msg.id}
            message={msg}
            streaming={streaming && i === messages.length - 1}
          />
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
      </div>

      <div className="composer-area">
        {currentTab &&
          (messages.length === 0 && !tabDismissed ? (
            <div
              className="context-pill attached"
              title={`This page is attached to your first message — ${currentTab.title}`}
            >
              {currentTab.favIconUrl ? (
                <img src={currentTab.favIconUrl} alt="" />
              ) : (
                <span className="context-dot" />
              )}
              <span className="context-title">{hostOf(currentTab.url) || currentTab.title}</span>
              <button
                className="context-remove"
                title="Don't share this page"
                onClick={() => setTabDismissed(true)}
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
          ) : (
            <div className="context-pill" title={`The agent can ask to view this tab — ${currentTab.title}`}>
              {currentTab.favIconUrl ? (
                <img src={currentTab.favIconUrl} alt="" />
              ) : (
                <span className="context-dot" />
              )}
              <span className="context-title">{hostOf(currentTab.url) || currentTab.title}</span>
            </div>
          ))}
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

function MessageView({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null)

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
      <div className="msg-assistant-body" ref={bodyRef}>
        {message.parts.map((part, i) =>
          part.type === 'text' ? (
            <AssistantText key={i} text={part.text} />
          ) : (
            <ToolPill key={part.toolCallId} part={part} />
          ),
        )}
        {message.parts.length === 0 && <div className="thinking-dot" />}
      </div>
      {message.parts.length > 0 && !streaming && (
        <MessageToolbar message={message} targetRef={bodyRef} />
      )}
    </div>
  )
}

// Renders one assistant text part. Runs of grouped image URLs become a
// side-scrollable download carousel; everything else renders as markdown.
function AssistantText({ text }: { text: string }) {
  const segments = useMemo(() => splitImageBlocks(text), [text])
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'images' ? (
          <ImageCarousel key={i} urls={seg.urls} />
        ) : (
          <Markdown key={i} text={seg.text} />
        ),
      )}
    </>
  )
}

// Actions on a completed assistant message: copy the rendered message as a PNG
// image, or copy its text as markdown.
function MessageToolbar({
  message,
  targetRef,
}: {
  message: UIMessage
  targetRef: React.RefObject<HTMLDivElement>
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
    const markdown = message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim()
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('done')
    } catch {
      setCopyState('error')
    }
    setTimeout(() => setCopyState('idle'), 1500)
  }

  const sources = deriveSources(message)

  return (
    <div className="msg-toolbar">
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
      <SourceBar sources={sources} />
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
  else if (part.toolName === 'ViewCurrentTab') label = `Viewed current tab · ${output?.title ?? ''}`
  else if (part.toolName === 'ViewOpenedTabs')
    label = output?.contents
      ? `Read ${output.contents.length} tab${output.contents.length > 1 ? 's' : ''}`
      : `Listed ${output?.tabs?.length ?? 0} open tabs`
  else if (part.toolName === 'GetActiveTabDOM')
    label = output?.error ? 'Could not read tab DOM' : `Read current tab DOM · ${output?.title ?? ''}`
  else if (part.toolName === 'GetAllDOM')
    label = output?.doms
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
  else if (part.toolName === 'InspectPage') label = 'Read the page elements'
  else if (part.toolName === 'RequestPageControl')
    label = output?.started ? 'Started controlling the page' : 'Asked to control the page'
  else if (part.toolName === 'ControlPage') label = controlActionLabel(part.input, output)
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
