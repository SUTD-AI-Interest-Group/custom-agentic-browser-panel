// What KIND of document is in this tab — and, when it is a PDF, which URL
// actually holds the bytes.
//
// Chrome renders a PDF in a plugin viewer whose DOM is an empty stub, so every
// ReadPage mode comes back blank. The old signal for "this is a PDF" was the
// URL ending in `.pdf`, which misses two very ordinary cases:
//
//   1. A PDF served from an extension-less path — arxiv.org/pdf/1706.03762 is
//      `application/pdf` with no suffix at all. The model got a blank page and
//      no hint that ReadPdf existed.
//   2. A PDF embedded in an ordinary HTML page (`<iframe>`/`<embed>`/`<object>`),
//      which is how course sites and document portals serve readings. The tab
//      URL is the wrapper; the PDF is a sub-resource.
//
// Both are settled by facts an injection already in flight can return for free:
// `document.contentType`, and the resolved srcs of the top frame's embeds.
//
// The embed scan is not an optimization — it is the only thing that works.
// Measured against a real Chromium: for a CROSS-ORIGIN embedded PDF,
// `executeScript({allFrames: true})` returns the top frame ONLY and never
// enumerates the PDF frame. (Same-origin embeds *do* enumerate, which is
// exactly how this looks solved if you only test a local fixture.)

import { looksLikePdfUrl } from './pdfText'

/** One `<embed>`/`<object>`/`<iframe>` as seen from the page. */
export interface EmbedRef {
  /** Uppercase tagName. */
  tag: string
  /** The declared `type` attribute, when present. */
  type: string | null
  /** The RESOLVED absolute src/data, as the page's own DOM reports it. */
  src: string | null
}

/** What an injection (or a bare tab record) can tell us about a document. */
export interface TabProbe {
  url: string
  /** `document.contentType`. Absent when the page could not be injected into. */
  contentType?: string
  /** Length of the top frame's innerText. */
  textLength?: number
  embeds: EmbedRef[]
}

export interface TabDocument {
  kind: 'html' | 'pdf' | 'pdf-embedded'
  /** The PDF to hand to ReadPdf: the tab itself, or the first embedded file. */
  pdfUrl?: string
  /** Every fetchable embedded PDF found, in document order. */
  embedded: string[]
}

/** `application/pdf`, plus the `application/x-pdf` some servers still send. */
const PDF_CONTENT_TYPE = /^application\/(x-)?pdf$/i

/**
 * A content type may carry parameters (`application/pdf; qs=0.001`, observed
 * from w3.org) and arbitrary casing. Compare only the essence.
 */
function isPdfContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  return PDF_CONTENT_TYPE.test(contentType.split(';')[0]!.trim())
}

/**
 * Schemes whose bytes the side panel can actually fetch. A `blob:` URL belongs
 * to the page's own origin and is unreachable from here, so an embed pointing
 * at one is deliberately NOT reported: handing it to ReadPdf would swap a blank
 * page for a failed fetch, which is not an improvement. (JS-based viewers that
 * render from a blob are the main source of these; the screenshot path is the
 * answer for those, not this one.)
 */
function isFetchable(url: string): boolean {
  try {
    return ['http:', 'https:', 'file:', 'data:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function isPdfEmbed(e: EmbedRef): boolean {
  if (!e.src) return false
  return isPdfContentType(e.type ?? undefined) || looksLikePdfUrl(e.src)
}

/**
 * Classify a tab from what the page itself reports. `contentType` is the
 * authority when we have it; the URL suffix is only a fallback for when the
 * page could not be injected into at all (a restricted page, or a local file
 * before the user grants file access) but still has a usable address.
 */
export function classifyTabDocument(probe: TabProbe): TabDocument {
  // The tab IS the PDF. Checked first: a PDF viewer that happens to contain an
  // embed must still resolve to the document the user is actually looking at.
  if (isPdfContentType(probe.contentType)) {
    return { kind: 'pdf', pdfUrl: probe.url, embedded: [] }
  }
  // No content type means no injection ran — fall back to the URL's own shape.
  if (probe.contentType === undefined && looksLikePdfUrl(probe.url)) {
    return { kind: 'pdf', pdfUrl: probe.url, embedded: [] }
  }

  const embedded: string[] = []
  for (const e of probe.embeds) {
    if (!isPdfEmbed(e) || !isFetchable(e.src!)) continue
    if (!embedded.includes(e.src!)) embedded.push(e.src!)
  }
  if (embedded.length > 0) return { kind: 'pdf-embedded', pdfUrl: embedded[0], embedded }

  return { kind: 'html', embedded: [] }
}
