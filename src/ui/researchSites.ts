// Pure host-add logic for the launch card's Sites field, extracted so it's
// unit-testable without mounting ResearchLaunchCard. Reuses normalizeHost and
// isScopableHost from researchFraming.ts — the same two rules parseFraming
// applies to the model's OWN "sites" output (Task 6) — so a hand-typed host is
// held to exactly the same bar as a model-proposed one: one rule, two
// producers, never two standards.

import { normalizeHost, isScopableHost } from '../agent/researchFraming'

/**
 * Add a hand-typed host to a proposal's site list. Returns the SAME array
 * reference when `input` doesn't turn into a new, addable host — junk input,
 * a bare public suffix (`isScopableHost`; worse than no scope at all, see its
 * doc comment), or a host already in `sites` — so a caller can tell "nothing
 * changed" apart from "the list is now empty" without a separate boolean, and
 * can disable an "Add" button by comparing the result to what it passed in.
 */
export function addSite(sites: string[], input: string): string[] {
  const host = normalizeHost(input)
  if (!isScopableHost(host) || sites.includes(host)) return sites
  return [...sites, host]
}
