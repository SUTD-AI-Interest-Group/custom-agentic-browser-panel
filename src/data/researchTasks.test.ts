import { test, expect, vi, afterEach } from 'vitest'
import { pruneTasks, resumableTasks, taskDeadline, capSteps, MAX_RESEARCH_DURATION_MS, clearTasks } from './researchTasks'
import type { ResearchTask, ResearchStep } from './researchTasks'

afterEach(() => {
  vi.unstubAllGlobals()
})

function task(
  id: string,
  startedAt: number,
  status: ResearchTask['status'] = 'done',
  updatedAt = startedAt,
): ResearchTask {
  return { id, question: `q-${id}`, status, steps: [], startedAt, updatedAt }
}

test('under the cap returns the map unchanged', () => {
  const map: Record<string, ResearchTask> = {
    a: task('a', 1),
    b: task('b', 2),
    c: task('c', 3),
  }
  const result = pruneTasks(map, 50)
  expect(result).toBe(map)
  expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c'])
})

test('over the cap keeps exactly max tasks, the newest by startedAt', () => {
  const map: Record<string, ResearchTask> = {}
  for (let i = 0; i < 55; i++) {
    map[`t${i}`] = task(`t${i}`, i)
  }
  const result = pruneTasks(map, 50)
  expect(Object.keys(result).length).toBe(50)
  // newest startedAt values are 5..54
  for (let i = 5; i < 55; i++) {
    expect(result[`t${i}`]).toBeDefined()
  }
  for (let i = 0; i < 5; i++) {
    expect(result[`t${i}`]).toBeUndefined()
  }
})

test('a running task older than the cutoff still survives pruning', () => {
  const map: Record<string, ResearchTask> = {
    old_running: task('old_running', 0, 'running'),
  }
  // 52 done tasks, all newer than the running task
  for (let i = 1; i <= 52; i++) {
    map[`done${i}`] = task(`done${i}`, i, 'done')
  }
  const result = pruneTasks(map, 50)
  expect(result['old_running']).toBeDefined()
  expect(result['old_running'].status).toBe('running')
})

test('a paused task is active and survives pruning like a running one', () => {
  const map: Record<string, ResearchTask> = {
    old_paused: task('old_paused', 0, 'paused'),
  }
  for (let i = 1; i <= 52; i++) {
    map[`done${i}`] = task(`done${i}`, i, 'done')
  }
  const result = pruneTasks(map, 50)
  expect(result['old_paused']).toBeDefined()
  expect(result['old_paused'].status).toBe('paused')
})

test('taskDeadline is startedAt + 24h, and falls back for legacy tasks', () => {
  expect(taskDeadline({ startedAt: 1_000, deadlineAt: 5_000 })).toBe(5_000)
  expect(taskDeadline({ startedAt: 1_000 })).toBe(1_000 + MAX_RESEARCH_DURATION_MS)
})

test('resumableTasks selects only active tasks whose heartbeat is stale', () => {
  const now = 1_000_000
  const staleMs = 180_000
  const map: Record<string, ResearchTask> = {
    fresh_running: task('fresh_running', 0, 'running', now - 1_000), // live worker
    stale_running: task('stale_running', 0, 'running', now - staleMs - 1), // dead worker
    stale_paused: task('stale_paused', 0, 'paused', now - staleMs - 1), // waiting, worker gone
    fresh_paused: task('fresh_paused', 0, 'paused', now - 1_000), // waiting, worker alive
    done: task('done', 0, 'done', now - staleMs - 1),
    cancelled: task('cancelled', 0, 'cancelled', now - staleMs - 1),
    errored: task('errored', 0, 'error', now - staleMs - 1),
  }
  const ids = resumableTasks(map, now, staleMs)
    .map((t) => t.id)
    .sort()
  expect(ids).toEqual(['stale_paused', 'stale_running'])
})

// ---------------------------------------------------------------------------
// capSteps — exported, non-trivial (trim-to-max, prepend exactly one marker
// with the correct drop-count, must be idempotent since saveTask/applyUpdate
// call it on EVERY write) — and had zero direct test coverage before this.
// ---------------------------------------------------------------------------

function step(tool: string): ResearchStep {
  return { tool, summary: tool, detail: '', status: 'done' }
}

test('capSteps is a no-op under the cap, returning the SAME array reference', () => {
  const steps = [step('a'), step('b'), step('c')]
  const result = capSteps(steps, 10)
  expect(result).toBe(steps) // same reference — matches pruneTasks's "unchanged" convention
  expect(result).toEqual([step('a'), step('b'), step('c')])
})

test('capSteps over the cap keeps `max` entries TOTAL — the marker counts toward the cap, not on top of it', () => {
  const steps = Array.from({ length: 205 }, (_, i) => step(`s${i}`))
  const result = capSteps(steps, 200)
  // The marker itself occupies one of the `max` slots: 199 real steps + 1 marker.
  // Without that, an already-at-cap array (max+1 long) would still read as "over
  // the cap" and get re-trimmed by a second call — see the idempotency test below.
  expect(result.length).toBe(200)
  expect(result[0].summary).toContain('6 earlier steps trimmed')
  // The most recent 199 (indices 6..204) survive, oldest-first, marker excluded.
  expect(result.slice(1)).toEqual(steps.slice(-199))
  expect(result[1].tool).toBe('s6')
  expect(result[result.length - 1].tool).toBe('s204')
})

test('capSteps is idempotent — capping an already-capped array is a no-op', () => {
  const steps = Array.from({ length: 205 }, (_, i) => step(`s${i}`))
  const once = capSteps(steps, 200)
  const twice = capSteps(once, 200)
  expect(twice).toBe(once) // already at (or under) the cap — same reference, no further trimming
  expect(twice.length).toBe(200)
})

// ---------------------------------------------------------------------------
// clearTasks() cross-context race (F2, reassigned from the data-domain audit;
// carried over from Wave 1's mitigation to the real fix here).
//
// clearTasks() used to write chrome.storage.local directly no matter which
// context called it. The SW (background.ts) and the side panel (via
// storage.ts's clearStore/eraseAllData) each import this module as their OWN JS
// execution context, so the module-scoped `writeChain` above only serializes
// writes WITHIN one context — a panel-issued clear could race an in-flight SW
// saveTask/applyUpdate/heartbeat with no way to serialize the two against each
// other. An earlier fix mitigated this with a storage-backed "clearedAt" marker
// every writer rechecked immediately before its own write (narrowing the race,
// not closing it — see git history / the W1-F report for that version).
//
// The actual fix, tested below: clearTasks() only ever writes directly when IT
// IS the service worker (no `window` global there); everywhere else — the side
// panel today — it asks the SW to do it via a chrome.runtime message instead.
// That leaves exactly one writer of this key, ever, so the marker is gone: it
// could never fire its "skip" branch again now that there is no second writer
// left to race against.
// ---------------------------------------------------------------------------

test('clearTasks() in the service worker (no window global) clears directly — no runtime message, no clearedAt marker', async () => {
  vi.stubGlobal('window', undefined) // simulates the SW: no window global exists there
  const store: Record<string, unknown> = { researchTasks: { t1: task('t1', 1) } }
  const sendMessage = vi.fn()
  const remove = vi.fn((key: string) => {
    delete store[key]
    return Promise.resolve()
  })
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: {
        get: vi.fn((key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {})),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(store, items)
          return Promise.resolve()
        }),
        remove,
      },
    },
  })

  await clearTasks()

  expect(remove).toHaveBeenCalledWith('researchTasks')
  expect(store.researchTasks).toBeUndefined()
  expect(sendMessage).not.toHaveBeenCalled()
  // The old clearedAt-marker mitigation must be gone: once the SW is the only
  // writer, ever, a recheck-before-write marker guards nothing (see clearTasks()'s
  // doc comment) — so it must not still be written on every clear.
  expect(store.researchTasksClearedAt).toBeUndefined()
})

test('clearTasks() outside the service worker (a window global present, e.g. the side panel) routes through a message instead of touching storage', async () => {
  // jsdom's default `window` is already present here — nothing to stub — which is
  // exactly what makes this simulate the panel rather than the SW.
  const store: Record<string, unknown> = { researchTasks: { t1: task('t1', 1) } }
  const remove = vi.fn((key: string) => {
    delete store[key]
    return Promise.resolve()
  })
  const set = vi.fn((items: Record<string, unknown>) => {
    Object.assign(store, items)
    return Promise.resolve()
  })
  const sendMessage = vi.fn(() => Promise.resolve(undefined))
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(() => Promise.resolve({})), set, remove } },
  })

  await clearTasks()

  expect(sendMessage).toHaveBeenCalledWith({ type: 'research.clearTasks' })
  // The panel must never touch storage directly for this — that is the whole
  // point of the fix (it is what used to race the SW's writeChain).
  expect(remove).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  expect(store.researchTasks).toEqual({ t1: task('t1', 1) }) // untouched by this call
})

test('clearTasksNow() shares the SAME writeChain as applyUpdate() — the update runs to completion, THEN the clear removes it', async () => {
  // A fresh module instance keeps this test's writeChain isolated from the
  // others above, though by this point in the file it would already be settled
  // regardless (every earlier test awaits its own operations to completion).
  vi.resetModules()
  const store: Record<string, unknown> = { researchTasks: { t1: task('t1', 1, 'running') } }
  // Records WHICH storage call fired first, not just what `store` ends up
  // holding — see the comment below the assertions for why the end state
  // alone is not evidence of correct serialization here.
  const callOrder: string[] = []
  const get = vi.fn((key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}))
  const set = vi.fn((items: Record<string, unknown>) => {
    callOrder.push('set')
    Object.assign(store, items)
    return Promise.resolve()
  })
  const remove = vi.fn((key: string) => {
    callOrder.push('remove')
    delete store[key]
    return Promise.resolve()
  })
  vi.stubGlobal('chrome', { storage: { local: { get, set, remove } } })
  const mod = await import('./researchTasks')

  const applyDone = mod.applyUpdate('t1', { status: 'paused' }) // queued first
  const clearDone = mod.clearTasksNow() // queued second, same writeChain
  const [applyResult] = await Promise.all([applyDone, clearDone])

  // FIFO ordering via the shared writeChain means the update's read-modify-write
  // runs to completion BEFORE the clear starts — so the clear (strictly later)
  // always wins. Checking only the end state (`researchTasks` undefined) is NOT
  // proof of that: if the writeChain were broken and the clear jumped ahead
  // instead, it would delete the row first, applyUpdate's own re-read would
  // then find nothing, and its `if (!cur) return undefined` guard (line ~341)
  // would silently no-op WITHOUT ever calling set() — leaving `researchTasks`
  // undefined for a completely different, accidental reason. Asserting the
  // update actually produced a result, that set() ran with the update's own
  // payload, and that set() precedes remove() in call order is what only real
  // serialization — not that accidental no-op — can satisfy.
  expect(applyResult).toMatchObject({ id: 't1', status: 'paused' })
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ researchTasks: expect.objectContaining({ t1: expect.objectContaining({ status: 'paused' }) }) }),
  )
  expect(callOrder).toEqual(['set', 'remove'])
  expect(store.researchTasks).toBeUndefined()
})
