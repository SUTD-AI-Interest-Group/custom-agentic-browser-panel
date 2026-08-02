import { expect, test } from 'vitest'
import { shouldAdoptExternalSettings } from './settingsSync'

// Regression coverage for the HIGH finding: two side-panel windows (Chrome
// panels are per-window) each hold their own in-memory Settings loaded once at
// mount, and without a chrome.storage.onChanged listener one window's save
// silently clobbers another's. shouldAdoptExternalSettings is the pure
// decision App.tsx's listener makes: is the value now in storage actually
// different from what this window already has, or is this just the same
// storage event our own write always triggers (chrome.storage.onChanged fires
// for the writer too, not only other contexts)?

test('adopts when nothing is loaded locally yet', () => {
  expect(shouldAdoptExternalSettings(null, '{"a":1}')).toBe(true)
})

test('does not adopt when the incoming value is identical to what this window already has (its own write reflected back)', () => {
  const json = '{"providers":[],"selected":null}'
  expect(shouldAdoptExternalSettings(json, json)).toBe(false)
})

test('adopts when the incoming value genuinely differs (a concurrent window saved something)', () => {
  const current = '{"providers":[]}'
  const incoming = '{"providers":[{"id":"p1","apiKey":"sk-new"}]}'
  expect(shouldAdoptExternalSettings(current, incoming)).toBe(true)
})
