import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { durableDatabase, storageErrorMessage } from './durableDatabase'
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
describe('durable database connections', () => {
  it('reopens a closed cached connection without losing records', async () => {
    const transaction = durableDatabase(crypto.randomUUID(), 'items', 'id')
    const write = await transaction('readwrite')
    write.objectStore('items').put({ id: 'kept', value: 42 }); await done(write)
    write.db.close()
    const read = await transaction()
    const request = read.objectStore('items').get('kept')
    const value = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
    expect(value).toEqual({ id: 'kept', value: 42 })
    read.db.close()
  })
  it('forgets a connection closed by the browser', async () => {
    const transaction = durableDatabase(crypto.randomUUID(), 'items', 'id')
    const first = await transaction(); await done(first)
    first.db.close(); first.db.onclose?.call(first.db, new Event('close'))
    const next = await transaction()
    expect(next.db).not.toBe(first.db); await done(next); next.db.close()
  })
  it('preserves exception name and message in extension error logs', () => {
    expect(storageErrorMessage(new DOMException('The connection is closing.', 'InvalidStateError')))
      .toBe('InvalidStateError: The connection is closing.')
    expect(storageErrorMessage({ name: 'VersionError', message: 'Requested version is lower.' }))
      .toBe('VersionError: Requested version is lower.')
  })
})

it('opens a compatible version-2 database and retains its records and indexes', async () => {
  const name = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 2)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('items', { keyPath: 'id' })
      store.createIndex('byState', 'state')
      store.put({ id: 'existing', state: 'done', value: 'preserved' })
    }
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  })
  const transaction = durableDatabase(name, 'items', 'id')
  const tx = await transaction('readwrite')
  expect(tx.db.version).toBe(2)
  expect(tx.objectStore('items').indexNames.contains('byState')).toBe(true)
  const request = tx.objectStore('items').get('existing')
  const value = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
  expect(value).toEqual({ id: 'existing', state: 'done', value: 'preserved' })
  await done(tx); tx.db.close()
})

it('rejects incompatible newer stores without changing their schema or data', async () => {
  const name = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 2)
    request.onupgradeneeded = () => request.result.createObjectStore('items', { keyPath: 'otherKey' }).put({ otherKey: 'kept' })
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  })
  await expect(durableDatabase(name, 'items', 'id')()).rejects.toThrow('incompatible items key')
  const transaction = durableDatabase(name, 'items', 'otherKey')
  const tx = await transaction()
  const request = tx.objectStore('items').get('kept')
  expect(await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })).toEqual({ otherKey: 'kept' })
  await done(tx); tx.db.close()
})
