/** A small connection cache for the live chat/task stores. A closed connection
 * must not poison every subsequent poll. Retry only transaction creation: no
 * transaction callback or write is ever replayed. */
export function durableDatabase(name: string, store: string, keyPath: string) {
  let opening: Promise<IDBDatabase> | undefined
  const open = () => {
    if (opening) return opening
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      // Open an existing database at its current version. Previous builds may
      // have added indexes (v2); forcing v1 is a downgrade and throws VersionError.
      // A new database still starts at v1. Validate the store before using it.
      const request = indexedDB.open(name)
      request.onupgradeneeded = () => request.result.createObjectStore(store, { keyPath })
      request.onsuccess = () => {
        const connection = request.result
        if (!connection.objectStoreNames.contains(store)) {
          connection.close()
          reject(new Error(`${name} v${connection.version} is missing the required ${store} store. Existing data was left unchanged.`))
          return
        }
        const existing = connection.transaction(store).objectStore(store)
        if (existing.keyPath !== keyPath || existing.autoIncrement) {
          connection.close()
          reject(new Error(`${name} v${connection.version} has an incompatible ${store} key. Expected ${keyPath}; existing data was left unchanged.`))
          return
        }
        const forget = () => { if (opening === pending) opening = undefined }
        connection.onclose = forget
        connection.onversionchange = () => { connection.close(); forget() }
        resolve(connection)
      }
      request.onerror = () => { if (opening === pending) opening = undefined; reject(request.error) }
    })
    opening = pending
    void pending.catch(() => { if (opening === pending) opening = undefined })
    return pending
  }
  return async (mode: IDBTransactionMode = 'readonly'): Promise<IDBTransaction> => {
    for (let attempt = 0; ; attempt++) {
      const connection = await open()
      try { return connection.transaction(store, mode) }
      catch (error) {
        if (attempt || !(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
        connection.close()
        opening = undefined
      }
    }
  }
}

/** Chrome's extension error viewer renders DOMException objects as
 * [object DOMException]. Log an explicit string so the actionable detail stays. */
export function storageErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message } = error as { name?: unknown; message?: unknown }
    if (typeof message === 'string') return `${typeof name === 'string' ? name : 'Error'}: ${message}`
  }
  return String(error)
}
