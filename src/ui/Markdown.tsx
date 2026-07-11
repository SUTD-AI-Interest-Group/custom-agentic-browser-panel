import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from './mathDelimiters'
import { enhanceCodeBlocks, highlightAll, wrapTables } from './codeEnhance'
import { faviconUrl } from './favicon'
import { encodeCitations, replaceCitationSentinels, escapeAttr } from './citations'

/** One inline `[[n]]` citation → a favicon chip linking to source n (or a plain
 *  `[n]` when the index is out of range / not an http(s) source). The favicon
 *  <img> is injected AFTER DOMPurify because its chrome-extension:// src would
 *  otherwise be sanitized away; the URL is escaped and scheme-checked here. */
function citationHtml(n: number, citations: { url: string; title: string }[]): string {
  const c = citations[n - 1]
  if (!c || !/^https?:\/\//i.test(c.url)) return `[${n}]`
  const href = escapeAttr(c.url)
  const title = escapeAttr(c.title || c.url)
  const fav = escapeAttr(faviconUrl(c.url, 32))
  return `<a class="cite" href="${href}" target="_blank" rel="noreferrer" title="${title}"><img class="cite-favicon" src="${fav}" alt="" width="14" height="14" loading="lazy" /></a>`
}

// Configure the KaTeX extension once at module load (marked.use mutates the
// shared marked instance; Markdown is the only consumer of marked). Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message.
marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({
  text,
  streaming,
  citations,
}: {
  text: string
  streaming?: boolean
  /** When set, inline `[[n]]` citations render as favicon chips linking to
   *  source n (used by research reports). Absent for ordinary replies. */
  citations?: { url: string; title: string }[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    // Protect `[[n]]` citations from markdown BEFORE parsing (a private-use
    // sentinel marked/DOMPurify leave alone), then swap them for favicon chips
    // AFTER sanitize (their chrome-extension:// img src must dodge DOMPurify).
    const src = citations ? encodeCitations(text) : text
    const normalized = normalizeMathDelimiters(src)
    const raw = marked.parse(normalized, { async: false }) as string
    // KaTeX (output:'htmlAndMathml') emits a screen-reader MathML tree using
    // <semantics>/<annotation> alongside the visible HTML. DOMPurify's default
    // MathML profile forbids those two tags — it would unwrap them, orphaning
    // the raw-TeX fallback as loose text — so we explicitly allow them plus the
    // `encoding` attribute to keep the accessible MathML intact. The visible
    // glyphs come from KaTeX's plain-HTML tree and are unaffected either way.
    const clean = DOMPurify.sanitize(raw, {
      ADD_TAGS: ['semantics', 'annotation'],
      ADD_ATTR: ['encoding'],
    })
    return citations ? replaceCitationSentinels(clean, (n) => citationHtml(n, citations)) : clean
  }, [text, citations])
  useEffect(() => {
    if (!ref.current) return
    enhanceCodeBlocks(ref.current)
    wrapTables(ref.current)
    if (!streaming) highlightAll(ref.current)
  }, [html, streaming])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
