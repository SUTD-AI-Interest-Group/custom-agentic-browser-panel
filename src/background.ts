import { cancelResearchWork, withResearchWork } from './background/researchWork'
import { syncTaskAlarm } from './background/taskAlarm'
import { withOffscreen, closeOffscreenIfIdle } from './background/offscreenLifecycle'
import { installStudio } from './platform/studio'
import { installPageWatchMonitor } from './background/pageWatches'
import { installToolHost, releaseChatTools, releaseDetachedSessions } from './background/toolHost'
import { saveConversation } from './data/conversations'
import { dehydrateHistory } from './data/attachmentRefs'
import { chatRunMessages, activeChatRun, getChatRun, updateChatRun } from './data/chatRuns'
// MV3 service worker. Chat inference lives in the offscreen host; this worker
// hosts work that must outlive the panel — today that is the "dreaming"
// memory-consolidation cycle, which runs on an hourly alarm and only fires
// when the user has been idle for a while (see dream.ts).
//
// It *schedules* that cycle; it does not run it. Chrome terminates a service
// worker "when a single request, such as an event or API call, takes longer than
// 5 minutes to process" — and a dream generation over a whole day of transcript
// can exceed that. Measured against this worker: a 6-minute generation awaited
// here was killed mid-flight, losing the finished answer and stranding the dream
// lock. The alarm now checks the gates, takes the lock and hands the job to the
// offscreen document, which has no such ceiling; the result comes back as a
// message (dream.result / dream.failed) that revives this worker if it has since
// been killed.

import { installMcpTaskMonitor } from './background/mcpTasks'


import { abandonDispatchedDream, completeDispatchedDream, dreamIfDue, type DreamJob } from './agent/dream'
import type { DreamMsg } from './data/dreamMessages'
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
  clearTasksNow,
} from './data/researchTasks'
import { registerContextMenus, CONTEXT_MENU_IDS } from './platform/contextMenus'
import { sweepHighlightsForWindow } from './platform/highlight'
import { loadSettings, getSelectedProvider, observabilityConfig, resolveDreamIntervalMs } from './data/settings'
import { isFetchableUrl } from './platform/webFetch'
import { renderPage } from './platform/researchRender'
import { closeSessionsForTask, handleBrowseOp, reapExpiredSessions } from './platform/researchBrowse'
import { searchInTab } from './platform/researchSearch'
import { JANITOR_ALARM, runJanitorTick, sweepOrphanWindows, teardownNow } from './platform/researchTab'
import { installWebMcpBadge } from './platform/webmcpBadge'
import { removeLegacySystem1 } from './data/legacyCleanup'

installStudio()
installMcpTaskMonitor()
installPageWatchMonitor()
installToolHost()

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
  void listTasks().then(tasks => syncTaskAlarm(RESEARCH_WATCHDOG_ALARM, tasks.some(t => isActiveStatus(t.status)))).catch(console.error)
}

// Backs resumeStrandedResearch()'s self-serialization (defined further down,
// alongside its full reasoning). Declared here, ahead of every module-scope
// call site below (onInstalled/onStartup register listeners that fire later,
// but the unconditional call near the bottom of this file's setup runs
// synchronously at import time) — a `let` is in its temporal dead zone until
// the line that initializes it actually executes, so this must be assigned
// before resumeStrandedResearch() can ever be called, not merely before it is
// defined (function declarations are hoisted whole; this binding is not).
let resumeChain: Promise<void> = Promise.resolve()

/**
 * How often the dream alarm fires, in minutes: the user's chosen interval, but
 * capped at 60 (a 24h interval doesn't need 24h between checks — the alarm just
 * verifies the gap has elapsed) and floored at 1 (Chrome's minimum period). A
 * 30-minute interval genuinely fires every 30 minutes; dreamIfDue re-checks the
 * real gap and idle guard before consolidating.
 */
export function dreamAlarmPeriodMinutes(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  const minutes = Math.round(resolveDreamIntervalMs(settings) / 60_000)
  return Math.min(Math.max(minutes, 1), 60)
}

async function scheduleDreamAlarm(): Promise<void> {
  const period = dreamAlarmPeriodMinutes(await loadSettings())
  chrome.alarms.create(DREAM_ALARM, { delayInMinutes: Math.min(period, 5), periodInMinutes: period })
}

chrome.runtime.onInstalled.addListener(() => {
  // Reclaims the removed System-1 model's cached weights on the update that drops it.
  void removeLegacySystem1()
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
  if (area === 'local' && changes.researchTasks) scheduleWatchdog()
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
void sweepOrphanWindows()
// Same reasoning for research itself: if this worker (and the offscreen host) were
// evicted mid-task, resume any stranded task as soon as the worker comes back, not
// only on the next alarm tick.
void resumeStrandedResearch()

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JANITOR_ALARM) {
    // The research tab's teardown timer, which cannot be a setTimeout — this
    // worker is evicted long before one that long would fire (see JANITOR_ALARM
    // in platform/researchTab.ts). Reap expired browse sessions FIRST: each one
    // holds a lease, and the tab only counts as idle once they are released.
    reapExpiredSessions()
    void runJanitorTick().catch((err) => console.error('[research] janitor tick failed', err))
    return
  }
  if (alarm.name === RESEARCH_WATCHDOG_ALARM) {
    void resumeStrandedResearch()
    return
  }
  if (alarm.name !== DREAM_ALARM) return
  // Note what is NOT awaited here: the generation. dreamIfDue resolves as soon as
  // the job is handed to the offscreen host, so this handler stays short and this
  // worker is free to be killed while the host works — the result message wakes
  // it back up to record the outcome (see the dream.result branch below).
  dreamIfDue(dispatchDream)
    .then((outcome) => {
      if (outcome.status === 'dreamed') console.info('[dream]', outcome)
    })
    .catch((err) => console.error('[dream] failed', err))
})

/**
 * Hand a due dream to the offscreen host. Throwing is meaningful: dreamIfDue
 * releases the lock it took when this rejects, so a failure to create the host
 * costs one alarm tick rather than blocking every cycle (and the user's own
 * "Dream now") until the lock's TTL expires.
 */
async function dispatchDream(job: DreamJob, token: string): Promise<void> {
  await withOffscreen(() => chrome.runtime.sendMessage({ type: 'dream.run', token, job }))
}

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
const refreshWebMcpBadges = installWebMcpBadge(id => openPanels.has(id))

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return
  let windowId: number | undefined
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'hello' && typeof msg.windowId === 'number') {
      windowId = msg.windowId
      openPanels.set(msg.windowId, port)
      void refreshWebMcpBadges(msg.windowId)
    }
  })
  port.onDisconnect.addListener(() => {
    if (windowId === undefined) return
    if (openPanels.get(windowId) === port) openPanels.delete(windowId)
    void refreshWebMcpBadges(windowId)
    // The panel is gone, so the chat that explained the marks is gone: sweep the
    // passage highlights it left on this window's pages. Only the worker can —
    // the panel context that tracked them is already being destroyed.
    void sweepHighlightsForWindow(windowId).catch(() => {})
    void releaseDetachedSessions(windowId).catch(console.error)
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
// Clicking a notification. Two kinds reach here:
//  - "chat:<tabId>" — a finished background chat (see notifyChatLanded in
//    src/ui/App.tsx). The chat's tab is encoded in the notification id, so
//    putting the user back on it needs no state here — which is the point: the
//    panel that raised the toast may be closed by the time it is clicked, and
//    this worker is the only thing guaranteed to still be around. Activating
//    the tab is enough to swap the panel to that chat, since the binding
//    follows the tab.
//  - "research-<taskId>" — a finished background research task (see
//    notifyDone below). A research task isn't bound to any one tab/window the
//    way a chat is, so there is no tab to activate — the best this can do is
//    reopen the panel somewhere the user will see it.
//
// Either way, sidePanel.open() must run in the SAME microtask as the click's
// own continuation, before any FURTHER await — the click is the user gesture
// the API needs, and that gesture window does not survive extra round-trips
// (see the header comment above: no await before open() elsewhere in this
// file). Both branches below have exactly one UNAVOIDABLE await first (the
// window/tab id isn't known until then), and open() fires the instant that
// resolves, ahead of anything else.
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('chat:')) {
    const tabId = Number(notificationId.slice('chat:'.length))
    if (!Number.isInteger(tabId)) return
    chrome.notifications.clear(notificationId)
    void (async () => {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.windowId !== undefined) {
          chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error('sidePanel.open failed', err))
        }
        await chrome.tabs.update(tabId, { active: true })
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
      } catch {
        // The tab was closed while the toast sat there. Nothing to focus, and the
        // conversation is safe in history — silently drop it.
      }
    })()
    return
  }
  if (notificationId.startsWith('research-')) {
    chrome.notifications.clear(notificationId)
    void (async () => {
      try {
        // No tab/window is bound to a research task — the last-focused normal
        // window is the most reasonable place to surface the panel.
        const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
        if (win.id !== undefined) {
          chrome.sidePanel.open({ windowId: win.id }).catch((err) => console.error('sidePanel.open failed', err))
        }
      } catch (err) {
        console.error('[research] notification click failed', err)
      }
    })()
  }
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

/**
 * Everything that must be handed back when a task stops being active — done,
 * errored, or cancelled.
 *
 * Doing this HERE, in a live message handler, is the whole difference between a
 * graceful shutdown and the old behaviour: this worker is provably alive at this
 * instant, whereas anything deferred to a timer runs only if MV3 has not evicted
 * it first — and after the last task ends nothing is keeping it alive, so it
 * always has. Measured against the previous algorithm, the 60s teardown timer
 * fired zero times across three runs and the isolated window survived until some
 * later cold boot happened to sweep it.
 */
async function releaseTaskResources(taskId: string): Promise<void> {
  cancelResearchWork(taskId)
  // Each of this task's browse sessions holds a lease on the shared research
  // tab. Scoped to THIS task — tasks run concurrently, and a global close would
  // tear down another task's open page-walk mid-flight (see FIX H1).
  closeSessionsForTask(taskId)
  // Another task still running? It needs the window; leave it alone.
  const tasks = await listTasks().catch(() => [])
  if (tasks.some((t) => isActiveStatus(t.status))) return
  await teardownNow()
}

/**
 * Fire a system notification announcing a research task finished. Exported for
 * direct testing, and `await`s the create call rather than firing it and
 * forgetting it — this used to be a bare, un-awaited statement, so a rejection
 * (bad icon URL, quota, etc.) floated free as an unhandled rejection instead of
 * reaching the try/catch every caller wraps this in (see the `research.done`
 * branch below), which relies on this function's own promise actually
 * reflecting whether the notification succeeded.
 */
export async function notifyDone(taskId: string, question: string): Promise<void> {
  await chrome.notifications.create(`research-${taskId}`, {
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
  await withOffscreen(() => chrome.runtime.sendMessage({
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
    // Carried on the task since research.ensureAndStart's creation (see above) —
    // read from there rather than a fresh message so a WATCHDOG resume (which has
    // no original research.ensureAndStart to hand this function) keeps the scope
    // the user approved, not just the initial dispatch.
    sites: task.sites,
    brief: task.brief,
    subQuestions: task.subQuestions,
    attachments: task.attachments,
  } satisfies ResearchMsg))
}

/**
 * Find tasks whose worker looks dead (stale heartbeat) and re-dispatch them. Within
 * the 24h cap they resume from the notebook; past it, runResearch finalizes a partial
 * report. Each is "claimed" (updatedAt bumped) before dispatch so a racing watchdog
 * tick or the startup scan doesn't double-dispatch it.
 *
 * The claim itself (applyUpdate) is serialized against other researchTasks.ts
 * writers by that module's own writeChain — but the listTasks() READ just above
 * it is not a write, so two overlapping calls to THIS function (the unconditional
 * module-load call below racing the first watchdog tick, or two watchdog ticks)
 * could both snapshot the same task as stale before either's claim had committed,
 * producing a redundant research.start dispatch. `resumeChain` (declared near
 * the top of this file, ahead of every call site) serializes calls to
 * resumeStrandedResearch against each other — mirroring the shape of
 * researchTasks.ts's own `serialize()` — so a call's read-claim-dispatch only
 * starts once every earlier call's has fully finished, closing that race here
 * rather than relying solely on the offscreen host's `running`-map guard
 * (offscreen.ts) as the only thing making a redundant dispatch harmless.
 */
function resumeStrandedResearch(): Promise<void> {
  const run = resumeChain.then(doResumeStrandedResearch, doResumeStrandedResearch)
  resumeChain = run.catch(() => {})
  return run
}

async function doResumeStrandedResearch(): Promise<void> {
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
  } finally { scheduleWatchdog() }
}

// Returning `true` tells Chrome "a response is coming asynchronously" and holds
// the message channel open until sendResponse fires — which also keeps this
// worker alive for the await chain below (a research dispatch must not be cut in
// half by an eviction). Nothing in this protocol actually wants a reply, so the
// response is an empty ack sent in a finally: without it the channel stays open
// until the sender is torn down, and every sender that did not attach a .catch
// gets "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received" as an uncaught rejection.
chrome.runtime.onMessage.addListener((msg: ResearchMsg | DreamMsg, _sender, sendResponse) => {
  if ((msg as { kind?: string })?.kind === 'studio.zap') return
  if (typeof msg?.type === 'string' && msg.type.startsWith('chat.')) return
  ;(async () => {
    try {
      if (msg?.type === 'dream.result') {
        // The other half of the alarm's cycle, arriving in its own event —
        // this worker may be a fresh instance that this very message revived,
        // which is exactly why the lock token travels with the result instead
        // of living in memory here.
        const outcome = await completeDispatchedDream(msg.result, msg.token)
        if (outcome.status === 'dreamed') console.info('[dream]', outcome)
      } else if (msg?.type === 'dream.failed') {
        // The generation itself failed (provider unreachable, model error). Not
        // this worker's problem to retry: drop the lock and let the next alarm
        // tick start a fresh cycle over the same still-unconsolidated episodes.
        await abandonDispatchedDream(msg.token)
        console.warn('[dream] cycle failed in the offscreen host:', msg.error)
      } else if (msg?.type === 'research.ensureAndStart') {
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
          // All three are carried on the task (not just this dispatch) so a
          // watchdog resume — which re-derives its research.start from the
          // PERSISTED task, not this message — still has what the user approved
          // on the launch card. See startResearchTask.
          sites: msg.sites,
          brief: msg.brief,
          subQuestions: msg.subQuestions,
          attachments: msg.attachments,
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
        await releaseTaskResources(msg.taskId)
      } else if (msg?.type === 'research.error') {
        await applyUpdate(msg.taskId, (cur) => (cur.status === 'cancelled' ? {} : { status: 'error', error: msg.error }))
        await releaseTaskResources(msg.taskId)
      } else if (msg?.type === 'research.cancel') {
        await applyUpdate(msg.taskId, (cur) => (isActiveStatus(cur.status) ? { status: 'cancelled' } : {}))
        // A cancelled task's browse session would otherwise hold the research tab
        // until its TTL expired, blocking the next task's first fetch.
        await releaseTaskResources(msg.taskId)
      } else if (msg?.type === 'offscreen.idle') {
        // The host has no research task and no dream left. Shut it down rather
        // than leaving it resident until the browser restarts.
        await closeOffscreenIfIdle()
      } else if (msg?.type === 'research.clearTasks') {
        // Panel-issued "Clear"/"Erase all data" (Settings → Data). Only the SW
        // ever writes researchTasks state — see researchTasks.ts's clearTasks()
        // doc comment — so this relays the removal onto the SAME writeChain
        // saveTask/applyUpdate/heartbeat use, instead of the panel racing them by
        // touching storage itself.
        const tasks = await listTasks()
        for (const task of tasks) {
          if (isActiveStatus(task.status)) {
            await applyUpdate(task.id, () => ({ status: 'cancelled' }))
            postResearchMsg({ type: 'research.cancel', taskId: task.id })
          }
          await releaseTaskResources(task.id)
        }
        await clearTasksNow()
      } else if (msg?.type === 'research.browse') {
        // Interactive browse: the offscreen sub-agent drives the isolated tab one
        // policy-checked step at a time (see platform/researchBrowse.ts).
        const task = await getTask(msg.taskId)
        const result = task && isActiveStatus(task.status)
          ? await handleBrowseOp(msg.sessionId, msg.op)
          : { ok: false, message: 'Research is no longer active.' }
        postResearchMsg({
          type: 'research.browseResult',
          taskId: msg.taskId,
          requestId: msg.requestId,
          result,
        })
      } else if (msg?.type === 'research.searchTab') {
        // Tab-search fallback: the keyless fetch was throttled, so run the search in
        // a real tab that can clear the bot wall (see platform/researchSearch.ts).
        const { results, error } = await withResearchWork(msg.taskId, signal => searchInTab(msg.query, msg.maxResults, signal)).catch(() => ({ error: 'Research is no longer active.', results: undefined }))
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
        const outcome = guard.ok ? await withResearchWork(msg.taskId, signal => renderPage(msg.url, signal)).catch(() => ({ error: 'Research is no longer active.' })) : { error: `refused (${guard.reason})` }
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


// Chat inference belongs to the offscreen document, not to the panel or this
// disposable worker. Control messages carry IDs; inference inputs are read from IDB.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['chat.start', 'chat.abort', 'chat.settled', 'chat.inspect'].includes(msg?.type)) return
  void (async () => {
    const run = await getChatRun(msg.conversationId)
    if (msg.type === 'chat.inspect') {
      // A browser restart/reload destroys the offscreen host. Preserve the last
      // streamed text and mark interruption; never silently replay model/tool calls.
      const stale = activeChatRun(run) && Date.now() - run.updatedAt > 5000
      const hosted = stale && await chrome.offscreen.hasDocument()
        ? await chrome.runtime.sendMessage({ type: 'chat.hasRun', id: run.id }).then(reply => reply?.active === true, () => false)
        : !stale
      if (stale && !hosted) {
        const failed = await updateChatRun(run.conversationId, old => old?.id === run.id && activeChatRun(old)
          ? { ...old, providerSealed: undefined, error: 'Generation was interrupted because its background host closed. Send a message to continue.', updatedAt: Date.now() } : old)
        if (failed?.id === run.id) {
          await saveConversation({ id: failed.conversationId, messages: chatRunMessages(failed), history: dehydrateHistory(failed.history) })
          await updateChatRun(run.conversationId, old => old?.id === run.id ? { ...old, state: 'error' } : old)
          releaseChatTools(run.conversationId, run.id)
        }
      }
      return { ok: true }
    }
    if (!run || run.id !== msg.id) return { error: 'Chat run is unavailable.' }
    if (msg.type === 'chat.start') {
      return await withOffscreen(() => chrome.runtime.sendMessage({ type: 'chat.execute', conversationId: run.conversationId, id: run.id }))
    }
    if (msg.type === 'chat.abort') {
      await updateChatRun(run.conversationId, (old) => old?.id === run.id ? { ...old, cancelRequested: true } : old)
      releaseChatTools(run.conversationId, run.id)
      return { ok: true }
    }
    if (run.state !== 'cancelled' && (run.ownerUntil < Date.now() || run.windowId === undefined || !openPanels.has(run.windowId))) {
      const needsPanel = run.needsPanel || (run.result && run.result.stop.reason !== 'completed')
      await chrome.notifications.create(`chat:${run.tabId ?? -1}`, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: run.error ? 'Lychee encountered an error' : needsPanel ? 'Lychee needs your attention' : 'Lychee finished',
        message: run.error ? 'Open the chat to review the generation error.' : needsPanel ? 'Open the panel to continue through the normal tool and permission checks.' : 'Your answer is ready. Click to return to your chat.',
      })
    }
    return { ok: true }
  })().then(respond, (error) => respond({ error: error instanceof Error ? error.message : String(error) }))
  return true
})
