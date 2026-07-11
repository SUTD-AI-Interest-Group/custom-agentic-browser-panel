import { useMemo } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

// Configure the KaTeX extension once at module load (marked.use mutates the
// shared marked instance; Markdown is the only consumer of marked). Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message. DOMPurify ≥3.4 preserves KaTeX's MathML
// (<semantics>/<annotation>), so plain render-then-sanitize is safe.
marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
