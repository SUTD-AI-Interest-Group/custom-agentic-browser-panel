// MV3 service worker. Agent chat logic lives in the side panel; this worker
// hosts work that must outlive the panel — today that is the "dreaming"
// memory-consolidation cycle, which runs on an hourly alarm and only fires
// when the user has been idle for a while (see dream.ts).

import { dreamIfDue } from './lib/dream'

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
