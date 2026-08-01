import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { rankRegions, serializeRegions, SEMANTIC_TAG_SOURCE, type RawRegion, type VisualRegion } from './regionIndex'

// Real pages wrap everything: div.card > figure > img, all three within a few
// pixels of the same box. Offering the model three addresses for one chart
// wastes its attention and invites it to shoot the wrong one. Dedupe is what
// makes [rN] mean something, so it is pinned down here.

let nextId = 0
const region = (over: Partial<RawRegion> = {}): RawRegion => {
  const width = over.rect?.width ?? 600
  const height = over.rect?.height ?? 400
  return {
    id: over.id ?? nextId++,
    parentId: over.parentId ?? -1,
    tag: over.tag ?? 'div',
    role: over.role,
    name: over.name ?? '',
    kind: over.kind ?? 'card',
    rect: over.rect ?? { x: 0, y: 0, width, height },
    area: over.area ?? width * height,
    belowFold: over.belowFold ?? false,
  }
}

describe('rankRegions', () => {
  it('keeps the figure and drops the img hugging it — the caption is part of the chart', () => {
    const raw = [
      region({ id: 0, tag: 'figure', kind: 'figure', name: 'Q3 revenue', area: 10_000 }),
      region({ id: 1, parentId: 0, tag: 'img', kind: 'media', area: 9_000 }),
    ]
    const out = rankRegions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('figure')
    expect(out[0].index).toBe(0)
  })

  it('drops a styled card wrapper hugging a table — the table is the real component', () => {
    const raw = [
      region({ id: 0, tag: 'div', kind: 'card', area: 10_000 }),
      region({ id: 1, parentId: 0, tag: 'table', kind: 'table', area: 9_500 }),
    ]
    const out = rankRegions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('table')
  })

  it('keeps both when the parent is genuinely larger than the child', () => {
    // A section holding a chart plus a lot of prose: two useful, different shots.
    const raw = [
      region({ id: 0, tag: 'section', kind: 'landmark', area: 100_000 }),
      region({ id: 1, parentId: 0, tag: 'figure', kind: 'figure', area: 10_000 }),
    ]
    expect(rankRegions(raw).map((r) => r.tag)).toEqual(['section', 'figure'])
  })

  it('keeps the tighter child when two stacked regions are equally semantic', () => {
    const raw = [
      region({ id: 0, tag: 'section', kind: 'landmark', area: 10_000 }),
      region({ id: 1, parentId: 0, tag: 'article', kind: 'landmark', area: 9_800 }),
    ]
    const out = rankRegions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('article')
  })

  it('renumbers survivors contiguously from zero, so [rN] always resolves', () => {
    // Survivors must be addressed 0,1,2… with no holes where a loser used to be.
    const raw = [
      region({ id: 0, tag: 'figure', kind: 'figure', area: 10_000 }),
      region({ id: 1, parentId: 0, tag: 'img', kind: 'media', area: 9_900 }), // dropped
      region({ id: 2, tag: 'table', kind: 'table', area: 8_000 }),
      region({ id: 3, tag: 'pre', kind: 'code', area: 5_000 }),
    ]
    const out = rankRegions(raw)
    expect(out.map((r) => r.index)).toEqual([0, 1, 2])
    expect(out.map((r) => r.tag)).toEqual(['figure', 'table', 'pre'])
  })

  it('carries each survivor’s source id, so its DOM stamp can be rewritten', () => {
    // Without this the restamp would rewrite the wrong element and [r1] would
    // resolve to whatever happened to be second in the raw sweep.
    const raw = [
      region({ id: 0, tag: 'figure', kind: 'figure', area: 10_000 }),
      region({ id: 1, parentId: 0, tag: 'img', kind: 'media', area: 9_900 }), // dropped
      region({ id: 2, tag: 'table', kind: 'table', area: 8_000 }),
    ]
    const out = rankRegions(raw)
    expect(out.map((r) => [r.sourceId, r.index])).toEqual([
      [0, 0],
      [2, 1],
    ])
  })

  it('caps the registry', () => {
    const raw = Array.from({ length: 100 }, (_, i) => region({ id: i, tag: 'table', kind: 'table' }))
    expect(rankRegions(raw, 10)).toHaveLength(10)
  })

  it('leaves unrelated siblings alone', () => {
    const raw = [
      region({ id: 0, tag: 'figure', kind: 'figure', area: 10_000 }),
      region({ id: 1, tag: 'figure', kind: 'figure', area: 10_000 }),
    ]
    expect(rankRegions(raw)).toHaveLength(2)
  })
})

describe('serializeRegions', () => {
  const shown = (over: Partial<VisualRegion>): VisualRegion => ({
    index: 0,
    sourceId: 0,
    tag: 'figure',
    name: '',
    kind: 'figure',
    rect: { x: 0, y: 0, width: 640, height: 420 },
    belowFold: false,
    ...over,
  })

  it('addresses regions with an r-prefix, never a bare integer', () => {
    // A bare [1] would collide with the click registry's addresses and let the
    // model aim a ControlPage click at a <figure>, which fails opaquely.
    const text = serializeRegions([shown({ index: 1, name: 'Q3 revenue chart' })])
    expect(text).toBe('[r1]<figure> "Q3 revenue chart" 640x420')
  })

  it('flags regions the agent will have to scroll to', () => {
    expect(serializeRegions([shown({ belowFold: true })])).toBe('[r0]<figure> 640x420 (below fold)')
  })

  it('includes an explicit role when the page sets one', () => {
    const text = serializeRegions([shown({ tag: 'div', role: 'figure', name: 'Chart' })])
    expect(text).toBe('[r0]<div role=figure> "Chart" 640x420')
  })

  it('says so plainly when a page has nothing worth photographing', () => {
    expect(serializeRegions([])).toBe('(no visual regions found on this page)')
  })
})

// MEDIUM (d04 F5): same shadow-DOM gap as domIndex.ts's buildInteractiveIndex
// — a plain querySelectorAll('*') never descends into an open shadow root, so
// a chart/table living inside a web component was entirely invisible to the
// region index. Runs the REAL buildRegionIndex (extracted from the source and
// stripped of TypeScript syntax) against a fixture with an actual open shadow
// root, so this proves the fix landed in the function chrome.scripting.
// executeScript actually injects, not a stand-in. See domIndex.test.ts and
// pageActions.test.ts for the same extraction technique and its rationale.
const HERE = fileURLToPath(import.meta.url)
const SRC_PATH = join(dirname(HERE), 'regionIndex.ts')
const source = readFileSync(SRC_PATH, 'utf-8')
const require = createRequire(import.meta.url)
const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')

function extractFunctionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find function ${name} in regionIndex.ts`)
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
  if (end < 0) throw new Error(`could not brace-match function ${name} in regionIndex.ts`)
  return source.slice(start, end)
}

function extractInjected(name: string): (...args: any[]) => any {
  const raw = extractFunctionSource(name)
  const code = execFileSync(esbuildBin, ['--loader=ts', '--target=es2022'], { input: raw, encoding: 'utf-8' })
  // eslint-disable-next-line no-new-func -- executing the real, extracted+stripped source, not hand-written logic
  return new Function(`"use strict"; return (${code})`)()
}

describe('regionIndex — shadow DOM piercing (F5)', () => {
  const savedRect = Element.prototype.getBoundingClientRect
  const savedScrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')
  const savedScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')

  afterEach(() => {
    document.body.innerHTML = ''
    Element.prototype.getBoundingClientRect = savedRect
    if (savedScrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', savedScrollWidth)
    if (savedScrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', savedScrollHeight)
  })

  it('indexes a figure living inside an open shadow root', () => {
    document.body.innerHTML = '<my-widget></my-widget>'
    const host = document.querySelector('my-widget')!
    const shadow = (host as any).attachShadow ? host.attachShadow({ mode: 'open' }) : null
    if (!shadow) return // jsdom build without Shadow DOM support — skip rather than false-fail
    // aria-label rather than a <figcaption>: nameOf() falls back to innerText
    // for a caption-less figure, which jsdom does not compute (no layout
    // engine) — aria-label sidesteps that unrelated gap.
    shadow.innerHTML = '<figure aria-label="Q3 revenue"></figure>'
    const figure = shadow.querySelector('figure') as HTMLElement

    // buildRegionIndex needs a document large enough that the fixture's own
    // rect isn't mistaken for "the whole page" (MAX_AREA_RATIO), and a real
    // rect for the figure — jsdom's real getBoundingClientRect always reports
    // 0x0 (no layout engine). Both are Chrome runtime facts this fixture has
    // to fake; the shadow-piercing behavior under test is otherwise untouched.
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 1200, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true })
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const zero = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }
      if (this === figure) return { ...zero, right: 600, bottom: 400, width: 600, height: 400 } as DOMRect
      return zero as DOMRect
    }

    const buildRegionIndex = extractInjected('buildRegionIndex')
    const result = buildRegionIndex('data-agent-region', 240, SEMANTIC_TAG_SOURCE)
    const names = (result.regions as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('Q3 revenue')
  })
})
