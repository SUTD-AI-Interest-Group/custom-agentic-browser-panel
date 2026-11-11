import { createChangeSignal } from './changeSignal'

// Both MCP protocols used "tasks" in earlier builds, with incompatible record
// shapes. Upgrade atomically and keep their stores separate without dropping data.
let opening: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  if (opening) return opening
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lychee-mcp-tasks', 3)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('sdkTasks')) db.createObjectStore('sdkTasks', { keyPath: 'id' })
      const tx = request.transaction!
      const cursor = tx.objectStore('tasks').openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) return
        if (row.value.task && typeof row.value.task === 'object') {
          tx.objectStore('sdkTasks').put(row.value)
          row.delete()
        }
        row.continue()
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const forget = () => { if (opening === pending) opening = undefined }
      db.onclose = forget
      db.onversionchange = () => { db.close(); forget() }
      resolve(db)
    }
  })
  opening = pending
  void pending.catch(() => { if (opening === pending) opening = undefined })
  return pending
}

export async function mcpTaskTransaction(stores: string | string[], mode: IDBTransactionMode = 'readonly'): Promise<IDBTransaction> {
  for (let attempt = 0; ; attempt++) {
    const db = await open()
    try { return db.transaction(stores, mode) }
    catch (error) {
      if (attempt || !(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
      db.close(); opening = undefined
    }
  }
}

const changes = createChangeSignal('lychee-mcp-task-records')
export const subscribeTaskRecords = (listener: () => void) => changes.subscribe(listener)
export function notifyTaskRecords() {
  changes.publish('changed')
  try { void chrome.runtime.sendMessage({ type: 'mcp-task.changed' }).catch(() => {}) } catch { /* closing context */ }
}

export async function mcpTaskEpoch(): Promise<number> {
  const tx = await mcpTaskTransaction('meta')
  return new Promise((resolve, reject) => {
    const request = tx.objectStore('meta').get('epoch')
    request.onsuccess = () => resolve(request.result ?? 0)
    request.onerror = () => reject(request.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Clear both protocols and invalidate requests started before the deletion. */
export async function eraseTaskRecords(conversationId?: string): Promise<void> {
  const tx = await mcpTaskTransaction(['tasks', 'sdkTasks', 'meta'], 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const meta = tx.objectStore('meta'), epoch = meta.get('epoch')
    epoch.onsuccess = () => meta.put((epoch.result ?? 0) + 1, 'epoch')
    for (const name of ['tasks', 'sdkTasks']) {
      const store = tx.objectStore(name)
      if (conversationId === undefined) store.clear()
      else {
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          if (row.value.conversationId === conversationId) row.delete()
          row.continue()
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Task deletion failed.'))
    tx.onerror = () => reject(tx.error ?? new Error('Task deletion failed.'))
  })
  notifyTaskRecords()
}
