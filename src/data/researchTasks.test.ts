import { test, expect, vi } from 'vitest'
import { pruneTasks, resumableTasks, taskDeadline, capSteps, MAX_RESEARCH_DURATION_MS } from './researchTasks'
import type { ResearchTask, ResearchStep } from './researchTasks'

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
// clearTasks() cross-context race (F2, reassigned from the data-domain audit).
//
// The SW and the side panel each import this module as their OWN JS execution
// context, so the module-scoped `writeChain` below only serializes writes
// WITHIN one context — it cannot stop a panel-issued clearTasks() from racing
// an in-flight SW saveTask/applyUpdate/heartbeat (or vice versa). Simulated here
// via vi.resetModules() + two dynamic imports, each getting its own writeChain,
// sharing only the (mocked) chrome.storage.local — exactly like SW vs panel.
// ---------------------------------------------------------------------------

/** A chrome.storage.local stub whose get() SNAPSHOTS the value at call time but
 *  can delay DELIVERY of that snapshot — the only way to faithfully simulate "I
 *  already read a value; tell me about it later, whatever else happens to the
 *  store in the meantime" (a plain object store that reads lazily at resolution
 *  time would not reproduce the race at all). */
function stubChromeStorageWithGate() {
  const store: Record<string, unknown> = {}
  let gate: Promise<void> | null = null
  let release: (() => void) | undefined
  const get = vi.fn((key: string) => {
    const snapshot = key in store ? { [key]: store[key] } : {}
    if (key === 'researchTasks' && gate) return gate.then(() => snapshot)
    return Promise.resolve(snapshot)
  })
  const set = vi.fn((items: Record<string, unknown>) => {
    Object.assign(store, items)
    return Promise.resolve()
  })
  const remove = vi.fn((key: string) => {
    delete store[key]
    return Promise.resolve()
  })
  vi.stubGlobal('chrome', { storage: { local: { get, set, remove } } })
  return {
    store,
    /** The NEXT read of the task map will block until release() is called. */
    armGate: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    release: () => release?.(),
  }
}

test('a clear from one context is not resurrected by a slower write already in flight from another', async () => {
  const { store, armGate, release } = stubChromeStorageWithGate()

  vi.resetModules()
  const modB = await import('./researchTasks') // simulates the service worker
  vi.resetModules()
  const modA = await import('./researchTasks') // simulates the side panel

  store.researchTasks = { t1: task('t1', 1, 'running') }

  armGate() // the next read of the task map blocks until release() is called

  // B starts a read-modify-write — it snapshots the (about-to-be-stale) map...
  const applyDone = modB.applyUpdate('t1', { status: 'paused' })

  // ...while B's read is blocked, A (a different context) clears everything.
  await modA.clearTasks()
  expect(store.researchTasks).toBeUndefined()

  // Only now does B's delayed read resolve, and B proceeds to compute + write.
  release()
  await applyDone

  // The clear must win: B's write must not resurrect the map it read before the
  // clear landed.
  expect(store.researchTasks).toBeUndefined()
})
