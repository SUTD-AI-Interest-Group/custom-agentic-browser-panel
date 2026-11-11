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

import { mergeSettingsDraft } from './settingsSync'

test('preserves external fields and nested settings while committing local edits', () => {
  const base = { prompt: 'before', policies: { read: 'ask', write: 'ask' }, theme: 'light' }
  const draft = { ...base, prompt: 'local', policies: { ...base.policies, read: 'always' } }
  const external = { ...base, policies: { ...base.policies, write: 'never' }, theme: 'dark' }
  expect(mergeSettingsDraft(base, draft, external)).toEqual({ prompt: 'local', policies: { read: 'always', write: 'never' }, theme: 'dark' })
})

test('merges provider rows by id, preserving remote additions and deletions', () => {
  const base = [{ id: 'a', name: 'A', key: 'old' }, { id: 'b', name: 'B', key: '' }]
  const draft = [{ ...base[0], name: 'Renamed' }, { ...base[1], name: 'Edited deleted row' }]
  const external = [{ ...base[0], key: 'rotated' }, { id: 'c', name: 'New', key: '' }]
  expect(mergeSettingsDraft(base, draft, external)).toEqual([{ id: 'a', name: 'Renamed', key: 'rotated' }, external[1]])
})

test('keeps local removals and does not mutate the current settings', () => {
  const base = { a: 1, b: 2 }
  const current = { a: 1, b: 3 }
  expect(mergeSettingsDraft<Record<string, number>>(base, { a: 2 }, current)).toEqual({ a: 2 })
  expect(current).toEqual({ a: 1, b: 3 })
})
