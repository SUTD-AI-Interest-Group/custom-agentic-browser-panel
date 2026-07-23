import { describe, it, expect } from 'vitest'
import { highlightCode } from './codeEnhance'

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
})
