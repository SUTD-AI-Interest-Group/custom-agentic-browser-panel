import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'
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

/** Minimum gap between re-parses while a message is streaming (see `displayText`). */
const STREAM_PARSE_INTERVAL_MS = 100

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

  // `text` grows on every streamed token, and re-running marked.parse +
  // DOMPurify.sanitize over the WHOLE accumulated string on every one of those
  // is O(n^2) over a long reply (codeEnhance.ts's highlight pass is guarded off
  // streaming for the same reason). `displayText` throttles what actually gets
  // (re-)parsed to at most once per STREAM_PARSE_INTERVAL_MS while streaming;
  // the instant streaming flips false we snap straight to the exact final
  // `text` (bypassing the throttle) so the last render is always the full,
  // correct parse — never a stale throttled snapshot.
  const [displayText, setDisplayText] = useState(text)
  const lastAppliedAtRef = useRef(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!streaming) {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      lastAppliedAtRef.current = Date.now()
      setDisplayText(text)
      return
    }
    const elapsed = Date.now() - lastAppliedAtRef.current
    if (elapsed >= STREAM_PARSE_INTERVAL_MS) {
      lastAppliedAtRef.current = Date.now()
      setDisplayText(text)
      return
    }
    // Too soon — (re-)schedule a trailing update. The remaining delay is always
    // computed from lastAppliedAtRef, so repeatedly rescheduling as more tokens
    // arrive keeps the same fixed fire time (lastAppliedAtRef + interval); we
    // only clear+reset the timer to capture the latest `text` in its closure.
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null
      lastAppliedAtRef.current = Date.now()
      setDisplayText(text)
    }, STREAM_PARSE_INTERVAL_MS - elapsed)
  }, [text, streaming])
  // Belt-and-braces: clear a pending trailing update if the component unmounts
  // mid-stream (e.g. the chat is cleared) so it can't fire into a dead render.
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
  }, [])

  const html = useMemo(() => {
    // Protect `[[n]]` citations from markdown BEFORE parsing (a private-use
    // sentinel marked/DOMPurify leave alone), then swap them for favicon chips
    // AFTER sanitize (their chrome-extension:// img src must dodge DOMPurify).
    const src = citations ? encodeCitations(displayText) : displayText
    const normalized = normalizeMathDelimiters(src)
    // On the FINAL render, neutralize any LaTeX that won't compile so a stray
    // `$` can't cascade-break the rest. Mid-stream stays lenient (a closing `$`
    // may not have streamed yet); it self-heals when the stream completes.
    const safe = streaming ? normalized : validateMath(normalized).cleaned
    const raw = marked.parse(safe, { async: false }) as string
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
  }, [displayText, citations, streaming])
  useEffect(() => {
    if (!ref.current) return
    enhanceCodeBlocks(ref.current)
    wrapTables(ref.current)
    if (!streaming) highlightAll(ref.current)
  }, [html, streaming])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
