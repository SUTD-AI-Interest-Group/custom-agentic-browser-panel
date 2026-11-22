import { describe, expect, it } from 'vitest'
import type { UIMessage, UIPart } from '../agent/agent'
import { driverContinueOffered, driverSpecFromTranscript } from './driverTurn'

const fast = (output: unknown, state: 'running' | 'done' | 'error' = 'done'): UIPart => ({
  type: 'tool', toolCallId: Math.random().toString(36), toolName: 'FastSteps', input: {}, output, state,
})
const rpc: UIPart = { type: 'tool', toolCallId: 'r', toolName: 'RequestPageControl', input: {}, output: { started: true }, state: 'done' }
const bubble = (parts: UIPart[], driver = true): UIMessage => ({ id: 'a', role: 'assistant', parts, ...(driver ? { driver: true } : {}) })

describe('driverContinueOffered', () => {
  it('offered after a hand-back, a blocked or stopped run that is not the user’s own doing, or an error', () => {
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'handback', reason: 'unsure' }), { type: 'text', text: 'Stopped…' }]))).toBe(true)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'handback', reason: 'max steps' })]))).toBe(true)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'stopped', reason: 'session ended' })]))).toBe(true)
    expect(driverContinueOffered(bubble([rpc, fast({ error: 'No page-control session is open.' })]))).toBe(true)
    expect(driverContinueOffered(bubble([rpc, fast(undefined, 'error')]))).toBe(true)
  })
  it('the LAST FastSteps run decides', () => {
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'handback', reason: 'max steps' }), fast({ status: 'done', reason: 'done' })]))).toBe(false)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'handback', reason: 'max steps' }), fast({ status: 'handback', reason: 'unsure' })]))).toBe(true)
  })
  it('not after done, a declined step, Stop, a steer, a park, or a page-control card with no run', () => {
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'done', reason: 'done' })]))).toBe(false)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'blocked', reason: 'denied' })]))).toBe(false)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'stopped', reason: 'stopped' })]))).toBe(false)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'stopped', reason: 'steer' })]))).toBe(false)
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'stopped', reason: 'parked', parked: true })]))).toBe(false)
    expect(driverContinueOffered(bubble([{ ...rpc, output: { denied: true } }, { type: 'text', text: 'You declined page control.' }]))).toBe(false)
  })
  it('not while the run is still in flight', () => {
    expect(driverContinueOffered(bubble([rpc, fast(undefined, 'running')]))).toBe(false)
  })
  it('only under a driver bubble: a chat-model turn that used FastSteps itself is the chat model’s to continue', () => {
    expect(driverContinueOffered(bubble([rpc, fast({ status: 'handback', reason: 'unsure' })], false))).toBe(false)
    expect(driverContinueOffered({ id: 'u', role: 'user', parts: [{ type: 'text', text: '@driver x' }], driver: true })).toBe(false)
    expect(driverContinueOffered(undefined)).toBe(false)
  })
})

describe('driverSpecFromTranscript', () => {
  const user = (text: string, driver?: boolean): UIMessage => ({ id: text, role: 'user', parts: [{ type: 'text', text }], ...(driver ? { driver } : {}) })
  it('the newest user message started a driver turn → its spec, re-parsed', () => {
    expect(driverSpecFromTranscript([user('hi'), bubble([]), user('@driver search "mugs"', true), bubble([rpc])])).toEqual({
      goal: 'search "mugs"',
      values: { search: 'mugs' },
    })
  })
  it('a newer ordinary message (a steer, "Continue with chat model") → not a driver chain', () => {
    expect(driverSpecFromTranscript([user('@driver add it', true), bubble([rpc]), user('Continue this task with the chat model.')])).toBeUndefined()
    // A steer that merely contains the token carries no mark.
    expect(driverSpecFromTranscript([user('hi'), user('@driver add it')])).toBeUndefined()
    expect(driverSpecFromTranscript([])).toBeUndefined()
  })
})
