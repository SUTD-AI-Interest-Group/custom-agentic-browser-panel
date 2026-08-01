import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { saveMemory, searchMemories, getProfileMemories } from '../data/memory'
import { getSkill, listSkillMetas, saveSkill } from '../data/skills'
import type { ProviderConfig, TabAccess, ToolPolicy } from '../data/settings'
import {
  closeTabs,
  getActiveTab,
  listOpenTabs,
  navigateTab,
  readClosedStash,
  readTabContent,
  readTabDom,
  reopenClosedTabs,
} from '../platform/tabs'
import { buildTabIndex, hostOf, listTabFacts, TAB_GIST_LIMIT } from '../platform/tabIndex'
import { applyGrouping, ungroupTabs } from '../platform/tabGroups'
import { planClosure, planGrouping, TAB_GROUP_COLORS } from './tabPolicy'
import { getBrowsingHistory, getBookmarks, getTopSites, getDownloads } from '../platform/browsingData'
import type { BrowsingCapability } from '../platform/permissions'
import { snapshotPage, type PageSnapshot } from '../platform/domIndex'
import { snapshotRegions } from '../platform/regionIndex'
import { capture, tileShot, ShotError, planShotDelivery } from '../platform/screenshot'
import { looksLikePdfUrl, parsePageRange, searchPages, assemblePagesText } from '../platform/pdfText'
import { loadPdf, renderPdfPage, renderPdfPageHighlighted, PdfError, type LoadedPdf } from '../platform/pdf'
import { highlightTextOnPage, highlightRegionOnPage } from '../platform/highlight'
import { saveShot } from '../data/screenshots'
import type { QueuedImage } from '../agent/agent'
import { mountPresence, setTint, focusOn, pulse, setPresenceHidden, animateNavIntent, unmountPresence } from '../platform/presence'
import { captureWithMarks } from '../platform/marks'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { getMcpManager } from '../mcp/manager'
import { mapResourceResult } from '../mcp/content'
import { saveMcpArtifact } from '../data/mcpArtifacts'
import { instrumentToolset, type Trace } from '../agent/observability'
import { getExecHost } from '../exec/host'
import { budgetOutcome, escapeHtml, RUN_MEMORY_BYTES, RUN_TIMEOUT_MS } from '../exec/protocol'
import { saveArtifact, updateArtifactContent } from '../data/artifacts'
import { createStartResearchTool } from './research'
import { buildCatalog, searchCatalog, partitionToolNames, type CatalogEntry } from './toolDiscovery'
import {
  hasElementChanged,
  isPointOfNoReturn,
  runControlStep,
  type ControlSession,
  type ControlSpec,
} from './pageControl'

// ---------------------------------------------------------------------------
// Human-in-the-loop approval gate
//
// Every agent tool asks the user for permission before it runs: the tool's
// execute() suspends on requestApproval() until the user clicks Allow/Deny
// on an inline card in the chat. The AI SDK's multi-step loop is unaware of
// the pause — from the model's perspective the tool just returned.
//
// Future tools (form autofill, page control, memory, skills) plug into the
// same gate: add an entry to createAgentTools and the approval UI, streaming
// and rendering all come for free.
// ---------------------------------------------------------------------------

/**
 * Which tab a turn's page tools act on, and what happens when that tab isn't the
 * one in front.
 *
 * A chat is bound to the tab it was opened on (src/ui/tabChats.ts). Pinning
 * matters because a turn can outlive the user's attention: they ask a question,
 * switch tabs, and the turn keeps going. Without a pin, its next `ReadPage`
 * would quietly describe whatever page they moved to.
 */
export interface PageTarget {
  /** Defaults to the active tab — right for any caller that isn't tab-bound. */
  resolveTab?: () => Promise<chrome.tabs.Tab | undefined>
  /**
   * Raised by a tool that cannot proceed while its tab is in the background.
   * The caller ends the turn at this step boundary and resumes it when the user
   * comes back (see `parkPending` in src/agent/agent.ts).
   */
  park?: (reason: string) => void
}

/**
 * Is this tab the one its window is currently showing? Captures and page-control
 * steps need it to be: chrome.tabs.captureVisibleTab only ever returns the
 * *active* tab's viewport, and clicking a background tab shows the user nothing.
 * Window focus is deliberately not part of the test — an unfocused window's
 * active tab still captures fine.
 */
async function isForeground(tab: chrome.tabs.Tab): Promise<boolean> {
  if (tab.id === undefined || tab.windowId === undefined) return false
  try {
    const [live] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
    return live?.id === tab.id
  } catch {
    return false
  }
}

/**
 * What a page tool reports when `resolveTab` comes back empty. Worded to be true
 * of both callers: an unbound turn that has no active tab, and a tab-bound chat
 * (src/ui/tabChats.ts) whose tab the user closed while the turn was still going.
 * "No active tab found" would be a lie in the second case — the model would
 * retry against a tab that is never coming back.
 */
const NO_TAB_ERROR = 'This chat has no page to act on — its tab was closed, or there is no active tab.'

/** One row of a batch approval card's itemized list. */
export interface ApprovalItem {
  title: string
  host: string
  /** Optional trailing qualifier, e.g. "duplicate of #41" or "asleep". */
  note?: string
}

export interface ApprovalRequest {
  toolName: string
  /** One-line, human-readable description of what will happen. */
  summary: string
  /** The model's stated reason, shown to the user. */
  reason: string
  /** When true, the card must NOT offer "Allow this chat" — the action must be confirmed every time (point-of-no-return page actions). */
  once?: boolean
  /**
   * The exact things this call will act on, listed on the card. A summary saying
   * "Close 23 tabs" is not consent — the user has to be able to see *which* 23
   * before they click. Rendered as a scrollable list.
   */
  items?: ApprovalItem[]
  /** Destructive: tints the card and its primary button with the danger color. */
  danger?: boolean
  /**
   * Optional Chrome permissions to request from inside the Allow click. The card's
   * button handler is a genuine user gesture, which chrome.permissions.request
   * requires — so an optional permission can be granted at the moment it is
   * actually needed instead of sending the user hunting through Settings. Denying
   * the Chrome dialog denies the whole call.
   */
  needsPermissions?: string[]
}

export type ApprovalGate = (request: ApprovalRequest) => Promise<boolean>

const DENIED = {
  denied: true,
  message: 'The user denied permission for this tool call.',
}

function pointOfNoReturnSummary(spec: ControlSpec, el?: { name: string }): string {
  if (spec.action === 'navigate') return `Navigate to ${spec.url}`
  if (spec.action === 'press') return `Press ${spec.keys}`
  if (spec.action === 'click') return `Click “${el?.name || `element ${spec.index}`}”`
  if (spec.action === 'type') return `Enter text into a sensitive field`
  return `Perform ${spec.action}`
}

/** Friendly host from an origin string, for approval-card copy. */
function hostLabel(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin || 'a different site'
  }
}

/** Human-in-the-loop gate for page control, implemented by the chat UI. */
export interface PageControlGate {
  /** Show the session card with the plan; resolve true if the user allows. */
  requestSession(input: { plan: string; host: string; origin: string; tabId: number }): Promise<boolean>
  /** The currently open session, or null. */
  session(): ControlSession | null
  /** Close the session and tear down any on-page overlay. */
  endSession(): void
}

// Build a tool return that carries the text registry only. For vision models,
// the set-of-marks screenshot is captured and pushed onto imageQueue instead
// of being attached to the tool result: the OpenAI-compatible adapter
// serializes a tool result's `media` part to plain text, so the model never
// sees it that way. The turn loop (runAgentTurn's prepareStep) drains the
// queue and injects the image as a `user` message before the next step, with
// the caption each image carries. The presence overlay is hidden for the shot
// so the tint doesn't pollute what the model sees, and is always restored — on
// the success path and on any capture failure.
async function lookResult(
  tab: chrome.tabs.Tab,
  snap: PageSnapshot,
  base: Record<string, unknown>,
  selected: { provider: ProviderConfig; modelId: string } | null,
  /** Already resolved by the caller — see createAgentTools's `visionCapable`. */
  vision: boolean,
  imageQueue: QueuedImage[],
) {
  const value = { ...base, url: snap.url, title: snap.title, elements: snap.text }
  if (!selected || !vision || tab.id === undefined || tab.windowId === undefined) return value
  try {
    await setPresenceHidden(tab.id, true)
    const [live] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
    if (live?.id !== tab.id) {
      await setPresenceHidden(tab.id, false).catch(() => {})
      return value
    }
    const dataUrl = await captureWithMarks(tab.id, tab.windowId, snap.elements, snap.dpr)
    await setPresenceHidden(tab.id, false)
    imageQueue.push({
      dataUrl,
      caption:
        'Set-of-marks screenshot of the current page — the numbered boxes correspond to the [index] values in the element list you just read.',
    })
  } catch {
    await setPresenceHidden(tab.id, false).catch(() => {})
  }
  return value
}

// DOM is denser than plain text, so these caps run larger than the 25k text cap.
const MAX_DOM_CHARS = 40_000 // single active tab (ReadPage mode "dom")
const MAX_DOM_CHARS_PER_TAB = 15_000 // per tab in ReadTabs mode "dom", to bound aggregate size

// ReadPdf mode "pages" total budget — mirrors readTabContent's 25k text cap.
const MAX_PDF_TEXT_CHARS = 25_000

// Image budgets. A stitched page is handed to the model as several legible tiles
// rather than one illegible squashed strip (see planTiles), so one GetScreenshot call
// can cost several images — hence a per-call cap and a per-turn cap.
const MAX_TILES_PER_CALL = 6
const MAX_SHOT_IMAGES_PER_TURN = 12

export function createAgentTools(
  requestApproval: ApprovalGate,
  tabAccess: TabAccess,
  granted: Set<BrowsingCapability>,
  pageControl: PageControlGate,
  selected: { provider: ProviderConfig; modelId: string } | null,
  /**
   * Whether the selected model actually reads images (probed + cached by
   * ensureVisionCapability, resolved by the caller before this runs). This no
   * longer removes the screenshot tools — they always capture and always save the
   * shot for the user. It only routes whether the image ALSO reaches the model:
   * when false, planShotDelivery returns `blind` and the tool saves the artifact
   * and tells the model plainly it cannot see it (rather than queueing an image
   * part the endpoint would drop and the model would loop waiting for).
   */
  visionCapable: boolean,
  imageQueue: QueuedImage[],
  /** Resolves each tool's Never/Ask/Always policy; `never` tools are removed below. */
  policyFor: (name: string) => ToolPolicy,
  /** The open conversation, tagged onto any background research launched this turn. */
  conversationId: string,
  /** Per-turn mutable set of loaded tool names; GetTool adds to it, the turn loop reads it. */
  activeNames: Set<string>,
  /** Optional Langfuse trace for this turn; when set, each tool call becomes a span. */
  trace?: Trace,
  /**
   * Additional tools to merge into this turn's ToolSet — MCP server tools
   * (src/mcp/tools.ts), already policy-filtered and approval-gated by their
   * builder. They MUST come through here rather than being spread in by the
   * caller: the disclosure catalog below is derived from THIS ToolSet, and a
   * tool outside it could never be listed by ToolSearch, loaded by GetTool, or
   * self-healed by the repair hook — an unloaded call would dead-end.
   */
  extraTools?: ToolSet,
  /** Which tab this turn acts on, and what to do when it isn't in front. */
  pageTarget?: PageTarget,
): ToolSet {
  const resolveTab = pageTarget?.resolveTab ?? getActiveTab

  /**
   * Park the turn: this chat's tab is in the background, and the action needs it
   * in front. Returns a result that tells the model plainly not to retry — the
   * turn is over and resumes on its own — because a model told merely that
   * something "failed" will spend its remaining steps trying again.
   */
  const parkFor = (tab: chrome.tabs.Tab, action: string) => {
    const where = hostLabel(tab.url ?? '')
    pageTarget?.park?.(`needs ${where} in front to ${action}`)
    return {
      parked: true as const,
      note: `Cannot ${action}: the user has switched away from ${where}, and only the tab in front of them can be seen or clicked. This turn is now paused and will resume by itself when they return to that tab. Do not retry and do not call another tool — stop here.`,
    }
  }
  const BROWSING_SOURCES = ['history', 'bookmarks', 'topSites', 'downloads'] as const
  const grantedSources = BROWSING_SOURCES.filter((s) => granted.has(s))
  const sourcesLabel = grantedSources.length ? grantedSources.join(', ') : 'none currently enabled'

  // Assigned after all filtering below, so the catalog and GetTool only ever
  // surface tools that survive tabAccess / permission / policy gating.
  let catalog: CatalogEntry[] = []

  // Images are by far the most expensive thing this agent can spend tokens on, and
  // a model that can see tends to want to look at everything. createAgentTools is
  // called fresh for each cycle of the continuation chain, so this closure counter
  // is exactly a per-turn budget with no plumbing.
  let shotImagesUsed = 0

  // Both screenshot tools share one capture→save→deliver path. The shot is ALWAYS
  // saved for the user (ShotCard renders it in chat); planShotDelivery then decides
  // whether the image also reaches the model. shotImagesUsed is the shared per-turn
  // image budget across both tools.
  const runScreenshot = async (
    toolName: 'GetScreenshot' | 'GetElementScreenshot',
    spec: { kind: 'viewport' | 'element' | 'fullpage'; region?: number; selector?: string },
    summary: string,
    reason: string,
  ) => {
    const tab = await resolveTab()
    if (tab?.id === undefined) return { error: NO_TAB_ERROR }

    // Checked BEFORE the approval card: asking the user to approve a capture that
    // then can't happen would spend their attention on nothing.
    if (!(await isForeground(tab))) return parkFor(tab, 'capture this page')

    // Same exemption as ReadPage's perception modes: inside an open control session
    // the user has already granted sight of this tab, and a card between every click
    // and its verification shot would be unusable.
    const open = pageControl.session()
    const owned = !!open && open.active && open.tabId === tab.id
    if (!owned) {
      const approved = await requestApproval({ toolName, summary, reason })
      if (!approved) return DENIED
    }

    try {
      // `shot` is the full-resolution capture — only ever used to feed tileShot
      // below. `artifact` is the fit()-downscaled copy: the small strip saved as
      // the user-facing shot. Tiling the already-shrunk artifact is exactly the
      // bug this split fixes (a tall page would reach the model as one smear).
      const { shot, artifact, meta } = await capture(tab, spec)
      // Saved for the user regardless of whether the model can afford to look at
      // it — the artifact and the perception are different products.
      const shotId = await saveShot({
        dataUrl: artifact.dataUrl,
        width: artifact.width,
        height: artifact.height,
        url: meta.url,
        title: meta.title,
        label: meta.label,
        conversationId,
      })

      const host = hostLabel(meta.url)
      const truncatedNote = meta.truncated
        ? ' The page was taller than the capture limit, so this stops partway down.'
        : ''

      const delivery = planShotDelivery(visionCapable, shotImagesUsed, MAX_SHOT_IMAGES_PER_TURN)

      // Text-only model: the user sees the shot in chat, but the model cannot read
      // images. Say so plainly so it does not loop waiting for an image part.
      if (delivery.kind === 'blind') {
        return {
          ok: true,
          shotId,
          target: spec.kind,
          label: meta.label,
          // Report the saved artifact's dimensions, not the full-res tiling
          // source — the tool result should describe what the user was shown.
          width: artifact.width,
          height: artifact.height,
          note: `Captured ${meta.label} on ${host} and showed it to the user in the chat.${truncatedNote} You can't view images, so it was not sent to you — work from the page text if you need its contents.`,
        }
      }

      // Vision-capable but this turn's image budget is spent.
      if (delivery.kind === 'budget') {
        return {
          ok: true,
          shotId,
          target: spec.kind,
          label: meta.label,
          // Report the saved artifact's dimensions, not the full-res tiling
          // source — the tool result should describe what the user was shown.
          width: artifact.width,
          height: artifact.height,
          note: `Captured ${meta.label} on ${host} and saved it for the user, but this turn's image budget is spent, so it was not sent to you. Work from the page text instead.`,
        }
      }

      const { tiles, dropped } = await tileShot(shot, Math.min(MAX_TILES_PER_CALL, delivery.maxTiles))
      tiles.forEach((t, i) => {
        const where = tiles.length > 1 ? ` — tile ${i + 1} of ${tiles.length}, top to bottom` : ''
        imageQueue.push({
          dataUrl: t.dataUrl,
          caption: `Screenshot of ${meta.label} on ${host}${where}. This is a photograph of the page: there are no numbered boxes on it.`,
        })
      })
      shotImagesUsed += tiles.length

      // Say what was dropped. A silently truncated capture reads to the model as
      // "I have seen the whole thing", which is how it ends up confidently
      // describing a page section it was never shown.
      const droppedNote = dropped
        ? ` The page was too long to send in full: you are seeing the first ${tiles.length} of ${tiles.length + dropped} sections. Scroll and shoot again if you need the rest.`
        : ''

      return {
        ok: true,
        shotId,
        target: spec.kind,
        label: meta.label,
        // Report the saved artifact's dimensions, not the full-res tiling
        // source — the tool result should describe what the user was shown.
        width: artifact.width,
        height: artifact.height,
        images: tiles.length,
        note: `Captured ${meta.label} on ${host}.${truncatedNote}${droppedNote} The image follows.`,
      }
    } catch (err) {
      // A ShotError is an expected, explainable condition (restricted page, tab no
      // longer active, region gone) — hand the model the sentence so it can adapt.
      if (err instanceof ShotError) return { error: err.message }
      return {
        error: `Could not take the screenshot (${err instanceof Error ? err.message : String(err)}).`,
      }
    }
  }

  const tools: ToolSet = {
    ReadPage: tool({
      description:
        'Read the tab the user is currently viewing. mode="text": title, URL, selected text and full visible text. mode="dom": the cleaned HTML structure (tags, attributes, links, form fields) when you need page structure rather than visible text. mode="elements": a numbered list of interactive elements (buttons, links, inputs) each with an [index] — use before controlling a page, or to re-read after it changes. mode="regions": a numbered list of VISUAL regions (charts, figures, tables, images, cards, sections) each with an [rN] — use to find something worth looking at, then pass its number to GetElementScreenshot. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        mode: z
          .enum(['text', 'dom', 'elements', 'regions'])
          .describe(
            'text = visible text; dom = HTML structure; elements = indexed interactive elements to act on; regions = indexed visual regions to screenshot',
          ),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To summarize this article"'),
      }),
      execute: async ({ mode, reason }) => {
        const tab = await resolveTab()
        if (tab?.id === undefined) return { error: NO_TAB_ERROR }
        // Chrome renders PDFs in a plugin with no scriptable DOM — every ReadPage
        // mode would come back empty or error. Redirect the model to ReadPdf
        // before asking the user anything (this touches nothing but the tab URL,
        // which ReadPage already uses).
        if (looksLikePdfUrl(tab.url ?? '')) {
          return {
            note: 'The active tab is a PDF. Chrome shows PDFs in a plugin viewer with no readable page DOM, so ReadPage cannot see it. Use the ReadPdf tool instead: mode "outline" to orient, "search" to find text, "pages" to read, "view" to look at a page.',
          }
        }
        // Both perception modes are read-only, and both are exempt from the card
        // while a control session already owns this tab — the session grant covers
        // looking at the page it is already driving.
        if (mode === 'regions') {
          const open = pageControl.session()
          if (!open || !open.active || open.tabId !== tab.id) {
            const approved = await requestApproval({
              toolName: 'ReadPage',
              summary: 'List the visual regions on this page (charts, tables, figures)',
              reason,
            })
            if (!approved) return DENIED
          }
          try {
            const snap = await snapshotRegions(tab.id)
            return {
              url: snap.url,
              title: snap.title,
              regions: snap.text,
              note:
                'Pass a region number to GetElementScreenshot as `region` (e.g. region: 2 for [r2]) to look at it. ' +
                'This list is only the page\'s visual blocks — charts, tables, figures, sections. Most of the page is ' +
                'not in it: a paragraph, a heading, a line of prose or a rendered equation has no [rN]. So if you want ' +
                'to point the user at WORDS, do not pick the nearest region here — call HighlightContent with `text` ' +
                'quoting those words.',
            }
          } catch (err) {
            return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
          }
        }
        if (mode === 'elements') {
          const open = pageControl.session()
          if (!open || !open.active || open.tabId !== tab.id) {
            const approved = await requestApproval({
              toolName: 'ReadPage',
              summary: 'Read the interactive elements on this page',
              reason,
            })
            if (!approved) return DENIED
          }
          // Ambient presence: the agent is looking at this page. Idempotent, so
          // it never disturbs an already-mounted session (and warms the overlay
          // before a likely RequestPageControl). lookResult hides it for the shot.
          await mountPresence(tab.id)
          // Mid-session re-read: if a session is controlling this tab, keep the
          // tinted "active control" look after a navigation may have wiped it.
          if (open && open.active && open.tabId === tab.id) await setTint(tab.id, true)
          try {
            const snap = await snapshotPage(tab.id)
            return await lookResult(tab, snap, {}, selected, visionCapable, imageQueue)
          } catch (err) {
            return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
          }
        }
        const approved = await requestApproval({
          toolName: 'ReadPage',
          summary:
            mode === 'dom'
              ? 'Read the DOM/HTML structure of the tab you are on'
              : 'View the tab you are currently on',
          reason,
        })
        if (!approved) return DENIED
        if (mode === 'dom') return await readTabDom(tab.id, MAX_DOM_CHARS)
        const content = await readTabContent(tab.id)
        if ('error' in content && content.error) return content
        return {
          ...content,
          tip: 'When your answer comes from a specific passage on this page, call HighlightContent with that exact text to scroll to it and mark it for the user.',
        }
      },
    }),

    GetScreenshot: tool({
      description:
        'LOOK at the active tab as an image — a screenshot of the live rendered browser viewport (the composited page: charts, diagrams, maps, photos, rendered layout, anything whose meaning is visual and would be lost as text). Also use it to check your own work after a ControlPage action: confirm a click landed, or spot a modal, error, or CAPTCHA the element list does not convey. By default it shoots what is on screen; pass fullPage:true to scroll and stitch the whole page (costs several images — prefer the default). The shot is always shown to the user in the chat. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole scrolled page instead of just the visible viewport. Costs several images — prefer the default.'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To read the revenue chart"'),
      }),
      execute: async ({ fullPage, reason }) => {
        const summary = fullPage
          ? 'Take a screenshot of this whole page'
          : 'Take a screenshot of this page'
        return runScreenshot('GetScreenshot', { kind: fullPage ? 'fullpage' : 'viewport' }, summary, reason)
      },
    }),

    GetElementScreenshot: tool({
      description:
        'Screenshot ONE element/region of the active tab as a PNG — a chart, figure, table, image, or card you want to see on its own. Target it with a `region` number from ReadPage(mode:"regions") (preferred) or a CSS `selector`; give one or the other. The crop is always shown to the user in the chat. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        region: z
          .number()
          .optional()
          .describe('The region number from ReadPage(mode:"regions"), e.g. 2 for [r2].'),
        selector: z
          .string()
          .optional()
          .describe('A CSS selector, if you have no region number.'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To read the revenue chart"'),
      }),
      execute: async ({ region, selector, reason }) =>
        runScreenshot(
          'GetElementScreenshot',
          { kind: 'element', region, selector },
          'Take a screenshot of one element on this page',
          reason,
        ),
    }),

    RunCode: tool({
      description:
        'Execute JavaScript in a sealed sandbox and get its console output and completion value back. Use it when running code beats reasoning: calculations, data transforms, parsing, checking an algorithm. Pure computation only — no DOM, no network, no timers, no page or extension access; promise chains settle but nothing can wait on time. The value of the last expression is the result. This tool cannot SHOW anything: to render an interactive page, chart, visualization, or mini-app for the user, use CreateArtifact instead (compute here first if needed). Asks the user for permission first.',
      inputSchema: z.object({
        code: z.string().describe("The JavaScript to run. The last expression's value is returned."),
        reason: z.string().describe('Short reason shown to the user, e.g. "To compute the amortization table"'),
      }),
      execute: async ({ code, reason }) => {
        const preview = code.length > 400 ? `${code.slice(0, 400)}…` : code
        const approved = await requestApproval({
          toolName: 'RunCode',
          summary: `Run JavaScript in the sandbox:\n${preview}`,
          reason,
        })
        if (!approved) return DENIED
        try {
          const raw = await getExecHost().run(code, { timeoutMs: RUN_TIMEOUT_MS, memoryBytes: RUN_MEMORY_BYTES })
          const { outcome, valueOverflow } = budgetOutcome(raw)
          if (!outcome.ok) {
            return {
              ok: false,
              error: outcome.timedOut
                ? `Timed out after ${RUN_TIMEOUT_MS}ms. Break the work into smaller steps.`
                : outcome.error,
              logs: outcome.logs,
              durationMs: outcome.durationMs,
            }
          }
          if (valueOverflow !== null) {
            // The full value would bloat model history — spill it to a
            // user-facing artifact and hand back the truncated form + the id.
            const spilled = await saveArtifact({
              title: 'RunCode output',
              html:
                '<!doctype html><meta charset="utf-8"><body style="margin:12px;font:13px monospace;white-space:pre-wrap">' +
                escapeHtml(valueOverflow),
              conversationId,
            })
            return {
              ok: true,
              value: outcome.value,
              logs: outcome.logs,
              durationMs: outcome.durationMs,
              artifactId: spilled.id,
              note: 'Full output was too large for chat and is shown to the user as an artifact.',
            }
          }
          return { ok: true, value: outcome.value, logs: outcome.logs, durationMs: outcome.durationMs }
        } catch (err) {
          return { error: `Sandbox failure: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }),

    // The viewport numbers in the description mirror ArtifactCard's
    // COLLAPSED_H / EXPANDED_H — keep them in sync or the model designs for a
    // canvas the card doesn't have.
    CreateArtifact: tool({
      description:
        'Create a self-contained interactive web artifact — one complete HTML document with inline CSS and JavaScript — shown to the user as a live, interactive card right in the chat: a visualization, chart, mini-app, formatted document, diagram, demo, or game. This is THE way to display or render HTML/JS to the user. It runs in a sealed sandbox with NO network: no fetch/XHR/WebSocket, no remote scripts, fonts, or CDNs, no remote images, and no cross-origin form submission — inline everything, including images as data: URIs (a remote image URL will not load). No storage, no extension access. The card viewport is SMALL and FIXED: a narrow side-panel column about 360px wide and 360px tall (720px if the user expands it) — anything taller is clipped behind a scrollbar, not shown. Design to fit: fluid width (no fixed pixel widths), html/body{margin:0;height:100%}, compact spacing, and put long content behind tabs, accordions, pagination, or an internal scroll region instead of growing the page taller. Never emit a long scrolling document. Returns an artifactId; revise the same artifact later with UpdateArtifact instead of creating a new one. Asks the user for permission first.',
      inputSchema: z.object({
        title: z.string().describe('Short human title shown on the card, e.g. "Loan repayment explorer"'),
        html: z
          .string()
          .describe(
            'The complete standalone HTML document (inline <style> and <script> only), designed to fit the ~360px-wide, ~360px-tall card viewport — compact and fluid, never a long scrolling page.',
          ),
        reason: z.string().describe('Short reason shown to the user'),
      }),
      execute: async ({ title, html, reason }) => {
        const approved = await requestApproval({
          toolName: 'CreateArtifact',
          summary: `Create artifact "${title}" (${(html.length / 1024).toFixed(1)} KB of HTML)`,
          reason,
        })
        if (!approved) return DENIED
        const saved = await saveArtifact({ title, html, conversationId })
        return {
          artifactId: saved.id,
          title: saved.title,
          revision: saved.revision,
          note: 'The artifact is now rendered for the user. Use UpdateArtifact with this artifactId to revise it.',
        }
      },
    }),

    UpdateArtifact: tool({
      description:
        'Replace the HTML of an artifact you previously created with CreateArtifact, keeping its card and id. Send the COMPLETE new document, not a diff. Same sealed-sandbox and sizing rules: fully inline, no external URLs, and designed to fit the ~360px-wide, ~360px-tall card viewport (720px expanded) — never a long scrolling page. Asks the user for permission first.',
      inputSchema: z.object({
        artifactId: z.string().describe('The artifactId returned by CreateArtifact.'),
        html: z.string().describe('The complete replacement HTML document.'),
        title: z.string().optional().describe('New title, only if it should change.'),
        reason: z.string().describe('Short reason shown to the user'),
      }),
      execute: async ({ artifactId, html, title, reason }) => {
        const approved = await requestApproval({
          toolName: 'UpdateArtifact',
          summary: `Update artifact ${title ? `"${title}"` : artifactId} (${(html.length / 1024).toFixed(1)} KB of HTML)`,
          reason,
        })
        if (!approved) return DENIED
        const updated = await updateArtifactContent(artifactId, { html, title })
        if (!updated) return { error: `No artifact with id ${artifactId} — it may have been pruned. Use CreateArtifact.` }
        return { artifactId: updated.id, revision: updated.revision }
      },
    }),

    ReadPdf: tool({
      description:
        'Read, search, or look at a PDF — the one open in the active tab (default) or any PDF `url`. Chrome PDFs are invisible to ReadPage; this tool parses the actual file. mode="outline": title, page count, bookmarks — orient yourself first. mode="pages": read a page range (`pages:"3-7,12"`) as text. mode="search": find a word/phrase across every page, returning page numbers + snippets — the fastest way to answer a question about a long PDF; if a term misses, retry with synonyms. mode="view": render one page (`page:4`) as an image to look at — figures, charts, or scanned PDFs with no text layer. Asks the user for permission first.',
      inputSchema: z.object({
        mode: z
          .enum(['outline', 'pages', 'search', 'view'])
          .describe(
            'outline = metadata + bookmarks; pages = read a page range as text; search = find text across all pages; view = render one page as an image',
          ),
        url: z
          .string()
          .optional()
          .describe('A PDF URL to read. Omit to read the PDF open in the active tab.'),
        pages: z.string().optional().describe('mode="pages": a page range like "3-7" or "3-7,12"'),
        query: z.string().optional().describe('mode="search": the word or phrase to find'),
        page: z.number().optional().describe('mode="view": the page number to render'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To answer from the methods section"'),
      }),
      execute: async ({ mode, url, pages, query, page, reason }) => {
        // Validate before asking the user — a card for a call that cannot run is noise.
        if (mode === 'pages' && !pages) return { error: 'mode:"pages" needs a `pages` range like "3-7".' }
        if (mode === 'search' && !query?.trim()) return { error: 'mode:"search" needs a `query`.' }
        if (mode === 'view' && !page) return { error: 'mode:"view" needs a `page` number.' }
        let target = url
        if (!target) {
          const tab = await resolveTab()
          target = tab?.url
          if (!target) return { error: 'No active tab and no `url` given.' }
        }
        // The card names the document: the tab the user is viewing, or the host
        // it would be fetched from.
        const docLabel = url ? `the PDF at ${hostLabel(url)}` : 'the PDF you are viewing'
        const summary =
          mode === 'outline'
            ? `Read the table of contents of ${docLabel}`
            : mode === 'pages'
              ? `Read pages ${pages} of ${docLabel}`
              : mode === 'search'
                ? `Search ${docLabel} for “${query}”`
                : `Look at page ${page} of ${docLabel}`
        const approved = await requestApproval({ toolName: 'ReadPdf', summary, reason })
        if (!approved) return DENIED

        // The foreground fetch rides the user's cookies so a PDF they can see
        // behind a login, the agent can read too. (Research's PDF path stays
        // cookie-less — see fetchPdfReadable in research.ts.)
        const creds = { credentials: 'include' as const }

        if (mode === 'view') {
          try {
            const r = await renderPdfPage(target, page!, creds)
            // Same contract as the screenshot tools: the render is ALWAYS saved
            // as a user-facing artifact (ShotCard); planShotDelivery only routes
            // whether it also reaches the model, and only via imageQueue.
            const shotId = await saveShot({
              dataUrl: r.dataUrl,
              width: r.width,
              height: r.height,
              url: target,
              title: r.title,
              label: `PDF page ${page} of ${r.pageCount}`,
              conversationId,
              page,
            })
            const delivery = planShotDelivery(visionCapable, shotImagesUsed, MAX_SHOT_IMAGES_PER_TURN)
            if (delivery.kind === 'blind') {
              return {
                ok: true,
                shotId,
                page,
                pageCount: r.pageCount,
                note: `Rendered page ${page} of "${r.title}" and showed it to the user in the chat. You can't view images, so it was not sent to you — use mode:"pages" or mode:"search" for its text.`,
              }
            }
            if (delivery.kind === 'budget') {
              return {
                ok: true,
                shotId,
                page,
                pageCount: r.pageCount,
                note: `Rendered page ${page} of "${r.title}" and saved it for the user, but this turn's image budget is spent, so it was not sent to you. Use mode:"pages" for its text.`,
              }
            }
            imageQueue.push({
              dataUrl: r.dataUrl,
              caption: `Page ${page} of ${r.pageCount} of the PDF "${r.title}" — a plain rendered page; there are no numbered boxes on it.`,
            })
            shotImagesUsed += 1
            return { ok: true, shotId, page, pageCount: r.pageCount, images: 1, note: 'The page image follows.' }
          } catch (err) {
            if (err instanceof PdfError) return { error: err.message }
            return { error: `Could not render the page (${err instanceof Error ? err.message : String(err)}).` }
          }
        }

        let loaded: LoadedPdf
        try {
          loaded = await loadPdf(target, creds)
        } catch (err) {
          if (err instanceof PdfError) return { error: err.message }
          return { error: `Could not read the PDF (${err instanceof Error ? err.message : String(err)}).` }
        }
        const { info, pages: pageTexts, outline } = loaded
        const notes: string[] = []
        if (info.pageCount > info.extractedPages) {
          notes.push(`Text was extracted for the first ${info.extractedPages} of ${info.pageCount} pages.`)
        }

        if (mode === 'outline') {
          return {
            url: info.url,
            title: info.title,
            ...(info.author ? { author: info.author } : {}),
            pageCount: info.pageCount,
            ...(outline.length
              ? { bookmarks: outline }
              : { firstPage: pageTexts[0]?.text.slice(0, 600) ?? '' }),
            note: ['Use mode:"search" to locate topics, then mode:"pages" to read them.', ...notes].join(' '),
          }
        }

        if (mode === 'search') {
          const r = searchPages(pageTexts, query!)
          if ('error' in r) return { error: r.error }
          if (r.totalMatches === 0) {
            notes.push('No matches. Try a shorter or different term (synonyms, singular form).')
          } else if (r.capped) {
            notes.push(`More pages matched than shown (${r.totalMatches} occurrences in total); narrow the query.`)
          }
          if (r.totalMatches > 0) {
            notes.push('To point the user at a passage in their viewer, call HighlightContent with the matched text and its page number.')
          }
          return {
            url: info.url,
            title: info.title,
            pageCount: info.pageCount,
            totalMatches: r.totalMatches,
            matches: r.matches,
            ...(notes.length ? { note: notes.join(' ') } : {}),
          }
        }

        // mode === 'pages'
        const parsed = parsePageRange(pages!, info.pageCount)
        if ('error' in parsed) return { error: parsed.error }
        const { blocks, omittedPages } = assemblePagesText(pageTexts, parsed.pages, MAX_PDF_TEXT_CHARS)
        if (omittedPages.length) {
          notes.push(
            `The character budget cut page${omittedPages.length > 1 ? 's' : ''} ${omittedPages.join(', ')} — request ${omittedPages.length > 1 ? 'them' : 'it'} in a smaller range.`,
          )
        }
        if (blocks.length > 0 && blocks.every((b) => b.text.trim().length < 20)) {
          notes.push(
            'These pages have little or no text layer — this may be a scanned PDF. Use mode:"view" to look at a page as an image.',
          )
        } else if (blocks.length > 0) {
          notes.push(
            'When your answer comes from a specific passage here, call HighlightContent with that quoted text and its page number to mark it for the user.',
          )
        }
        return {
          url: info.url,
          title: info.title,
          pageCount: info.pageCount,
          pages: blocks.map((b) => ({ page: b.page, text: b.text, ...(b.truncated ? { truncated: true } : {}) })),
          ...(notes.length ? { note: notes.join(' ') } : {}),
        }
      },
    }),

    HighlightContent: tool({
      description:
        'Show the user exactly WHERE on the page your answer comes from: scroll the active tab to a passage or region and mark it like a highlighter pen. Use this proactively whenever your answer is grounded in a specific passage, clause, figure, or section of the page or PDF the user is viewing ("which part mentions…", "what are the terms…"). ALMOST ALWAYS PASS `text` — the passage quoted exactly from the page — because that is the only form that can point at a specific line, and the only one that is verified against the page. `region` marks a whole block by its [rN] number and is for things with no quotable words: a chart, a photo, a diagram. If you are pointing at words, use `text`, even when those words sit inside a table or a figure. Calls accumulate, so highlight each clause of a multi-part answer. On a PDF tab the viewer jumps to the page and the user is shown that page rendered with the passage marked. Highlights stay visible after your answer, until the next question or until the user closes the panel. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe(
            'PREFERRED. The passage to highlight, quoted exactly as it appears on the page or PDF (a phrase to a couple of sentences). Use this for anything made of words.',
          ),
        region: z
          .number()
          .optional()
          .describe(
            'A region number from ReadPage(mode:"regions"), e.g. 2 for [r2]. Marks that whole block — only for charts, images and diagrams with no quotable text. Never guess a number: if you have not just listed the regions, use `text`.',
          ),
        label: z.string().optional().describe('Optional short callout shown beside the highlight, e.g. "Termination clause".'),
        page: z
          .number()
          .optional()
          .describe('PDF only: the page the passage is on (from ReadPdf search/pages). Omit to search the whole PDF.'),
        reason: z.string().describe('Short reason shown to the user, e.g. "To show where the terms are stated"'),
      }),
      execute: async ({ text, region, label, page, reason }) => {
        if (!text?.trim() && region === undefined)
          return { error: 'Pass either `text` (a quoted passage) or `region` (an [rN] number).' }
        const tab = await resolveTab()
        if (tab?.id === undefined) return { error: NO_TAB_ERROR }
        const isPdf = looksLikePdfUrl(tab.url ?? '')
        if (isPdf && region !== undefined)
          return { error: 'The active tab is a PDF — regions do not exist there. Pass `text` (optionally with a `page` from ReadPdf search).' }

        // Same exemption as the other perception tools: an open control session
        // already covers pointing at the page it is driving.
        const open = pageControl.session()
        const owned = !!open && open.active && open.tabId === tab.id
        if (!owned) {
          const summary =
            region !== undefined
              ? 'Highlight a region on this page'
              : `Highlight “${text!.trim().slice(0, 60)}${text!.trim().length > 60 ? '…' : ''}” on ${isPdf ? 'the PDF' : 'this page'}`
          const approved = await requestApproval({ toolName: 'HighlightContent', summary, reason })
          if (!approved) return DENIED
        }

        if (isPdf) {
          const creds = { credentials: 'include' as const }
          const target = tab.url!
          try {
            let targetPage = page
            if (!targetPage) {
              const loaded = await loadPdf(target, creds)
              const found = searchPages(loaded.pages, text!)
              if ('error' in found) return { error: found.error }
              if (found.totalMatches === 0) {
                return {
                  found: false,
                  note: 'That passage was not found in the PDF. Quote the text exactly as ReadPdf returned it (mode:"search" finds its page), or pass a `page` number.',
                }
              }
              targetPage = found.matches[0].page
            }
            const r = await renderPdfPageHighlighted(target, targetPage, text!, creds)
            // Same contract as the screenshot tools: the render is a USER
            // artifact (ShotCard). It never rides imageQueue — the model already
            // knows the text it asked to highlight.
            const shotId = await saveShot({
              dataUrl: r.dataUrl,
              width: r.width,
              height: r.height,
              url: target,
              title: r.title,
              label: label?.trim() || `PDF page ${targetPage} — highlighted`,
              conversationId,
              page: targetPage,
            })
            // Jump the viewer. Chrome's PDF plugin only parses #page=N at
            // document load — a fragment-only tabs.update is a same-document
            // navigation it ignores (the URL bar changes, the page doesn't).
            // So set the URL, then reload, and the viewer re-opens on the
            // target page. Unconditional: even when the fragment already says
            // this page, the user may have scrolled away, and "highlight" means
            // "take me there". Best-effort — a failure still leaves the marked
            // render in chat.
            try {
              await chrome.tabs.update(tab.id, { url: `${target.split('#')[0]}#page=${targetPage}` })
              await chrome.tabs.reload(tab.id)
            } catch {
              /* best-effort */
            }
            return {
              ok: true,
              shotId,
              page: targetPage,
              pageCount: r.pageCount,
              note: `Sent the PDF viewer to page ${targetPage} and showed the user that page with the passage marked${r.matched ? '' : ' (the passage could not be located on that rendered page, so the plain page was shown)'}. The image was not sent to you — you already know the text.`,
            }
          } catch (err) {
            if (err instanceof PdfError) return { error: err.message }
            return { error: `Could not highlight in the PDF (${err instanceof Error ? err.message : String(err)}).` }
          }
        }

        if (region !== undefined) {
          const r = await highlightRegionOnPage(tab.id, region, label)
          // `highlighted` is the ground truth the model needs to catch itself
          // aiming at the wrong block — surface it as data, not just prose.
          return r.found ? { ok: true, region, highlighted: r.hit, note: r.message } : { error: r.message }
        }
        const r = await highlightTextOnPage(tab.id, text!, label)
        return r.found ? { ok: true, occurrences: r.count, note: r.message } : { error: r.message }
      },
    }),

    ToolSearch: tool({
      description:
        "List the tools available to you (name + description), optionally filtered by a query. Tools are not loaded until you select them. After finding what you need, call GetTool with their names to load them. Use this when the user's request needs a capability beyond reading the current page.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Optional keywords to filter the list (matches name + description). Omit to list all.'),
      }),
      execute: async ({ query }) => {
        const tools = searchCatalog(catalog, query)
        // Reference equality IS the fallback signal (see searchCatalog): tell
        // the model plainly, or it reads the full list as a strong match-set.
        return query?.trim() && tools === catalog
          ? { tools, note: 'No tool matched that query directly — this is the complete catalog instead.' }
          : { tools }
      },
    }),

    GetTool: tool({
      description:
        'Load one or more tools by name so you can call them for the rest of this turn. Get names from ToolSearch. Loading a tool does not run it — you still call it afterward, and it still asks the user for permission when it runs.',
      inputSchema: z.object({
        names: z.array(z.string()).min(1).describe('Exact tool names to load, from ToolSearch.'),
      }),
      execute: async ({ names }) => {
        const { valid, unknown } = partitionToolNames(names, catalog)
        valid.forEach((n) => activeNames.add(n))
        if (unknown.length > 0) {
          return { loaded: valid, error: `Unknown tool name(s): ${unknown.join(', ')}. Call ToolSearch to see valid names.` }
        }
        return { loaded: valid, note: 'These tools are now available to call.' }
      },
    }),

    ReadTabs: tool({
      description:
        'List all tabs the user has open (titles, URLs, tab ids), and optionally read specific tabs by id. mode="gist": a one-line summary of EVERY tab plus duplicate detection and pinned/asleep/audible/blank state — the cheap way to understand a whole window before organizing it, and the right first step for any "what do I have open", "find the tab that…", "group my tabs" or "clean up my tabs" request. mode="text": full visible text of the tabs you name; mode="dom": their HTML structure. Pass tabIds to read those tabs; omit tabIds to only list. Asks the user for permission first. Prefer gist over reading many tabs — full pages are large.',
      inputSchema: z.object({
        mode: z
          .enum(['gist', 'text', 'dom'])
          .describe('gist = one-line summary of every tab; text = visible text; dom = HTML structure'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find your open documentation tabs"'),
        tabIds: z
          .array(z.number())
          .optional()
          .describe('Tab ids (from a previous listing) to read. Omit to only list tabs. Ignored for gist, which covers every tab.'),
      }),
      execute: async ({ mode, reason, tabIds }) => {
        const reading = mode !== 'gist' && tabIds && tabIds.length > 0
        const approved = await requestApproval({
          toolName: 'ReadTabs',
          summary:
            mode === 'gist'
              ? 'Skim every open tab (title, site, and a one-line summary)'
              : reading
                ? `Read the ${mode === 'dom' ? 'DOM' : 'content'} of ${tabIds!.length} open tab${tabIds!.length > 1 ? 's' : ''}`
                : 'See the list of your open tabs',
          reason,
        })
        if (!approved) return DENIED

        if (mode === 'gist') {
          const index = await buildTabIndex()
          // The organizing cluster: a model that just skimmed the window is
          // almost always about to file or close something, and making it pay a
          // GetTool round-trip first is pure latency. Loading is not permission —
          // both still raise their own card when actually called.
          activeNames.add('GroupTabs')
          activeNames.add('CloseTabs')
          const asleep = index.tabs.filter((t) => t.discarded).length
          return {
            tabs: index.tabs,
            duplicates: index.duplicates,
            note: [
              `${index.tabs.length} tab(s).`,
              index.duplicates.length
                ? `${index.duplicates.length} set(s) of duplicate pages.`
                : 'No duplicate pages.',
              asleep ? `${asleep} tab(s) are asleep and were not read (reading one would reload it).` : '',
              index.probeLimitHit ? `Only the first ${TAB_GIST_LIMIT} tabs were summarized.` : '',
              'Tabs with an empty gist have a "skipped" reason. You can now use GroupTabs and CloseTabs.',
            ]
              .filter(Boolean)
              .join(' '),
          }
        }

        const tabs = await listOpenTabs()
        if (!reading) return { tabs }
        if (mode === 'dom') {
          const doms = await Promise.all(tabIds!.map((id) => readTabDom(id, MAX_DOM_CHARS_PER_TAB)))
          return { tabs, doms }
        }
        const contents = await Promise.all(tabIds!.map((id) => readTabContent(id)))
        return { tabs, contents }
      },
    }),

    GroupTabs: tool({
      description:
        'Organize the user\'s open tabs into named, colored Chrome tab groups, or pull tabs back out of a group. Call ReadTabs with mode="gist" first so you are grouping by what the pages actually are. Only ungrouped tabs can be filed — groups the user made by hand are left alone — and a group cannot span windows, so a set spread across two windows becomes one group in each. Asks the user for permission first, showing them exactly which tabs move.',
      inputSchema: z
        .object({
          action: z
            .enum(['group', 'ungroup'])
            .describe('group: file tabs into named groups; ungroup: pull tabs out of their group'),
          reason: z
            .string()
            .describe('Short reason shown to the user, e.g. "To gather your thesis sources in one place"'),
          groups: z
            .array(
              z.object({
                name: z.string().describe('Short, specific group name, e.g. "Thesis sources" — not "Group 1".'),
                color: z
                  .enum(TAB_GROUP_COLORS)
                  .optional()
                  .describe('Chrome tab-group color. Omit to have one chosen.'),
                tabIds: z.array(z.number()).min(1).describe('Tabs to put in this group.'),
              }),
            )
            .optional()
            .describe('Required for action="group".'),
          tabIds: z.array(z.number()).optional().describe('Required for action="ungroup".'),
        })
        .refine((v) => (v.action === 'group' ? !!v.groups?.length : !!v.tabIds?.length), {
          message: 'group requires groups; ungroup requires tabIds.',
        }),
      execute: async ({ action, reason, groups, tabIds }) => {
        const open = await listTabFacts()
        const byId = new Map(open.map((t) => [t.tabId, t]))

        if (action === 'ungroup') {
          const known = (tabIds ?? []).filter((id) => byId.has(id))
          if (known.length === 0) return { error: 'None of those tabs are open any more.' }
          const approved = await requestApproval({
            toolName: 'GroupTabs',
            summary: `Take ${known.length} tab${known.length > 1 ? 's' : ''} out of ${known.length > 1 ? 'their groups' : 'its group'}`,
            reason,
            items: known.map((id) => ({ title: byId.get(id)!.title, host: byId.get(id)!.host })),
          })
          if (!approved) return DENIED
          return await ungroupTabs(known)
        }

        const plan = planGrouping(groups ?? [], open)
        if (plan.groups.length === 0) {
          return {
            grouped: [],
            rejected: plan.rejected,
            error:
              'Nothing could be grouped. Tabs already in a group are left alone, pinned tabs cannot be grouped, and a group needs at least 2 tabs in the same window.',
          }
        }
        const total = plan.groups.reduce((n, g) => n + g.tabIds.length, 0)
        const approved = await requestApproval({
          toolName: 'GroupTabs',
          summary: `Sort ${total} tabs into ${plan.groups.length} group${plan.groups.length > 1 ? 's' : ''}`,
          reason,
          // One row per tab, labelled with the group it is headed for, so the
          // user is approving the actual filing rather than a headline number.
          items: plan.groups.flatMap((g) =>
            g.tabIds.map((id) => ({
              title: byId.get(id)?.title ?? `Tab ${id}`,
              host: byId.get(id)?.host ?? '',
              note: `→ ${g.name}`,
            })),
          ),
          // Naming and coloring a group is the whole point, and that needs the
          // optional tabGroups permission. Requested from this card's Allow
          // click, which is the user gesture Chrome requires.
          needsPermissions: ['tabGroups'],
        })
        if (!approved) return DENIED
        const outcome = await applyGrouping(plan.groups)
        return {
          grouped: outcome.created.map((g) => ({ name: g.name, color: g.color, tabIds: g.tabIds })),
          failed: outcome.failed,
          rejected: plan.rejected,
        }
      },
    }),

    CloseTabs: tool({
      description:
        "Close tabs the user no longer needs, or reopen the batch you last closed. Call ReadTabs with mode=\"gist\" first — it reports duplicates and blank tabs, which are what is usually worth closing. Never closes the tab the user is looking at, pinned tabs, or the last tab of a window. The user sees and confirms the full list every time.",
      inputSchema: z
        .object({
          action: z
            .enum(['close', 'reopen'])
            .describe('close: close the listed tabs; reopen: restore the batch you last closed'),
          reason: z
            .string()
            .describe('Short reason shown to the user, e.g. "These are duplicates of tabs you already have open"'),
          tabIds: z.array(z.number()).optional().describe('Tabs to close. Required for action="close".'),
        })
        .refine((v) => (v.action === 'close' ? !!v.tabIds?.length : true), {
          message: 'close requires tabIds.',
        }),
      execute: async ({ action, reason, tabIds }) => {
        if (action === 'reopen') {
          const stash = await readClosedStash()
          if (!stash) return { error: 'Nothing was closed recently, so there is nothing to reopen.' }
          const approved = await requestApproval({
            toolName: 'CloseTabs',
            summary: `Reopen ${stash.tabs.length} tab${stash.tabs.length > 1 ? 's' : ''} you closed earlier`,
            reason,
            items: stash.tabs.map((t) => ({ title: t.title, host: hostOf(t.url) })),
          })
          if (!approved) return DENIED
          return await reopenClosedTabs()
        }

        const open = await listTabFacts()
        const byId = new Map(open.map((t) => [t.tabId, t]))
        const plan = planClosure(tabIds ?? [], open)
        if (plan.close.length === 0) {
          return {
            closed: 0,
            rejected: plan.rejected,
            error: 'None of those tabs can be closed. The active tab, pinned tabs, and the last tab of a window are always kept.',
          }
        }
        const approved = await requestApproval({
          toolName: 'CloseTabs',
          summary: `Close ${plan.close.length} tab${plan.close.length > 1 ? 's' : ''}`,
          reason,
          items: plan.close.map((id) => ({
            title: byId.get(id)?.title ?? `Tab ${id}`,
            host: byId.get(id)?.host ?? '',
          })),
          danger: true,
          // No "Allow this chat" for closing. A standing allowance would mean a
          // later batch closes with no card at all, which is not a trade anyone
          // should be able to make in one click.
          once: true,
        })
        if (!approved) return DENIED
        const result = await closeTabs(plan.close)
        if (result.error) return { closed: 0, error: result.error, rejected: plan.rejected }
        // What was actually confirmed removed, not the pre-approval plan
        // count: an id can vanish in the human-reaction-time gap between
        // planning this batch and closeTabs() actually stashing/removing it.
        const closed = result.closed.length
        return {
          closed,
          rejected: plan.rejected,
          note:
            result.recoverable >= closed
              ? 'Closed tabs were saved — call CloseTabs with action="reopen" to undo this.'
              : `Only the first ${result.recoverable} of ${closed} closed tabs were saved; action="reopen" will restore those.`,
        }
      },
    }),

    RequestPageControl: tool({
      description:
        'Ask the user for permission to control the active tab to carry out a task (fill a form, click through a flow, navigate). State a concise plan. On approval you get a page-control session and the first element list; then use ControlPage for each step and ReadPage (mode "elements") to re-read. Point-of-no-return steps (submitting, cross-site navigation, passwords/payments) still ask each time.',
      inputSchema: z.object({
        plan: z
          .string()
          .describe('One or two sentences: what you will do on the page and where you will stop.'),
      }),
      execute: async ({ plan }) => {
        const tab = await resolveTab()
        if (tab?.id === undefined) return { error: NO_TAB_ERROR }
        // Before the consent card, not after: a control session the user cannot
        // watch is precisely what the presence overlay exists to prevent.
        if (!(await isForeground(tab))) return parkFor(tab, 'take control of this page')
        const host = (() => {
          try {
            return new URL(tab.url ?? '').host
          } catch {
            return tab.url ?? 'this page'
          }
        })()
        const origin = (() => {
          try {
            return new URL(tab.url ?? '').origin
          } catch {
            return ''
          }
        })()
        const granted = await pageControl.requestSession({ plan, host, origin, tabId: tab.id })
        if (!granted) return DENIED
        // Load the control cluster so the model can act without a second GetTool
        // round-trip once a session is open. GetScreenshot joins it so the model can
        // check its own work — confirm a click landed, catch a modal the element
        // list does not convey — without breaking stride. (Harmless when the model
        // is text-only: GetScreenshot still saves the shot for the user, and its
        // result tells the model plainly that no image was sent, so it does not loop.)
        activeNames.add('ControlPage')
        activeNames.add('AutofillForm')
        activeNames.add('GetScreenshot')
        await mountPresence(tab.id)
        // Entering active control: turn the soft dark tint on (ambient shows the
        // frame only). The spotlight/cursor come alive on the first ControlPage.
        await setTint(tab.id, true)
        try {
          const snap = await snapshotPage(tab.id)
          return await lookResult(tab, snap, { started: true }, selected, visionCapable, imageQueue)
        } catch (err) {
          pageControl.endSession()
          return { error: `Cannot control this page (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),

    ControlPage: tool({
      description:
        'Perform ONE action on the active tab within an open page-control session: click, type, select, scroll, highlight, navigate, press a key, or wait. Target elements by their [index] from ReadPage (mode "elements")/RequestPageControl. wait: pause until the page settles or an optional CSS selector (passed in text) appears. Returns the refreshed element list.',
      inputSchema: z.object({
        action: z.enum(['click', 'type', 'select', 'scroll', 'highlight', 'navigate', 'press', 'wait']),
        index: z.number().optional().describe('Target element index from the list.'),
        text: z.string().optional().describe('Text to type (action=type), or a CSS selector to wait for (action=wait).'),
        value: z.string().optional().describe('Option value or label (action=select).'),
        url: z.string().optional().describe('URL to open (action=navigate).'),
        keys: z.string().optional().describe('Key to press: Enter, Tab, or Escape (action=press).'),
        direction: z.enum(['up', 'down', 'toElement']).optional().describe('Scroll direction (action=scroll).'),
        label: z.string().optional().describe('Callout text to show on the page (action=highlight).'),
        clear: z.boolean().optional().describe('Replace existing text instead of appending (action=type).'),
        sensitive: z.boolean().optional().describe('Set true if this step is risky; forces a confirm.'),
        timeoutMs: z.number().optional().describe('Max ms to wait for the page to settle (action=wait).'),
      }),
      execute: async (spec: ControlSpec) => {
        const session = pageControl.session()
        if (!session || !session.active)
          return { error: 'No page-control session is open. Call RequestPageControl first.' }
        const tab = await resolveTab()
        if (tab?.id === undefined || tab.id !== session.tabId)
          return { error: 'The controlled tab is no longer active.' }
        // Park rather than click blind. The session itself survives — the user
        // granted it and hasn't revoked it — so returning to the tab resumes the
        // flow mid-plan instead of asking for control a second time.
        if (!(await isForeground(tab))) return parkFor(tab, 'act on this page')
        // The presence overlay lives in the page's DOM, which any navigation
        // wipes. For the life of a session the overlay must persist, so
        // re-establish it at the top of every step: idempotent when it's still
        // there, and it restores the tint/frame after a prior step's navigation
        // (an explicit navigate, a click that loaded a new page, a cross-origin
        // drift) destroyed them. Covers the drift branch's early returns too.
        await mountPresence(tab.id)
        await setTint(tab.id, true)
        const liveOrigin = (() => {
          try {
            return new URL(tab.url ?? '').origin
          } catch {
            return ''
          }
        })()
        // Origin drifted since the last step — a full-page nav that committed
        // after that step's post-action snapshot. If the previous step's approved
        // point-of-no-return authorized the crossing, re-fence silently (no
        // second grant); otherwise ask once to continue. Either way, hand back
        // the fresh page instead of running this call's action against a
        // now-stale element index.
        if (liveOrigin !== session.origin) {
          if (!session.crossingAuthorized) {
            const cont = await requestApproval({
              toolName: 'ControlPage',
              summary: `Keep controlling the page now that it moved to ${hostLabel(liveOrigin)}?`,
              reason: 'The page navigated to a different site on its own.',
              once: true,
            })
            if (!cont) {
              pageControl.endSession()
              return {
                error: `The page moved to ${hostLabel(liveOrigin)}; page control ended for safety. Call RequestPageControl again to continue.`,
              }
            }
          }
          session.origin = liveOrigin
          session.crossingAuthorized = false
          try {
            const fresh = await snapshotPage(tab.id)
            return {
              ok: true,
              message: `The page is now on ${hostLabel(liveOrigin)}; re-read the elements and continue.`,
              urlChanged: true,
              elements: fresh.text,
            }
          } catch (err) {
            return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
          }
        }
        let snap
        try {
          snap = await snapshotPage(tab.id)
        } catch (err) {
          return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
        }
        const el = spec.index !== undefined ? snap.elements[spec.index] : undefined
        const por = isPointOfNoReturn(spec, el, session.origin)
        if (por) {
          const approved = await requestApproval({
            toolName: 'ControlPage',
            summary: pointOfNoReturnSummary(spec, el),
            reason: 'This step changes state or leaves the page.',
            once: true,
          })
          if (!approved) return DENIED
          // The card's summary was built from `el` as it stood BEFORE the
          // human reaction-time wait inside requestApproval. Re-read the page
          // now and re-check that the same element is still at this index —
          // an ordinary async re-render (a price/coupon recalculation
          // relabeling this exact button) can swap what the stamp points to
          // while the card was on screen, and the user approved what the card
          // said, not necessarily what is about to actually happen.
          try {
            const freshSnap = await snapshotPage(tab.id)
            const freshEl = spec.index !== undefined ? freshSnap.elements[spec.index] : undefined
            if (hasElementChanged(el, freshEl)) {
              return {
                error:
                  'The page changed while you were waiting for approval — re-read the elements (ReadPage or ControlPage) and try again.',
              }
            }
            snap = freshSnap
          } catch {
            // Best-effort: if the re-read itself fails, proceed on the
            // original (already-approved) snapshot rather than dead-end here.
          }
        }
        const { registry, ok, message, urlChanged, origin } = await runControlStep({
          tabId: tab.id,
          spec,
          snapshot: snap,
          beforeAct: (index) => (index === undefined ? Promise.resolve() : focusOn(tab.id!, index, spec.label)),
          afterAct: () => pulse(tab.id!),
          afterNav: async () => {
            await mountPresence(tab.id!)
            await setTint(tab.id!, true)
          },
        })
        // Handle an origin change this action caused. When the post-action
        // snapshot already shows the new origin (explicit navigate — which
        // settles 600ms — or a same-document/SPA nav), re-fence here so the next
        // call proceeds directly: an approved point-of-no-return re-fences
        // silently; an unexpected crossing (a plain click that JS-navigated, a
        // role=link with no href) asks once, and deny ends the session. When the
        // snapshot did NOT show a change (a full-page load may still be
        // committing), remember whether this step was an approved crossing so the
        // next call's drift check re-fences without a second grant.
        if (origin && origin !== session.origin) {
          if (!por) {
            const cont = await requestApproval({
              toolName: 'ControlPage',
              summary: `Keep controlling the page now that it moved to ${hostLabel(origin)}?`,
              reason: 'The page navigated to a different site on its own.',
              once: true,
            })
            if (!cont) {
              pageControl.endSession()
              return {
                error: `The page moved to ${hostLabel(origin)}; page control ended for safety. Call RequestPageControl again to continue.`,
              }
            }
          }
          session.origin = origin
          session.crossingAuthorized = false
        } else {
          session.crossingAuthorized = por
        }
        // Coerce to a real boolean: `urlChanged` is undefined for non-navigation
        // actions, and a tool result must not carry undefined into the history.
        return { ok, message, urlChanged: urlChanged === true, elements: registry }
      },
    }),

    /** Fills mapped, non-sensitive fields from saved profile memories inside an already-open page-control session; sensitive fields still raise a one-shot point-of-no-return card, and submit is never part of this tool. */
    AutofillForm: tool({
      description:
        'Fill the form on the active tab from the user\'s saved profile memories, within an open page-control session. Maps profile details (name, email, address…) to the indexed fields you pass. Sensitive fields (passwords, payment) and any submit still ask each time. Never invents secrets.',
      inputSchema: z.object({
        fields: z.array(z.object({
          index: z.number().describe('Target field [index] from ReadPage (mode "elements").'),
          value: z.string().describe('The value to enter (you map this from profile memories).'),
          sensitive: z.boolean().optional().describe('True for passwords/payment; forces a confirm and is skipped if not user-provided.'),
        })).describe('The fields to fill and the values to enter.'),
      }),
      execute: async ({ fields }) => {
        const session = pageControl.session()
        if (!session || !session.active) return { error: 'No page-control session is open. Call RequestPageControl first.' }
        const tab = await resolveTab()
        if (tab?.id === undefined || tab.id !== session.tabId) return { error: 'The controlled tab is no longer active.' }
        // Typing into a page the user cannot see is the least watchable thing
        // this agent does — park it like any other control step.
        if (!(await isForeground(tab))) return parkFor(tab, 'fill in this form')
        const profile = await getProfileMemories()
        const filled: number[] = []
        const staleSkipped: number[] = []
        for (const f of fields) {
          let snap
          try { snap = await snapshotPage(tab.id) } catch { return { error: 'Cannot read this page.' } }
          if (snap.origin !== session.origin) {
            pageControl.endSession()
            return { filled, error: 'The page is now on a different site; autofill stopped and page control ended for safety.' }
          }
          const el = snap.elements[f.index]
          const spec: ControlSpec = { action: 'type', index: f.index, text: f.value, clear: true, sensitive: f.sensitive }
          if (isPointOfNoReturn(spec, el, session.origin)) {
            const approved = await requestApproval({ toolName: 'AutofillForm', summary: `Fill a sensitive field (${el?.name ?? f.index})`, reason: 'This field is sensitive.', once: true })
            if (!approved) continue
            // Same re-check as ControlPage (see its comment): the card's
            // summary was built from `el` as it stood before this wait, so
            // re-verify the field is still the same one before typing into it.
            try {
              const freshSnap = await snapshotPage(tab.id)
              if (freshSnap.origin !== session.origin) {
                pageControl.endSession()
                return { filled, error: 'The page is now on a different site; autofill stopped and page control ended for safety.' }
              }
              if (hasElementChanged(el, freshSnap.elements[f.index])) {
                staleSkipped.push(f.index)
                continue
              }
              snap = freshSnap
            } catch {
              staleSkipped.push(f.index)
              continue
            }
          }
          await runControlStep({
            tabId: tab.id, spec, snapshot: snap,
            beforeAct: (i) => (i === undefined ? Promise.resolve() : focusOn(tab.id!, i, undefined)),
            afterAct: () => pulse(tab.id!),
          })
          filled.push(f.index)
        }
        return {
          filled,
          note:
            `Filled ${filled.length} field(s) from profile. Profile memories available: ${profile.length}. Submit is a separate, confirmed step.` +
            (staleSkipped.length
              ? ` Skipped field(s) ${staleSkipped.join(', ')} — the page changed while waiting for approval; re-read the page and try again for those.`
              : ''),
        }
      },
    }),

    NavigateTab: tool({
      description:
        "Drive the user's tabs: switch to an existing tab, load a URL in a tab, or open a new tab. Use when the user asks you to go to a page, switch tabs, or open something. Asks the user for permission first.",
      inputSchema: z
        .object({
          reason: z
            .string()
            .describe('Short reason shown to the user, e.g. "To open the API documentation"'),
          action: z
            .enum(['activate', 'goto', 'open'])
            .describe(
              'activate: focus an existing tab by tabId; goto: load a url in a tab (the active tab if tabId omitted); open: open a new tab at a url',
            ),
          tabId: z
            .number()
            .optional()
            .describe('Target tab id. Required for activate; optional for goto (defaults to the active tab).'),
          url: z.string().optional().describe('Destination URL. Required for goto and open.'),
        })
        .refine((v) => (v.action === 'activate' ? v.tabId !== undefined : !!v.url), {
          message: 'activate requires tabId; goto and open require url.',
        }),
      execute: async ({ reason, action, tabId, url }) => {
        const summary =
          action === 'activate'
            ? `Switch to tab #${tabId}`
            : action === 'open'
              ? `Open a new tab at ${url}`
              : `Navigate ${tabId !== undefined ? `tab #${tabId}` : 'the current tab'} to ${url}`
        const approved = await requestApproval({ toolName: 'NavigateTab', summary, reason })
        if (!approved) return DENIED
        // Pre-navigation intent cue for `goto` only: on the tab's *current* page
        // — the one window where there's still content to dim — glide the cursor,
        // pop a "Navigating to <host>…" pill, then darken with a blue shimmer,
        // before the load swaps the DOM. `open` starts on a blank new tab and
        // `activate` loads no URL, so neither qualifies. Resolve the target up
        // front since `goto` may omit tabId (defaults to the active tab). Awaited
        // so the cue plays out first, but best-effort — a restricted page just
        // skips it and navigation proceeds.
        // Tracks which tab (if any) actually got the nav-intent cue, so a
        // failed navigation below knows what to tear down.
        let navCueTabId: number | undefined
        if (action === 'goto' && url) {
          const targetId = tabId ?? (await resolveTab())?.id
          if (targetId !== undefined) {
            let host: string
            try {
              host = new URL(url).host
            } catch {
              host = url
            }
            await animateNavIntent(targetId, `Navigating to ${host}…`)
            navCueTabId = targetId
          }
        }
        const result = await navigateTab(action, { tabId, url })
        // Ambient presence on the tab the agent just moved to (frame only, no
        // dimming). For goto/open the new document is still loading, so wait a
        // beat — matching runControlStep's post-navigate delay — before mounting,
        // and await it so the frame can't land after the turn's teardown.
        // Restricted URLs (chrome://) fail the inject silently. 'activate' is
        // already loaded, so mount immediately.
        if (!result.error && result.tabId >= 0) {
          if (action !== 'activate') await new Promise((r) => setTimeout(r, 600))
          await mountPresence(result.tabId)
        } else if (navCueTabId !== undefined) {
          // animateNavIntent's own contract ("the load then wipes the
          // overlay, so there is nothing to tear down") only holds when the
          // navigation actually succeeds. On failure (malformed URL, blocked
          // by policy) the page never navigates, so nothing wipes the dark
          // tint/shimmer/"Navigating to…" pill it just played — tear it down
          // explicitly instead of leaving the tab stuck looking mid-navigation
          // for the rest of the turn.
          await unmountPresence(navCueTabId)
        }
        return { action, ...result }
      },
    }),

    ExtractData: tool({
      description:
        'Extract structured data from the active tab into a caller-defined JSON schema. Use when the user wants records pulled out — a table, a list of items, fields from a page — as clean JSON. Asks permission first.',
      inputSchema: z.object({
        reason: z.string().describe('Short reason shown to the user, e.g. "To pull the product table into a list"'),
        instruction: z.string().describe('What to extract, e.g. "every product with name and price"'),
        schema: z.record(z.any()).describe('A JSON Schema object describing the desired output shape.'),
      }),
      execute: async ({ reason, instruction, schema }, { abortSignal }) => {
        const approved = await requestApproval({
          toolName: 'ExtractData',
          summary: 'Extract structured data from this page',
          reason,
        })
        if (!approved) return DENIED
        if (!selected) return { error: 'No model is configured.' }
        const tab = await resolveTab()
        if (tab?.id === undefined) return { error: NO_TAB_ERROR }
        const page = await readTabContent(tab.id)
        if (page.error) return { error: page.error }
        const source = page.text
        const model = createModel(selected.provider, selected.modelId)
        const prompt = `${instruction}\n\nSource page content:\n${source.slice(0, 40_000)}`
        try {
          return { data: await extractStructured(model, prompt, schema as Record<string, unknown>, abortSignal, trace) }
        } catch (err) {
          return { error: `Could not extract structured data (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),

    SaveMemory: tool({
      description:
        'Save a durable memory about the user to local long-term storage (the browser\'s IndexedDB). Use when the user shares something worth remembering across conversations — who they are, preferences, ongoing projects — or explicitly asks you to remember something. Asks the user for permission first. Do not store secrets like passwords or API keys.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "So I remember your preferred format"'),
        kind: z
          .enum(['fact', 'preference', 'project', 'profile'])
          .describe(
            'fact: stable info about the user; preference: how they want you to behave; project: ongoing work or goals; profile: a reusable personal detail for filling forms (name, email, address)',
          ),
        content: z
          .string()
          .describe('The memory as one self-contained sentence, understandable without this conversation'),
        tags: z.array(z.string()).optional().describe('A few lowercase keywords to help future recall'),
      }),
      execute: async ({ reason, kind, content, tags }) => {
        const approved = await requestApproval({
          toolName: 'SaveMemory',
          summary: `Remember: “${content}”`,
          reason,
        })
        if (!approved) return DENIED
        const record = await saveMemory({ kind, content, tags, source: 'agent' })
        return { saved: true, id: record.id, content: record.content }
      },
    }),

    SearchMemory: tool({
      description:
        'Search your long-term memories from past conversations (saved explicitly or distilled during nightly memory consolidation). The most relevant memories are already in your system prompt — use this to dig deeper when the user references past context you cannot see. Asks the user for permission first.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To recall what we discussed about your thesis"'),
        query: z.string().describe('Keywords to search memory contents and tags'),
      }),
      execute: async ({ reason, query }) => {
        const approved = await requestApproval({
          toolName: 'SearchMemory',
          summary: `Search saved memories for “${query}”`,
          reason,
        })
        if (!approved) return DENIED
        const memories = await searchMemories(query)
        if (memories.length === 0) return { memories: [], note: 'No matching memories found.' }
        return {
          memories: memories.map((m) => ({
            id: m.id,
            kind: m.kind,
            content: m.content,
            updatedAt: new Date(m.updatedAt).toISOString().slice(0, 10),
          })),
        }
      },
    }),

    QueryBrowserData: tool({
      description:
        `Draw on the user's own browser data. source="history": pages they visited; source="bookmarks": saved bookmarks; source="topSites": most-visited sites; source="downloads": downloaded files. Only enabled sources work (currently: ${sourcesLabel}). Asks the user for permission first. Use when the user refers to something they read, saved, or downloaded but did not share.`,
      inputSchema: z.object({
        source: z
          .enum(['history', 'bookmarks', 'topSites', 'downloads'])
          .describe('Which browser-data source to query'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the article you read about X"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match (history / bookmarks / downloads). Omit to list recent.'),
        sinceDays: z.number().optional().describe('history only: how many days back (default 7).'),
        state: z
          .enum(['complete', 'in_progress', 'interrupted'])
          .optional()
          .describe('downloads only: filter by state.'),
        maxResults: z.number().optional().describe('Max entries to return.'),
      }),
      execute: async ({ source, reason, query, sinceDays, state, maxResults }) => {
        if (!granted.has(source)) {
          return { error: `The "${source}" source is not enabled. Ask the user to grant it in Settings → Permissions.` }
        }
        const summary =
          source === 'topSites'
            ? 'See your most-visited sites'
            : source === 'history'
              ? query
                ? `Search your browsing history for “${query}”`
                : 'Look through your recent browsing history'
              : source === 'bookmarks'
                ? query
                  ? `Search your bookmarks for “${query}”`
                  : 'List your recent bookmarks'
                : 'Look through your downloads'
        const approved = await requestApproval({ toolName: 'QueryBrowserData', summary, reason })
        if (!approved) return DENIED
        if (source === 'history') return { history: await getBrowsingHistory({ query, sinceDays, maxResults }) }
        if (source === 'bookmarks') return { bookmarks: await getBookmarks({ query, maxResults }) }
        if (source === 'topSites') return { sites: await getTopSites() }
        return { downloads: await getDownloads({ query, state, maxResults }) }
      },
    }),

    ListAllSkills: tool({
      description:
        'List all skills available to you (name + description). The most relevant skills are already summarized in your system prompt; use this to see the full current list before loading one with ReadSkill.',
      inputSchema: z.object({}),
      execute: async () => {
        const approved = await requestApproval({
          toolName: 'ListAllSkills',
          summary: 'List your saved skills',
          reason: 'To see which skills are available',
        })
        if (!approved) return DENIED
        const skills = await listSkillMetas({ modelInvocableOnly: true })
        return { skills }
      },
    }),

    ReadSkill: tool({
      description:
        "Load the full instructions for a skill by name, then follow them for the current task. Use when the user invokes a skill or when a request matches a skill listed in your system prompt. Returns the skill's instruction body.",
      inputSchema: z.object({
        name: z.string().describe('The exact skill name to load, e.g. "summarizing-pages"'),
      }),
      execute: async ({ name }) => {
        const approved = await requestApproval({
          toolName: 'ReadSkill',
          summary: `Load the “${name}” skill`,
          reason: "To follow this skill's instructions",
        })
        if (!approved) return DENIED
        const skill = await getSkill(name)
        if (!skill) return { error: `No skill named "${name}". Use ListAllSkills to see valid names.` }
        if (skill.enabled === false)
          return { error: `The "${name}" skill is turned off in Settings → Skills.` }
        if (!skill.modelInvocable)
          return { error: `The "${name}" skill can only be run when the user types /${name}; it cannot be auto-loaded.` }
        return { name: skill.name, description: skill.description, body: skill.body }
      },
    }),

    SaveSkill: tool({
      description:
        "Create or update a skill in the user's local Skills Library. Use when the user has agreed on a skill to save (for example during /create-skill). Upserts by name; an existing custom skill with the same name is overwritten. Asks the user for permission first. Built-in skills cannot be overwritten.",
      inputSchema: z.object({
        name: z
          .string()
          .describe('Skill slug: lowercase letters, numbers and single hyphens, ≤64 chars (e.g. "drafting-replies")'),
        description: z
          .string()
          .describe('Third-person sentence stating what the skill does and when to use it, with trigger keywords'),
        body: z.string().describe('The Markdown instruction body the assistant follows when the skill runs'),
        icon: z.string().optional().describe('A single emoji to represent the skill in the Library'),
        userInvocable: z
          .boolean()
          .optional()
          .describe('Whether the user can run it by typing /name (default true)'),
        modelInvocable: z
          .boolean()
          .optional()
          .describe('Whether you may auto-load it via ReadSkill when relevant (default true). Set false for user-only actions.'),
      }),
      execute: async ({ name, description, body, icon, userInvocable, modelInvocable }) => {
        const approved = await requestApproval({
          toolName: 'SaveSkill',
          summary: `Save skill “${name}”`,
          reason: description,
        })
        if (!approved) return DENIED
        try {
          const saved = await saveSkill({ name, description, body, icon, userInvocable, modelInvocable })
          return { saved: true, name: saved.name }
        } catch (err) {
          // Validation / built-in-overwrite failures come back as text so the
          // model can correct the name and retry rather than treating it as denial.
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    ListMcpResources: tool({
      description:
        "List the resources (documents, data, files) exposed by the user's connected MCP servers — names, URIs and mime types, per server. Use before ReadMcpResource to find what a server offers.",
      inputSchema: z.object({
        server: z.string().optional().describe('Limit to one server by name. Omit to list all.'),
      }),
      execute: async ({ server }) => {
        const approved = await requestApproval({
          toolName: 'ListMcpResources',
          summary: server ? `List resources on the ${server} MCP server` : 'List MCP server resources',
          reason: 'To see which resources are available',
        })
        if (!approved) return DENIED
        const runtime = getMcpManager()
          .runtime()
          .filter((r) => (server ? r.name === server : true))
        if (runtime.length === 0)
          return { error: server ? `No MCP server named "${server}".` : 'No MCP servers are configured.' }
        return {
          servers: runtime.map((r) => ({
            server: r.name,
            status: r.status,
            resources: r.resources.slice(0, 100),
          })),
          note: 'Read one with ReadMcpResource (server + uri). A disconnected server may list stale or no resources.',
        }
      },
    }),

    ReadMcpResource: tool({
      description:
        'Read one resource from a connected MCP server by its URI (find URIs with ListMcpResources). Text is returned to you; images/media are shown to the user. Asks the user for permission first.',
      inputSchema: z.object({
        server: z.string().describe('The MCP server name, as configured by the user.'),
        uri: z.string().describe('The resource URI, from ListMcpResources or a tool result.'),
        reason: z.string().describe('Short reason shown to the user, e.g. "To read the project spec"'),
      }),
      execute: async ({ server, uri, reason }, { abortSignal }) => {
        const approved = await requestApproval({
          toolName: 'ReadMcpResource',
          summary: `Read “${uri}” from the ${server} MCP server`,
          reason,
        })
        if (!approved) return DENIED
        let result
        try {
          result = await getMcpManager().readResource(server, uri, { signal: abortSignal })
        } catch (err) {
          return { error: `Could not read the resource (${err instanceof Error ? err.message : String(err)}).` }
        }
        const mapped = mapResourceResult(result as { contents?: unknown[] }, { server })
        const artifactIds: string[] = []
        for (const a of mapped.artifacts) {
          try {
            artifactIds.push(await saveMcpArtifact({ ...a, conversationId, server, tool: 'resource' }))
          } catch {
            /* best-effort */
          }
        }
        const value = { ...mapped.modelValue }
        if (mapped.images.length > 0) {
          if (visionCapable) imageQueue.push(...mapped.images)
          else
            value.note = [value.note, 'You cannot view images, so the image was shown to the user only.']
              .filter(Boolean)
              .join(' ')
        }
        if (artifactIds.length > 0) value.artifactIds = artifactIds
        return value
      },
    }),
  }

  // Background web research: gated in the foreground (this card), then handed
  // off to the offscreen research host, which runs the real (ungated) research
  // tools headlessly — see src/tools/research.ts and src/agent/research.ts.
  Object.assign(tools, createStartResearchTool(requestApproval, conversationId))

  // MCP server tools, pre-gated and policy-filtered by buildMcpTools. Built-in
  // names win a collision (the mcp_ prefix makes one implausible anyway).
  if (extraTools) {
    for (const [name, t] of Object.entries(extraTools)) {
      if (!(name in tools)) tools[name] = t
    }
  }

  // Honor the tab-visibility preference chosen in onboarding: in active-tab
  // mode the model never even sees a tool that could enumerate other tabs —
  // which covers organizing and closing them too, since both start from
  // enumeration and both act on tabs the user never pointed at.
  if (tabAccess !== 'all-tabs') {
    delete tools.ReadTabs
    delete tools.GroupTabs
    delete tools.CloseTabs
  }

  // Browsing-data is hidden unless the user has granted at least one optional
  // permission. The single QueryBrowserData tool is removed only when NO source
  // is granted; per-source gating happens inside its execute (and the granted
  // sources are named in its description) so the model never requests an
  // ungranted source.
  if (grantedSources.length === 0) delete tools.QueryBrowserData

  // The MCP resource tools exist only when the user has configured at least one
  // MCP server — same principle as QueryBrowserData: a capability the user
  // never set up should not appear in the model's catalog at all.
  if (getMcpManager().runtime().length === 0) {
    delete tools.ListMcpResources
    delete tools.ReadMcpResource
  }

  // Honor the per-tool permission policy: a tool set to "Never" is removed
  // entirely (like the visibility/insight gates above), so the model never even
  // sees it. "Ask"/"Always" only differ at the approval gate (see requestApproval).
  for (const name of Object.keys(tools)) {
    if (policyFor(name) === 'never') delete tools[name]
  }

  // Catalog is derived AFTER every deletion above, so ToolSearch/GetTool can
  // never surface or load a tool the user disabled or lacks permission for.
  catalog = buildCatalog(tools)

  // Observability: wrap the surviving tools so each call is a Langfuse span
  // (input, output/error, duration, approval outcome). Only when a trace exists.
  if (trace) instrumentToolset(tools, trace)

  return tools
}
