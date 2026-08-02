import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { shouldTearDownPageControl } from './chainLifecycle'

// F1 (d11): a parked chain's `finally` used to tear down the page-control
// session/overlay unconditionally, even though tools.ts's ControlPage deliberately
// designs the session to SURVIVE a park (so returning to the tab resumes mid-plan
// instead of re-asking for control). shouldTearDownPageControl is the extracted
// decision runTurnChain's finally now guards on.
test('shouldTearDownPageControl keeps the session/overlay alive only for a parked exit', () => {
  expect(shouldTearDownPageControl('parked')).toBe(false)
})

test('shouldTearDownPageControl tears down for every other exit reason', () => {
  expect(shouldTearDownPageControl('completed')).toBe(true)
  expect(shouldTearDownPageControl('checkpoint')).toBe(true)
  expect(shouldTearDownPageControl('budget')).toBe(true)
  expect(shouldTearDownPageControl('error')).toBe(true)
  expect(shouldTearDownPageControl('aborted')).toBe(true)
})

// F2 (d11): continueTask() and regenerate() never cleared parkedReason, unlike
// startFreshTurn/resumeFromPark — a completed regenerate after a park could leave
// a stale "Paused" banner, and the tab-focus effect would later fire an unprompted
// phantom turn once the user refocused the long-forgotten bound tab. The fix
// centralizes the reset inside runTurnChain itself (before its `while` loop
// starts) so all four chain-starting call sites get it for free, present and
// future, instead of each needing to remember it individually.
//
// Chat.tsx has no component test harness (confirmed by the audit itself), so this
// locks down the fix structurally: runTurnChain's own body, before its main loop
// begins, unconditionally clears parkedReason. Mirrors this repo's existing
// sandbox-exec.html CSP guard-test technique (src/exec/sandboxCsp.test.ts) for a
// property that has no pure function to extract.
const HERE = fileURLToPath(import.meta.url)
const CHAT_TSX_PATH = join(dirname(HERE), 'Chat.tsx')

function runTurnChainPreLoopBody(): string {
  const src = readFileSync(CHAT_TSX_PATH, 'utf-8')
  const start = src.indexOf('async function runTurnChain(ctx:')
  if (start === -1) throw new Error('runTurnChain not found in Chat.tsx')
  const loopStart = src.indexOf('while (true) {', start)
  if (loopStart === -1) throw new Error('runTurnChain\'s while loop not found in Chat.tsx')
  return src.slice(start, loopStart)
}

test('runTurnChain unconditionally resets parkedReason before its loop starts, so every chain-starting caller gets it for free', () => {
  const body = runTurnChainPreLoopBody()
  expect(body).toMatch(/setParkedReason\(null\)/)
})
