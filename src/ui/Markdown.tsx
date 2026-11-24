import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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

// KaTeX lives in its own chunk (mathEngine.ts) because it was a third of the
// panel's entry bundle while most replies contain no math. Loaded once, shared
// by every Markdown instance; a failed load clears the promise so a later
// message can retry. Until it lands, a message with math renders through plain
// marked (raw TeX visible) and re-renders the moment the engine arrives —
// which in practice is before any reply finishes, because the first Markdown
// to mount warms it in idle time (see `warmMathEngine`).
type MathEngine = typeof import('./mathEngine')
let mathEngine: MathEngine | null = null
let mathLoading: Promise<MathEngine> | null = null
/** Every mounted Markdown still waiting on the engine. A load succeeds for all of them at once —
 *  including one whose own attempt failed earlier (a chunk fetch can fail, e.g. a stale hash after
 *  an extension reload), which would otherwise show raw TeX until it remounted. */
const waitingForEngine = new Set<(m: MathEngine) => void>()
let warmScheduled = false

export function loadMathEngine(): Promise<MathEngine> {
  mathLoading ??= import('./mathEngine').then(
    (m) => {
      mathEngine = m
      for (const notify of [...waitingForEngine]) notify(m)
      return m
    },
    (err) => {
      // Let the next caller (a new message, or the next idle warm-up) try again.
      mathLoading = null
      warmScheduled = false
      throw err
    },
  )
  return mathLoading
}

function warmMathEngine() {
  if (warmScheduled || mathEngine) return
  warmScheduled = true
  const load = () => void loadMathEngine().catch(() => {})
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 3000 })
  else setTimeout(load, 500)
}

/** After `normalizeMathDelimiters`, every math span is `$…$` or `$$…$$`, so no
 *  `$` at all means there is nothing for KaTeX to do. */
const mayContainMath = (normalized: string) => normalized.includes('$')

/** Minimum gap between re-parses while a message is streaming (see `displayText`). */
const STREAM_PARSE_INTERVAL_MS = 100

// A single reparse's own cost grows with the current message length (measured:
// ~57ms at 7.6K chars, ~117ms at 22.8K, ~187ms at 45.6K, ~363ms at 91.2K — a
// realistic detailed answer or research-style report can comfortably exceed
// 20K chars). Once one reparse alone takes longer than the fixed 100ms window
// below, the throttle can no longer keep up with its own schedule — every
// subsequent reparse for the rest of the stream both re-triggers immediately
// AND blocks the main thread for close to its own duration. Scaling the
// interval by length keeps short/typical messages exactly as responsive as
// before (the 100ms floor is unchanged) while giving a long one enough room to
// actually finish a reparse before the next is due. ~150 chars/ms is a
// conservative reading of the measurements above (they range 130-250).
function streamParseIntervalMs(length: number): number {
  return Math.max(STREAM_PARSE_INTERVAL_MS, length / 150)
}

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
  // (re-)parsed to at most once per streamParseIntervalMs(text.length) while
  // streaming; the instant streaming flips false we snap straight to the exact
  // final `text` (bypassing the throttle) so the last render is always the
  // full, correct parse — never a stale throttled snapshot.
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
    const interval = streamParseIntervalMs(text.length)
    const elapsed = Date.now() - lastAppliedAtRef.current
    if (elapsed >= interval) {
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
    }, interval - elapsed)
  }, [text, streaming])
  // Belt-and-braces: clear a pending trailing update if the component unmounts
  // mid-stream (e.g. the chat is cleared) so it can't fire into a dead render.
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
  }, [])

  // Protect `[[n]]` citations from markdown BEFORE parsing (a private-use
  // sentinel marked/DOMPurify leave alone), then swap them for favicon chips
  // AFTER sanitize (their chrome-extension:// img src must dodge DOMPurify).
  const normalized = useMemo(
    () => normalizeMathDelimiters(citations ? encodeCitations(displayText) : displayText),
    [displayText, citations],
  )
  const needsMath = mayContainMath(normalized)
  const [engine, setEngine] = useState<MathEngine | null>(mathEngine)
  useEffect(warmMathEngine, [])
  useEffect(() => {
    if (!needsMath || engine) return
    if (mathEngine) {
      setEngine(mathEngine)
      return
    }
    waitingForEngine.add(setEngine)
    loadMathEngine().catch(() => {})
    return () => {
      waitingForEngine.delete(setEngine)
    }
  }, [needsMath, engine])

  const html = useMemo(() => {
    const math = needsMath ? engine : null
    let raw: string
    if (math) {
      // On the FINAL render, neutralize any LaTeX that won't compile so a stray
      // `$` can't cascade-break the rest. Mid-stream stays lenient (a closing `$`
      // may not have streamed yet); it self-heals when the stream completes.
      const safe = streaming ? normalized : math.validateMath(normalized).cleaned
      raw = math.mathMarked.parse(safe, { async: false }) as string
    } else {
      raw = marked.parse(normalized, { async: false }) as string
    }
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
  }, [normalized, needsMath, engine, citations, streaming])
  useEffect(() => {
    if (!ref.current) return
    enhanceCodeBlocks(ref.current)
    wrapTables(ref.current)
    if (!streaming) highlightAll(ref.current)
  }, [html, streaming])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
