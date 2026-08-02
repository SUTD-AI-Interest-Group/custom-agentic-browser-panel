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
// Pure given the resolver (no Chrome, no IndexedDB) — keep it that way.

import type { ModelMessage } from 'ai'

/** Reference to a stored attachment; `page` marks a derived PDF page render. */
export interface AttachmentRef {
  id: string
  page?: number
}

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
  data?: unknown
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

function mapParts(
  history: ModelMessage[],
  fn: (part: TaggedPart) => TaggedPart | Promise<TaggedPart>,
  async: false,
): ModelMessage[]
function mapParts(
  history: ModelMessage[],
  fn: (part: TaggedPart) => TaggedPart | Promise<TaggedPart>,
  async: true,
): Promise<ModelMessage[]>
function mapParts(
  history: ModelMessage[],
  fn: (part: TaggedPart) => TaggedPart | Promise<TaggedPart>,
  async: boolean,
): ModelMessage[] | Promise<ModelMessage[]> {
  const mapMessage = (m: ModelMessage): ModelMessage | Promise<ModelMessage> => {
    if (!Array.isArray(m.content)) return m
    if (!async) {
      return { ...m, content: (m.content as TaggedPart[]).map((p) => fn(p) as TaggedPart) } as ModelMessage
    }
    return Promise.all((m.content as TaggedPart[]).map((p) => fn(p))).then(
      (content) => ({ ...m, content }) as ModelMessage,
    )
  }
  return async
    ? Promise.all(history.map((m) => mapMessage(m)))
    : history.map((m) => mapMessage(m) as ModelMessage)
}

/**
 * Replace every attachment-tagged file part's data with its sentinel, for
 * persistence. Builds new objects — the live history is never mutated.
 */
export function dehydrateHistory(history: ModelMessage[]): ModelMessage[] {
  return mapParts(
    history,
    (part) => {
      const ref = refOfPart(part)
      return ref ? { ...part, data: sentinelOf(ref) } : part
    },
    false,
  )
}

/**
 * Restore sentinels to real data via `resolve`. A ref that no longer resolves
 * (pruned from the capped store) becomes an explanatory TEXT part — a file
 * part with dead data would 400 the next model call.
 */
export function hydrateHistory(
  history: ModelMessage[],
  resolve: (ref: AttachmentRef) => Promise<string | null>,
): Promise<ModelMessage[]> {
  return mapParts(
    history,
    async (part) => {
      const ref = parseSentinel(part.data)
      if (!ref) return part
      const data = await resolve(ref)
      if (data !== null) return { ...part, data }
      return {
        type: 'text',
        text: `[an attachment in this message ("${ref.id}") is no longer available — it was pruned from local storage]`,
      }
    },
    true,
  )
}
