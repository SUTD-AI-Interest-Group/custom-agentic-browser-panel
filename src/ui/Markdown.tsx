import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from './mathDelimiters'
import { enhanceCodeBlocks, highlightAll, wrapTables } from './codeEnhance'

// Configure the KaTeX extension once at module load (marked.use mutates the
// shared marked instance; Markdown is the only consumer of marked). Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message.
marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const normalized = normalizeMathDelimiters(text)
    const raw = marked.parse(normalized, { async: false }) as string
    // KaTeX (output:'htmlAndMathml') emits a screen-reader MathML tree using
    // <semantics>/<annotation> alongside the visible HTML. DOMPurify's default
    // MathML profile forbids those two tags — it would unwrap them, orphaning
    // the raw-TeX fallback as loose text — so we explicitly allow them plus the
    // `encoding` attribute to keep the accessible MathML intact. The visible
    // glyphs come from KaTeX's plain-HTML tree and are unaffected either way.
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ['semantics', 'annotation'],
      ADD_ATTR: ['encoding'],
    })
  }, [text])
  useEffect(() => {
    if (!ref.current) return
    enhanceCodeBlocks(ref.current)
    wrapTables(ref.current)
    if (!streaming) highlightAll(ref.current)
  }, [html, streaming])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
