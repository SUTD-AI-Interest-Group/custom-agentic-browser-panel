import { expect, test } from 'vitest'
import { buildSteerFallback, freshTurnGatherErrorText } from './steerFallback'

// d11 F6: buildUserTurn had one unguarded `await listOpenTabs()` (@all), unlike
// every other sub-step in the function (readTabContent, assembleAttachments are
// both self-guarding). A rejection there propagated out of injectSteer's pushed
// promise with no .catch() — runTurnChain's drain does
// `Promise.all(steerQueueRef.current.splice(0))`, so ONE bad steer aborted the
// WHOLE chain (as a generic chain-level error) and lost any other, healthy
// steer batched in the same drain. Separately, startFreshTurn's own unguarded
// `await buildUserTurn(spec)` left the user's just-added bubble with no reply
// and no visible error on failure — only a console-level unhandled rejection.
//
// These two pure helpers back the fix: injectSteer's pushed promise now has a
// `.catch()` producing this fallback instead of rejecting, and startFreshTurn's
// catch appends this error text to a fresh assistant bubble instead of leaving
// the user's message stranded.

test('buildSteerFallback carries the plain text with no attached sources, tagged with a failure note', () => {
  const f = buildSteerFallback('summarize this', true)
  expect(f.message).toEqual({ role: 'user', content: 'summarize this' })
  expect(f.sources).toEqual([])
  expect(f.journal).toContain('summarize this')
  expect(f.journal).toContain('[steer failed to gather its attached context]')
  expect(f.useMemory).toBe(true)
})

test('buildSteerFallback preserves useMemory:false', () => {
  expect(buildSteerFallback('hi', false).useMemory).toBe(false)
})

test('freshTurnGatherErrorText formats an Error', () => {
  expect(freshTurnGatherErrorText(new Error('tabs.query failed'))).toBe(
    '**Error:** Could not prepare this message: tabs.query failed',
  )
})

test('freshTurnGatherErrorText formats a non-Error thrown value', () => {
  expect(freshTurnGatherErrorText('nope')).toBe('**Error:** Could not prepare this message: nope')
})
