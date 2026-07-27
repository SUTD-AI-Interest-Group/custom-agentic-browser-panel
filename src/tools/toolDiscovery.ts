// Pure tool-discovery logic for progressive disclosure. No Chrome or AI-SDK
// imports — this is the unit-tested core that the meta-tools (ToolSearch,
// GetTool) and the turn loop (prepareStep -> activeTools) build on.

/** One row in the searchable tool catalog: a tool the model can load on demand. */
export interface CatalogEntry {
  name: string
  description: string
}

/**
 * Tools exposed to the model on every step without a discovery round-trip:
 * the two disclosure meta-tools plus ReadPage (the current-tab reader, by far
 * the most common action).
 */
export const ALWAYS_ON: readonly string[] = ['ToolSearch', 'GetTool', 'ReadPage']

/** The disclosure meta-tools themselves — excluded from the searchable catalog. */
export const META_NAMES: Set<string> = new Set(['ToolSearch', 'GetTool'])

/**
 * Build the searchable catalog from an already-filtered ToolSet: name +
 * description, minus meta-tools. `description` is typed loosely because AI SDK
 * v7 allows a tool description to be a string OR a `(options) => string`
 * function; only static string descriptions are catalogued (dynamic ones — none
 * in this app — collapse to an empty string).
 */
export function buildCatalog(tools: Record<string, { description?: unknown }>): CatalogEntry[] {
  return Object.entries(tools)
    .filter(([name]) => !META_NAMES.has(name))
    .map(([name, t]) => ({ name, description: typeof t.description === 'string' ? t.description : '' }))
}

/**
 * Keyword search over name + description: the query is tokenized on
 * whitespace and an entry matches when ANY token appears in it
 * (case-insensitive substring), best-matching entries first. A literal
 * whole-phrase match would make every realistic multi-word query ("create
 * interactive visualization") return nothing — the model then wrongly
 * concludes the capability does not exist.
 *
 * Empty/omitted query returns the whole catalog. So does a query with NO
 * matches at all — a dead-end [] is worse than full disclosure at this
 * catalog size — and the fallback returns the `catalog` array itself, so a
 * caller can detect it by reference (`result === catalog`).
 */
export function searchCatalog(catalog: CatalogEntry[], query?: string): CatalogEntry[] {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return catalog
  const tokens = q.split(/\s+/)
  const scored = catalog
    .map((e, i) => {
      const hay = `${e.name} ${e.description}`.toLowerCase()
      return { e, i, hits: tokens.filter((t) => hay.includes(t)).length }
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
  if (!scored.length) return catalog
  return scored.map((s) => s.e)
}

/** Split requested names into those present in the catalog and those that are not. */
export function partitionToolNames(
  names: string[],
  catalog: CatalogEntry[],
): { valid: string[]; unknown: string[] } {
  const known = new Set(catalog.map((e) => e.name))
  const valid: string[] = []
  const unknown: string[] = []
  for (const n of names) (known.has(n) ? valid : unknown).push(n)
  return { valid, unknown }
}

/**
 * The active tool set for a step: the always-on core plus everything loaded or
 * seeded so far. When `existing` (the turn's actual tool names) is given, the
 * result is intersected with it so a seeded/loaded name that was removed by
 * policy or permission never reaches `activeTools`.
 */
export function resolveActiveTools(activeNames: Set<string>, existing?: Iterable<string>): string[] {
  const all = new Set<string>([...ALWAYS_ON, ...activeNames])
  if (!existing) return Array.from(all)
  const exist = new Set(existing)
  return Array.from(all).filter((n) => exist.has(n))
}
