// The dehydrate/hydrate boundary for attachment data in persisted history —
// the conversations record must not hold megabytes of inline file data, but the
// model needs the real bytes on every send. Same chokepoint shape as the
// vault's seal/open: swap on the way to disk, restore on the way back.
//
// Parts built from an attachment are tagged with providerOptions.lychee (a
// namespace no adapter reads, so nothing leaks to the wire). At save time the
// tag's id replaces the part's data with a `lychee-attachment:<id>[#page=<n>]`
// sentinel; at load time a resolver turns the sentinel back into a data URL —
// or, when the attachment was pruned from the capped store, the whole part
// becomes an explanatory text part rather than a broken file part.
//
// A resolved ref is NOT always a straight data swap, though: a whole-document
// native-PDF part (see attachmentPlan.ts's isNativePdfPart) was routed for
// whichever provider was active when it was attached, and that provider may
// not be the one active now (supportsNativeDocuments differs per
// providerProfiles.ts kind). The resolver — src/ui/attachments.ts's
// makeHistoricalAttachmentResolver — re-plans that one shape against the
// CURRENTLY active provider and can hand back a `replace` of one or more
// fresh parts (rendered pages, extracted text) instead of a bare data string.
// Every other historical part (images, already-rendered PDF pages) is
// wire-compatible everywhere, so it always resolves as a plain data swap.
//
// Pure given the resolver (no Chrome, no IndexedDB) — keep it that way.

import type { ModelMessage } from 'ai'

/** Reference to a stored attachment; `page` marks a derived PDF page render. */
export interface AttachmentRef {
  id: string
  page?: number
}

/** A part `hydrateHistory` can splice in to replace a resolved sentinel. */
export type ReplacementPart =
  | {
      type: 'file'
      mediaType: string
      data: string
      filename?: string
      providerOptions?: ReturnType<typeof lycheeProviderOptions>
    }
  | { type: 'text'; text: string }

/**
 * What a resolver hands back for one sentinel: the common case is `{data}` —
 * the same part, data restored — but a part whose wire form no longer suits
 * the active provider resolves as `{replace}` (see the file banner above);
 * `null` means the attachment is gone (pruned from the capped store).
 */
export type ResolvedAttachmentPart = { data: string } | { replace: ReplacementPart[] } | null

const SENTINEL_PREFIX = 'lychee-attachment:'

/** The providerOptions tag an attachment-sourced part carries. */
export function lycheeProviderOptions(ref: AttachmentRef): {
  lychee: { attachmentId: string; page?: number }
} {
  return {
    lychee: {
      attachmentId: ref.id,
      ...(ref.page !== undefined ? { page: ref.page } : {}),
    },
  }
}

interface TaggedPart {
  type?: string
  mediaType?: string
  data?: unknown
  text?: string
  filename?: string
  providerOptions?: { lychee?: { attachmentId?: string; page?: number } }
}

function refOfPart(part: TaggedPart): AttachmentRef | null {
  const tag = part.providerOptions?.lychee
  if (part.type !== 'file' || typeof tag?.attachmentId !== 'string') return null
  return { id: tag.attachmentId, ...(typeof tag.page === 'number' ? { page: tag.page } : {}) }
}

function sentinelOf(ref: AttachmentRef): string {
  return `${SENTINEL_PREFIX}${ref.id}${ref.page !== undefined ? `#page=${ref.page}` : ''}`
}

function parseSentinel(data: unknown): AttachmentRef | null {
  if (typeof data !== 'string' || !data.startsWith(SENTINEL_PREFIX)) return null
  const body = data.slice(SENTINEL_PREFIX.length)
  const hash = body.indexOf('#page=')
  if (hash === -1) return { id: body }
  const page = Number(body.slice(hash + '#page='.length))
  return { id: body.slice(0, hash), ...(Number.isFinite(page) ? { page } : {}) }
}

/** dehydrateHistory's shape: always exactly one part in, one part out, sync. */
function mapPartsSync(history: ModelMessage[], fn: (part: TaggedPart) => TaggedPart): ModelMessage[] {
  return history.map((m) => {
    if (!Array.isArray(m.content)) return m
    return { ...m, content: (m.content as TaggedPart[]).map(fn) } as ModelMessage
  })
}

/**
 * hydrateHistory's shape: one part in, one-OR-MANY parts out (a `replace`
 * degrade can expand a single native-pdf part into several rendered-page
 * parts, or collapse it into one text part) — `.flat()` splices whichever
 * comes back into the message's content array in place of the original.
 */
function mapPartsAsync(
  history: ModelMessage[],
  fn: (part: TaggedPart) => Promise<TaggedPart | TaggedPart[]>,
): Promise<ModelMessage[]> {
  return Promise.all(
    history.map(async (m) => {
      if (!Array.isArray(m.content)) return m
      const mapped = await Promise.all((m.content as TaggedPart[]).map(fn))
      return { ...m, content: mapped.flat() } as ModelMessage
    }),
  )
}

/**
 * Replace every attachment-tagged file part's data with its sentinel, for
 * persistence. Builds new objects — the live history is never mutated.
 */
export function dehydrateHistory(history: ModelMessage[]): ModelMessage[] {
  return mapPartsSync(history, (part) => {
    const ref = refOfPart(part)
    return ref ? { ...part, data: sentinelOf(ref) } : part
  })
}

/**
 * Restore sentinels via `resolve`, which sees each ref's original mediaType so
 * it can tell a whole-document native-PDF part (the one shape that needs
 * re-planning against the currently active provider — see the file banner)
 * from everything else. A ref that no longer resolves (pruned from the capped
 * store) becomes an explanatory TEXT part — a file part with dead data would
 * fail the next model call; `resolve`'s own `replace` result (a re-planned
 * degrade) splices in whatever parts it hands back instead.
 */
export function hydrateHistory(
  history: ModelMessage[],
  resolve: (ref: AttachmentRef, mediaType: string | undefined) => Promise<ResolvedAttachmentPart>,
): Promise<ModelMessage[]> {
  return mapPartsAsync(history, async (part) => {
    const ref = parseSentinel(part.data)
    if (!ref) return part
    const resolved = await resolve(ref, part.mediaType)
    if (resolved === null) {
      return {
        type: 'text',
        text: `[an attachment in this message ("${ref.id}") is no longer available — it was pruned from local storage]`,
      }
    }
    if ('replace' in resolved) return resolved.replace as TaggedPart[]
    return { ...part, data: resolved.data }
  })
}
