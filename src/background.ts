// MV3 service worker. Agent chat logic lives in the side panel; this worker
// hosts work that must outlive the panel — today that is the "dreaming"
// memory-consolidation cycle, which runs on an hourly alarm and only fires
// when the user has been idle for a while (see dream.ts).

import { dreamIfDue } from './agent/dream'
import type { ResearchMsg } from './data/researchTasks'
import { saveTask, applyUpdate } from './data/researchTasks'
import { loadSettings, getSelectedProvider } from './data/settings'

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel.setPanelBehavior failed', err))

const DREAM_ALARM = 'dream'

function scheduleDreamAlarm() {
  chrome.alarms.create(DREAM_ALARM, { delayInMinutes: 5, periodInMinutes: 60 })
}

chrome.runtime.onInstalled.addListener(scheduleDreamAlarm)
chrome.runtime.onStartup.addListener(scheduleDreamAlarm)

chrome.alarms.onAlarm.addListener((alarm) => {
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
    if (windowId !== undefined && openPanels.get(windowId) === port) openPanels.delete(windowId)
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

/** Draw a small notification icon at runtime — no bundled icon asset exists — and return it as a data URL. */
async function researchIconDataUrl(): Promise<string> {
  const c = new OffscreenCanvas(128, 128)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#4f46e5'
  ctx.fillRect(0, 0, 128, 128)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 72px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('R', 64, 70)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.readAsDataURL(blob)
  })
}

/** Fire a system notification announcing a research task finished. */
async function notifyDone(taskId: string, question: string): Promise<void> {
  const iconUrl = await researchIconDataUrl()
  chrome.notifications.create(`research-${taskId}`, {
    type: 'basic',
    iconUrl,
    title: 'Research complete',
    message: question.slice(0, 120),
    priority: 1,
  })
}

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  ;(async () => {
    if (msg?.type === 'research.ensureAndStart') {
      await saveTask({
        id: msg.taskId,
        question: msg.question,
        status: 'running',
        steps: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
      try {
        await ensureOffscreen()
        const settings = await loadSettings()
        const sel = getSelectedProvider(settings)
        if (!sel) {
          await applyUpdate(msg.taskId, { status: 'error', error: 'No model is configured.' })
          return
        }
        chrome.runtime.sendMessage({
          type: 'research.start',
          taskId: msg.taskId,
          question: msg.question,
          providerConfig: sel.provider,
          modelId: sel.modelId,
        } satisfies ResearchMsg)
      } catch (err) {
        await applyUpdate(msg.taskId, { status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    } else if (msg?.type === 'research.update') {
      await applyUpdate(msg.taskId, (cur) => ({ steps: [...cur.steps, msg.step] }))
    } else if (msg?.type === 'research.done') {
      const t = await applyUpdate(msg.taskId, (cur) =>
        cur.status === 'cancelled' ? {} : { status: 'done', report: msg.report, sources: msg.sources },
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
      await applyUpdate(msg.taskId, { status: 'cancelled' })
    }
  })()
  return true
})
