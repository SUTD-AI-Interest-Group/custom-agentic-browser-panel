import { describe, it, expect, vi } from 'vitest'
import { highlightCode, enhanceCodeBlocks, wrapTables } from './codeEnhance'

/** Build a marked-style <pre><code class="language-x"> block in the jsdom body. */
function codeEl(lang: string, text: string): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.className = `language-${lang}`
  code.textContent = text
  pre.append(code)
  document.body.append(pre)
  return code
}

describe('highlightCode with the common language set', () => {
  it('tokenizes a language outside the old 7 (go) with its real grammar', async () => {
    const code = codeEl('go', 'package main\n\nfunc main() {\n}\n')
    await highlightCode(code, 'go')
    // `func` is only a keyword under the genuine go grammar — auto-detect over
    // the old 7-language set (js/ts/python/bash/json/xml/css) never tags it.
    expect(code.innerHTML).toContain('<span class="hljs-keyword">func</span>')
    expect(code.classList.contains('hljs')).toBe(true)
  })

  it('tokenizes sql keywords', async () => {
    const code = codeEl('sql', 'SELECT id FROM users WHERE age > 21;')
    await highlightCode(code, 'sql')
    expect(code.innerHTML).toContain('hljs-keyword')
  })

  it('still tokenizes the original set (typescript)', async () => {
    const code = codeEl('typescript', 'const x: number = 1')
    await highlightCode(code, 'typescript')
    expect(code.innerHTML).toContain('hljs-keyword')
  })

  it('is idempotent — a second call leaves the DOM unchanged', async () => {
    const code = codeEl('go', 'func main() {}')
    await highlightCode(code, 'go')
    const once = code.innerHTML
    await highlightCode(code, 'go')
    expect(code.innerHTML).toBe(once)
  })

  it('falls back to auto-detect (no throw, no crash) when no language class is present', async () => {
    const code = codeEl('', 'SELECT id FROM users;')
    await highlightCode(code, '')
    expect(code.classList.contains('hljs')).toBe(true)
    expect(code.dataset.highlighted).toBe('1')
  })

  it('preserves literal backtick characters in the code content through highlighting', async () => {
    // Backticks are markdown fence syntax, but by the time text reaches this
    // module it is already-parsed DOM text content — plain characters like
    // any other, not something highlightCode should treat specially.
    const text = 'echo `date` # backticks run a command in bash'
    const code = codeEl('bash', text)
    await highlightCode(code, 'bash')
    expect(code.textContent).toBe(text)
  })

  it('caps highlighting cost on a very large block instead of tokenizing all of it', async () => {
    // A pathologically large block (e.g. a minified bundle quoted into a
    // research report) must not block the main thread for seconds running
    // hljs over the whole thing — skip highlighting outright above the cap.
    // The block should still render as plain (unhighlighted) text: the
    // dataset flag is set so it isn't retried, but no hljs spans are added.
    const huge = 'x = 1;\n'.repeat(20000) // ~140,000 chars
    const code = codeEl('javascript', huge)
    await highlightCode(code, 'javascript')
    expect(code.dataset.highlighted).toBe('1')
    expect(code.classList.contains('hljs')).toBe(false)
    expect(code.innerHTML).not.toContain('hljs-')
    // Content itself must be unchanged, just not colorized.
    expect(code.textContent).toBe(huge)
  })

  it('handles a single very long line (wide, not tall) — under the cap, so it still tokenizes normally', async () => {
    // Distinct from the "many short lines" cap case above: this is one line
    // with no newlines at all, the shape that would make enhanceCodeBlocks'
    // height-based collapse-toggle never trigger (scrollHeight measures
    // height, not width — untestable under jsdom's layout-free scrollHeight,
    // see the enhanceCodeBlocks describe block below). highlightCode itself
    // has no such blind spot: it operates on character count regardless of
    // line shape, so a long single line under MAX_HIGHLIGHT_CHARS must still
    // highlight rather than choke or silently skip.
    const longLine = `const s = "${'a'.repeat(50000)}"`
    const code = codeEl('javascript', longLine)
    await highlightCode(code, 'javascript')
    expect(code.classList.contains('hljs')).toBe(true)
    expect(code.textContent).toBe(longLine)
  })

  it('a block just under the cap still highlights normally', async () => {
    const code = codeEl('javascript', 'const ok = true')
    await highlightCode(code, 'javascript')
    expect(code.classList.contains('hljs')).toBe(true)
  })
})

describe('enhanceCodeBlocks', () => {
  function fixture(lang: string | null, text: string): { root: HTMLDivElement; pre: HTMLPreElement } {
    const root = document.createElement('div')
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    if (lang) code.className = `language-${lang}`
    code.textContent = text
    pre.append(code)
    root.append(pre)
    document.body.append(root)
    return { root, pre }
  }

  it('wraps a <pre> in a header with a language label and a copy button', () => {
    const { root } = fixture('python', 'print(1)')
    enhanceCodeBlocks(root)
    const wrap = root.querySelector('.code-block')
    expect(wrap).not.toBeNull()
    expect(wrap!.querySelector('.code-block-lang')?.textContent).toBe('python')
    expect(wrap!.querySelector('.code-block-copy')).not.toBeNull()
    // The original <pre> is still present, now nested inside the wrapper.
    expect(wrap!.querySelector('pre')).not.toBeNull()
  })

  it('labels a code block with no language class as "text" rather than leaving it blank', () => {
    const { root } = fixture(null, 'plain content, no fence info string')
    enhanceCodeBlocks(root)
    expect(root.querySelector('.code-block-lang')?.textContent).toBe('text')
  })

  it('marks the original <pre> as enhanced so a second pass is a no-op', () => {
    const { root, pre } = fixture('go', 'func main() {}')
    enhanceCodeBlocks(root)
    expect(pre.getAttribute('data-enhanced')).toBe('1')
  })

  it('is idempotent — a second call does not double-wrap or duplicate the header', () => {
    const { root } = fixture('go', 'func main() {}')
    enhanceCodeBlocks(root)
    const afterFirst = root.innerHTML
    enhanceCodeBlocks(root)
    expect(root.innerHTML).toBe(afterFirst)
    expect(root.querySelectorAll('.code-block').length).toBe(1)
    expect(root.querySelectorAll('.code-block-header').length).toBe(1)
  })

  it('the copy button copies the code text, not the header/button markup', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // jsdom has no Clipboard API implementation; add just enough of one.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { root } = fixture('js', 'const x = 1')
    enhanceCodeBlocks(root)
    const copyBtn = root.querySelector<HTMLButtonElement>('.code-block-copy')!
    copyBtn.click()
    expect(writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('handles multiple independent code blocks under one root', () => {
    const root = document.createElement('div')
    for (const [lang, text] of [
      ['js', 'a'],
      ['python', 'b'],
    ] as const) {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.className = `language-${lang}`
      code.textContent = text
      pre.append(code)
      root.append(pre)
    }
    document.body.append(root)
    enhanceCodeBlocks(root)
    const labels = Array.from(root.querySelectorAll('.code-block-lang')).map((n) => n.textContent)
    expect(labels).toEqual(['js', 'python'])
  })
})

describe('wrapTables', () => {
  function tableFixture(): { root: HTMLDivElement; table: HTMLTableElement } {
    const root = document.createElement('div')
    root.innerHTML = '<table><tbody><tr><td>a</td></tr></tbody></table>'
    document.body.append(root)
    return { root, table: root.querySelector('table')! }
  }

  it('wraps a <table> in a scroll container', () => {
    const { root } = tableFixture()
    wrapTables(root)
    const scroll = root.querySelector('.table-scroll')
    expect(scroll).not.toBeNull()
    expect(scroll!.querySelector('table')).not.toBeNull()
  })

  it('marks the table as wrapped', () => {
    const { root, table } = tableFixture()
    wrapTables(root)
    expect(table.getAttribute('data-wrapped')).toBe('1')
  })

  it('is idempotent — a second call does not double-wrap', () => {
    const { root } = tableFixture()
    wrapTables(root)
    const afterFirst = root.innerHTML
    wrapTables(root)
    expect(root.innerHTML).toBe(afterFirst)
    expect(root.querySelectorAll('.table-scroll').length).toBe(1)
  })
})
