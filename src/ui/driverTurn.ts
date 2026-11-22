// The transcript side of `@driver` (src/decider/driverPrompt.ts parses the message; the offscreen
// host runs the scripted model, src/agent/driverScript.ts). Pure and React-free, like the other
// per-helper files here, so Chat.tsx's decisions about a driver turn unit-test without mounting it.
//
// A driver turn is marked on its bubbles (`UIMessage.driver`): the user bubble that started it, and
// every assistant bubble the scripted model wrote. The marks are booleans — the spec itself is
// re-parsed from the user's own text when a chain has to be re-entered (a park resumed, a turn
// regenerated or recovered), so nothing new is persisted.

import type { ModelMessage } from 'ai'
import type { UIMessage } from '../agent/agent'
import { parseDriverPrompt, type DriverSpec } from '../decider/driverPrompt'

/** The user message a "Continue with chat model" click sends. */
export const CONTINUE_WITH_CHAT_MODEL = 'Continue this task with the chat model.'

/**
 * Re-entering a chain over this transcript (park resume, regenerate, recovery): is it a driver
 * chain? Only when the newest user message is one that STARTED a driver turn — a steer that merely
 * contains `@driver` is an ordinary message, and a "Continue with chat model" turn is the chat
 * model's — AND every assistant bubble after it is the scripted run's own: anything else since (an
 * MCP-completion chain, say) means the driver turn is over, and its old goal must not run again.
 *
 * `typedText` is that turn's MODEL-FACING text as typed (the newest user history message, its
 * context blocks cut off — hooks.ts latestUserText): the text the spec was first parsed from, tab
 * mentions already out, so the re-parsed goal is the one the scripted run matches its turn by.
 * Returns the spec, or undefined.
 */
export function driverSpecFromTranscript(messages: UIMessage[], typedText: string): DriverSpec | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      if (m.driver !== true) return undefined
      continue
    }
    if (m.driver !== true) return undefined
    const spec = parseDriverPrompt(typedText)
    return spec.goal ? spec : undefined
  }
  return undefined
}

/**
 * The history a REGENERATED turn's driver message is read from (as hooks.ts latestUserText reads
 * it): the turn's opener when it has one; a chain that was itself a park resume or a recovery has
 * none, and then it is the history up to the rewind point, whose newest user message is that turn's.
 * Without this a resumed driver chain regenerated as an ordinary one, on the chat model. Pure.
 */
export function regenSource(opener: ModelMessage | null, history: readonly ModelMessage[], historyLen: number): ModelMessage[] {
  return opener ? [opener] : history.slice(0, historyLen)
}

/**
 * Why a driver message may not start a turn now — the composer's inline error — or null. The same
 * check guards every way a driver turn can start: a send, a queued flush, a regenerate, a recovery.
 * An ordinary message (no spec) is never blocked here.
 */
export function driverSendBlock(driver: DriverSpec | undefined, unavailable: string | null): string | null {
  if (!driver) return null
  return unavailable ?? (driver.goal ? null : 'Say what to do after @driver.')
}

/**
 * Queue a message submitted while a turn runs. Two ordinary messages (composer actions included)
 * merge as before; a @driver message never merges with anything — merged, either its goal would
 * swallow an ordinary request or an ordinary one would lose its routing — so it waits as its own
 * turn. Pure.
 */
export function enqueueSpec<T extends { driver?: unknown }>(queue: readonly T[], spec: T, merge: (a: T, b: T) => T): T[] {
  const last = queue[queue.length - 1]
  if (last && !last.driver && !spec.driver) return [...queue.slice(0, -1), merge(last, spec)]
  return [...queue, spec]
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
