import { expect, test } from 'vitest'
import type { UIMessage } from '../agent/agent'
import { recallableUserTexts, shouldIgnoreComposerKeydown } from './composerKeys'

// F3 (d11): the composer's onKeyDown had no IME composition guard. Confirming a
// kanji/hanja/hangul candidate with Enter (a completely ordinary CJK keystroke,
// not intended to submit anything) fires a real 'Enter' keydown with
// isComposing:true — with no guard, the handler's Enter-to-submit branch fired
// anyway, sending a half-typed message. Same for ArrowUp/Down candidate
// navigation clobbering the composer via history-recall.
test('shouldIgnoreComposerKeydown is true only while an IME composition is in progress', () => {
  expect(shouldIgnoreComposerKeydown({ isComposing: true })).toBe(true)
  expect(shouldIgnoreComposerKeydown({ isComposing: false })).toBe(false)
  expect(shouldIgnoreComposerKeydown({})).toBe(false)
})

// F5 (d11): recallableUserTexts used to be a useMemo keyed on the whole
// `messages` array, recomputing a full backward transcript scan on every
// streamed token even though the result is read only on ArrowUp. Extracted as
// a plain function (called lazily from the keydown handler, not reactively)
// — this test locks down the same scan logic the old useMemo body ran.
function userMsg(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }
}
function assistantMsg(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text }] }
}

test('recallableUserTexts returns [] for an empty history', () => {
  expect(recallableUserTexts([])).toEqual([])
})

test('recallableUserTexts lists only user messages, newest first', () => {
  const messages = [userMsg('first'), assistantMsg('reply'), userMsg('second'), assistantMsg('reply 2')]
  expect(recallableUserTexts(messages)).toEqual(['second', 'first'])
})

test('recallableUserTexts ignores non-text parts and skips empty-text user messages', () => {
  const messages: UIMessage[] = [
    userMsg('kept'),
    { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'tool', toolCallId: 't1', toolName: 'X', input: {}, state: 'done', output: {} }] },
    { id: crypto.randomUUID(), role: 'user', parts: [] },
  ]
  expect(recallableUserTexts(messages)).toEqual(['kept'])
})
