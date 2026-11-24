/**
 * A small connection cache for the live chat/task stores. A closed connection
 * must not poison every subsequent poll. Retry only transaction creation: no
 * transaction callback or write is ever replayed.
 *
 * `stores` maps each object store this build needs to its keyPath. A store that
 * is missing from an existing database is added in an upgrade one version above
 * whatever version the database is at — never a fixed number, because previous
 * builds may already have moved it on (some added indexes at v2) — and `migrate`
 * runs inside that same upgrade, told which stores were just created, so data is
 * reshaped atomically with the schema. Existing stores, their records and their
 * indexes are left as they are.
 */
export function durableDatabase(
  name: string,
  stores: Record<string, string>,
  migrate?: (upgrade: IDBTransaction, created: string[]) => void,
) {
  const names = Object.keys(stores)
  let opening: Promise<IDBDatabase> | undefined
  const connect = (version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
    // Without a version this opens an existing database at its current one (forcing a
    // lower version is a downgrade and throws VersionError); a new database starts at v1.
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      const created = names.filter((store) => !db.objectStoreNames.contains(store))
      for (const store of created) db.createObjectStore(store, { keyPath: stores[store] })
      migrate?.(request.transaction!, created)
    }
    request.onsuccess = () => {
      const connection = request.result
      // Until it is validated and handed out, never hold up another context's upgrade.
      connection.onversionchange = () => connection.close()
      resolve(connection)
    }
    request.onerror = () => reject(request.error)
  })
  const open = () => {
    if (opening) return opening
    const pending = (async () => {
      let connection = await connect()
      if (names.some((store) => !connection.objectStoreNames.contains(store))) {
        const next = connection.version + 1
        connection.close()
        try {
          connection = await connect(next)
        } catch (error) {
          // Another context upgraded first, past `next`: open at whatever version it left.
          if (!(error instanceof DOMException) || error.name !== 'VersionError') throw error
          connection = await connect()
        }
      }
      for (const store of names) {
        if (!connection.objectStoreNames.contains(store)) {
          connection.close()
          throw new Error(`${name} v${connection.version} is missing the required ${store} store. Existing data was left unchanged.`)
        }
        const existing = connection.transaction(store).objectStore(store)
        if (existing.keyPath !== stores[store] || existing.autoIncrement) {
          connection.close()
          throw new Error(`${name} v${connection.version} has an incompatible ${store} key. Expected ${stores[store]}; existing data was left unchanged.`)
        }
      }
      const forget = () => { if (opening === pending) opening = undefined }
      connection.onclose = forget
      connection.onversionchange = () => { connection.close(); forget() }
      return connection
    })()
    opening = pending
    void pending.catch(() => { if (opening === pending) opening = undefined })
    return pending
  }
  /** A transaction over `scope` (default: every store). Scope a hot write to the one store it
   *  touches, so it never queues behind — or holds up — readers of the others. */
  return async (mode: IDBTransactionMode = 'readonly', scope: string | string[] = names): Promise<IDBTransaction> => {
    for (let attempt = 0; ; attempt++) {
      const connection = await open()
      try { return connection.transaction(scope, mode) }
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
