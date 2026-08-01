import { expect, test } from 'vitest'
import type { DreamOutcome } from '../agent/dream'
import { describeOutcome } from './memoryDisplay'

test('a skipped dream reports its reason verbatim', () => {
  expect(describeOutcome({ status: 'skipped', reason: 'User is still active.' })).toBe('User is still active.')
})

test('zero-episode dream reads as "no changes" rather than an empty clause', () => {
  const res: DreamOutcome = { status: 'dreamed', added: 0, updated: 0, deleted: 0, episodes: 0, summary: null }
  expect(describeOutcome(res)).toBe('Dreamed over 0 conversations — no changes.')
})

test('singular episode count', () => {
  const res: DreamOutcome = { status: 'dreamed', added: 1, updated: 0, deleted: 0, episodes: 1, summary: null }
  expect(describeOutcome(res)).toBe('Dreamed over 1 conversation — 1 added.')
})

test('plural added/updated/deleted counts join in order', () => {
  const res: DreamOutcome = { status: 'dreamed', added: 3, updated: 2, deleted: 1, episodes: 4, summary: null }
  expect(describeOutcome(res)).toBe('Dreamed over 4 conversations — 3 added, 2 updated, 1 forgotten.')
})

test('a single added memory is singular, plural episodes still plural', () => {
  const res: DreamOutcome = { status: 'dreamed', added: 1, updated: 0, deleted: 0, episodes: 2, summary: null }
  expect(describeOutcome(res)).toBe('Dreamed over 2 conversations — 1 added.')
})
