import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetDbForTests,
  clearConversations,
  clearInFlight,
  comparePinnedThenRecent,
  conversationsUsage,
  deleteConversation,
  getConversation,
  getInFlight,
  listConversations,
  renameConversation,
  saveConversation,
  saveInFlight,
  sweepInFlight,
  togglePin,
  type ConversationSummary,
  type InFlightTurn,
} from './conversations'

type Row = Pick<ConversationSummary, 'pinned' | 'updatedAt'>

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort(comparePinnedThenRecent)
}

describe('comparePinnedThenRecent', () => {
  it('puts pinned rows before unpinned rows regardless of recency', () => {
    const older = { pinned: true, updatedAt: 1 }
    const newer = { pinned: false, updatedAt: 100 }
    expect(sortRows([newer, older])).toEqual([older, newer])
  })

  it('orders unpinned rows by updatedAt descending', () => {
    const a = { pinned: false, updatedAt: 10 }
    const b = { pinned: false, updatedAt: 30 }
    const c = { pinned: false, updatedAt: 20 }
    expect(sortRows([a, b, c])).toEqual([b, c, a])
  })

  it('orders pinned rows among themselves by updatedAt descending', () => {
    const a = { pinned: true, updatedAt: 5 }
    const b = { pinned: true, updatedAt: 15 }
    expect(sortRows([a, b])).toEqual([b, a])
  })

  it('treats a missing pinned flag as false', () => {
    const untouched: Row = { updatedAt: 50 } as Row
    const pinned = { pinned: true, updatedAt: 1 }
    expect(sortRows([untouched, pinned])).toEqual([pinned, untouched])
  })
})

// F6 (d07 = d13 F6): listConversations/conversationsUsage used to getAll() the
// FULL conversations store — every messages[]/history[] transcript — just to
// project 5 scalar summary fields. That cost scales with an install's entire
// lifetime of chat data and used to be paid on every single turn. A lightweight
// `summaries` store (kept in sync inside the same transaction as every write)
// is what these two functions read instead.
describe('listConversations / conversationsUsage (summaries store)', () => {
  beforeEach(async () => {
    await _resetDbForTests()
  })

  it('never surfaces messages/history in the returned rows', async () => {
    await saveConversation({
      id: 'c1',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as never],
      history: [{ role: 'user', content: 'hi' } as never],
    })
    const [row] = await listConversations()
    expect(row).not.toHaveProperty('messages')
    expect(row).not.toHaveProperty('history')
    expect(row).toEqual({
      id: 'c1',
      title: null,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      messageCount: 1,
      pinned: false,
    })
  })

  it('reads its rows from a separate summaries object store, not the heavy conversations store', async () => {
    await saveConversation({ id: 'c1', messages: [{ id: 'm1' } as never], history: [] })
    // Open the raw database ourselves and confirm the summaries store exists
    // and independently holds the right projection — proof listConversations'
    // data source really is the lightweight store, not an artifact of the
    // public API alone.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('lychee-conversations')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(db.objectStoreNames.contains('summaries')).toBe(true)
    const row = await new Promise<{ id: string; messageCount: number } | undefined>((resolve, reject) => {
      const tx = db.transaction('summaries', 'readonly')
      const get = tx.objectStore('summaries').get('c1')
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    })
    db.close()
    expect(row).toMatchObject({ id: 'c1', messageCount: 1 })
    expect(row).not.toHaveProperty('messages')
  })

  it('conversationsUsage sums the byte estimate denormalized at write time', async () => {
    await saveConversation({ id: 'c1', messages: [{ id: 'm1', big: 'x'.repeat(1000) } as never], history: [] })
    const usage = await conversationsUsage()
    expect(usage.count).toBe(1)
    expect(usage.bytes).toBeGreaterThan(1000)
    expect(usage.detail).toBe('1 chat')
  })

  it('backfills summaries for conversations that already existed in a pre-summaries (v1) database', async () => {
    await _resetDbForTests()
    // Simulate an install that saved conversations before the summaries store
    // existed: hand-create a v1 database with the old single-store schema.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-conversations', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('conversations', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('conversations', 'readwrite')
        tx.objectStore('conversations').put({
          id: 'legacy-1',
          title: 'Old chat',
          createdAt: 1000,
          updatedAt: 2000,
          messages: [{ id: 'm1' }, { id: 'm2' }],
          history: [],
          pinned: true,
        })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // The module's own openDb() should now upgrade 1 -> 2 and backfill.
    const list = await listConversations()
    expect(list).toEqual([
      { id: 'legacy-1', title: 'Old chat', createdAt: 1000, updatedAt: 2000, messageCount: 2, pinned: true },
    ])
  })

  // R1: a pre-existing row that fails to project into a summary (missing/
  // non-array `messages` — a bug in an earlier release, a manual devtools
  // edit, a partial write) must never abort the v1->v2 upgrade. Per the
  // IndexedDB spec, an uncaught exception thrown from a cursor's onsuccess
  // handler aborts the WHOLE versionchange transaction — rolling back both
  // the summaries-store creation AND the version bump — so every subsequent
  // openDb() would retry the identical upgrade, hit the identical bad row,
  // and abort again: the database stuck at v1 forever, with list/save/
  // rename/pin/delete/clear all broken permanently and no in-app recovery.
  it('does not brick the database when one pre-existing row is malformed: it is degraded, not dropped, and the upgrade still completes', async () => {
    await _resetDbForTests()
    const malformed = {
      id: 'bad-1',
      title: 'Poisoned row',
      createdAt: 500,
      updatedAt: 600,
      // No `messages` array at all — the exact shape that makes
      // `toSummaryRow`'s `c.messages.length` throw a TypeError. Caught by the
      // `Array.isArray` guard, this one still projects a real (if
      // messageCount-less) summary — title/dates are genuine, nothing here
      // was actually unreadable.
      history: [],
    }
    // A circular reference is exactly the "more realistic going forward" case
    // the review named: `messages` IS an array (the guard above doesn't fire),
    // but the unrelated `estimateBytes` walk in the same function recurses
    // forever over the cycle and stack-overflows — a genuinely unrecoverable
    // per-row failure that only the try/catch (not the Array.isArray guard)
    // can contain. Structured-clone (what IndexedDB actually uses) supports
    // cycles, so this round-trips through a real put/get, unlike JSON.
    const circular: Record<string, unknown> = { id: 'm1' }
    circular.self = circular
    const malformedCircular = {
      id: 'bad-2',
      title: 'Circular row',
      createdAt: 700,
      updatedAt: 800,
      messages: [circular],
      history: [],
    }
    const healthy = {
      id: 'good-1',
      title: 'Fine',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [{ id: 'm1' }, { id: 'm2' }],
      history: [],
      pinned: true,
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-conversations', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('conversations', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('conversations', 'readwrite')
        const store = tx.objectStore('conversations')
        store.put(malformed)
        store.put(malformedCircular)
        store.put(healthy)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // The module's own openDb() upgrade path, exercised exactly as a
    // side-panel reopen would trigger it. Must not throw/reject.
    const list = await listConversations()

    expect(list.find((c) => c.id === 'good-1')).toEqual({
      id: 'good-1', title: 'Fine', createdAt: 1000, updatedAt: 2000, messageCount: 2, pinned: true,
    })

    // The non-array-`messages` row is caught by the defensive field-level
    // guard, not the generic catch — its real title/dates survive; only the
    // unknowable message count is defaulted.
    expect(list.find((c) => c.id === 'bad-1')).toEqual({
      id: 'bad-1', title: 'Poisoned row', createdAt: 500, updatedAt: 600, messageCount: 0, pinned: false,
    })

    // The circular-reference row defeats the field-level guard (`messages`
    // IS an array) and can only be caught by the generic try/catch around
    // the whole projection. It must still be LISTED — never silently
    // dropped — but honestly marked as unreadable rather than showing
    // fabricated data.
    const bad2 = list.find((c) => c.id === 'bad-2')
    expect(bad2).toBeDefined()
    expect(bad2?.title).toBe('(unreadable conversation)')

    // The upgrade must have actually completed, and a second raw open confirms
    // it rather than being stuck retrying forever. This row was seeded at v1, so
    // this also covers the straight v1 → current jump an old install takes:
    // every store must exist afterwards, not just the one the last bump added.
    // Keep this in step with DB_VERSION in conversations.ts.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('lychee-conversations')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(db.version).toBe(3)
    expect(db.objectStoreNames.contains('summaries')).toBe(true)
    expect(db.objectStoreNames.contains('inflight')).toBe(true)

    // The original malformed records themselves must be untouched: the
    // migration may read the conversations store but must never mutate or
    // delete it.
    const getRaw = (id: string) =>
      new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('conversations', 'readonly')
        const get = tx.objectStore('conversations').get(id)
        get.onsuccess = () => resolve(get.result)
        get.onerror = () => reject(get.error)
      })
    expect(await getRaw('bad-1')).toEqual(malformed)
    expect(await getRaw('bad-2')).toEqual(malformedCircular)
    db.close()

    // Every write path that assumes `summaries` exists must keep working —
    // proof the db isn't stuck retrying a broken upgrade on every open.
    await expect(listConversations()).resolves.toBeDefined()
    await expect(saveConversation({ id: 'new-1', messages: [], history: [] })).resolves.toBeUndefined()
    await expect(clearConversations()).resolves.toBeUndefined()
  })

  it('deleteConversation and clearConversations also remove the summary row, not just the full record', async () => {
    await saveConversation({ id: 'c1', messages: [], history: [] })
    await saveConversation({ id: 'c2', messages: [], history: [] })

    await deleteConversation('c1')
    expect((await listConversations()).map((c) => c.id)).toEqual(['c2'])

    await clearConversations()
    expect(await listConversations()).toEqual([])
    expect(await getConversation('c2')).toBeNull()
  })
})

describe('saveConversation / renameConversation / togglePin', () => {
  beforeEach(async () => {
    await _resetDbForTests()
  })

  it('preserves pinned and regen across a later transcript save (mutate is field-by-field, not a spread)', async () => {
    await saveConversation({ id: 'c1', messages: [], history: [] })
    await togglePin('c1')
    expect((await getConversation('c1'))?.pinned).toBe(true)

    // A later transcript save must not silently unpin the conversation, and
    // must carry forward a regen target it wasn't given.
    const regen = {
      historyLen: 1,
      opener: null,
      firstBubbleId: 'b1',
      attachedSources: [],
      activeSkill: null,
      journalUserText: '',
      droppableTail: false,
      allowed: [],
    }
    await saveConversation({ id: 'c1', messages: [], history: [], regen })
    await saveConversation({ id: 'c1', messages: [{ id: 'm1' } as never], history: [] })

    const final = await getConversation('c1')
    expect(final?.pinned).toBe(true)
    expect(final?.regen).toEqual(regen)
  })

  it('renameConversation and togglePin create a stub row and its summary when the transcript has not saved yet', async () => {
    await renameConversation('c1', 'Named before first save')
    const list = await listConversations()
    expect(list).toEqual([
      {
        id: 'c1',
        title: 'Named before first save',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        messageCount: 0,
        pinned: false,
      },
    ])
  })
})

describe('in-flight turns', () => {
  beforeEach(async () => {
    await _resetDbForTests()
  })

  const inflight = (o: Partial<InFlightTurn> = {}): InFlightTurn => ({
    conversationId: 'c1',
    startedAt: 1000,
    updatedAt: 1000,
    messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'half a rep' }] }],
    history: [{ role: 'user', content: 'go' }],
    ctx: {
      attachedSources: [],
      activeSkill: null,
      journalUserText: 'go',
      droppableTail: true,
      regen: null,
    },
    activeNames: ['ReadPage'],
    autoContinues: 0,
    episodeId: 'e1',
    assistantId: 'a1',
    ...o,
  })

  it('round-trips an in-flight record', async () => {
    await saveInFlight(inflight())
    const got = await getInFlight('c1')
    expect(got?.assistantId).toBe('a1')
    expect(got?.activeNames).toEqual(['ReadPage'])
    expect(got?.messages).toHaveLength(1)
  })

  it('is undefined for a conversation with nothing in flight', async () => {
    expect(await getInFlight('nope')).toBeUndefined()
  })

  it('clears explicitly', async () => {
    await saveInFlight(inflight())
    await clearInFlight('c1')
    expect(await getInFlight('c1')).toBeUndefined()
  })

  it('is deleted by the final saveConversation, in the same transaction', async () => {
    // THE atomicity rule. A finished turn must never leave a resume card behind
    // — and the delete has to ride the same transaction as the record write, or
    // a crash between the two would strand one.
    await saveInFlight(inflight())
    await saveConversation({ id: 'c1', messages: [], history: [] })
    expect(await getInFlight('c1')).toBeUndefined()
  })

  it('does not disturb another conversation’s in-flight record', async () => {
    await saveInFlight(inflight({ conversationId: 'c1' }))
    await saveInFlight(inflight({ conversationId: 'c2' }))
    await saveConversation({ id: 'c1', messages: [], history: [] })
    expect(await getInFlight('c1')).toBeUndefined()
    expect(await getInFlight('c2')).toBeDefined()
  })

  it('is taken with the conversation on delete', async () => {
    await saveInFlight(inflight())
    await deleteConversation('c1')
    expect(await getInFlight('c1')).toBeUndefined()
  })

  it('is wiped by clearConversations', async () => {
    await saveInFlight(inflight())
    await clearConversations()
    expect(await getInFlight('c1')).toBeUndefined()
  })

  it('sweeps records older than the cutoff and keeps fresh ones', async () => {
    const now = Date.now()
    await saveInFlight(inflight({ conversationId: 'old', updatedAt: now - 10 * 86_400_000 }))
    await saveInFlight(inflight({ conversationId: 'fresh', updatedAt: now - 60_000 }))
    await sweepInFlight(7 * 86_400_000)
    expect(await getInFlight('old')).toBeUndefined()
    expect(await getInFlight('fresh')).toBeDefined()
  })

  it('a rename or pin does NOT clear an in-flight turn', async () => {
    // The auto-namer fires while a turn is still streaming. If renaming cleared
    // the in-flight record, every conversation would lose its crash recovery at
    // precisely the moment the turn was still running.
    await saveInFlight(inflight())
    await renameConversation('c1', 'Named mid-turn')
    await togglePin('c1')
    expect(await getInFlight('c1')).toBeDefined()
  })
})
