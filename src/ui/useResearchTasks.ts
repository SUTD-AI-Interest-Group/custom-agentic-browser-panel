import { useMemo, useSyncExternalStore } from 'react'
import { listTasks, type ResearchTask } from '../data/researchTasks'

// One storage read and subscription per panel, shared by retained chats and
// Library. A storage change during a read schedules a fresh read, never a race.
let snapshot: ResearchTask[] = []
const listeners = new Set<() => void>()
let reading = false, dirty = false
async function refresh() {
  dirty = true
  if (reading) return
  reading = true
  try {
    do {
      dirty = false
      const tasks = await listTasks()
      if (!listeners.size) return
      snapshot = tasks
      for (const listener of listeners) listener()
    } while (dirty)
  } catch (error) { console.error('Could not load research tasks', error) }
  finally { reading = false }
}
function onChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes.researchTasks) void refresh()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    chrome.storage.onChanged.addListener(onChanged)
    void refresh()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) chrome.storage.onChanged.removeListener(onChanged)
  }
}
const getSnapshot = () => snapshot
export function useResearchTasks(conversationId?: string) {
  const tasks = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(() => conversationId ? tasks.filter(task => task.conversationId === conversationId) : tasks, [tasks, conversationId])
}
