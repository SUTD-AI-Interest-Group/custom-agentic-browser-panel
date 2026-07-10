// MV3 service worker. Agent chat logic lives in the side panel; this worker
// hosts work that must outlive the panel — today that is the "dreaming"
// memory-consolidation cycle, which runs on an hourly alarm and only fires
// when the user has been idle for a while (see dream.ts).

import { dreamIfDue } from './agent/dream'

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
