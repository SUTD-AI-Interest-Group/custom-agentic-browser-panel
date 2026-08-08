// Composer attachments: the impure glue between dropped/picked/pasted Files
// and the outgoing user message. Ingestion turns Files into ComposerAttachment
// values (validating early — a corrupt PDF errors at attach time, not send);
// assembly executes the pure planner's routes (src/agent/attachmentPlan.ts)
// into message parts + model text, and persists originals to the capped
// attachments store. Chat.tsx owns only state and JSX around this module.

import type { ProviderConfig } from '../data/settings'
import { providerKind } from '../data/settings'
import { profileFor } from '../data/providerProfiles'
import { ensureVisionCapability } from '../agent/vision'
import {
  classifyIncomingFile,
  formatInlineTextBlock,
  isNativePdfPart,
  looksBinary,
  pageCaption,
  planAttachmentDelivery,
  MAX_ATTACHMENTS,
  type AttachmentDescriptor,
  type DeliveryContext,
} from '../agent/attachmentPlan'
import {
  lycheeProviderOptions,
  type AttachmentRef,
  type ReplacementPart,
  type ResolvedAttachmentPart,
} from '../data/attachmentRefs'
import { saveAttachment, getAttachment, approxBytes, type AttachmentMeta } from '../data/attachments'
import { makeThumb } from '../data/screenshots'
import { loadPdfFromBytes, renderPdfPageFromBytes, PdfError } from '../platform/pdf'
import { assemblePagesText } from '../platform/pdfText'
import type { CapturedImage } from '../platform/capture'
import { parseOfficeDocument, OfficeError } from '../platform/office'
import { formatOfficeDoc, describeOfficeDoc, type OfficeDoc, type OfficeFormat } from '../platform/officeText'

/** One attachment sitting in the composer, ready to send. */
export type ComposerAttachment =
  | {
      kind: 'image'
      id: string
      name: string
      dataUrl: string
      width: number
      height: number
      thumbDataUrl: string
    }
  | { kind: 'pdf'; id: string; name: string; bytes: Uint8Array; byteSize: number; pageCount: number }
  | { kind: 'text'; id: string; name: string; text: string; byteSize: number }
  | {
      kind: 'document'
      id: string
      name: string
      bytes: Uint8Array
      byteSize: number
      /** Parsed at attach time; reused at send time. */
      doc: OfficeDoc
      docSummary: string
    }

export interface IngestResult {
  attachments: ComposerAttachment[]
  errors: string[]
}

// Matches capture.ts's MAX_SIDE: most vision APIs downscale beyond ~1500px anyway.
const MAX_SIDE = 1400

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(blob)
  })
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode the image'))
    img.src = dataUrl
  })
}

/** Base64-encode bytes chunked — String.fromCharCode(...50MB) blows the stack. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

/** Decode a data URL's payload back to bytes (history rehydration of PDF pages). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function ingestImage(file: File, id: string): Promise<ComposerAttachment> {
  const original = await readAsDataUrl(file)
  const img = await decodeImage(original)
  const w = img.naturalWidth
  const h = img.naturalHeight
  let dataUrl = original
  let outW = w
  let outH = h
  if (Math.max(w, h) > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(w, h)
    outW = Math.max(1, Math.round(w * scale))
    outH = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(img, 0, 0, outW, outH)
    // Photographic sources re-encode as JPEG; PNG/GIF stay PNG (line art, alpha).
    dataUrl = /image\/(png|gif)/.test(file.type)
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', 0.9)
  }
  return {
    kind: 'image',
    id,
    name: file.name,
    dataUrl,
    width: outW,
    height: outH,
    thumbDataUrl: await makeThumb(dataUrl),
  }
}

async function ingestPdf(file: File, id: string): Promise<ComposerAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // The parse doubles as validation: password/corrupt/non-PDF files throw a
  // PdfError HERE, at attach time, instead of failing the send later. The parsed
  // document stays in pdf.ts's LRU under this id, so send-time work is cached.
  const loaded = await loadPdfFromBytes(bytes, id, file.name)
  return { kind: 'pdf', id, name: file.name, bytes, byteSize: bytes.byteLength, pageCount: loaded.info.pageCount }
}

// Canonical MIME per office format, for persisting a document's original bytes
// with a type that actually describes them. Mirrors officeText.ts's internal
// MIME_FORMATS table (not imported — that one is scoped to *detecting* a format
// from an incoming, possibly-wrong MIME; this is the reverse direction, off a
// format we already parsed successfully, so trusting it is safe and duplicating
// eight literal strings is cheaper than adding a cross-file dependency for it).
const OFFICE_MIME: Record<OfficeFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
}

async function ingestDocument(file: File, id: string): Promise<ComposerAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Parsing here doubles as validation: a corrupt, encrypted or mislabelled
  // file throws an OfficeError NOW, in the composer, rather than failing the
  // send later. The parse stays in office.ts's cache under this id, so the
  // send-time format is free.
  const doc = await parseOfficeDocument(bytes, id, file.name, file.type)
  return {
    kind: 'document',
    id,
    name: file.name,
    bytes,
    byteSize: bytes.byteLength,
    doc,
    docSummary: describeOfficeDoc(doc),
  }
}

async function ingestText(file: File, id: string): Promise<ComposerAttachment | { error: string }> {
  const text = await file.text()
  if (!text.trim()) return { error: `"${file.name}" is empty.` }
  if (looksBinary(text.slice(0, 512))) {
    return { error: `"${file.name}" looks like a binary file, not text.` }
  }
  return { kind: 'text', id, name: file.name, text, byteSize: file.size }
}

/**
 * Turn incoming Files (drop, paste, picker) into composer attachments. Errors
 * are per-file and never abort the batch — the rest still attach.
 */
export async function ingestFiles(files: File[], existingCount: number): Promise<IngestResult> {
  const attachments: ComposerAttachment[] = []
  const errors: string[] = []
  for (const file of files) {
    if (existingCount + attachments.length >= MAX_ATTACHMENTS) {
      errors.push(`Attachment limit reached (${MAX_ATTACHMENTS} per message) — "${file.name}" was not added.`)
      continue
    }
    const classified = classifyIncomingFile(file.name, file.type, file.size)
    if ('error' in classified) {
      errors.push(classified.error)
      continue
    }
    const id = crypto.randomUUID()
    try {
      if (classified.kind === 'image') {
        attachments.push(await ingestImage(file, id))
      } else if (classified.kind === 'pdf') {
        attachments.push(await ingestPdf(file, id))
      } else if (classified.kind === 'document') {
        attachments.push(await ingestDocument(file, id))
      } else {
        const result = await ingestText(file, id)
        if ('error' in result) errors.push(result.error)
        else attachments.push(result)
      }
    } catch (err) {
      const msg =
        err instanceof PdfError || err instanceof OfficeError
          ? err.message
          : `Could not read "${file.name}".`
      errors.push(msg)
    }
  }
  return { attachments, errors }
}

/** Wrap a camera/right-click capture in the attachment model (with a thumb). */
export async function fromCapturedImage(img: CapturedImage, name = 'Screenshot'): Promise<ComposerAttachment> {
  return {
    kind: 'image',
    id: img.id,
    name,
    dataUrl: img.dataUrl,
    width: img.width,
    height: img.height,
    thumbDataUrl: await makeThumb(img.dataUrl),
  }
}

/** The transcript-facing metas for a user bubble (small: thumbs, not data). */
export function attachmentUiMetas(atts: ComposerAttachment[]): AttachmentMeta[] {
  return atts.map((a) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    byteSize: a.kind === 'image' ? approxBytes(a.dataUrl) : a.byteSize,
    ...(a.kind === 'pdf' ? { pageCount: a.pageCount } : {}),
    ...(a.kind === 'image' ? { thumbDataUrl: a.thumbDataUrl } : {}),
    ...(a.kind === 'document' ? { docSummary: a.docSummary } : {}),
  }))
}

/** A user-message file part, tagged so persistence can swap data for a ref. */
export interface OutgoingFilePart {
  type: 'file'
  mediaType: string
  filename?: string
  data: string
  providerOptions?: ReturnType<typeof lycheeProviderOptions>
}

export interface AssembledAttachments {
  /** File parts for the user message, in attachment order. */
  parts: OutgoingFilePart[]
  /** Text to append to the model-facing message text (fences, captions, notes). */
  appendText: string
  /** Journal notes for the episode log. */
  notes: string[]
  /** Per-attachment processing failures (already also noted in appendText). */
  errors: string[]
}

/**
 * Render a pdf-pages plan's pages in order, tagging each as a `[id]#page=N`
 * file part. Each page renders independently — a failure on page k must not
 * orphan pages 1..k-1 as uncaptioned image parts (already rendered, already
 * meant to be shown), so this stops at the first failure and reports exactly
 * how far it got rather than throwing and losing what already succeeded.
 * Shared by a fresh send (assembleAttachments) and a historical native-PDF
 * part being re-planned for a provider that no longer takes it natively
 * (makeHistoricalAttachmentResolver).
 */
async function renderPdfPagesAsParts(
  bytes: Uint8Array,
  id: string,
  pages: number[],
): Promise<{
  parts: OutgoingFilePart[]
  rendered: number[]
  failure: { page: number; message: string } | null
}> {
  const parts: OutgoingFilePart[] = []
  const rendered: number[] = []
  let failure: { page: number; message: string } | null = null
  for (const page of pages) {
    try {
      const r = await renderPdfPageFromBytes(bytes, id, page)
      parts.push({
        type: 'file',
        mediaType: 'image',
        data: r.dataUrl,
        providerOptions: lycheeProviderOptions({ id, page }),
      })
      rendered.push(page)
    } catch (err) {
      failure = { page, message: err instanceof Error ? err.message : String(err) }
      break
    }
  }
  return { parts, rendered, failure }
}

/** The user-facing caption for a renderPdfPagesAsParts result. */
function pdfPagesCaption(
  name: string,
  pageCount: number,
  rendered: number[],
  failure: { page: number; message: string } | null,
  truncationNote: string | null,
): string {
  if (rendered.length === 0) {
    const why = failure ? ` (${failure.message})` : ''
    return `[The user attached the PDF "${name}" (${pageCount} pages), but no pages could be rendered as images${why}.]`
  }
  const first = rendered[0]
  const last = rendered[rendered.length - 1]
  const partialNote = failure
    ? ` Page ${failure.page} failed to render (${failure.message}), so later pages are omitted.`
    : truncationNote
      ? `\n${truncationNote}`
      : ''
  return `[The user attached the PDF "${name}" (${pageCount} pages). Its pages are attached as images, in order: ${pageCaption(name, first, pageCount)} through ${pageCaption(name, last, pageCount)}.]${partialNote}`
}

/**
 * Extracted-text block for the pdf-text route (blind models). Shared by a
 * fresh send and the historical resolver's same-route degrade.
 */
async function extractPdfTextBlock(
  bytes: Uint8Array,
  id: string,
  name: string,
  pageCount: number,
  budget: number,
): Promise<string> {
  const loaded = await loadPdfFromBytes(bytes, id, name)
  const assembled = assemblePagesText(
    loaded.pages,
    loaded.pages.map((p) => p.page),
    budget,
  )
  const body = assembled.blocks.map((b) => `[page ${b.page}]\n${b.text}`).join('\n\n')
  const cuts: string[] = []
  if (assembled.blocks.some((b) => b.truncated)) cuts.push('the last shown page is truncated')
  if (assembled.omittedPages.length > 0) cuts.push(`${assembled.omittedPages.length} later pages were omitted`)
  if (loaded.info.pageCount > loaded.info.extractedPages)
    cuts.push(`only the first ${loaded.info.extractedPages} of ${loaded.info.pageCount} pages were extracted`)
  const cutNote = cuts.length > 0 ? `\n[Note: ${cuts.join('; ')} to fit the text budget.]` : ''
  return `--- attached file: ${name} (${pageCount}-page PDF, text extracted) ---\n${body}${cutNote}\n--- end of ${name} ---`
}

/**
 * Execute the delivery plan for every attachment: build the message parts and
 * appended text this provider/model can actually consume, and persist the
 * originals to the capped store. Store failures degrade to an unpersisted send
 * (the parts are already in memory) — never a failed send.
 */
export async function assembleAttachments(
  atts: ComposerAttachment[],
  o: { provider: ProviderConfig; modelId: string; conversationId: string },
): Promise<AssembledAttachments> {
  if (atts.length === 0) return { parts: [], appendText: '', notes: [], errors: [] }
  const profile = profileFor(providerKind(o.provider))
  const visionCapable = await ensureVisionCapability(o.provider, o.modelId).catch(() => false)
  const ctx = {
    supportsNativeDocuments: profile.supportsNativeDocuments,
    nativeDocMaxBytes: profile.nativeDocMaxBytes,
    visionCapable,
  }

  const parts: OutgoingFilePart[] = []
  const blocks: string[] = []
  const errors: string[] = []

  for (const att of atts) {
    const descriptor: AttachmentDescriptor = {
      kind: att.kind,
      name: att.name,
      byteSize: att.kind === 'image' ? approxBytes(att.dataUrl) : att.byteSize,
      ...(att.kind === 'pdf' ? { pageCount: att.pageCount } : {}),
    }
    const plan = planAttachmentDelivery(descriptor, ctx)
    // Computed at most once per PDF attachment (native-pdf's outgoing part and
    // the persistence step below both want the same encode) — bytesToDataUrl
    // is an expensive main-thread-blocking pass on the largest attachments.
    let pdfDataUrl: string | undefined
    try {
      if (plan.route === 'image-part' && att.kind === 'image') {
        parts.push({
          type: 'file',
          mediaType: 'image',
          data: att.dataUrl,
          providerOptions: lycheeProviderOptions({ id: att.id }),
        })
      } else if (plan.route === 'image-note') {
        blocks.push(plan.note)
      } else if (plan.route === 'native-pdf' && att.kind === 'pdf') {
        pdfDataUrl = bytesToDataUrl(att.bytes, 'application/pdf')
        parts.push({
          type: 'file',
          mediaType: 'application/pdf',
          filename: att.name,
          data: pdfDataUrl,
          providerOptions: lycheeProviderOptions({ id: att.id }),
        })
        blocks.push(`[The user attached the PDF "${att.name}" (${att.pageCount} pages).]`)
      } else if (plan.route === 'pdf-pages' && att.kind === 'pdf') {
        const { parts: pageParts, rendered, failure } = await renderPdfPagesAsParts(att.bytes, att.id, plan.pages)
        parts.push(...pageParts)
        blocks.push(pdfPagesCaption(att.name, att.pageCount, rendered, failure, plan.truncationNote))
      } else if (plan.route === 'pdf-text' && att.kind === 'pdf') {
        blocks.push(await extractPdfTextBlock(att.bytes, att.id, att.name, att.pageCount, plan.budget))
      } else if (plan.route === 'document-text' && att.kind === 'document') {
        blocks.push(formatOfficeDoc(att.doc, att.name, plan.budget).text)
      } else if (plan.route === 'inline-text' && att.kind === 'text') {
        blocks.push(formatInlineTextBlock(att.name, att.text, plan.budget))
      }
    } catch (err) {
      const msg = `[attachment "${att.name}" could not be processed: ${err instanceof Error ? err.message : String(err)}]`
      errors.push(msg)
      blocks.push(msg)
      continue
    }
    // Persist the original once per send; the transcript and history refer to it
    // by id. Best-effort — losing bookkeeping must not lose the user's message.
    // Reuses the native-pdf route's encode above when there is one, computes it
    // fresh (once) otherwise — pdf-pages/pdf-text still persist the original
    // file regardless of which delivery route was used to show it to the model.
    const dataUrl =
      att.kind === 'image'
        ? att.dataUrl
        : att.kind === 'pdf'
          ? (pdfDataUrl ?? bytesToDataUrl(att.bytes, 'application/pdf'))
          : att.kind === 'document'
            ? bytesToDataUrl(att.bytes, OFFICE_MIME[att.doc.format])
            : bytesToDataUrl(new TextEncoder().encode(att.text), 'text/plain')
    const meta = attachmentUiMetas([att])[0]
    await saveAttachment({ id: att.id, conversationId: o.conversationId, meta, dataUrl }).catch((err) => {
      console.warn('attachment not persisted:', err)
    })
  }

  const label = (a: ComposerAttachment) =>
    a.kind === 'pdf'
      ? `${a.name} (${a.pageCount} pages)`
      : a.kind === 'document'
        ? `${a.name} (${a.docSummary})`
        : a.name
  const notes = [`[attached: ${atts.map(label).join(', ')}]`]
  return { parts, appendText: blocks.join('\n\n'), notes, errors }
}

/**
 * Build a per-conversation resolver for hydrateHistory (src/data/attachmentRefs.ts)
 * — the counterpart to assembleAttachments for ALREADY-SENT history. A stored
 * attachment was routed by whichever provider was active when it was
 * attached, and that may not be the provider active now: a whole-document
 * native-PDF part (isNativePdfPart) only stays a native-PDF part if the
 * CURRENTLY active provider still supports native documents — otherwise it is
 * re-planned down the same ladder a fresh attachment would take (rendered
 * page images, then extracted text), so a conversation never sends a wire
 * form the active provider can't accept just because it once could.
 *
 * Every other ref (images, an already-rendered PDF page, a native-PDF part
 * that's still native) is wire-compatible regardless of provider, so
 * isNativePdfPart is a cheap gate BEFORE any byte fetch or PDF re-render: the
 * common case costs exactly what it did before this fix (one IndexedDB read
 * to get the original data back), and the expensive path (loading pdf.js,
 * rendering pages, extracting text) only runs on an actual downgrade.
 * visionCapable is probed at most once per resolver instance — reused across
 * every ref in the conversation, matching assembleAttachments's one probe per
 * batch — not once per attachment.
 */
export function makeHistoricalAttachmentResolver(
  provider: ProviderConfig,
  modelId: string,
): (ref: AttachmentRef, mediaType: string | undefined) => Promise<ResolvedAttachmentPart> {
  const profile = profileFor(providerKind(provider))
  let visionCapable: Promise<boolean> | null = null
  const activeCtx = (): Promise<DeliveryContext> => {
    if (!visionCapable) visionCapable = ensureVisionCapability(provider, modelId).catch(() => false)
    return visionCapable.then((v) => ({
      supportsNativeDocuments: profile.supportsNativeDocuments,
      nativeDocMaxBytes: profile.nativeDocMaxBytes,
      visionCapable: v,
    }))
  }

  return async (ref, mediaType) => {
    const rec = await getAttachment(ref.id).catch(() => null)
    if (!rec) return null

    if (ref.page !== undefined) {
      // A derived page render is always a plain image part — wire-compatible
      // on every provider (isNativePdfPart is the only provider-sensitive
      // shape). Re-render from the cached original bytes, same as before
      // this fix — no replanning needed here.
      try {
        const { dataUrl } = await renderPdfPageFromBytes(dataUrlToBytes(rec.dataUrl), ref.id, ref.page)
        return { data: dataUrl }
      } catch {
        return null
      }
    }

    if (!isNativePdfPart(mediaType) || rec.meta.kind !== 'pdf') return { data: rec.dataUrl }

    // Second cheap gate, mirroring planAttachmentDelivery's own native-pdf
    // condition (attachmentPlan.ts): still native and still under the active
    // provider's byte cap needs no replanning, so skip straight past the
    // vision probe below — on a cache miss ensureVisionCapability is a LIVE
    // model round-trip, not a storage read, and simply loading a conversation
    // full of untouched native-pdf attachments must never fire one.
    if (profile.supportsNativeDocuments && rec.meta.byteSize <= profile.nativeDocMaxBytes) {
      return { data: rec.dataUrl }
    }

    // Whole-document native-PDF part that no longer fits: replan against the
    // active provider via the SAME planner a fresh attachment goes through
    // (single-sourced with the pre-check above, so both stay in lockstep).
    const descriptor: AttachmentDescriptor = {
      kind: 'pdf',
      name: rec.meta.name,
      byteSize: rec.meta.byteSize,
      pageCount: rec.meta.pageCount,
    }
    const plan = planAttachmentDelivery(descriptor, await activeCtx())
    if (plan.route === 'native-pdf') return { data: rec.dataUrl }

    try {
      const bytes = dataUrlToBytes(rec.dataUrl)
      if (plan.route === 'pdf-pages') {
        const { parts, rendered, failure } = await renderPdfPagesAsParts(bytes, ref.id, plan.pages)
        const caption: ReplacementPart = {
          type: 'text',
          text: pdfPagesCaption(rec.meta.name, rec.meta.pageCount ?? 1, rendered, failure, plan.truncationNote),
        }
        // rendered.length===0 means every page failed — never splice in an
        // empty page list, just the explanatory caption on its own.
        return { replace: rendered.length > 0 ? [caption, ...parts] : [caption] }
      }
      if (plan.route === 'pdf-text') {
        const text = await extractPdfTextBlock(bytes, ref.id, rec.meta.name, rec.meta.pageCount ?? 1, plan.budget)
        return { replace: [{ type: 'text', text }] }
      }
      // A 'pdf' descriptor only ever plans native-pdf | pdf-pages | pdf-text
      // (planAttachmentDelivery) — this is unreachable in practice, but the
      // static type is the FULL DeliveryRoute union (the planner isn't typed
      // per input kind), so fall back to the unchanged data rather than assume.
      return { data: rec.dataUrl }
    } catch (err) {
      // Rendering/extraction itself failed (corrupt cached bytes, pdf.js
      // unavailable, …) — degrade to a plain note rather than propagating and
      // leaving the sentinel unresolved, which hydrateHistory would otherwise
      // have no choice but to drop entirely.
      const msg = err instanceof Error ? err.message : String(err)
      return {
        replace: [
          {
            type: 'text',
            text: `[the PDF "${rec.meta.name}" could not be converted for the current model (${msg}) — its earlier content is unavailable]`,
          },
        ],
      }
    }
  }
}
