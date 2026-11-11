import { getTask, isActiveStatus } from '../data/researchTasks'
import { teardownNow } from '../platform/researchTab'

const pending = new Map<string, Set<AbortController>>()
export function cancelResearchWork(taskId: string) {
  for (const controller of pending.get(taskId) ?? []) controller.abort()
}
export async function withResearchWork<T>(taskId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let requests = pending.get(taskId)
  if (!requests) pending.set(taskId, requests = new Set())
  requests.add(controller)
  try {
    const task = await getTask(taskId)
    if (!task || !isActiveStatus(task.status)) controller.abort()
    controller.signal.throwIfAborted()
    return await work(controller.signal)
  } finally {
    requests.delete(controller)
    if (!requests.size) pending.delete(taskId)
    if (controller.signal.aborted) await teardownNow()
  }
}
