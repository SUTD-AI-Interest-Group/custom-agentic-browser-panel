import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetTracesForTests,
  clearTraces,
  deleteTracesForConversation,
  getTrace,
  saveTrace,
  tracesUsage,
  type TraceStep,
} from './traces'

const step = (o: Partial<TraceStep> = {}): TraceStep => ({
  index: 0,
  startedAt: 1000,
  durationMs: 250,
  activeTools: ['ToolSearch', 'GetTool', 'ReadPage'],
  toolCalls: [{ name: 'ReadPage', ok: true }],
  ...o,
})

const trace = (o: Partial<Parameters<typeof saveTrace>[0]> = {}) => ({
  id: 't1',
  conversationId: 'c1',
  createdAt: Date.now(),
  label: 'what is on this page?',
  steps: [step()],
  ...o,
})

describe('traces store', () => {
  beforeEach(async () => {
    await _resetTracesForTests()
  })

  it('round-trips a trace', async () => {
    await saveTrace(trace())
    const got = await getTrace('t1')
    expect(got?.label).toBe('what is on this page?')
    expect(got?.steps).toHaveLength(1)
    expect(got?.steps[0].activeTools).toEqual(['ToolSearch', 'GetTool', 'ReadPage'])
  })

  it('is undefined for a turn that was never traced', async () => {
    expect(await getTrace('nope')).toBeUndefined()
  })

  it('computes a byte estimate at write time so pruning never reads a record', async () => {
    await saveTrace(trace())
    expect((await getTrace('t1'))?.bytes).toBeGreaterThan(0)
  })

  it('reports usage from the index alone', async () => {
    await saveTrace(trace({ id: 't1' }))
    await saveTrace(trace({ id: 't2' }))
    const usage = await tracesUsage()
    expect(usage.count).toBe(2)
    expect(usage.bytes).toBeGreaterThan(0)
    expect(usage.detail).toBe('2 turns')
  })

  it('uses the singular in its detail for exactly one trace', async () => {
    await saveTrace(trace())
    expect((await tracesUsage()).detail).toBe('1 turn')
  })

  it('cascades on conversation delete, leaving other conversations alone', async () => {
    await saveTrace(trace({ id: 't1', conversationId: 'c1' }))
    await saveTrace(trace({ id: 't2', conversationId: 'c2' }))
    await deleteTracesForConversation('c1')
    expect(await getTrace('t1')).toBeUndefined()
    expect(await getTrace('t2')).toBeDefined()
    // The index row must go with it, or usage would keep counting a ghost.
    expect((await tracesUsage()).count).toBe(1)
  })

  it('evicts traces past the age cap', async () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    await saveTrace(trace({ id: 'old', createdAt: old }))
    await saveTrace(trace({ id: 'fresh' }))
    // saveTrace prunes on write, so the stale row is already gone.
    expect(await getTrace('old')).toBeUndefined()
    expect(await getTrace('fresh')).toBeDefined()
  })

  it('clears everything, index included', async () => {
    await saveTrace(trace())
    await clearTraces()
    expect(await getTrace('t1')).toBeUndefined()
    expect((await tracesUsage()).count).toBe(0)
  })

  it('keeps the index in step with the record across an overwrite', async () => {
    await saveTrace(trace({ steps: [step()] }))
    await saveTrace(trace({ steps: [step(), step({ index: 1 })] }))
    expect((await getTrace('t1'))?.steps).toHaveLength(2)
    // One record, one index row — an overwrite must not double-count.
    expect((await tracesUsage()).count).toBe(1)
  })
})
