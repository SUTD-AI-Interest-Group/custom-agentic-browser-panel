/** A dormant queue needs no periodic wake-up. Changes/startup re-arm it. */
export async function syncTaskAlarm(name: string, needed: boolean): Promise<void> {
  if (!needed) { await chrome.alarms.clear(name); return }
  if (!(await chrome.alarms.get(name))) await chrome.alarms.create(name, { periodInMinutes: 1, delayInMinutes: 1 })
}
