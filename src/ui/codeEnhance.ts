// Post-render enhancement of `.markdown pre` code blocks: a header bar (language
// label + copy button) and a collapse toggle for tall blocks. Runs against the
// DOM produced by marked → DOMPurify (dangerouslySetInnerHTML), so it operates
// imperatively and is idempotent (guarded by data-enhanced). Syntax highlighting
// is layered on in Task 6.

const COLLAPSE_PX = 360

/** Enhance every not-yet-enhanced <pre> under `root`. Safe to call repeatedly. */
export function enhanceCodeBlocks(root: HTMLElement): void {
  const pres = root.querySelectorAll<HTMLPreElement>('pre:not([data-enhanced])')
  pres.forEach((pre) => {
    pre.setAttribute('data-enhanced', '1')
    const code = pre.querySelector('code')
    const lang = languageOf(code)

    const wrap = document.createElement('div')
    wrap.className = 'code-block'
    pre.replaceWith(wrap)

    const header = document.createElement('div')
    header.className = 'code-block-header'
    const label = document.createElement('span')
    label.className = 'code-block-lang'
    label.textContent = lang || 'text'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'code-block-copy'
    copy.textContent = 'Copy'
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code?.textContent ?? '').then(() => {
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1200)
      }).catch(() => {})
    })
    header.append(label, copy)

    wrap.append(header, pre)

    // Collapse tall blocks behind a toggle.
    requestAnimationFrame(() => {
      if (pre.scrollHeight > COLLAPSE_PX) {
        wrap.classList.add('code-collapsed')
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'code-block-toggle'
        toggle.textContent = 'Show more'
        toggle.addEventListener('click', () => {
          const open = wrap.classList.toggle('code-open')
          toggle.textContent = open ? 'Show less' : 'Show more'
        })
        wrap.append(toggle)
      }
    })
  })
}

function languageOf(code: Element | null): string {
  const cls = code?.className ?? ''
  const m = cls.match(/language-([\w-]+)/)
  return m ? m[1] : ''
}

// Lazy highlight.js core with a curated common-language set, loaded once and
// shared. Dynamic import keeps it out of the initial sidepanel bundle.
let hljsPromise: Promise<typeof import('highlight.js/lib/core').default> | null = null
async function loadHljs() {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import('highlight.js/lib/core')
      const langs: [string, () => Promise<{ default: unknown }>][] = [
        ['javascript', () => import('highlight.js/lib/languages/javascript')],
        ['typescript', () => import('highlight.js/lib/languages/typescript')],
        ['python', () => import('highlight.js/lib/languages/python')],
        ['bash', () => import('highlight.js/lib/languages/bash')],
        ['json', () => import('highlight.js/lib/languages/json')],
        ['xml', () => import('highlight.js/lib/languages/xml')],
        ['css', () => import('highlight.js/lib/languages/css')],
      ]
      await Promise.all(
        langs.map(async ([name, imp]) => hljs.registerLanguage(name, ((await imp()).default) as never)),
      )
      return hljs
    })()
  }
  return hljsPromise
}

/** Highlight one code element with the lazily-loaded engine. Idempotent. */
export async function highlightCode(code: HTMLElement, lang: string): Promise<void> {
  if (code.dataset.highlighted) return
  code.dataset.highlighted = '1'
  const hljs = await loadHljs()
  const result = hljs.getLanguage(lang)
    ? hljs.highlight(code.textContent ?? '', { language: lang })
    : hljs.highlightAuto(code.textContent ?? '')
  code.innerHTML = result.value
  code.classList.add('hljs')
}

/** Highlight every not-yet-highlighted code block under `root`. Called only
 *  once a message has finished streaming (highlighting is O(n) per call and
 *  re-running it on every streamed token would be O(n^2)). */
export function highlightAll(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('pre code:not([data-highlighted])').forEach((code) => {
    void highlightCode(code, languageOf(code)).catch(() => {})
  })
}

/** Wrap each not-yet-wrapped <table> in a horizontal-scroll container so a wide
 *  table scrolls within its own bubble instead of stretching the message. */
export function wrapTables(root: HTMLElement): void {
  root.querySelectorAll<HTMLTableElement>('table:not([data-wrapped])').forEach((table) => {
    table.setAttribute('data-wrapped', '1')
    const scroll = document.createElement('div')
    scroll.className = 'table-scroll'
    table.replaceWith(scroll)
    scroll.append(table)
  })
}
