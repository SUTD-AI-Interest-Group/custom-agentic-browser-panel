import { getAttachment } from '../data/attachments'
import { loadPdfFromBytes } from '../platform/pdf'
import { assemblePagesText, parsePageRange, searchPages, type PageText } from '../platform/pdfText'
import { formatOfficeDoc, type OfficeDoc } from '../platform/officeText'
import type { ResearchAttachmentRef } from '../data/researchTasks'

/**
 * Reading the documents a user attached to a research launch.
 *
 * Runs in the OFFSCREEN research host, which is why this works at all: that
 * document is an extension page, so it shares an origin — and therefore the
 * `lychee-attachments` IndexedDB — with the panel that wrote the bytes. It
 * already reads IndexedDB there to dream. So attachments travel as ids and the
 * bytes never cross a message boundary; only the SW is barred from this, and the
 * SW is not in the path.
 *
 * `pdf.ts` likewise already runs here (never in the SW) and already accepts raw
 * bytes, so PDF text extraction needs no new machinery.
 */

/** The citation URL an attachment is recorded under. Not a real scheme — it just
 *  has to be stable, unique per attachment, and obviously not a web page, so the
 *  notebook's dedup/numbering works unchanged and the chip can render a document
 *  icon instead of trying to fetch a favicon. */
export function attachmentUrl(id: string): string {
  return `attachment:${id}`
}

/** True for a URL minted by `attachmentUrl`. */
export function isAttachmentUrl(url: string): boolean {
  return url.startsWith('attachment:')
}

/** A resolved attachment, ready to read. */
export interface LoadedAttachment {
  ref: ResearchAttachmentRef
  /** Page-wise text for PDFs; a single synthetic page for everything else, so
   *  every kind reads through one code path. */
  pages: PageText[]
}

/** Why an attachment could not be read — always stated, never thrown. */
export interface AttachmentUnavailable {
  ref: ResearchAttachmentRef
  reason: string
}

export type AttachmentLoad = LoadedAttachment | AttachmentUnavailable

export function isLoaded(a: AttachmentLoad): a is LoadedAttachment {
  return 'pages' in a
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const bin = atob(comma === -1 ? dataUrl : dataUrl.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const onePage = (text: string): PageText[] => [{ page: 1, text, plain: text }]

/**
 * Resolve one attachment reference to readable pages.
 *
 * Never throws. The attachments store is capped by size and age while a research
 * task runs to a 24h deadline, so a task genuinely can outlive its own
 * attachment — a missing record is an ordinary, explicable outcome, and reporting
 * it as text lets the agent note the gap in its report instead of the run dying
 * over a file the user attached yesterday.
 */
export async function loadAttachment(ref: ResearchAttachmentRef): Promise<AttachmentLoad> {
  let rec
  try {
    rec = await getAttachment(ref.id)
  } catch (err) {
    return { ref, reason: `could not be read (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!rec) {
    return {
      ref,
      reason:
        'is no longer available — attachments are pruned by age and total size, and this task has outlived its copy',
    }
  }
  try {
    const bytes = base64ToBytes(rec.dataUrl)
    if (ref.kind === 'pdf') {
      const loaded = await loadPdfFromBytes(bytes, ref.id, ref.name)
      return { ref, pages: loaded.pages }
    }
    if (ref.kind === 'text') {
      return { ref, pages: onePage(new TextDecoder().decode(bytes)) }
    }
    if (ref.kind === 'document') {
      // The office path stores the parsed doc alongside the original; re-parsing
      // it here would duplicate officeText's own logic, so go through its
      // formatter with a generous budget and treat the result as one page.
      const doc = (rec as unknown as { doc?: OfficeDoc }).doc
      if (!doc) return { ref, reason: 'could not be re-parsed from storage' }
      return { ref, pages: onePage(formatOfficeDoc(doc, ref.name, 200_000).text) }
    }
    // An image has no text layer and this path has no vision ladder — see the
    // design doc's stated limitation. It still becomes a citable source (the user
    // chose it), it just cannot contribute content.
    return { ref, reason: 'is an image, and background research reads text only — its content was not used' }
  } catch (err) {
    return { ref, reason: `could not be parsed (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** Resolve every reference, in order. */
export async function loadAttachments(refs: ResearchAttachmentRef[]): Promise<AttachmentLoad[]> {
  const out: AttachmentLoad[] = []
  for (const ref of refs) out.push(await loadAttachment(ref))
  return out
}

/**
 * A one-line-per-document inventory for the Scope & Plan prompt, so the planner
 * knows what it has rather than discovering it by luck — and knows up front which
 * documents are unreadable, so it does not build a plan that leans on one.
 */
export function describeAttachments(loads: AttachmentLoad[]): string {
  if (loads.length === 0) return ''
  const lines = loads.map((l) =>
    isLoaded(l)
      ? `  - "${l.ref.name}" (${l.pages.length} page${l.pages.length === 1 ? '' : 's'}) — read it with ReadAttachment`
      : `  - "${l.ref.name}" — UNAVAILABLE: ${l.reason}`,
  )
  return `\n\nThe user attached these documents; they are primary sources and you may cite them:\n${lines.join('\n')}`
}

/** Read a page range out of a loaded attachment, budgeted like ReadPdf's. */
export function readRange(a: LoadedAttachment, range: string | undefined, budget: number) {
  const parsed = range ? parsePageRange(range, a.pages.length) : { pages: a.pages.map((p) => p.page) }
  if ('error' in parsed) return { error: parsed.error }
  return assemblePagesText(a.pages, parsed.pages, budget)
}

/** Search a loaded attachment, matching on the stripped text so the agent can
 *  quote back what it is shown (see pdfText's own note on why). */
export function searchAttachment(a: LoadedAttachment, query: string, maxPages = 8) {
  return searchPages(a.pages, query, { maxPages })
}
