import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { saveMemory, searchMemories, getProfileMemories } from '../data/memory'
import { getSkill, listSkillMetas, saveSkill } from '../data/skills'
import type { ProviderConfig, TabAccess, ToolPolicy } from '../data/settings'
import { getActiveTab, listOpenTabs, navigateTab, readTabContent, readTabDom } from '../platform/tabs'
import { getBrowsingHistory, getBookmarks, getTopSites, getDownloads } from '../platform/browsingData'
import type { BrowsingCapability } from '../platform/permissions'
import { snapshotPage, type PageSnapshot } from '../platform/domIndex'
import { snapshotRegions } from '../platform/regionIndex'
import { capture, tileShot, ShotError } from '../platform/screenshot'
import { saveShot } from '../data/screenshots'
import type { QueuedImage } from '../agent/agent'
import { mountPresence, setTint, focusOn, pulse, setPresenceHidden } from '../platform/presence'
import { captureWithMarks } from '../platform/marks'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { instrumentToolset, type Trace } from '../agent/observability'
import { createStartResearchTool } from './research'
import { buildCatalog, searchCatalog, partitionToolNames, type CatalogEntry } from './toolDiscovery'
import {
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

export interface ApprovalRequest {
  toolName: string
  /** One-line, human-readable description of what will happen. */
  summary: string
  /** The model's stated reason, shown to the user. */
  reason: string
  /** When true, the card must NOT offer "Allow this chat" — the action must be confirmed every time (point-of-no-return page actions). */
  once?: boolean
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

// Image budgets. A stitched page is handed to the model as several legible tiles
// rather than one illegible squashed strip (see planTiles), so one Screenshot call
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
   * ensureVisionCapability, resolved by the caller before this runs). When false
   * the Screenshot tool is removed entirely — a tool whose entire output is an
   * image the model cannot see is worse than no tool, because the model will call
   * it, get an empty-handed text result, and try again.
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
): ToolSet {
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

  const tools: ToolSet = {
    ReadPage: tool({
      description:
        'Read the tab the user is currently viewing. mode="text": title, URL, selected text and full visible text. mode="dom": the cleaned HTML structure (tags, attributes, links, form fields) when you need page structure rather than visible text. mode="elements": a numbered list of interactive elements (buttons, links, inputs) each with an [index] — use before controlling a page, or to re-read after it changes. mode="regions": a numbered list of VISUAL regions (charts, figures, tables, images, cards, sections) each with an [rN] — use to find something worth looking at, then pass its number to Screenshot. Asks the user for permission first (except while a page-control session already owns this tab).',
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
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
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
              note: 'Pass a region number to Screenshot as `region` (e.g. region: 2 for [r2]) to look at it.',
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
        return await readTabContent(tab.id)
      },
    }),

    Screenshot: tool({
      description:
        'LOOK at the active tab as an image. Use when the page has to be SEEN rather than read: a chart, diagram, map, photo, rendered layout, or anything whose meaning is visual and would be lost as text. Also use it to check your own work after a ControlPage action — to confirm a click landed, or to spot a modal, error, or CAPTCHA the element list does not convey. target="element" needs a `region` number from ReadPage(mode:"regions") (preferred) or a CSS `selector`; target="viewport" shoots what is on screen; target="fullpage" scrolls and stitches the whole page. Prefer element or viewport: a full page costs several images. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        target: z
          .enum(['viewport', 'element', 'fullpage'])
          .describe('viewport = what is on screen; element = one region/selector; fullpage = the whole scrolled page'),
        region: z
          .number()
          .optional()
          .describe('For target="element": the region number from ReadPage(mode:"regions"), e.g. 2 for [r2].'),
        selector: z
          .string()
          .optional()
          .describe('For target="element": a CSS selector, if you have no region number.'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To read the revenue chart"'),
      }),
      execute: async ({ target, region, selector, reason }) => {
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }

        // Same exemption as ReadPage's perception modes: inside an open control
        // session the user has already granted this agent sight of this tab, and a
        // card between every click and its verification shot would be unusable.
        const open = pageControl.session()
        const owned = !!open && open.active && open.tabId === tab.id
        if (!owned) {
          const what =
            target === 'fullpage'
              ? 'Take a screenshot of this whole page'
              : target === 'element'
                ? 'Take a screenshot of one element on this page'
                : 'Take a screenshot of this page'
          const approved = await requestApproval({ toolName: 'Screenshot', summary: what, reason })
          if (!approved) return DENIED
        }

        try {
          const { shot, meta } = await capture(tab, { kind: target, region, selector })
          // Saved for the user regardless of whether the model can afford to look
          // at it — the artifact and the perception are different products.
          const shotId = await saveShot({
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height,
            url: meta.url,
            title: meta.title,
            label: meta.label,
            conversationId,
          })

          const host = hostLabel(meta.url)
          const truncatedNote = meta.truncated
            ? ' The page was taller than the capture limit, so this stops partway down.'
            : ''

          const budget = Math.max(0, MAX_SHOT_IMAGES_PER_TURN - shotImagesUsed)
          if (budget === 0) {
            return {
              ok: true,
              shotId,
              width: shot.width,
              height: shot.height,
              note: `Captured ${meta.label} on ${host} and saved it for the user, but this turn's image budget is spent, so it was not sent to you. Work from the page text instead.`,
            }
          }

          const { tiles, dropped } = await tileShot(shot, Math.min(MAX_TILES_PER_CALL, budget))
          tiles.forEach((t, i) => {
            const where =
              tiles.length > 1 ? ` — tile ${i + 1} of ${tiles.length}, top to bottom` : ''
            imageQueue.push({
              dataUrl: t.dataUrl,
              caption: `Screenshot of ${meta.label} on ${host}${where}. This is a photograph of the page: there are no numbered boxes on it.`,
            })
          })
          shotImagesUsed += tiles.length

          // Say what was dropped. A silently truncated capture reads to the model
          // as "I have seen the whole thing", which is how it ends up confidently
          // describing a page section it was never shown.
          const droppedNote = dropped
            ? ` The page was too long to send in full: you are seeing the first ${tiles.length} of ${tiles.length + dropped} sections. Scroll and shoot again if you need the rest.`
            : ''

          return {
            ok: true,
            shotId,
            target,
            label: meta.label,
            width: shot.width,
            height: shot.height,
            images: tiles.length,
            note: `Captured ${meta.label} on ${host}.${truncatedNote}${droppedNote} The image follows.`,
          }
        } catch (err) {
          // A ShotError is an expected, explainable condition (restricted page, tab
          // no longer active, region gone) — hand the model the sentence so it can
          // adapt, rather than an opaque failure it will just retry.
          if (err instanceof ShotError) return { error: err.message }
          return {
            error: `Could not take the screenshot (${err instanceof Error ? err.message : String(err)}).`,
          }
        }
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
      execute: async ({ query }) => ({ tools: searchCatalog(catalog, query) }),
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
        'List all tabs the user has open (titles, URLs, tab ids), and optionally read specific tabs by id. mode="text": visible text; mode="dom": cleaned HTML structure. Pass tabIds to read those tabs; omit tabIds to only list. Asks the user for permission first. Read only the tabs you need — each page is large.',
      inputSchema: z.object({
        mode: z.enum(['text', 'dom']).describe('text = visible text; dom = HTML structure'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find your open documentation tabs"'),
        tabIds: z
          .array(z.number())
          .optional()
          .describe('Tab ids (from a previous listing) to read. Omit to only list tabs.'),
      }),
      execute: async ({ mode, reason, tabIds }) => {
        const reading = tabIds && tabIds.length > 0
        const approved = await requestApproval({
          toolName: 'ReadTabs',
          summary: reading
            ? `Read the ${mode === 'dom' ? 'DOM' : 'content'} of ${tabIds!.length} open tab${tabIds!.length > 1 ? 's' : ''}`
            : 'See the list of your open tabs',
          reason,
        })
        if (!approved) return DENIED
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

    RequestPageControl: tool({
      description:
        'Ask the user for permission to control the active tab to carry out a task (fill a form, click through a flow, navigate). State a concise plan. On approval you get a page-control session and the first element list; then use ControlPage for each step and ReadPage (mode "elements") to re-read. Point-of-no-return steps (submitting, cross-site navigation, passwords/payments) still ask each time.',
      inputSchema: z.object({
        plan: z
          .string()
          .describe('One or two sentences: what you will do on the page and where you will stop.'),
      }),
      execute: async ({ plan }) => {
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
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
        // round-trip once a session is open. Screenshot joins it so the model can
        // check its own work — confirm a click landed, catch a modal the element
        // list does not convey — without breaking stride. (Harmless when the model
        // is text-only: the tool is absent from the ToolSet, and prepareStep
        // intersects activeNames with the turn's real tools.)
        activeNames.add('ControlPage')
        activeNames.add('AutofillForm')
        activeNames.add('Screenshot')
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
        const tab = await getActiveTab()
        if (tab?.id === undefined || tab.id !== session.tabId)
          return { error: 'The controlled tab is no longer active.' }
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
        const tab = await getActiveTab()
        if (tab?.id === undefined || tab.id !== session.tabId) return { error: 'The controlled tab is no longer active.' }
        const profile = await getProfileMemories()
        const filled: number[] = []
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
          note: `Filled ${filled.length} field(s) from profile. Profile memories available: ${profile.length}. Submit is a separate, confirmed step.`,
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
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
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
  }

  // Background web research: gated in the foreground (this card), then handed
  // off to the offscreen research host, which runs the real (ungated) research
  // tools headlessly — see src/tools/research.ts and src/agent/research.ts.
  Object.assign(tools, createStartResearchTool(requestApproval, conversationId))

  // A blind model must not be handed a camera. Screenshot's entire product is an
  // image; against a text-only endpoint the model would call it, receive a result
  // that promises "the image follows", never see one, and loop. Removing the tool
  // outright (rather than failing at execute) is the same mechanism a "never"
  // policy uses, so it is absent from the catalog and ToolSearch/GetTool cannot
  // resurrect it.
  if (!visionCapable) delete tools.Screenshot

  // Honor the tab-visibility preference chosen in onboarding: in active-tab
  // mode the model never even sees a tool that could enumerate other tabs.
  if (tabAccess !== 'all-tabs') {
    delete tools.ReadTabs
  }

  // Browsing-data is hidden unless the user has granted at least one optional
  // permission. The single QueryBrowserData tool is removed only when NO source
  // is granted; per-source gating happens inside its execute (and the granted
  // sources are named in its description) so the model never requests an
  // ungranted source.
  if (grantedSources.length === 0) delete tools.QueryBrowserData

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
