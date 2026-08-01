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
  looksBinary,
  pageCaption,
  planAttachmentDelivery,
  MAX_ATTACHMENTS,
  type AttachmentDescriptor,
} from '../agent/attachmentPlan'
import { lycheeProviderOptions } from '../data/attachmentRefs'
import { saveAttachment, approxBytes, type AttachmentMeta } from '../data/attachments'
import { makeThumb } from '../data/screenshots'
import { loadPdfFromBytes, renderPdfPageFromBytes, PdfError } from '../platform/pdf'
import { assemblePagesText } from '../platform/pdfText'
import type { CapturedImage } from '../platform/capture'

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
      } else {
        const result = await ingestText(file, id)
        if ('error' in result) errors.push(result.error)
        else attachments.push(result)
      }
    } catch (err) {
      const msg = err instanceof PdfError ? err.message : `Could not read "${file.name}".`
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
        // Each page renders independently — a failure on page k must not
        // orphan pages 1..k-1 as uncaptioned image parts (already pushed,
        // already shown to the model) nor propagate to the outer catch below,
        // which would also skip persisting the attachment entirely. Stop at
        // the first failure and caption exactly what was actually attached.
        const rendered: number[] = []
        let failure: { page: number; message: string } | null = null
        for (const page of plan.pages) {
          try {
            const r = await renderPdfPageFromBytes(att.bytes, att.id, page)
            parts.push({
              type: 'file',
              mediaType: 'image',
              data: r.dataUrl,
              providerOptions: lycheeProviderOptions({ id: att.id, page }),
            })
            rendered.push(page)
          } catch (err) {
            failure = { page, message: err instanceof Error ? err.message : String(err) }
            break
          }
        }
        if (rendered.length === 0) {
          const why = failure ? ` (${failure.message})` : ''
          blocks.push(`[The user attached the PDF "${att.name}" (${att.pageCount} pages), but no pages could be rendered as images${why}.]`)
        } else {
          const first = rendered[0]
          const last = rendered[rendered.length - 1]
          const partialNote = failure
            ? ` Page ${failure.page} failed to render (${failure.message}), so later pages are omitted.`
            : plan.truncationNote
              ? `\n${plan.truncationNote}`
              : ''
          blocks.push(
            `[The user attached the PDF "${att.name}" (${att.pageCount} pages). Its pages are attached as images, in order: ${pageCaption(att.name, first, att.pageCount)} through ${pageCaption(att.name, last, att.pageCount)}.]${partialNote}`,
          )
        }
      } else if (plan.route === 'pdf-text' && att.kind === 'pdf') {
        const loaded = await loadPdfFromBytes(att.bytes, att.id, att.name)
        const assembled = assemblePagesText(
          loaded.pages,
          loaded.pages.map((p) => p.page),
          plan.budget,
        )
        const body = assembled.blocks.map((b) => `[page ${b.page}]\n${b.text}`).join('\n\n')
        const cuts: string[] = []
        if (assembled.blocks.some((b) => b.truncated)) cuts.push('the last shown page is truncated')
        if (assembled.omittedPages.length > 0) cuts.push(`${assembled.omittedPages.length} later pages were omitted`)
        if (loaded.info.pageCount > loaded.info.extractedPages)
          cuts.push(`only the first ${loaded.info.extractedPages} of ${loaded.info.pageCount} pages were extracted`)
        const cutNote = cuts.length > 0 ? `\n[Note: ${cuts.join('; ')} to fit the text budget.]` : ''
        blocks.push(
          `--- attached file: ${att.name} (${att.pageCount}-page PDF, text extracted) ---\n${body}${cutNote}\n--- end of ${att.name} ---`,
        )
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
          : bytesToDataUrl(new TextEncoder().encode(att.text), 'text/plain')
    const meta = attachmentUiMetas([att])[0]
    await saveAttachment({ id: att.id, conversationId: o.conversationId, meta, dataUrl }).catch((err) => {
      console.warn('attachment not persisted:', err)
    })
  }

  const label = (a: ComposerAttachment) => (a.kind === 'pdf' ? `${a.name} (${a.pageCount} pages)` : a.name)
  const notes = [`[attached: ${atts.map(label).join(', ')}]`]
  return { parts, appendText: blocks.join('\n\n'), notes, errors }
}
