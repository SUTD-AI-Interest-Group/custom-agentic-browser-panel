// The attachment delivery planner — the single place that knows which wire form
// a user attachment can take on which provider. Documents have NO provider-
// agnostic format: the two native adapters (Anthropic Messages, OpenAI
// Responses) turn an application/pdf `file` part into a native document block,
// but the OpenAI-compatible adapter THROWS on any non-image file part, 400ing
// the whole request — so a raw PDF must never be routed at a compatible
// provider. Everything else degrades down a ladder: rendered page images for
// vision-capable models, extracted text for blind ones, inline fenced text for
// text-like files.
//
// Pure logic (no Chrome, no AI SDK imports) so the routing matrix is fully
// unit-testable — same species as planShotDelivery / planTabProbe. The impure
// executor that turns routes into message parts lives in src/ui/attachments.ts.

/** What a dropped/picked file was classified as. */
export type AttachmentKind = 'image' | 'pdf' | 'text'

/** Most attachments one message may carry; violations are per-file errors. */
export const MAX_ATTACHMENTS = 10
/** Most PDF pages rendered as images on the fallback path (~1-2k tokens each). */
export const PAGE_BUDGET = 20
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** Matches pdf.ts's MAX_PDF_BYTES — the parse ceiling. */
export const PDF_MAX_BYTES = 50 * 1024 * 1024
export const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024
/** Char budget for an inlined text file. */
export const INLINE_TEXT_BUDGET = 48_000
/** Char budget for blind-model PDF text extraction. */
export const PDF_TEXT_BUDGET = 48_000

const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/
// Extension fallback for text-like files: browsers report many of these with an
// empty or generic MIME type (application/octet-stream), so the name decides.
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|toml|ini|log|sql)$/i

/**
 * Decide what an incoming file is — or why it can't attach. MIME wins where it
 * is specific; the extension allowlist catches text files with generic types.
 * Size caps are per kind so the error can name the actual limit.
 */
export function classifyIncomingFile(
  name: string,
  mimeType: string,
  byteSize: number,
): { kind: AttachmentKind } | { error: string } {
  if (IMAGE_MIME.test(mimeType)) {
    return byteSize > IMAGE_MAX_BYTES
      ? { error: `"${name}" is larger than the 20 MB image limit.` }
      : { kind: 'image' }
  }
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) {
    return byteSize > PDF_MAX_BYTES
      ? { error: `"${name}" is larger than the 50 MB PDF limit.` }
      : { kind: 'pdf' }
  }
  if (mimeType.startsWith('text/') || TEXT_EXT.test(name)) {
    return byteSize > TEXT_FILE_MAX_BYTES
      ? { error: `"${name}" is larger than the 2 MB text-file limit.` }
      : { kind: 'text' }
  }
  return { error: `"${name}" is not a supported type (images, PDFs, and text files only).` }
}

/**
 * Cheap binary sniff for extension-matched "text" files: a NUL anywhere, or
 * >5% other control characters (tab/LF/CR excepted), means it isn't text.
 */
export function looksBinary(sample: string): boolean {
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++
  }
  return sample.length > 0 && control / sample.length > 0.05
}

/** The planner's view of one attachment — metadata only, never the bytes. */
export interface AttachmentDescriptor {
  kind: AttachmentKind
  name: string
  byteSize: number
  /** PDFs only — read at attach time (which doubles as early validation). */
  pageCount?: number
}

/** What the active provider+model combination can consume. */
export interface DeliveryContext {
  supportsNativeDocuments: boolean
  nativeDocMaxBytes: number
  visionCapable: boolean
}

/** How one attachment reaches the model. */
export type DeliveryRoute =
  | { route: 'image-part' }
  | { route: 'image-note'; note: string }
  | { route: 'native-pdf' }
  | { route: 'pdf-pages'; pages: number[]; truncationNote: string | null }
  | { route: 'pdf-text'; budget: number }
  | { route: 'inline-text'; budget: number }

/**
 * Route one attachment for one provider/model. PDFs walk a ladder: native
 * document part (native adapter, under the byte cap) → rendered page images
 * (model has vision) → extracted text (blind). Images are vision-gated; text
 * files inline everywhere.
 */
export function planAttachmentDelivery(
  att: AttachmentDescriptor,
  ctx: DeliveryContext,
): DeliveryRoute {
  if (att.kind === 'image') {
    return ctx.visionCapable
      ? { route: 'image-part' }
      : {
          route: 'image-note',
          note: `[The user attached the image "${att.name}", but this model cannot read images — say so rather than guessing its contents.]`,
        }
  }
  if (att.kind === 'pdf') {
    if (ctx.supportsNativeDocuments && att.byteSize <= ctx.nativeDocMaxBytes) {
      return { route: 'native-pdf' }
    }
    if (ctx.visionCapable) {
      // `??` only falls back on null/undefined — pageCount:0 (a degenerate but
      // parseable PDF) would pass straight through and yield an empty `pages`
      // array downstream. Treat it like an unknown count instead.
      const total = att.pageCount || 1
      const shown = Math.min(total, PAGE_BUDGET)
      const pages = Array.from({ length: shown }, (_, i) => i + 1)
      const truncationNote =
        total > shown
          ? `[Only the first ${shown} of ${total} pages of "${att.name}" are shown as images.]`
          : null
      return { route: 'pdf-pages', pages, truncationNote }
    }
    return { route: 'pdf-text', budget: PDF_TEXT_BUDGET }
  }
  return { route: 'inline-text', budget: INLINE_TEXT_BUDGET }
}

/** Caption for one rendered PDF page, so the model can name what it sees. */
export function pageCaption(name: string, page: number, pageCount: number): string {
  return `${name} — page ${page} of ${pageCount}`
}

/**
 * Slice `text[0:end]` without splitting a UTF-16 surrogate pair at the cut —
 * .slice() counts code units, not code points, so a cut landing between a
 * pair's high and low half leaves a lone surrogate at the end of the string.
 * The byte-level UTF-8 encode a provider performs on the request replaces that
 * lone surrogate with U+FFFD, so trim it rather than send a corrupted char.
 */
function safeSliceEnd(text: string, end: number): string {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return text.slice(0, end - 1)
  }
  return text.slice(0, end)
}

/**
 * Wrap a text file's content in a named fence for the model text, truncating
 * to `budget` chars with an explicit notice (never a silent cut).
 */
export function formatInlineTextBlock(name: string, text: string, budget: number): string {
  const truncated = text.length > budget
  const body = truncated ? safeSliceEnd(text, budget) : text
  const tail = truncated
    ? `\n[truncated — file continues past the ${budget.toLocaleString()}-character budget]`
    : ''
  return `--- attached file: ${name} ---\n${body}${tail}\n--- end of ${name} ---`
}
