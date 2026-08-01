// Pure bounds behind JsonTree's rendering of a parsed JSON value. Extracted
// so they're reachable by Vitest — JsonTree.tsx is a .tsx file, and this
// project's test config only collects src/**/*.test.ts (see CLAUDE.md).
//
// The value JsonTree renders is always *parsed* JSON (blocks.ts's tryJson,
// capped at JSON_MAX=20000 raw characters before it's even attempted) — real
// JSON.parse output can never contain a cycle, so there is no live circular-
// reference case to guard here. It CAN, however, get extremely deep for its
// size: '[' x 9999 + ']' x 9999 alone is under half of JSON_MAX. JsonTree's
// Node component recurses once per nesting level, so an unbounded depth risks
// an actual "Maximum call stack size exceeded" render crash, not a
// hypothetical one — see the reachability test below. It can also be
// extremely wide at a single level (thousands of short entries fit in the
// same budget), which doesn't risk a crash but does risk rendering
// thousands of DOM rows the instant a shallow node auto-opens.
//
// MAX_DEPTH is also incidental defense-in-depth against a hypothetical
// circular object graph from some future non-JSON.parse caller: a cycle can
// only ever be stopped by *some* depth eventually running out, same
// mechanism as a genuinely deep-but-finite structure.

/** Recursion stops here — depth counts nesting levels, root is depth 0. */
export const MAX_DEPTH = 40

/** Cap on entries actually rendered per object/array node; the rest are
 *  summarized behind a "+N more" note instead of silently dropped. */
export const MAX_ENTRIES = 200

export interface EntryPage<T> {
  shown: T[]
  hiddenCount: number
}

/** Bound how many of a node's entries are rendered. */
export function pageEntries<T>(entries: T[], max = MAX_ENTRIES): EntryPage<T> {
  if (entries.length <= max) return { shown: entries, hiddenCount: 0 }
  return { shown: entries.slice(0, max), hiddenCount: entries.length - max }
}

/** Whether a container node at `depth` should still recurse into its
 *  children, or stop and render an opaque, non-expandable summary instead. */
export function shouldDescend(depth: number, maxDepth = MAX_DEPTH): boolean {
  return depth < maxDepth
}
