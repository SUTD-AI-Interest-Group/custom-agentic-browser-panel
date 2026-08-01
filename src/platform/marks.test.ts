import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// injLiveRects is injected via chrome.scripting.executeScript — fully
// self-contained (no module imports/closures), so it cannot be imported
// directly for testing. Extracting the literal function body straight out of
// the real source (rather than retyping it here) is what keeps this test
// honest: it exercises whatever injLiveRects actually says TODAY. Same
// technique as pageActions.test.ts/domIndex.test.ts.
const HERE = fileURLToPath(import.meta.url)
const SRC_PATH = join(dirname(HERE), 'marks.ts')
const source = readFileSync(SRC_PATH, 'utf-8')

const require = createRequire(import.meta.url)
const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')

function extractFunctionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find function ${name} in marks.ts`)
  let depth = 0
  let bodyStarted = false
  let end = -1
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      depth++
      bodyStarted = true
    } else if (ch === '}') {
      depth--
      if (bodyStarted && depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`could not brace-match function ${name} in marks.ts`)
  return source.slice(start, end)
}

/** Extract, strip TS, and return a callable bound to this test's own jsdom globals. */
function extractInjected(name: string): (...args: any[]) => any {
  const raw = extractFunctionSource(name)
  const code = execFileSync(esbuildBin, ['--loader=ts', '--target=es2022'], { input: raw, encoding: 'utf-8' })
  // eslint-disable-next-line no-new-func -- executing the real, extracted+stripped source, not hand-written logic
  return new Function(`"use strict"; return (${code})`)()
}

// MEDIUM (d04 F4): captureWithMarks drew numbered boxes from a snapshot rect
// that could already be stale by the time the screenshot was actually taken —
// several awaited round trips (presence-hide, tab liveness check, the
// capture itself) sit between when buildInteractiveIndex read `el.rect` and
// when the boxes are drawn, long enough for ordinary async layout shift (a
// lazy image, an ad slot, an SPA re-render) to move the real element. The fix
// re-reads each stamped element's LIVE rect via injLiveRects right before
// drawing, keyed by the same data-agent-idx attribute the text registry uses.
describe('injLiveRects (marks.ts) — re-reads current geometry, not a stale snapshot', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the CURRENT rect, reflecting a layout change since the element was first indexed', () => {
    document.body.innerHTML = '<button data-agent-idx="3" style="position:absolute;">Click me</button>'
    const btn = document.querySelector('button') as HTMLElement
    // Simulate the snapshot having been taken before this reflow: give the
    // fixture element a controlled "moved" rect for the SECOND read.
    const movedRect = { left: 240, top: 500, width: 80, height: 24, right: 320, bottom: 524 } as DOMRect
    btn.getBoundingClientRect = () => movedRect

    const injLiveRects = extractInjected('injLiveRects')
    const result = injLiveRects('data-agent-idx', [3])

    expect(result[3]).toEqual({ x: 240, y: 500, width: 80, height: 24 })
  })

  it('re-finds by the SAME index across two reads and reflects whatever changed in between', () => {
    document.body.innerHTML = '<a data-agent-idx="7" href="#">link</a>'
    const el = document.querySelector('a') as HTMLElement

    const injLiveRects = extractInjected('injLiveRects')

    el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 50, height: 20 }) as DOMRect
    const first = injLiveRects('data-agent-idx', [7])
    expect(first[7]).toEqual({ x: 10, y: 10, width: 50, height: 20 })

    // The page reflows between the two reads (e.g. a lazy image above it
    // finishing load and pushing content down) — a live re-read must pick up
    // the NEW position, unlike a rect captured once at index-build time.
    el.getBoundingClientRect = () => ({ left: 10, top: 210, width: 50, height: 20 }) as DOMRect
    const second = injLiveRects('data-agent-idx', [7])
    expect(second[7]).toEqual({ x: 10, y: 210, width: 50, height: 20 })
  })

  it('omits an index whose element can no longer be found, so the caller can fall back to the snapshot rect', () => {
    document.body.innerHTML = '<button data-agent-idx="1">still here</button>'
    const injLiveRects = extractInjected('injLiveRects')
    // Index 2 was never stamped (or its element was removed since the
    // snapshot) — must be absent from the result, not present with a
    // zeroed/garbage rect, so `live[el.index] ?? el.rect` falls back cleanly.
    const result = injLiveRects('data-agent-idx', [1, 2])
    expect(2 in result).toBe(false)
    expect(1 in result).toBe(true)
  })

  it('handles an empty index list without touching the DOM', () => {
    document.body.innerHTML = ''
    const injLiveRects = extractInjected('injLiveRects')
    expect(injLiveRects('data-agent-idx', [])).toEqual({})
  })
})
