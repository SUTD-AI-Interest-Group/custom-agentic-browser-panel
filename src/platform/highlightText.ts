// Pure cross-chunk text matching for the HighlightContent tool. Given the page
// as an ordered list of text chunks (DOM text nodes on a webpage, pdf.js text
// items on a PDF page), find a quoted passage and map it back to
// (chunk, offset) endpoints a Range or a canvas rect can be built from.
//
// Matching is deliberately forgiving in one direction: whitespace in the QUERY
// is optional in the page. Chunks concatenate with no separator, so a passage
// quoted from innerText ("foo\nbar") must still match two blocks that abut as
// "foobar", and a word split by inline markup ("child" + "hood") must match the
// quoted "childhood". Chrome-free and unit-tested — keep it that way.

/** Where the first occurrence starts and ends, as (chunk index, char offset). */
export interface ChunkRange {
  startChunk: number
  startOffset: number
  endChunk: number
  /** Exclusive, within endChunk. */
  endOffset: number
}

export interface ChunkMatch {
  /** Occurrences across all chunks (0 = not found). */
  count: number
  /** The first occurrence, or null when count is 0. */
  first: ChunkRange | null
}

const MAX_QUERY_CHARS = 1000

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive search for `query` across concatenated `chunks`. Whitespace
 * runs are collapsed on both sides, and each whitespace gap in the query is
 * optional in the page (see module comment). Returns every occurrence's count
 * and the first occurrence's chunk-relative endpoints.
 */
export function findTextInChunks(chunks: string[], query: string): ChunkMatch {
  const none: ChunkMatch = { count: 0, first: null }
  const tokens = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return none

  // Raw concatenation, plus each chunk's start offset in it.
  const starts: number[] = []
  let raw = ''
  for (const c of chunks) {
    starts.push(raw.length)
    raw += c
  }
  if (raw.length === 0) return none

  // Normalized haystack (lowercased, whitespace runs collapsed to one space)
  // with a map from each normalized char back to a raw index. A collapsed space
  // maps to the following non-space char — endpoints never land on a space
  // (tokens are trimmed), so that approximation is invisible to callers.
  let norm = ''
  const map: number[] = []
  let pendingSpace = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0
      continue
    }
    if (pendingSpace) {
      norm += ' '
      map.push(i)
      pendingSpace = false
    }
    norm += ch.toLowerCase()
    map.push(i)
  }

  const re = new RegExp(tokens.map(escapeRegExp).join(' ?'), 'g')
  let count = 0
  let first: { index: number; length: number } | null = null
  for (let m = re.exec(norm); m !== null; m = re.exec(norm)) {
    if (!first) first = { index: m.index, length: m[0].length }
    count++
  }
  if (!first) return none

  const rawStart = map[first.index]
  const rawEnd = map[first.index + first.length - 1] + 1

  // Binary-search the chunk containing a raw index (probe rawEnd-1 for the end,
  // so an exclusive end that lands exactly on a boundary stays in-chunk).
  const locate = (rawIdx: number, forEnd: boolean) => {
    const probe = forEnd ? rawIdx - 1 : rawIdx
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= probe) lo = mid
      else hi = mid - 1
    }
    return { chunk: lo, offset: rawIdx - starts[lo] }
  }
  const s = locate(rawStart, false)
  const e = locate(rawEnd, true)
  return {
    count,
    first: { startChunk: s.chunk, startOffset: s.offset, endChunk: e.chunk, endOffset: e.offset },
  }
}
