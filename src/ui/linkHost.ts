// Pure host-label logic behind LinkCard's fallback display (used before an
// OpenGraph preview resolves, or whenever one has no siteName). Extracted so
// it's reachable by Vitest — LinkCard.tsx is a .tsx file, and this project's
// test config only collects src/**/*.test.ts (see CLAUDE.md).

/** The link's bare hostname (no "www.", no port, no path) for display, or the
 *  original string verbatim if it isn't a parseable URL — LinkCard's caller
 *  only ever passes a `LinkRef.url` that blocks.ts's `asUrl` already
 *  validated as http(s), so the catch branch is defense-in-depth, not the
 *  common case. */
export function hostOfLink(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
