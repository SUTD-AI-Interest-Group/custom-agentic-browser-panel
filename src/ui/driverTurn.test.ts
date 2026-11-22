import { describe, expect, it } from 'vitest'
import type { UIMessage, UIPart } from '../agent/agent'
import { driverContinueOffered, driverSendBlock, driverSpecFromTranscript, enqueueSpec } from './driverTurn'
import { driverSpecFor } from '../decider/driverPrompt'

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
  it('the newest user message started a driver turn → its spec, re-parsed from the model-facing typed text', () => {
    expect(driverSpecFromTranscript([user('hi'), bubble([]), user('@driver search "mugs"', true), bubble([rpc])], 'search "mugs"')).toEqual({
      goal: 'search "mugs"',
      values: { search: 'mugs' },
    })
    // Recovered before any reply bubble: still a driver turn.
    expect(driverSpecFromTranscript([user('@driver search "mugs"', true)], 'search "mugs"')).toBeDefined()
  })
  it('a tab mention in the bubble does not change the goal: it comes from the model-facing text (mentions already out)', () => {
    expect(driverSpecFromTranscript([user('@driver open @Driver Booster Pro downloads', true), bubble([rpc])], 'open  downloads')?.goal).toBe('open downloads')
  })
  it('a newer ordinary message (a steer, "Continue with chat model") → not a driver chain', () => {
    expect(driverSpecFromTranscript([user('@driver add it', true), bubble([rpc]), user('Continue this task with the chat model.')], 'x')).toBeUndefined()
    // A steer that merely contains the token carries no mark.
    expect(driverSpecFromTranscript([user('hi'), user('@driver add it')], 'add it')).toBeUndefined()
    expect(driverSpecFromTranscript([], 'x')).toBeUndefined()
  })
  it('any non-driver assistant bubble after the driver turn (an MCP-completion chain) ends it: the old goal never re-runs', () => {
    const mcp: UIMessage = { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'The task finished.' }], autoContinue: 1 }
    expect(driverSpecFromTranscript([user('@driver add it', true), bubble([rpc]), mcp], 'add it')).toBeUndefined()
    expect(driverSpecFromTranscript([user('@driver add it', true), bubble([rpc]), bubble([rpc])], 'add it')).toBeDefined()
  })
  it('an empty goal is not a spec', () => {
    expect(driverSpecFromTranscript([user('@driver', true)], '')).toBeUndefined()
  })
})

describe('driverSendBlock — the one check every way a driver turn starts', () => {
  const OFF = 'Turn the decision model on in Settings → Experimental.'
  it('an ordinary message is never blocked, Off or on — a tab titled "Driver Booster" mentioned included', () => {
    expect(driverSendBlock(driverSpecFor('@Driver Booster Pro what is this?', ['@Driver Booster Pro']), OFF)).toBeNull()
    expect(driverSendBlock(driverSpecFor('@Driver Booster Pro what is this?', ['@Driver Booster Pro']), null)).toBeNull()
  })
  it('a driver message is blocked while unavailable (Off), and goes when available (on)', () => {
    expect(driverSendBlock(driverSpecFor('@driver add the mug'), OFF)).toBe(OFF)
    expect(driverSendBlock(driverSpecFor('@driver add the mug'), null)).toBeNull()
  })
  it('a driver message with nothing to do is blocked even when available', () => {
    expect(driverSendBlock(driverSpecFor('@driver'), null)).toBe('Say what to do after @driver.')
  })
})

describe('enqueueSpec — messages submitted while a turn runs', () => {
  type Q = { text: string; driver?: { goal: string } }
  const merge = (a: Q, b: Q): Q => ({ text: `${a.text}+${b.text}` })
  it('ordinary messages (composer actions included) merge as before', () => {
    expect(enqueueSpec<Q>([{ text: 'a' }], { text: 'b' }, merge)).toEqual([{ text: 'a+b' }])
    expect(enqueueSpec<Q>([], { text: 'a' }, merge)).toEqual([{ text: 'a' }])
  })
  it('a @driver message never merges, either way round, nor with another @driver message', () => {
    const d1: Q = { text: 'd1', driver: { goal: 'd1' } }
    const d2: Q = { text: 'd2', driver: { goal: 'd2' } }
    expect(enqueueSpec<Q>([{ text: 'a' }], d1, merge)).toEqual([{ text: 'a' }, d1])
    expect(enqueueSpec<Q>([d1], { text: 'b' }, merge)).toEqual([d1, { text: 'b' }])
    expect(enqueueSpec<Q>([d1], d2, merge)).toEqual([d1, d2])
    // An ordinary message after a driver one merges with a later ordinary one, not across it.
    expect(enqueueSpec<Q>([{ text: 'a' }, d1, { text: 'b' }], { text: 'c' }, merge)).toEqual([{ text: 'a' }, d1, { text: 'b+c' }])
  })
})
