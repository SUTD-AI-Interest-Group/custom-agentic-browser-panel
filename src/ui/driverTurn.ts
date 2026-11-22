// The transcript side of `@driver` (src/decider/driverPrompt.ts parses the message; the offscreen
// host runs the scripted model, src/agent/driverScript.ts). Pure and React-free, like the other
// per-helper files here, so Chat.tsx's decisions about a driver turn unit-test without mounting it.
//
// A driver turn is marked on its bubbles (`UIMessage.driver`): the user bubble that started it, and
// every assistant bubble the scripted model wrote. The marks are booleans — the spec itself is
// re-parsed from the user's own text when a chain has to be re-entered (a park resumed, a turn
// regenerated or recovered), so nothing new is persisted.

import type { UIMessage } from '../agent/agent'
import { parseDriverPrompt, type DriverSpec } from '../decider/driverPrompt'

/** The user message a "Continue with chat model" click sends. */
export const CONTINUE_WITH_CHAT_MODEL = 'Continue this task with the chat model.'

const textOf = (m: UIMessage) =>
  m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join(' ')
    .trim()

/**
 * Re-entering a chain over this transcript (park resume, regenerate, recovery): is it a driver
 * chain? Only when the newest user message is one that STARTED a driver turn — a steer that merely
 * contains `@driver` is an ordinary message, and a "Continue with chat model" turn is the chat
 * model's. Returns the spec re-parsed from that message, or undefined.
 */
export function driverSpecFromTranscript(messages: UIMessage[]): DriverSpec | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (m.driver !== true) return undefined
    const spec = parseDriverPrompt(textOf(m))
    return spec.goal ? spec : undefined
  }
  return undefined
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Should "Continue with chat model" sit under this (the newest) message? Only under a driver bubble
 * whose LAST FastSteps run ended without finishing: a hand-back, a stop, an error. Not after `done`;
 * not after the user declined a step (or the page-control card itself — no FastSteps ran at all);
 * not after the user stopped the turn (Stop drops the turn from history, so the chat model would
 * have nothing to continue from); and not while a run is still in flight. The caller adds "no chain
 * is running".
 */
export function driverContinueOffered(message: UIMessage | undefined): boolean {
  if (!message || message.role !== 'assistant' || message.driver !== true) return false
  let last: Extract<UIMessage['parts'][number], { type: 'tool' }> | undefined
  for (const p of message.parts) if (p.type === 'tool' && p.toolName === 'FastSteps') last = p
  if (!last) return false
  if (last.state === 'error') return true
  if (last.state !== 'done' || !isObj(last.output)) return false
  const out = last.output
  if (typeof out.error === 'string') return true
  if (out.status === 'done') return false
  // A park resumes on its own when the user is back on the tab.
  if (out.reason === 'denied' || out.reason === 'stopped' || out.reason === 'steer' || out.parked === true) return false
  return true
}
