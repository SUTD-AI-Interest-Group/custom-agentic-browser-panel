import { useMemo } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

// Configure the KaTeX extension once at module load (marked.use mutates the
// shared marked instance; Markdown is the only consumer of marked). Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message.
marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
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
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
