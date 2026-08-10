import { describe, expect, it } from 'vitest'
import type { InFlightTurn } from '../data/conversations'
import { INFLIGHT_MAX_AGE_MS, isResumable, restoreCtx } from './turnRecovery'

const NOW = 1_700_000_000_000

const record = (o: Partial<InFlightTurn> = {}): InFlightTurn => ({
  conversationId: 'c1',
  startedAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] }],
  history: [{ role: 'user', content: 'go' }],
  ctx: {
    attachedSources: [],
    activeSkill: null,
    journalUserText: 'go',
    droppableTail: true,
    regen: null,
  },
  activeNames: ['ReadPage', 'GetTool'],
  autoContinues: 1,
  episodeId: 'e1',
  assistantId: 'a1',
  ...o,
})

describe('isResumable', () => {
  it('accepts a checkpoint from a minute ago', () => {
    expect(isResumable(record(), NOW)).toBe(true)
  })

  it('rejects a checkpoint older than the max age', () => {
    expect(isResumable(record({ updatedAt: NOW - INFLIGHT_MAX_AGE_MS - 1 }), NOW)).toBe(false)
  })

  it('rejects a checkpoint with no history to resume from', () => {
    // Nothing to send: resuming would post an empty prompt and bill the user
    // for a turn that cannot say anything.
    expect(isResumable(record({ history: [] }), NOW)).toBe(false)
  })

  it('rejects a checkpoint timestamped in the future', () => {
    // Clock skew or a corrupted write. Treated the same way dream.ts treats an
    // implausibly-future lock: not trustworthy, so not offered.
    expect(isResumable(record({ updatedAt: NOW + 10 * 60_000 }), NOW)).toBe(false)
  })

  it('tolerates trivial clock skew rather than discarding a live checkpoint', () => {
    expect(isResumable(record({ updatedAt: NOW + 500 }), NOW)).toBe(true)
  })
})

describe('restoreCtx', () => {
  it('rebuilds the chain ctx verbatim', () => {
    const { ctx } = restoreCtx(record())
    expect(ctx.journalUserText).toBe('go')
    expect(ctx.droppableTail).toBe(true)
    expect(ctx.regen).toBeNull()
  })

  it('restores activeNames as a Set so disclosure keeps working', () => {
    const { activeNames } = restoreCtx(record())
    expect(activeNames).toBeInstanceOf(Set)
    expect(activeNames.has('ReadPage')).toBe(true)
  })

  it('never restores a page-control grant or an image queue', () => {
    // THE safety property of this feature. A resumed turn must re-ask for page
    // control through a fresh card: the tab has very likely navigated, so the
    // stored session's origin fence is meaningless. Asserting the exact key set
    // means a future edit that smuggles a session back in fails here.
    expect(Object.keys(restoreCtx(record())).sort()).toEqual(['activeNames', 'ctx'])
  })

  it('does not alias the stored arrays, so resuming cannot mutate the record', () => {
    const stored = record()
    const { activeNames } = restoreCtx(stored)
    activeNames.add('ControlPage')
    expect(stored.activeNames).toEqual(['ReadPage', 'GetTool'])
  })
})
