import { test, expect } from 'vitest'
import { pruneTasks, resumableTasks, taskDeadline, MAX_RESEARCH_DURATION_MS } from './researchTasks'
import type { ResearchTask } from './researchTasks'

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
