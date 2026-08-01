// Pure decisions behind the composer textarea's onKeyDown handler, extracted so
// they're unit-testable without a DOM or mounting Chat.

import type { UIMessage } from '../agent/agent'

/**
 * Whether the composer's onKeyDown handler should ignore this keydown outright
 * — currently just "an IME composition is in progress." Without this guard,
 * confirming a kanji/hanja/hangul candidate with Enter (a completely ordinary
 * keystroke for CJK input, not intended to submit anything) fell through to
 * the handler's Enter-to-submit branch and sent a half-typed message; Arrow
 * keys used to navigate a candidate list fell through to history-recall and
 * overwrote the whole composer. Checked FIRST, before any popover/recall/
 * submit branch, so it uniformly guards all of them with one early return.
 */
export function shouldIgnoreComposerKeydown(e: { isComposing?: boolean }): boolean {
  return e.isComposing === true
}

/**
 * This conversation's previous user messages, newest first — the source list
 * for ArrowUp/ArrowDown composer history-recall. A plain function (called
 * lazily, only from inside the ArrowUp/ArrowDown branches of onKeyDown)
 * rather than a `useMemo` keyed on the whole `messages` array: that array's
 * identity changes on every streamed token (see MessageView's memoization
 * fix), so a reactive memo here recomputed a full backward transcript scan on
 * every token even though the result is read only when the user actually
 * presses an arrow key.
 */
export function recallableUserTexts(messages: UIMessage[]): string[] {
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const t = messages[i].parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    if (t) texts.push(t)
  }
  return texts
}
