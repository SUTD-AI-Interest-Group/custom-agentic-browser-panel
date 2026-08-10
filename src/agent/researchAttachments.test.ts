import { expect, test } from 'vitest'
import {
  attachmentUrl,
  describeAttachments,
  isAttachmentUrl,
  isLoaded,
  readRange,
  searchAttachment,
  type AttachmentLoad,
  type LoadedAttachment,
} from './researchAttachments'
import type { ResearchAttachmentRef } from '../data/researchTasks'

const ref = (over: Partial<ResearchAttachmentRef> = {}): ResearchAttachmentRef => ({
  id: 'a1',
  name: 'spec-sheet.pdf',
  kind: 'pdf',
  ...over,
})

const loaded = (texts: string[]): LoadedAttachment => ({
  ref: ref({ pageCount: texts.length }),
  pages: texts.map((t, i) => ({ page: i + 1, text: t, plain: t })),
})

test('attachment urls round-trip and are recognisable', () => {
  expect(attachmentUrl('a1b2')).toBe('attachment:a1b2')
  expect(isAttachmentUrl(attachmentUrl('a1b2'))).toBe(true)
  // A real page that merely mentions the word must not be mistaken for one.
  expect(isAttachmentUrl('https://example.com/attachment:a1')).toBe(false)
})

test('isLoaded separates a readable document from a stated reason', () => {
  const ok: AttachmentLoad = loaded(['hello'])
  const bad: AttachmentLoad = { ref: ref(), reason: 'is no longer available' }
  expect(isLoaded(ok)).toBe(true)
  expect(isLoaded(bad)).toBe(false)
})

test('the plan inventory names readable documents and flags unreadable ones', () => {
  const out = describeAttachments([
    loaded(['a', 'b']),
    { ref: ref({ id: 'a2', name: 'chart.png', kind: 'image' }), reason: 'is an image' },
  ])
  expect(out).toContain('"spec-sheet.pdf" (2 pages)')
  expect(out).toContain('ReadAttachment')
  // The planner must know up front which documents it CANNOT lean on, or it will
  // build a plan around one and discover the gap mid-run.
  expect(out).toContain('"chart.png" — UNAVAILABLE: is an image')
})

test('an empty attachment list contributes nothing to the prompt', () => {
  expect(describeAttachments([])).toBe('')
})

test('readRange honours a page spec and reports what the budget omitted', () => {
  const doc = loaded(['page one text', 'page two text', 'page three text'])
  const all = readRange(doc, undefined, 10_000)
  expect('error' in all).toBe(false)
  if ('error' in all) return
  expect(all.blocks.map((b) => b.page)).toEqual([1, 2, 3])

  const some = readRange(doc, '2-3', 10_000)
  if ('error' in some) throw new Error('expected pages')
  expect(some.blocks.map((b) => b.page)).toEqual([2, 3])
})

test('readRange surfaces a bad page spec as a stated error, not a throw', () => {
  const res = readRange(loaded(['a']), '99', 10_000)
  expect('error' in res).toBe(true)
})

test('searchAttachment finds a phrase and reports its page', () => {
  const doc = loaded(['nothing here', 'the warranty is three years on-site'])
  const res = searchAttachment(doc, 'three years')
  if ('error' in res) throw new Error('expected matches')
  expect(res.matches.map((m) => m.page)).toEqual([2])
})

test('an empty query is refused rather than matching everything', () => {
  expect('error' in searchAttachment(loaded(['a']), '   ')).toBe(true)
})
