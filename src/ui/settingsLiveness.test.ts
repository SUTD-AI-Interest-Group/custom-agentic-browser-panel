import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// d09 F2: a mid-chain MCP policy tightening had no effect until the whole
// turn/chain ended. `settings` is a plain destructured prop, closed over by
// runTurnChain — which can run for many auto-continue cycles over many
// minutes (see runTurnChain's own doc comment). App keeps a Chat mounted (even
// hidden) while it's mid-turn, so it DOES re-render with a fresh `settings`
// prop on every settings change — but an ALREADY-RUNNING runTurnChain
// invocation is a separate, earlier JS closure that never observes that
// update; it keeps using whatever `settings` was when the chain/cycle
// started, for the rest of its life. A user flipping an MCP tool's policy to
// 'never'/'ask' mid-chain to stop a misbehaving tool had zero effect —
// contradicting the Permissions/MCP tabs' own "commits instantly" promise.
//
// The fix: requestApproval's policy check and runTurnChain's per-cycle
// MCP-toolset construction now read settingsRef.current (synced by a
// useEffect on every render) instead of the closed-over `settings`. Chat.tsx
// has no component test harness, so — like chainLifecycle.test.ts's F2 guard
// — this locks the fix down structurally by reading the source directly
// (mirrors src/exec/sandboxCsp.test.ts's technique).

const HERE = fileURLToPath(import.meta.url)
const CHAT_TSX_PATH = join(dirname(HERE), 'Chat.tsx')

function chatSource(): string {
  return readFileSync(CHAT_TSX_PATH, 'utf-8')
}

test('a settingsRef exists and is kept in sync with the settings prop', () => {
  const src = chatSource()
  expect(src).toMatch(/const settingsRef = useRef\(settings\)/)
  expect(src).toMatch(/settingsRef\.current = settings/)
})

test("requestApproval's auto-approve check reads settingsRef.current, not the closed-over settings", () => {
  const src = chatSource()
  const start = src.indexOf('function requestApproval(request: ApprovalRequest)')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(start, start + 600)
  expect(body).toMatch(/toolPolicy\(settingsRef\.current, request\.toolName\)/)
})

test("runTurnChain's per-cycle MCP-toolset construction reads settingsRef.current, not the closed-over settings", () => {
  const src = chatSource()
  const start = src.indexOf('async function runTurnChain(ctx:')
  expect(start).toBeGreaterThan(-1)
  const loopStart = src.indexOf('while (true) {', start)
  const cycleBody = src.slice(loopStart, loopStart + 1500)
  // buildMcpTools's settings field and the per-cycle tool-policy callback
  // passed into createAgentTools — the two live MCP-policy gating touchpoints.
  expect(cycleBody).toMatch(/settings: settingsRef\.current/)
  expect(cycleBody).toMatch(/toolPolicy\(settingsRef\.current, name\)/)
})
