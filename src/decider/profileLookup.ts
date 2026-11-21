// The user's saved profile, as a lookup table the decision model can choose from.
//
// Profile memories are sentences ("The user's email address is ada@example.com."); a form-fill
// decision needs keyed values (`profile.email`). One structured-output call on the user's own chat
// model turns the one into the other. Panel-only (it imports the AI SDK through extract.ts).
//
// NOTHING INVENTED REACHES A FORM. The prompt asks for values copied exactly as written, and the
// answer is held to it: a value that does not appear in any of the sentences (compared with case,
// curly quotes and whitespace folded) is dropped, so a model that "helpfully" completes a phone
// number or a postcode cannot get it typed into a page.
//
// CACHED IN MEMORY ONLY, per memory set: the key is every memory's id and updatedAt, so editing,
// adding or deleting a profile memory misses it. The promise is cached (concurrent lookups share
// one call) and dropped again on failure (a transient error is not remembered). Nothing here is
// persisted: the structured profile is derived data with the memories as its source of truth.

import type { LanguageModel } from 'ai'
import { extractStructured } from '../agent/extract'
import type { MemoryRecord } from '../data/memory'

const SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
    },
  },
  required: ['fields'],
}

/** Distinct memory sets kept; a user edits their profile rarely, so a handful is plenty. */
const CACHE_LIMIT = 8
const MAX_KEY = 48
const cache = new Map<string, Promise<Record<string, string>>>()

/** For tests. */
export function clearProfileLookupCache(): void {
  cache.clear()
}

function promptFor(memories: MemoryRecord[]): string {
  return [
    "Extract the user's profile details from the saved profile sentences below, as key/value pairs.",
    '- key: a short snake_case name for what the value is, e.g. full_name, first_name, last_name, email, work_email, phone, home_address, street, city, postcode, country.',
    '- value: copied exactly as written in the sentences. Do not reformat, abbreviate, translate or complete it.',
    '- When a value has well-known parts (a full name, a postal address), give the whole value AND each part as its own key, every part copied exactly as it appears.',
    '- Nothing invented: if a detail is not stated in the sentences, leave it out.',
    '',
    'Profile sentences:',
    ...memories.map((m, k) => `${k + 1}. ${m.content}`),
  ].join('\n')
}

const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()

const snakeCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY)

function tableOf(raw: unknown, memories: MemoryRecord[]): Record<string, string> {
  const fields = (raw as { fields?: unknown } | null)?.fields
  if (!Array.isArray(fields)) throw new Error('the profile answer was not a list of fields')
  const source = memories.map((m) => fold(m.content))
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (typeof f !== 'object' || f === null) continue
    const { key, value } = f as { key?: unknown; value?: unknown }
    if (typeof key !== 'string' || typeof value !== 'string') continue
    const k = snakeCase(key)
    const v = value.trim()
    if (!k || !v || Object.hasOwn(out, k)) continue
    const folded = fold(v)
    if (!source.some((s) => s.includes(folded))) continue // invented, or rewritten: never typed into a form
    out[k] = v
  }
  return out
}

/**
 * The profile memories as `{ key: value }` — e.g. `{ full_name: 'Ada Lovelace', email: … }` — from
 * ONE extractStructured call on `model`, cached in memory per memory set. Zero memories make no call.
 * Rejects when the model call fails or answers off-schema. Each caller gets its own copy.
 */
export async function profileLookup(model: LanguageModel, memories: MemoryRecord[], signal?: AbortSignal): Promise<Record<string, string>> {
  if (memories.length === 0) return {}
  const key = memories
    .map((m) => m.id + ':' + m.updatedAt)
    .sort()
    .join('|')
  let entry = cache.get(key)
  if (!entry) {
    entry = extractStructured(model, promptFor(memories), SCHEMA, signal).then((raw) => tableOf(raw, memories))
    cache.set(key, entry)
    entry.catch(() => {
      if (cache.get(key) === entry) cache.delete(key)
    })
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  }
  return { ...(await entry) }
}
