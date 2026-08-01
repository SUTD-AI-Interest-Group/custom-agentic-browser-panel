// MV3 service worker. The agent loop lives in the side panel; this worker
// hosts work that must outlive the panel — today that is the "dreaming"
// memory-consolidation cycle, which runs on an hourly alarm and only fires
// when the user has been idle for a while (see dream.ts).

import { dreamIfDue } from './agent/dream'
import type { ComposerAction } from './platform/composerActions'
import { COMPOSER_ACTION_MSG, setComposerAction } from './platform/composerActions'
import type { ResearchMsg } from './data/researchTasks'
import {
  saveTask,
  applyUpdate,
  getTask,
  listTasks,
  resumableTasks,
  taskDeadline,
  isActiveStatus,
  heartbeat,
  postResearchMsg,
  MAX_RESEARCH_DURATION_MS,
} from './data/researchTasks'
import { registerContextMenus, CONTEXT_MENU_IDS } from './platform/contextMenus'
import { sweepHighlightsForWindow } from './platform/highlight'
import { loadSettings, getSelectedProvider, observabilityConfig, resolveDreamIntervalMs } from './data/settings'
import { isFetchableUrl } from './platform/webFetch'
import { renderPage } from './platform/researchRender'
import { closeSessionsForTask, handleBrowseOp } from './platform/researchBrowse'
import { searchInTab } from './platform/researchSearch'
import { sweepOrphanWindow } from './platform/researchTab'

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel.setPanelBehavior failed', err))

const DREAM_ALARM = 'dream'

// The research watchdog: a periodic tick that re-dispatches any stranded task (its
// worker died with Chrome/offscreen) so it resumes from its persisted notebook, and
// finalizes any task past its 24h cap. 1-minute period — Chrome's practical floor —
// so recovery after a restart or eviction is prompt.
const RESEARCH_WATCHDOG_ALARM = 'research-watchdog'
function scheduleWatchdog(): void {
  chrome.alarms.create(RESEARCH_WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
}

/**
 * How often the dream alarm fires, in minutes: the user's chosen interval, but
 * capped at 60 (a 24h interval doesn't need 24h between checks — the alarm just
 * verifies the gap has elapsed) and floored at 1 (Chrome's minimum period). A
 * 30-minute interval genuinely fires every 30 minutes; dreamIfDue re-checks the
 * real gap and idle guard before consolidating.
 */
function dreamAlarmPeriodMinutes(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  const minutes = Math.round(resolveDreamIntervalMs(settings) / 60_000)
  return Math.min(Math.max(minutes, 1), 60)
}

async function scheduleDreamAlarm(): Promise<void> {
  const period = dreamAlarmPeriodMinutes(await loadSettings())
  chrome.alarms.create(DREAM_ALARM, { delayInMinutes: Math.min(period, 5), periodInMinutes: period })
}

chrome.runtime.onInstalled.addListener(() => {
  void scheduleDreamAlarm()
  scheduleWatchdog()
  void resumeStrandedResearch()
  void registerContextMenus()
})
chrome.runtime.onStartup.addListener(() => {
  void scheduleDreamAlarm()
  scheduleWatchdog()
  // Chrome just restarted — resume any research that was mid-flight when it closed.
  void resumeStrandedResearch()
  void registerContextMenus()
})

// Re-arm the alarm when the user changes the dream interval, so a new cadence
// takes effect without waiting for the next browser restart. Settings live under
// one 'settings' key; only reschedule when the derived period actually changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return
  void (async () => {
    const period = dreamAlarmPeriodMinutes(await loadSettings())
    const existing = await chrome.alarms.get(DREAM_ALARM)
    if (!existing || existing.periodInMinutes !== period) {
      chrome.alarms.create(DREAM_ALARM, { delayInMinutes: Math.min(period, 5), periodInMinutes: period })
    }
  })()
})

// MV3 can kill this worker at any time, which drops the research tab's handle and
// strands its (minimized, invisible) window. Sweep any leftover on every wake —
// module scope runs on each worker start, not just at install/startup.
void sweepOrphanWindow()
// Same reasoning for research itself: if this worker (and the offscreen host) were
// evicted mid-task, resume any stranded task as soon as the worker comes back, not
// only on the next alarm tick.
void resumeStrandedResearch()

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESEARCH_WATCHDOG_ALARM) {
    void resumeStrandedResearch()
    return
  }
  if (alarm.name !== DREAM_ALARM) return
  dreamIfDue()
    .then((outcome) => {
      if (outcome.status === 'dreamed') console.info('[dream]', outcome)
    })
    .catch((err) => console.error('[dream] failed', err))
})

// ---------------------------------------------------------------------------
// Toggle the side panel with a browser-global keyboard shortcut (default
// Ctrl/Cmd+E, rebindable at chrome://extensions/shortcuts).
//
// Chrome has no sidePanel.close(), so we track which windows currently have a
// panel open via a Port each panel opens on load; to "close", we ask that panel
// to window.close() itself. Opening goes through sidePanel.open(), which must
// run in the same task as the user gesture — so the command handler reads
// windowId synchronously from the event's tab and never awaits before opening.
// ---------------------------------------------------------------------------

const openPanels = new Map<number, chrome.runtime.Port>()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return
  let windowId: number | undefined
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'hello' && typeof msg.windowId === 'number') {
      windowId = msg.windowId
      openPanels.set(msg.windowId, port)
    }
  })
  port.onDisconnect.addListener(() => {
    if (windowId === undefined) return
    if (openPanels.get(windowId) === port) openPanels.delete(windowId)
    // The panel is gone, so the chat that explained the marks is gone: sweep the
    // passage highlights it left on this window's pages. Only the worker can —
    // the panel context that tracked them is already being destroyed.
    void sweepHighlightsForWindow(windowId).catch(() => {})
  })
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-panel') return
  const windowId = tab?.windowId
  if (windowId === undefined) return
  const existing = openPanels.get(windowId)
  if (existing) {
    existing.postMessage({ type: 'close' })
    return
  }
  // No await before open() — awaiting would spend the user gesture the API needs.
  chrome.sidePanel.open({ windowId }).catch((err) => console.error('sidePanel.open failed', err))
})

// ---------------------------------------------------------------------------
// Clicking the toast a finished background chat fired (see notifyChatLanded in
// src/ui/App.tsx). The chat's tab is encoded in the notification id, so putting
// the user back on it needs no state here — which is the point: the panel that
// raised the toast may be closed by the time it is clicked, and this worker is
// the only thing guaranteed to still be around. Activating the tab is enough to
// swap the panel to that chat, since the binding follows the tab.
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('chat:')) return
  const tabId = Number(notificationId.slice('chat:'.length))
  if (!Number.isInteger(tabId)) return
  chrome.notifications.clear(notificationId)
  void (async () => {
    try {
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true })
        // The panel may have been closed since the turn started; this click is a
        // user gesture, so it is allowed to reopen it.
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})
      }
    } catch {
      // The tab was closed while the toast sat there. Nothing to focus, and the
      // conversation is safe in history — silently drop it.
    }
  })()
})

// ---------------------------------------------------------------------------
// "Ask Lychee about this" context menu: right-click a selection, link, image, or
// the page itself to hand it straight to the panel. The menu items themselves are
// registered in src/platform/contextMenus.ts; what lives here is the click half.
// The mailbox contract (src/platform/composerActions.ts) carries the action across
// the gap between "panel may be closed" and "panel mounts and drains it"; here we
// only stage it and open the panel, in that order, on the gesture.
// ---------------------------------------------------------------------------

/** Map a context-menu click to the ComposerAction the panel should act on. */
function buildComposerAction(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): ComposerAction | null {
  switch (info.menuItemId) {
    case CONTEXT_MENU_IDS.selection:
      return { kind: 'selection', text: info.selectionText ?? '', pageUrl: info.pageUrl ?? tab?.url ?? '', pageTitle: tab?.title }
    case CONTEXT_MENU_IDS.link:
      return { kind: 'link', url: info.linkUrl ?? '', pageUrl: info.pageUrl ?? '' }
    case CONTEXT_MENU_IDS.image:
      return { kind: 'image', srcUrl: info.srcUrl ?? '', pageUrl: info.pageUrl ?? '' }
    case CONTEXT_MENU_IDS.page:
      return { kind: 'page', pageUrl: info.pageUrl ?? tab?.url ?? '', pageTitle: tab?.title }
    default:
      return null
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const windowId = tab?.windowId
  if (windowId === undefined) return // no window to open the panel into

  const action = buildComposerAction(info, tab)
  if (!action) return

  // sidePanel.open must run synchronously in the gesture (same constraint as the
  // toggle-panel command above) — so open first, then stage the mailbox and
  // broadcast. The panel drains on mount regardless, and the broadcast only
  // covers the already-open case, so this ordering loses nothing.
  chrome.sidePanel.open({ windowId }).catch((err) => console.error('sidePanel.open failed', err))
  void setComposerAction(action)
  void chrome.runtime.sendMessage({ type: COMPOSER_ACTION_MSG }).catch(() => {})
})

// ---------------------------------------------------------------------------
// Background research: the SW orchestrates a headless "offscreen document"
// (Task 8's research host) that runs the actual research loop (Task 10), since
// the SW itself can be killed/respawned at any time by MV3 and must not hold
// state in module variables. All task state lives in chrome.storage via
// researchTasks.ts; the offscreen document is a disposable worker the SW can
// (re)create on demand.
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html'

// A synchronous module-scope gate: the assignment to `creating` happens before
// any await yields control, so two near-simultaneous calls share ONE in-flight
// createDocument() instead of racing two. This is a synchronization primitive
// for a disposable browser resource (like the existing openPanels Map), not
// persisted research state — and it self-heals on SW restart (creating resets
// to null, and hasDocument() reflects reality).
let creatingOffscreen: Promise<void> | null = null
function ensureOffscreen(): Promise<void> {
  if (creatingOffscreen) return creatingOffscreen
  creatingOffscreen = (async () => {
    if (await chrome.offscreen.hasDocument()) return
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse fetched HTML for background research.',
    })
  })().finally(() => { creatingOffscreen = null })
  return creatingOffscreen
}

/** Fire a system notification announcing a research task finished. */
async function notifyDone(taskId: string, question: string): Promise<void> {
  chrome.notifications.create(`research-${taskId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Research complete',
    message: question.slice(0, 120),
    priority: 1,
  })
}

/**
 * Dispatch (or re-dispatch) a task to the offscreen host. Shared by the initial
 * launch and the watchdog's resume, so both take the identical, resilient path:
 * a missing provider is a *pause* (never a terminal error), the 24h deadline rides
 * along, and a resume seeds the offscreen run from the task's persisted notebook.
 * The offscreen host's `running` guard makes a redundant dispatch a no-op.
 */
async function startResearchTask(taskId: string, opts: { resume?: boolean } = {}): Promise<void> {
  const task = await getTask(taskId)
  if (!task || !isActiveStatus(task.status)) return // finished, cancelled, or gone
  const settings = await loadSettings()
  const sel = getSelectedProvider(settings)
  if (!sel) {
    // No model configured: pause (the user can configure one and it resumes), never
    // stop. The watchdog re-checks every tick.
    await applyUpdate(taskId, (cur) =>
      isActiveStatus(cur.status)
        ? { status: 'paused', pauseReason: 'No model configured — set one up to resume', nextRetryAt: Date.now() + 60_000 }
        : {},
    )
    return
  }
  await ensureOffscreen()
  postResearchMsg({
    type: 'research.start',
    taskId,
    question: task.question,
    providerConfig: sel.provider,
    modelId: sel.modelId,
    conversationId: task.conversationId,
    // The offscreen host has no chrome.storage to read observability from itself.
    observability: observabilityConfig(settings),
    deadlineAt: taskDeadline(task),
    resume: opts.resume,
    // On resume, hand back the persisted notebook so gathered findings carry over.
    notebook: opts.resume ? task.notebook : undefined,
  } satisfies ResearchMsg)
}

/**
 * Find tasks whose worker looks dead (stale heartbeat) and re-dispatch them. Within
 * the 24h cap they resume from the notebook; past it, runResearch finalizes a partial
 * report. Each is "claimed" (updatedAt bumped) before dispatch so a racing watchdog
 * tick or the startup scan doesn't double-dispatch it — with the offscreen guard as
 * the ultimate backstop.
 */
async function resumeStrandedResearch(): Promise<void> {
  try {
    const tasks = await listTasks()
    const map = Object.fromEntries(tasks.map((t) => [t.id, t]))
    const stranded = resumableTasks(map, Date.now())
    for (const task of stranded) {
      await applyUpdate(task.id, {}) // claim: bump updatedAt so a concurrent tick skips it
      await startResearchTask(task.id, { resume: true })
    }
  } catch (err) {
    console.error('[research] resume scan failed', err)
  }
}

// Returning `true` tells Chrome "a response is coming asynchronously" and holds
// the message channel open until sendResponse fires — which also keeps this
// worker alive for the await chain below (a research dispatch must not be cut in
// half by an eviction). Nothing in this protocol actually wants a reply, so the
// response is an empty ack sent in a finally: without it the channel stays open
// until the sender is torn down, and every sender that did not attach a .catch
// gets "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received" as an uncaught rejection.
chrome.runtime.onMessage.addListener((msg: ResearchMsg, _sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg?.type === 'research.ensureAndStart') {
        const now = Date.now()
        await saveTask({
          id: msg.taskId,
          question: msg.question,
          status: 'running',
          steps: [],
          startedAt: now,
          updatedAt: now,
          conversationId: msg.conversationId,
          // Anchor the 24h cap at creation, so a later resume can't extend it.
          deadlineAt: now + MAX_RESEARCH_DURATION_MS,
        })
        // Dispatch through the shared, resilient path. Any failure here (e.g. offscreen
        // creation hiccup) leaves the task 'running'; the watchdog re-dispatches it.
        await startResearchTask(msg.taskId, { resume: false }).catch((err) =>
          console.error('[research] initial dispatch failed', err),
        )
      } else if (msg?.type === 'research.update') {
        // The offscreen host sends the full derived step list (with live results)
        // and, when it changes, the structured notebook (plan/coverage drive the
        // sheet). Replace rather than append. Any progress also clears a stale
        // 'paused' state (a resumed phase may emit updates before its resumed signal).
        await applyUpdate(msg.taskId, (cur) => {
          const base = msg.notebook ? { steps: msg.steps, notebook: msg.notebook } : { steps: msg.steps }
          return cur.status === 'paused'
            ? { ...base, status: 'running' as const, pauseReason: undefined, nextRetryAt: undefined }
            : base
        })
      } else if (msg?.type === 'research.paused') {
        // A phase hit a transient failure and is backing off. Active → paused, with the
        // reason for the card; a cancelled task must not be resurrected.
        await applyUpdate(msg.taskId, (cur) =>
          isActiveStatus(cur.status)
            ? { status: 'paused', pauseReason: msg.reason, nextRetryAt: msg.nextRetryAt }
            : {},
        )
      } else if (msg?.type === 'research.resumed') {
        await applyUpdate(msg.taskId, (cur) =>
          cur.status === 'paused' ? { status: 'running', pauseReason: undefined, nextRetryAt: undefined } : {},
        )
      } else if (msg?.type === 'research.heartbeat') {
        // Liveness only: bump updatedAt for an active task so the watchdog sees it live.
        await heartbeat(msg.taskId)
      } else if (msg?.type === 'research.done') {
        const t = await applyUpdate(msg.taskId, (cur) =>
          cur.status === 'cancelled'
            ? {}
            : {
                status: 'done',
                report: msg.report,
                sources: msg.sources,
                notebook: msg.notebook,
                verification: msg.verification,
                partial: msg.partial,
                pauseReason: undefined,
                nextRetryAt: undefined,
              },
        )
        if (t && t.status === 'done') {
          try {
            await notifyDone(msg.taskId, t.question)
          } catch (err) {
            console.error('[research] notify failed', err)
          }
        }
      } else if (msg?.type === 'research.error') {
        await applyUpdate(msg.taskId, (cur) => (cur.status === 'cancelled' ? {} : { status: 'error', error: msg.error }))
      } else if (msg?.type === 'research.cancel') {
        await applyUpdate(msg.taskId, (cur) => (isActiveStatus(cur.status) ? { status: 'cancelled' } : {}))
        // A cancelled task's browse session would otherwise hold the research tab
        // until its TTL expired, blocking the next task's first fetch. Scoped to
        // THIS task only — tasks run concurrently, and a global close would tear
        // down another task's open page-walk mid-flight (see FIX H1).
        closeSessionsForTask(msg.taskId)
      } else if (msg?.type === 'research.browse') {
        // Interactive browse: the offscreen sub-agent drives the isolated tab one
        // policy-checked step at a time (see platform/researchBrowse.ts).
        const result = await handleBrowseOp(msg.sessionId, msg.op)
        postResearchMsg({
          type: 'research.browseResult',
          taskId: msg.taskId,
          requestId: msg.requestId,
          result,
        })
      } else if (msg?.type === 'research.searchTab') {
        // Tab-search fallback: the keyless fetch was throttled, so run the search in
        // a real tab that can clear the bot wall (see platform/researchSearch.ts).
        const { results, error } = await searchInTab(msg.query, msg.maxResults)
        postResearchMsg({
          type: 'research.searchTabResult',
          taskId: msg.taskId,
          requestId: msg.requestId,
          results,
          error,
        })
      } else if (msg?.type === 'research.renderPage') {
        // Hybrid-escalation broker: the offscreen agent can't touch tabs, so it asks
        // the SW to render a hard URL in an isolated tab and return the text/shot.
        const guard = isFetchableUrl(msg.url)
        const outcome = guard.ok ? await renderPage(msg.url, msg.want) : { error: `refused (${guard.reason})` }
        postResearchMsg({
          type: 'research.renderResult',
          taskId: msg.taskId,
          requestId: msg.requestId,
          ...outcome,
        })
      }
    } catch (err) {
      // A storage/quota failure (or anything else unguarded above) would otherwise
      // become a silent unhandled rejection inside this fire-and-forget IIFE.
      console.error('[bg] message handler failed', msg?.type, err)
    } finally {
      // Close the channel. Throws if the sender is already gone (a panel that
      // navigated away mid-dispatch) — that is nothing to report.
      try {
        sendResponse()
      } catch {}
    }
  })()
  return true
})
