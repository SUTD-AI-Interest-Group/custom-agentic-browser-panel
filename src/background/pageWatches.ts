import { listPageWatches, updatePageWatch, matchesWatch, type PageWatch } from '../data/pageWatches'
import { observeWatchTarget } from '../platform/pageWatch'
import { loadSettings, toolPolicy } from '../data/settings'
import { syncTaskAlarm } from './taskAlarm'

export const PAGE_WATCH_ALARM = 'page-watches'
let polling: Promise<void> | undefined
const ownedKey = (id: string) => `page-watch-tab:${id}`

async function closeOwnedTab(watch: PageWatch) {
  const key = ownedKey(watch.id)
  const record = (await chrome.storage.session.get(key))[key] as { tabId: number } | undefined
  // Session storage is cleared on browser restart; never close a reused tab ID.
  if (record) {
    const tab = await chrome.tabs.get(record.tabId).catch(() => undefined)
    if (tab && !tab.active) await chrome.tabs.remove(record.tabId).catch(() => {})
    await chrome.storage.session.remove(key)
  }
}
async function waitForPage(tabId: number, url: string) {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') {
      if (tab.url !== url) throw new Error('Page redirected; sign in or recreate the watch on the destination page.')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Page did not finish loading within 20 seconds.')
}
async function check(watch: PageWatch) {
  await closeOwnedTab(watch)
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
  if (tab.id === undefined) throw new Error('Could not create checking tab.')
  try { await chrome.storage.session.set({ [ownedKey(watch.id)]: { tabId: tab.id } }) }
  catch (error) {
    const current = await chrome.tabs.get(tab.id).catch(() => undefined)
    if (current && !current.active) await chrome.tabs.remove(tab.id).catch(() => {})
    throw error
  }
  try {
    await chrome.tabs.update(tab.id, { url: watch.url })
    await waitForPage(tab.id, watch.url)
    // SPAs often populate after the load event. Retry missing targets briefly.
    let observation
    for (let attempt = 0; attempt < 5; attempt++) {
      try { observation = await observeWatchTarget(tab.id, watch.url, watch.selector); break }
      catch (error) {
        if (attempt === 4) throw error
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    if (!observation) throw new Error('Component could not be read.')
    if (observation.tag !== watch.baseline.tag) throw new Error('Component identity changed. Select the component again.')
    const matched = matchesWatch(watch, observation)
    await updatePageWatch(watch.id, old => {
      if (!old || old.status !== 'active') return old
      if (Date.now() >= old.deadlineAt) return { ...old, status: 'expired', leaseUntil: undefined }
      return { ...old, status: matched ? 'matched' : 'active', lastObservation: observation, lastCheckedAt: Date.now(), nextCheckAt: Date.now() + old.intervalSeconds * 1000, leaseUntil: undefined, error: undefined }
    })
  } finally { await closeOwnedTab(watch) }
}
async function notify(watch: PageWatch) {
  if (watch.notified || !['matched', 'needs_attention'].includes(watch.status)) return
  // Stable notification ID makes retries replace an existing notification.
  const current = (await listPageWatches()).find(w => w.id === watch.id)
  if (!current || current.status !== watch.status) return
  await chrome.notifications.create(`page-watch:${watch.id}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: watch.status === 'matched' ? 'Lychee: watch matched' : 'Lychee: watch needs attention',
    message: (watch.status === 'matched' ? `${watch.description}\n${watch.lastObservation?.text || watch.condition}` : `${watch.description}\n${watch.error}`).slice(0, 500),
  })
  await updatePageWatch(watch.id, old => old && old.status === watch.status ? { ...old, notified: true } : old)
}
export function pollPageWatches() {
  return polling ??= poll().finally(() => { polling = undefined })
}
async function poll() {
  const watches = await listPageWatches()
  // Reap a checking tab left behind when its conversation was deleted or the worker died.
  const session = await chrome.storage.session.get(null)
  for (const key of Object.keys(session)) {
    if (!key.startsWith('page-watch-tab:')) continue
    const id = key.slice('page-watch-tab:'.length)
    if (!watches.some(w => w.id === id)) await closeOwnedTab({ id } as PageWatch)
  }
  if (!watches.length) return
  const settings = await loadSettings()
  const disabled = toolPolicy(settings, 'CreatePageWatch') === 'never'
  let checked = 0
  for (const watch of watches.sort((a, b) => a.nextCheckAt - b.nextCheckAt)) {
    if (watch.status !== 'active') { await closeOwnedTab(watch); if (!disabled) await notify(watch).catch(console.error); continue }
    if (watch.leaseUntil && watch.leaseUntil > Date.now()) continue
    if (disabled || Date.now() >= watch.deadlineAt) {
      await closeOwnedTab(watch)
      await updatePageWatch(watch.id, old => old?.status === 'active' ? { ...old, status: disabled ? 'cancelled' : 'expired' } : old)
      continue
    }
    if (watch.nextCheckAt > Date.now() || checked >= 3) continue
    let claimed = false
    const leased = await updatePageWatch(watch.id, old => {
      if (!old || old.status !== 'active' || (old.leaseUntil ?? 0) > Date.now()) return old
      claimed = true
      return { ...old, leaseUntil: Date.now() + 60_000 }
    })
    if (!claimed || !leased) continue
    checked++
    try { await check(leased) }
    catch (error) {
      await updatePageWatch(watch.id, old => old?.status === 'active' ? { ...old, status: Date.now() >= old.deadlineAt ? 'expired' : 'needs_attention', error: error instanceof Error ? error.message : String(error), lastCheckedAt: Date.now(), leaseUntil: undefined } : old)
    }
    const current = (await listPageWatches()).find(w => w.id === watch.id)
    if (current && toolPolicy(await loadSettings(), 'CreatePageWatch') !== 'never') await notify(current).catch(console.error)
  }
}
export function installPageWatchMonitor() {
  const schedule = () => void pollPageWatches().then(async () => {
    await syncTaskAlarm(PAGE_WATCH_ALARM, (await listPageWatches()).some(w => w.status === 'active' || (!w.notified && ['matched', 'needs_attention'].includes(w.status))))
  }).catch(console.error)
  schedule()
  chrome.runtime.onStartup.addListener(schedule)
  chrome.runtime.onInstalled.addListener(schedule)
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === PAGE_WATCH_ALARM) schedule() })
  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'page-watches.changed') schedule() })
  // Once the user takes over a checking tab, cleanup must never close it.
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.storage.session.get(null).then(async values => {
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('page-watch-tab:') && value?.tabId === tabId) await chrome.storage.session.remove(key)
      }
    }).catch(console.error)
  })
  chrome.notifications.onClicked.addListener(id => {
    if (!id.startsWith('page-watch:')) return
    void (async () => {
      const watch = (await listPageWatches()).find(w => `page-watch:${w.id}` === id)
      if (watch && /^https?:\/\//.test(watch.url)) await chrome.tabs.create({ url: watch.url })
      await chrome.notifications.clear(id)
    })().catch(console.error)
  })
}
