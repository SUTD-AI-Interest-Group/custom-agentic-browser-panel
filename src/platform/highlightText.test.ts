import { describe, expect, it } from 'vitest'
import { findTextInChunks } from './highlightText'

describe('findTextInChunks', () => {
  it('finds a passage inside a single chunk with exact offsets', () => {
    const m = findTextInChunks(['The quick brown fox'], 'quick brown')
    expect(m.count).toBe(1)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 4, endChunk: 0, endOffset: 15 })
  })

  it('is case-insensitive', () => {
    expect(findTextInChunks(['The QUICK brown fox'], 'quick BROWN').count).toBe(1)
  })

  it('matches across a mid-word chunk split (inline formatting)', () => {
    const m = findTextInChunks(["The author's child", 'hood was spent in Kyoto'], 'childhood was')
    expect(m.count).toBe(1)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 13, endChunk: 1, endOffset: 8 })
  })

  it('matches when the page joins words with no whitespace (block boundary)', () => {
    const m = findTextInChunks(['Payment is due.', 'Late fees apply.'], 'due. Late fees')
    expect(m.count).toBe(1)
    expect(m.first!.startChunk).toBe(0)
    expect(m.first!.endChunk).toBe(1)
  })

  it('collapses whitespace runs and newlines on both sides', () => {
    const m = findTextInChunks(['Terms\n  and   conditions apply'], 'terms and conditions')
    expect(m.count).toBe(1)
  })

  it('counts every occurrence but locates the first', () => {
    const m = findTextInChunks(['ab ab ab'], 'ab')
    expect(m.count).toBe(3)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 0, endChunk: 0, endOffset: 2 })
  })

  it('matches PDF-item style chunks with leading spaces', () => {
    const chunks = ['Termination.', ' Either party may', ' terminate with 30 days notice.']
    const m = findTextInChunks(chunks, 'Either party may terminate')
    expect(m.count).toBe(1)
    expect(m.first!.startChunk).toBe(1)
    expect(m.first!.endChunk).toBe(2)
  })

  it('returns no match for absent text or an empty query', () => {
    expect(findTextInChunks(['hello world'], 'goodbye')).toEqual({ count: 0, first: null })
    expect(findTextInChunks(['hello'], '   ')).toEqual({ count: 0, first: null })
    expect(findTextInChunks([], 'hello')).toEqual({ count: 0, first: null })
  })

  it('escapes regex metacharacters in the query', () => {
    const m = findTextInChunks(['Fee (see §4.2) applies'], '(see §4.2)')
    expect(m.count).toBe(1)
  })
})
