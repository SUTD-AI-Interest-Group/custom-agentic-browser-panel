import { expect, test } from 'vitest'
import { conversationTitle } from './conversationTitle'

// Consolidates the display-title fallback that used to be duplicated ad hoc
// in three places (ConversationsList's displayTitle, and two spots in
// App.tsx) — one test instead of three call sites trusted by convention.

test('a null title (not yet named) falls back to "New chat"', () => {
  expect(conversationTitle(null)).toBe('New chat')
})

test('a real title passes through unchanged', () => {
  expect(conversationTitle('Trip to Kyoto')).toBe('Trip to Kyoto')
})
