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
    }
  }

  const modelValue: Record<string, unknown> = {}
  let text = texts.join('\n\n')
  if (text.length > maxChars) {
    const note = ` [truncated: ${text.length - maxChars} more characters]`
    text = text.slice(0, maxChars - note.length) + note
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
    modelValue.structured = result.structuredContent
  }
  if (resourceLinks.length > 0) {
    modelValue.resourceLinks = resourceLinks
    notes.push('It linked resources you can read with ReadMcpResource.')
  }
  if (!result.isError && !text && result.structuredContent === undefined && artifacts.length === 0 && resourceLinks.length === 0) {
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
    text = text.slice(0, maxChars - note.length) + note
    notes.push('The text was longer than the budget and was truncated.')
  }
  if (text) modelValue.text = text
  if (!text && artifacts.length === 0) notes.push('The resource had no readable content.')
  if (notes.length > 0) modelValue.note = notes.join(' ')
  return { modelValue, images, artifacts }
}
