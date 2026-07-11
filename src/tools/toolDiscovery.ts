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

/** Build the searchable catalog from an already-filtered ToolSet: name + description, minus meta-tools. */
export function buildCatalog(tools: Record<string, { description?: string }>): CatalogEntry[] {
  return Object.entries(tools)
    .filter(([name]) => !META_NAMES.has(name))
    .map(([name, t]) => ({ name, description: t.description ?? '' }))
}

/** Case-insensitive substring match over name + description. Empty/omitted query returns the whole catalog. */
export function searchCatalog(catalog: CatalogEntry[], query?: string): CatalogEntry[] {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return catalog
  return catalog.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q))
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
