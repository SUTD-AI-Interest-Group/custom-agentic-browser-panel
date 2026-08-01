// Pure mapping from MCP results to the three places their content can go.
// This module is where the image invariant is enforced for MCP: a tool result
// sent to the MODEL carries text only; images ride the per-turn imageQueue
// (the one channel the adapters turn into a real image part); and every
// non-text payload becomes a user-facing artifact card persisted in IndexedDB
// (src/data/mcpArtifacts.ts). No Chrome or AI-SDK imports — unit-tested.

/** A user-facing artifact extracted from an MCP result, pre-persistence. */
export interface McpArtifactInput {
  kind: 'image' | 'audio' | 'video' | 'html' | 'blob' | 'text'
  mimeType: string
  /** Binary payloads, as a data URL ready for <img>/<audio>/<video>. */
  dataUrl?: string
  /** Textual payloads (html, large text) kept as text. */
  text?: string
  title: string
}

export interface MappedResult {
  /** What the model sees — text only, budgeted. Becomes the tool return value. */
  modelValue: Record<string, unknown>
  /** Images for the per-turn imageQueue, caption riding with each. */
  images: { dataUrl: string; caption: string }[]
  /** Rich payloads to persist and render as cards for the user. */
  artifacts: McpArtifactInput[]
}

/** Default text budget for one result — mirrors the page-reading caps. */
const DEFAULT_MAX_CHARS = 16_000

/** Cap on how many `resource_link` entries reach the model in one result. */
const MAX_RESOURCE_LINKS = 200

/**
 * Slice text down to at most `end` UTF-16 code units, backing the cut off by
 * one more unit when that would split a surrogate pair (leaving a lone high
 * surrogate right before the appended "[truncated: …]" note). Same class of
 * bug — and same fix shape — as src/platform/pdfText.ts's safeSlice/
 * safeSliceEnd; reimplemented locally rather than imported, since that
 * helper is module-private there and this module is deliberately kept
 * Chrome/pdf.js-free.
 */
function safeSliceEnd(text: string, end: number): string {
  let e = end
  if (e > 0 && e < text.length) {
    const code = text.charCodeAt(e - 1)
    if (code >= 0xd800 && code <= 0xdbff) e -= 1 // lone high surrogate at the cut -> drop it
  }
  return text.slice(0, e)
}

interface Ctx {
  server: string
  tool: string
  maxChars?: number
}

/** Best-effort base64 → text, for HTML blobs we want to render, not download. */
function decodeBase64Text(b64: string): string | null {
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

function kindForMime(mimeType: string): McpArtifactInput['kind'] {
  const m = mimeType.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('text/html') || m === 'application/xhtml+xml') return 'html'
  return 'blob'
}

/** One binary payload → artifact (+ queue entry when it is an image). */
function mapBinary(
  b64: string,
  mimeType: string,
  title: string,
  caption: string,
  out: { images: MappedResult['images']; artifacts: McpArtifactInput[]; notes: string[] },
) {
  const kind = kindForMime(mimeType)
  const dataUrl = `data:${mimeType};base64,${b64}`
  if (kind === 'image') {
    out.images.push({ dataUrl, caption })
    out.artifacts.push({ kind, mimeType, dataUrl, title })
    out.notes.push('It returned an image — shown to you separately and to the user in the chat.')
    return
  }
  if (kind === 'html') {
    const text = decodeBase64Text(b64)
    out.artifacts.push(text !== null ? { kind, mimeType, text, title } : { kind: 'blob', mimeType, dataUrl, title })
    out.notes.push('It returned an HTML document, shown to the user as a card.')
    return
  }
  out.artifacts.push({ kind, mimeType, dataUrl, title })
  out.notes.push(
    kind === 'audio'
      ? 'It returned audio — an audio player was shown to the user (you cannot hear it).'
      : kind === 'video'
        ? 'It returned a video — a video player was shown to the user (you cannot watch it).'
        : `It returned a binary attachment (${mimeType}), offered to the user as a download.`,
  )
}

/**
 * Split one MCP tool-call result into model text / imageQueue entries /
 * user artifacts. Truncation is always explicit — a silently cut result reads
 * to the model as "I saw everything".
 */
export function mapCallResult(
  result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean },
  ctx: Ctx,
): MappedResult {
  const maxChars = ctx.maxChars ?? DEFAULT_MAX_CHARS
  const texts: string[] = []
  const notes: string[] = []
  const images: MappedResult['images'] = []
  const artifacts: McpArtifactInput[] = []
  const resourceLinks: { uri: string; name?: string; description?: string; mimeType?: string }[] = []
  const out = { images, artifacts, notes }
  const label = `${ctx.server}.${ctx.tool}`
  const imageCaption = `Image returned by the MCP tool ${label}. This is a plain image: there are no numbered boxes on it.`
  let unrecognizedParts = 0

  for (const part of result.content ?? []) {
    const p = part as Record<string, unknown>
    switch (p.type) {
      case 'text': {
        if (typeof p.text === 'string' && p.text.length > 0) texts.push(p.text)
        break
      }
      case 'image':
      case 'audio': {
        if (typeof p.data === 'string' && typeof p.mimeType === 'string') {
          mapBinary(p.data, p.mimeType, `${label} result`, imageCaption, out)
        }
        break
      }
      case 'resource': {
        const r = p.resource as Record<string, unknown> | undefined
        if (!r) break
        const uri = typeof r.uri === 'string' ? r.uri : ''
        if (typeof r.text === 'string') {
          texts.push(uri ? `[resource ${uri}]\n${r.text}` : r.text)
        } else if (typeof r.blob === 'string') {
          const mime = typeof r.mimeType === 'string' ? r.mimeType : 'application/octet-stream'
          mapBinary(r.blob, mime, uri || `${label} resource`, imageCaption, out)
        }
        break
      }
      case 'resource_link': {
        resourceLinks.push({
          uri: String(p.uri ?? ''),
          ...(typeof p.name === 'string' ? { name: p.name } : {}),
          ...(typeof p.description === 'string' ? { description: p.description } : {}),
          ...(typeof p.mimeType === 'string' ? { mimeType: p.mimeType } : {}),
        })
        break
      }
      default: {
        // A content-part type this SDK version doesn't model (a vendor
        // extension, or a future MCP content kind). The tool DID return
        // something — count it so the "no content" note below doesn't lie.
        unrecognizedParts += 1
        break
      }
    }
  }

  const modelValue: Record<string, unknown> = {}
  let text = texts.join('\n\n')
  if (text.length > maxChars) {
    const note = ` [truncated: ${text.length - maxChars} more characters]`
    text = safeSliceEnd(text, maxChars - note.length) + note
    notes.push(`The text was longer than the budget and was truncated.`)
  }

  if (result.isError) {
    // An MCP error result: hand the text back as an error so the model
    // self-corrects (retries with different arguments) instead of treating the
    // failure text as an answer.
    modelValue.error = text || 'The tool reported an error with no message.'
  } else if (text) {
    modelValue.text = text
  }

  if (result.structuredContent !== undefined && !result.isError) {
    // Unbounded structuredContent (an unpaginated "list everything" tool, say)
    // would otherwise blow straight past the text budget entirely — it rode
    // through as a raw object with no size check at all. Budget its serialized
    // size the same way the text above is budgeted; only degrade to a
    // truncated string when it's actually oversized, so the common small-JSON
    // case is untouched.
    const serialized = JSON.stringify(result.structuredContent) ?? ''
    if (serialized.length > maxChars) {
      const note = ` [truncated: ${serialized.length - maxChars} more characters]`
      modelValue.structured = safeSliceEnd(serialized, maxChars - note.length) + note
      notes.push('The structured result was larger than the budget and was truncated to text.')
    } else {
      modelValue.structured = result.structuredContent
    }
  }
  if (resourceLinks.length > 0) {
    const overflow = resourceLinks.length - MAX_RESOURCE_LINKS
    modelValue.resourceLinks = overflow > 0 ? resourceLinks.slice(0, MAX_RESOURCE_LINKS) : resourceLinks
    notes.push(
      overflow > 0
        ? `It linked resources you can read with ReadMcpResource (showing the first ${MAX_RESOURCE_LINKS} of ${resourceLinks.length}).`
        : 'It linked resources you can read with ReadMcpResource.',
    )
  }
  if (unrecognizedParts > 0) {
    notes.push(`It also returned ${unrecognizedParts} part(s) of an unrecognized content type, not shown.`)
  }
  if (
    !result.isError &&
    !text &&
    result.structuredContent === undefined &&
    artifacts.length === 0 &&
    resourceLinks.length === 0 &&
    unrecognizedParts === 0
  ) {
    notes.push('The tool returned no content.')
  }
  if (notes.length > 0) modelValue.note = notes.join(' ')
  return { modelValue, images, artifacts }
}

/**
 * Map a resources/read result (ReadMcpResource, MCP Apps templates) the same
 * three ways. Text contents go to the model; binaries become artifacts, images
 * additionally ride the queue.
 */
export function mapResourceResult(
  result: { contents?: unknown[] },
  ctx: { server: string; maxChars?: number },
): MappedResult {
  const maxChars = ctx.maxChars ?? DEFAULT_MAX_CHARS
  const texts: string[] = []
  const notes: string[] = []
  const images: MappedResult['images'] = []
  const artifacts: McpArtifactInput[] = []
  const out = { images, artifacts, notes }

  for (const part of result.contents ?? []) {
    const c = part as Record<string, unknown>
    const uri = typeof c.uri === 'string' ? c.uri : ''
    if (typeof c.text === 'string') {
      texts.push(uri ? `[${uri}]\n${c.text}` : c.text)
    } else if (typeof c.blob === 'string') {
      const mime = typeof c.mimeType === 'string' ? c.mimeType : 'application/octet-stream'
      mapBinary(
        c.blob,
        mime,
        uri || `${ctx.server} resource`,
        `Resource ${uri} from the MCP server ${ctx.server}. This is a plain image: there are no numbered boxes on it.`,
        out,
      )
    }
  }

  const modelValue: Record<string, unknown> = {}
  let text = texts.join('\n\n')
  if (text.length > maxChars) {
    const note = ` [truncated: ${text.length - maxChars} more characters]`
    text = safeSliceEnd(text, maxChars - note.length) + note
    notes.push('The text was longer than the budget and was truncated.')
  }
  if (text) modelValue.text = text
  if (!text && artifacts.length === 0) notes.push('The resource had no readable content.')
  if (notes.length > 0) modelValue.note = notes.join(' ')
  return { modelValue, images, artifacts }
}
