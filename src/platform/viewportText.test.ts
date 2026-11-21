import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readViewportText } from './viewportText'

// injViewportText is injected with chrome.scripting.executeScript, so it must be fully
// self-contained. Like domIndex.test.ts, this extracts the REAL function from the source, strips
// its types with esbuild's CLI, and runs it with no outer scope at all — a closure over module
// state would throw here instead of passing.
const HERE = fileURLToPath(import.meta.url)
const source = readFileSync(join(dirname(HERE), 'viewportText.ts'), 'utf-8')
const require = createRequire(import.meta.url)
const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')

function extractInjected(name: string): (...args: unknown[]) => unknown {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find function ${name} in viewportText.ts`)
  let depth = 0
  let bodyStarted = false
  let end = -1
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
      bodyStarted = true
    } else if (source[i] === '}') {
      depth--
      if (bodyStarted && depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`could not brace-match function ${name}`)
  const code = execFileSync(esbuildBin, ['--loader=ts', '--target=es2022'], { input: source.slice(start, end), encoding: 'utf-8' })
  // eslint-disable-next-line no-new-func -- executing the real, extracted+stripped source
  return new Function(`"use strict"; return (${code})`)()
}

// jsdom has no layout: give every text range a visible box inside the viewport.
const savedRect = (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
beforeEach(() => {
  ;(Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 10, left: 10, right: 110, bottom: 30, width: 100, height: 20, toJSON() {} }) as DOMRect
})
afterEach(() => {
  ;(Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect = savedRect
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// Explicit display values: jsdom has no user-agent stylesheet to supply them.
const row = (name: string, price: string) =>
  `<div style="display:block"><a href="#" style="display:inline">${name}</a> — <span style="display:inline">${price}</span></div>`

describe('injViewportText — the visible text, one block at a time', () => {
  it('joins separate blocks with " | " and keeps inline siblings on one line', () => {
    document.body.innerHTML = `<main style="display:block">${row('Arc wireless headphones', '$64')}${row('Nimbus wireless headphones', '$95')}</main>`
    const text = extractInjected('injViewportText')(1200)
    // Each product keeps its own price: a plain space join read "… $64 Nimbus …", and the
    // decider then paired the cheaper price with the wrong product.
    expect(text).toBe('Arc wireless headphones — $64 | Nimbus wireless headphones — $95')
  })

  it('still skips hidden and non-content text, and stops at the cap', () => {
    document.body.innerHTML =
      `<div style="display:block">Visible</div><div style="display:none">Hidden</div>` +
      `<script>var x = 1</script><div style="display:block">${'w'.repeat(50)}</div>`
    const inj = extractInjected('injViewportText')
    expect(inj(1200)).toBe(`Visible | ${'w'.repeat(50)}`)
    expect((inj(20) as string).length).toBeLessThanOrEqual(20)
  })

  it('readViewportText injects it with the cap and returns its text', async () => {
    const executeScript = vi.fn(async () => [{ result: 'A | B' }])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    expect(await readViewportText(7, 1200)).toBe('A | B')
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 }, args: [1200], func: expect.any(Function) }))
  })
})
