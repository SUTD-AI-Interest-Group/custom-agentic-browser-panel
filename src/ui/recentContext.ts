// A short, bounded plain-text summary of the last few turns, fed to the
// research framing prompt (frameResearch, researchFraming.ts) so it can
// resolve a reference like "the 5 setups" against what the conversation
// actually established. Bounded, not the whole history: a long chat's full
// transcript would blow the framing call's prompt budget for no benefit — the
// model only needs enough of the tail to disambiguate the just-armed message.
// Pure and Chrome/React-free (only a type-only UIMessage import) so it's
// unit-testable without mounting Chat, matching the file-per-pure-helper
// convention this directory already uses (chatNaming.ts, researchCard.ts, …).

import type { UIMessage } from '../agent/agent'

/** How many of the most recent messages to scan, before the character cap. */
const RECENT_CONTEXT_MESSAGES = 8
/** Hard cap on the returned string. Trimmed from the FRONT so the most recent
 *  lines — nearest the message that just got armed — are what survive. */
const RECENT_CONTEXT_CHARS = 4000

/**
 * Render the last few turns as `Role: text` lines, oldest first, joined by a
 * blank line. A research report or launch-card message is skipped — both are
 * artifacts rather than conversation (a finished report's full text would
 * otherwise dominate the char budget with something that isn't dialogue, and
 * a launch card carries no text part at all — see `UIMessage.proposal`'s own
 * comment). A message with no text part (tool-only, or a bare attachment)
 * contributes nothing rather than a blank line. Returns `''` when there is
 * nothing to summarize (a fresh chat, or the window is all artifacts).
 */
export function recentContext(messages: UIMessage[]): string {
  const lines = messages
    .slice(-RECENT_CONTEXT_MESSAGES)
    .flatMap((m) => {
      if (m.research || m.proposal) return []
      const text = m.parts
        .flatMap((p) => (p.type === 'text' ? [p.text] : []))
        .join(' ')
        .trim()
      return text ? [`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`] : []
    })
    .join('\n\n')
  return lines.length > RECENT_CONTEXT_CHARS ? lines.slice(-RECENT_CONTEXT_CHARS) : lines
}
