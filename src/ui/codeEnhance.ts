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
      })
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
