import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _putAttachmentForTests,
  _resetDbForTests,
  deleteAttachmentsForConversation,
  getAttachment,
  pruneAttachments,
  type StoredAttachment,
} from './attachments'

// deleteAttachmentsForConversation and pruneAttachments used to issue one
// readwrite transaction PER deleted record (Promise.all over N separate
// requestOf('readwrite', ...delete) calls) — correct, but chatty against a
// 100MB/30-day store that can accumulate many small records. Both now batch
// every delete for one call into a SINGLE transaction (see attachments.ts's
// `batchTransaction`, mirroring memory.ts's helper of the same name). These
// tests assert the transaction count structurally (spying on
// IDBDatabase.prototype.transaction), never via timing.

function attachment(overrides: Partial<StoredAttachment> & Pick<StoredAttachment, 'id' | 'bytes' | 'createdAt'>): StoredAttachment {
  return {
    conversationId: 'c1',
    meta: { id: overrides.id, kind: 'image', name: 'file.png', byteSize: overrides.bytes },
    dataUrl: 'data:image/png;base64,x',
    ...overrides,
  }
}

/** Count only the readwrite transactions opened against the store — the
 *  getAll() read that precedes every delete pass is deliberately excluded. */
function countReadwriteTransactions(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((args) => args[1] === 'readwrite').length
}

beforeEach(async () => {
  await _resetDbForTests()
})

describe('deleteAttachmentsForConversation', () => {
  it("deletes only the matching conversation's attachments, in one transaction", async () => {
    await _putAttachmentForTests(attachment({ id: 'a1', conversationId: 'target', bytes: 10, createdAt: Date.now() }))
    await _putAttachmentForTests(attachment({ id: 'a2', conversationId: 'target', bytes: 10, createdAt: Date.now() }))
    await _putAttachmentForTests(attachment({ id: 'a3', conversationId: 'other', bytes: 10, createdAt: Date.now() }))

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await deleteAttachmentsForConversation('target')
    expect(countReadwriteTransactions(spy)).toBe(1) // ONE transaction for both doomed records, not two
    spy.mockRestore()

    expect(await getAttachment('a1')).toBeNull()
    expect(await getAttachment('a2')).toBeNull()
    expect(await getAttachment('a3')).not.toBeNull()
  })

  it('opens no readwrite transaction at all when nothing matches', async () => {
    await _putAttachmentForTests(attachment({ id: 'a1', conversationId: 'other', bytes: 10, createdAt: Date.now() }))

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await deleteAttachmentsForConversation('target')
    expect(countReadwriteTransactions(spy)).toBe(0)
    spy.mockRestore()

    expect(await getAttachment('a1')).not.toBeNull()
  })
})

describe('pruneAttachments', () => {
  it('evicts the oldest attachment once the total byte cap is crossed', async () => {
    // MAX_TOTAL_BYTES is 100MB — two 60MB records cross it, so the older one goes.
    await _putAttachmentForTests(attachment({ id: 'old', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putAttachmentForTests(attachment({ id: 'new', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 1_000 }))

    const result = await pruneAttachments()
    expect(result.deleted).toBe(1)
    expect(await getAttachment('old')).toBeNull()
    expect(await getAttachment('new')).not.toBeNull()
  })

  it('evicts attachments past MAX_AGE_MS regardless of size', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days old; cap is 30
    await _putAttachmentForTests(attachment({ id: 'ancient', bytes: 10, createdAt: ancient }))

    const result = await pruneAttachments()
    expect(result.deleted).toBe(1)
    expect(await getAttachment('ancient')).toBeNull()
  })

  it('batches multiple doomed records into a single readwrite transaction, not one per record', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000
    await _putAttachmentForTests(attachment({ id: 'a1', bytes: 10, createdAt: ancient }))
    await _putAttachmentForTests(attachment({ id: 'a2', bytes: 10, createdAt: ancient }))
    await _putAttachmentForTests(attachment({ id: 'a3', bytes: 10, createdAt: ancient }))
    await _putAttachmentForTests(attachment({ id: 'keep', bytes: 10, createdAt: Date.now() }))

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const result = await pruneAttachments()
    expect(countReadwriteTransactions(spy)).toBe(1) // ONE transaction for all 3 doomed records, not 3
    spy.mockRestore()

    expect(result.deleted).toBe(3)
    expect(await getAttachment('keep')).not.toBeNull()
  })

  it('opens no readwrite transaction at all when nothing is doomed', async () => {
    await _putAttachmentForTests(attachment({ id: 'fine', bytes: 10, createdAt: Date.now() }))

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const result = await pruneAttachments()
    expect(result.deleted).toBe(0)
    expect(countReadwriteTransactions(spy)).toBe(0)
    spy.mockRestore()
  })
})

describe('pruning and per-chat deletion read index keys, never records', () => {
  beforeEach(async () => {
    await _resetDbForTests()
  })

  it('never loads a stored file to decide what to evict or delete', async () => {
    const day = 24 * 60 * 60 * 1000
    await _putAttachmentForTests(attachment({ id: 'old', bytes: 10, createdAt: Date.now() - 40 * day }))
    await _putAttachmentForTests(attachment({ id: 'big', bytes: 101 * 1024 * 1024, createdAt: Date.now() - 2 }))
    await _putAttachmentForTests(attachment({ id: 'keep', bytes: 10, createdAt: Date.now() - 1, conversationId: 'other' }))
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    const get = vi.spyOn(IDBObjectStore.prototype, 'get')
    const openCursor = vi.spyOn(IDBIndex.prototype, 'openCursor')
    try {
      expect(await pruneAttachments()).toEqual({ deleted: 2 })
      await deleteAttachmentsForConversation('other')
      expect(getAll).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
      expect(openCursor).not.toHaveBeenCalled()
    } finally {
      getAll.mockRestore(); get.mockRestore(); openCursor.mockRestore()
    }
    expect(await getAttachment('keep')).toBeNull()
  })

  it('upgrades a v1 database in place: existing files are indexed and still pruned', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-attachments', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('attachments', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.put(attachment({ id: 'stale', bytes: 10, createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }))
        store.put(attachment({ id: 'fresh', bytes: 10, createdAt: Date.now() }))
      }
      req.onsuccess = () => { req.result.close(); resolve() }
      req.onerror = () => reject(req.error)
    })
    expect(await pruneAttachments()).toEqual({ deleted: 1 })
    expect(await getAttachment('stale')).toBeNull()
    expect(await getAttachment('fresh')).not.toBeNull()
  })
})
