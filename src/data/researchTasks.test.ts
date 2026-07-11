import { test, expect } from 'vitest'
import { pruneTasks } from './researchTasks'
import type { ResearchTask } from './researchTasks'

function task(id: string, startedAt: number, status: ResearchTask['status'] = 'done'): ResearchTask {
  return { id, question: `q-${id}`, status, steps: [], startedAt, updatedAt: startedAt }
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
