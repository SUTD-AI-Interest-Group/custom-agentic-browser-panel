import { isObject, type JsonObject } from './modern'
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
export interface TaskHandle {
  taskId: string; status: TaskStatus; statusMessage?: string; createdAt: string; lastUpdatedAt: string; ttlMs: number | null; pollIntervalMs?: number
}
export interface SavedTask extends TaskHandle {
  id: string; server: string; scope: string; tool: string; conversationId?: string; nextPollAt: number
}
export function parseTask(value: JsonObject, expectedId?: string, detailed = false): TaskHandle {
  if (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 2048 || (expectedId !== undefined && value.taskId !== expectedId) ||
      !['working','input_required','completed','failed','cancelled'].includes(String(value.status)) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(value.lastUpdatedAt)) ||
      (value.ttlMs !== null && (!Number.isSafeInteger(value.ttlMs) || (value.ttlMs as number) < 0)) ||
      (value.pollIntervalMs !== undefined && (!Number.isSafeInteger(value.pollIntervalMs) || (value.pollIntervalMs as number) < 0)) ||
      (value.statusMessage !== undefined && (typeof value.statusMessage !== 'string' || value.statusMessage.length > 8000))) throw Error('Invalid MCP task handle.')
  if (detailed && ((value.status === 'completed' && !isObject(value.result)) || (value.status === 'failed' && !isObject(value.error)) || (value.status === 'input_required' && !isObject(value.inputRequests)))) throw Error('Invalid MCP task state.')
  return { taskId: value.taskId, status: value.status as TaskStatus, createdAt: value.createdAt, lastUpdatedAt: value.lastUpdatedAt, ttlMs: value.ttlMs as number | null,
    pollIntervalMs: value.pollIntervalMs as number | undefined, statusMessage: value.statusMessage as string | undefined }
}
export function expiredTask(t: TaskHandle): boolean { return t.ttlMs !== null && Date.now() >= Date.parse(t.createdAt) + t.ttlMs }
export function taskPollDelay(t: TaskHandle): number { return Math.max(1000, t.pollIntervalMs ?? 5000) }
export function terminalTask(t: TaskHandle): boolean { return ['completed','failed','cancelled'].includes(t.status) }
let dbPromise: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  return dbPromise ??= new Promise((resolve,reject) => {
    const r = indexedDB.open('lychee-mcp-tasks',1)
    r.onupgradeneeded = () => { r.result.createObjectStore('tasks',{keyPath:'id'}) }
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbPromise = undefined }; resolve(r.result) }
    r.onerror = () => { dbPromise = undefined; reject(r.error) }
  })
}
const listeners = new Set<() => void>()
export const subscribeTasks = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
export async function listSavedTasks(): Promise<SavedTask[]> {
  const d = await db()
  return new Promise((resolve,reject) => { const r=d.transaction('tasks').objectStore('tasks').getAll(); r.onsuccess=()=>resolve(r.result as SavedTask[]);r.onerror=()=>reject(r.error) })
}
export async function saveTask(task: SavedTask): Promise<void> {
  const d = await db()
  await new Promise<void>((resolve,reject) => {
    const tx=d.transaction('tasks','readwrite'), store=tx.objectStore('tasks')
    const all=store.getAll()
    all.onsuccess=()=>{
      const records=all.result as SavedTask[]
      if (!records.some(x=>x.id===task.id) && records.length>=100) {
        const oldest=records.filter(x=>terminalTask(x)||expiredTask(x)).sort((a,b)=>a.nextPollAt-b.nextPollAt)[0]
        if (oldest) store.delete(oldest.id)
        else { tx.abort(); return }
      }
      store.put(task)
    }
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error ?? Error('Task storage is full. Remove an old task before starting more.'));tx.onerror=()=>reject(tx.error)
  })
  for(const f of listeners) f()
}
export async function forgetTask(id: string): Promise<void> {
  const d=await db()
  await new Promise<void>((resolve,reject)=>{const tx=d.transaction('tasks','readwrite');tx.objectStore('tasks').delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})
  for(const f of listeners) f()
}
