// buildUserTurn hardening (d11 F6): a graceful fallback for when gathering a
// turn/steer's attached context fails outright, instead of the caller
// stranding a user message or losing an unrelated co-queued steer.

import type { ModelMessage } from 'ai'
import type { MessageSource } from '../agent/agent'

/** What a steer becomes when buildUserTurn rejects — the user's plain text,
 *  no synced tabs/attachments, tagged so the journal explains the gap. */
export interface SteerFallback {
  message: ModelMessage
  sources: MessageSource[]
  journal: string
  useMemory: boolean
}

/**
 * Steering with the user's plain text is better than losing this steer — AND
 * any others batched in the same runTurnChain drain (`Promise.all` has no
 * partial-success mode) — to one bad promise over, e.g., a rejecting
 * `listOpenTabs()` call from an `@all` steer.
 */
export function buildSteerFallback(text: string, useMemory: boolean): SteerFallback {
  return {
    message: { role: 'user', content: text },
    sources: [],
    journal: [text, '[steer failed to gather its attached context]'].filter(Boolean).join('\n'),
    useMemory,
  }
}

/**
 * The visible error appended to a fresh turn's assistant slot when
 * buildUserTurn itself rejects. Without this, the user's just-added bubble
 * (already pushed to `messages` before the awaited call) is stranded with no
 * reply and no visible error — only a console-level unhandled rejection.
 */
export function freshTurnGatherErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `**Error:** Could not prepare this message: ${msg}`
}
