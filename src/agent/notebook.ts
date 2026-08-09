// The structured research notebook: the long-horizon memory that replaces
// "just grow the message array". The controller (research.ts) and the ungated
// ungated WriteNotebook/ReadNotebook tools (tools/research.ts) both mutate one NotebookHandle; the
// controller persists it onto the ResearchTask and injects a compact summary
// into each phase's context (so context doesn't explode on big topics).
//
// Everything here is pure/Chrome-independent (unit-tested in notebook.test.ts):
// ids come from an internal counter, hashing is a small non-crypto djb2 so it
// stays synchronous, and dedup is by URL / content hash.
//
// addImage is also the SSRF/auto-fetch choke point for report images: the
// Synthesize phase (research.ts) embeds recorded images verbatim as
// `![caption](url)`, which the panel renders as a plain `<img src>` with no
// approval gate — an image URL harvested from attacker-influenced page content
// (SearchImages/HarvestImages) is not something a human ever reviews before it
// auto-loads in the user's browser. addImage screens `url` with the same
// isSafeRenderUrl guard the UI's own render surfaces use, so a private/
// internal/link-local target is refused before it ever enters the notebook —
// one guard here covers every present and future consumer of nb.images,
// rather than relying on each render surface to re-derive its own check.

import { isSafeRenderUrl } from '../platform/safeRenderUrl'

/** Confidence a finding's source actually supports its claim. */
export type Confidence = 'high' | 'med' | 'low'

/** A page (or paper/image host) the research drew on. `n` doubles as the
 *  1-based citation index — sources are numbered in the order first seen. */
export interface ResearchSourceRec {
  /** 1-based citation index, stable once assigned. */
  n: number
  url: string
  title: string
  /** Coarse credibility hint derived from the host (see credibilityHint). */
  credibility?: string
  /** How the page text was obtained. */
  fetchedVia: 'headless' | 'tab'
  /** djb2 of the normalized URL. This IS the dedup identity, not just a hint —
   *  there is no fallback string comparison, so a (32-bit-hash-space,
   *  astronomically unlikely at the scale one task reaches) collision between two
   *  distinct URLs would silently merge them into one source/citation number. */
  contentHash: string
}

/** One recorded claim tied (ideally) to a source + supporting quote. */
export interface Finding {
  id: string
  claim: string
  /** The citation index (`ResearchSourceRec.n`) this finding rests on. */
  sourceN?: number
  quote?: string
  confidence: Confidence
}

/** An image asset gathered for the report, with attribution. */
export interface ResearchImage {
  id: string
  url: string
  sourceN?: number
  caption?: string
  license?: string
  author?: string
  dims?: { w: number; h: number }
  relevanceNote?: string
  /** See ResearchSourceRec.contentHash — same "the hash IS the identity" caveat. */
  contentHash: string
}

/** Coverage of one plan sub-question. */
export interface CoverageEntry {
  supported: boolean
  gap?: string
}

/** The plan artifact emitted by the Scope&Plan phase. */
export interface ResearchPlan {
  subQuestions: string[]
  outline: string[]
  effortBudget?: { searches: number; fetches: number }
}

/** The full structured notebook, persisted on the ResearchTask. */
export interface ResearchNotebook {
  plan: ResearchPlan
  sources: ResearchSourceRec[]
  findings: Finding[]
  images: ResearchImage[]
  /** Keyed by sub-question text. */
  coverage: Record<string, CoverageEntry>
}

/** A fresh, empty notebook. */
export function emptyNotebook(): ResearchNotebook {
  return { plan: { subQuestions: [], outline: [] }, sources: [], findings: [], images: [], coverage: {} }
}

/** Small, fast, synchronous string hash (djb2). Not cryptographic — only a
 *  dedup key, so collisions are harmless and speed/sync matter more. */
export function djb2(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i)
  return (h >>> 0).toString(36)
}

/** Normalize a URL for dedup: lowercase host, drop hash + trailing slash + a
 *  handful of tracking params. Falls back to the raw string if unparseable. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid']) {
      u.searchParams.delete(p)
    }
    u.hostname = u.hostname.toLowerCase()
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s
  } catch {
    return raw.trim()
  }
}

/** Coarse, offline credibility hint from the host — a nudge for triage/synthesis,
 *  never a hard filter. Recognizes a few high-trust TLDs/domains. */
export function credibilityHint(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (/(^|\.)(gov|mil)(\.[a-z]{2})?$/.test(host) || host.endsWith('.gov') || host.endsWith('.mil')) return 'official'
  if (host.endsWith('.edu') || host.endsWith('.ac.uk')) return 'academic'
  if (/(^|\.)(wikipedia|nature|science|nih|who|nasa|arxiv|acm|ieee)\./.test(host)) return 'reference'
  if (/(^|\.)(reddit|quora|medium|substack|blogspot|wordpress)\./.test(host)) return 'user-generated'
  return undefined
}

/**
 * A mutable handle over one notebook. The controller creates it, hands it to
 * the tools, and persists `get()` after each `onChange`. Reducers dedup and
 * assign ids/citation numbers so callers (model tools included) don't have to.
 */
export interface NotebookHandle {
  get(): ResearchNotebook
  setPlan(plan: ResearchPlan): void
  /** Add or return the existing source for this URL; returns its citation index. */
  addSource(input: { url: string; title?: string; fetchedVia?: 'headless' | 'tab' }): ResearchSourceRec
  addFinding(input: { claim: string; sourceUrl?: string; quote?: string; confidence?: Confidence }): Finding
  /** Add an image, or return undefined (recording nothing) for a duplicate URL
   *  OR one that fails isSafeRenderUrl — see the module header. */
  addImage(input: {
    url: string
    sourceUrl?: string
    caption?: string
    license?: string
    author?: string
    dims?: { w: number; h: number }
    relevanceNote?: string
  }): ResearchImage | undefined
  setCoverage(subQuestion: string, entry: CoverageEntry): void
}

/** Build a handle over an existing (or empty) notebook, firing `onChange` on
 *  every mutation so the controller can persist + emit. */
export function createNotebook(initial?: ResearchNotebook, onChange?: () => void): NotebookHandle {
  const nb: ResearchNotebook = initial ?? emptyNotebook()
  let seq = nb.findings.length + nb.images.length
  const nextId = (p: string) => `${p}${++seq}`
  const fire = () => onChange?.()

  const findSourceByUrl = (url: string): ResearchSourceRec | undefined => {
    const hash = djb2(normalizeUrl(url))
    return nb.sources.find((s) => s.contentHash === hash)
  }

  return {
    get: () => nb,
    setPlan(plan) {
      nb.plan = plan
      fire()
    },
    addSource({ url, title, fetchedVia = 'headless' }) {
      const existing = findSourceByUrl(url)
      if (existing) {
        // A later real-tab render supersedes a headless fetch of the same page.
        if (fetchedVia === 'tab') existing.fetchedVia = 'tab'
        if (title && (!existing.title || existing.title === existing.url)) existing.title = title
        fire()
        return existing
      }
      const rec: ResearchSourceRec = {
        n: nb.sources.length + 1,
        url,
        title: title || url,
        credibility: credibilityHint(url),
        fetchedVia,
        contentHash: djb2(normalizeUrl(url)),
      }
      nb.sources.push(rec)
      fire()
      return rec
    },
    addFinding({ claim, sourceUrl, quote, confidence = 'med' }) {
      const src = sourceUrl ? findSourceByUrl(sourceUrl) : undefined
      const f: Finding = { id: nextId('f'), claim, sourceN: src?.n, quote, confidence }
      nb.findings.push(f)
      fire()
      return f
    },
    addImage({ url, sourceUrl, caption, license, author, dims, relevanceNote }) {
      // Refuse BEFORE dedup so an unsafe URL is never recorded even once — the
      // synthesize prompt (research.ts) later embeds every recorded image
      // as a bare `![]()` the panel auto-renders with no approval gate. Same
      // treatment as a dedup miss (return undefined, record nothing, fire
      // nothing) rather than a distinct error channel: the model didn't type
      // this URL itself (it came from SearchImages/HarvestImages results), so
      // there is nothing for it to retry or fix, and surfacing a per-URL
      // "blocked because X" reason back into the transcript would add an
      // oracle with no offsetting benefit.
      if (!isSafeRenderUrl(url)) return undefined
      const hash = djb2(normalizeUrl(url))
      if (nb.images.some((i) => i.contentHash === hash)) return undefined // dedup
      const src = sourceUrl ? findSourceByUrl(sourceUrl) : undefined
      const img: ResearchImage = {
        id: nextId('img'),
        url,
        sourceN: src?.n,
        caption,
        license,
        author,
        dims,
        relevanceNote,
        contentHash: hash,
      }
      nb.images.push(img)
      fire()
      return img
    },
    setCoverage(subQuestion, entry) {
      nb.coverage[subQuestion] = entry
      fire()
    },
  }
}

/**
 * A compact, size-bounded text view of the notebook for context injection —
 * plan + per-sub-question coverage + the most recent findings + the numbered
 * source list. Never the raw fetched text (that would defeat the point).
 */
export function summarizeNotebook(nb: ResearchNotebook, opts?: { maxFindings?: number; maxSources?: number }): string {
  const maxFindings = opts?.maxFindings ?? 25
  const maxSources = opts?.maxSources ?? 60
  const lines: string[] = []
  if (nb.plan.subQuestions.length) {
    lines.push('SUB-QUESTIONS (coverage):')
    nb.plan.subQuestions.forEach((q, i) => {
      const c = nb.coverage[q]
      const status = !c ? 'pending' : c.supported ? 'supported' : `GAP: ${c.gap ?? 'thin'}`
      lines.push(`  ${i + 1}. ${q} — ${status}`)
    })
  }
  if (nb.plan.outline.length) lines.push(`OUTLINE: ${nb.plan.outline.join(' · ')}`)
  if (nb.findings.length) {
    lines.push(`FINDINGS (${nb.findings.length}, showing last ${Math.min(maxFindings, nb.findings.length)}):`)
    for (const f of nb.findings.slice(-maxFindings)) {
      lines.push(`  - ${f.claim}${f.sourceN ? ` [${f.sourceN}]` : ''} (${f.confidence})`)
    }
  }
  if (nb.images.length) lines.push(`IMAGES gathered: ${nb.images.length}`)
  if (nb.sources.length) {
    // No cite-count on ResearchSourceRec to rank by, so — like FINDINGS above — cap
    // to the most-recently-added sources (array order == citation order == recency).
    // A citation number outside this window can still appear in FINDINGS text; that's
    // fine, the model doesn't need every source's row to resolve a bracket it wrote.
    const shown = nb.sources.slice(-maxSources)
    const omitted = nb.sources.length - shown.length
    lines.push('SOURCES:')
    for (const s of shown) {
      lines.push(`  [${s.n}] ${s.title} — ${s.url}${s.credibility ? ` (${s.credibility})` : ''}`)
    }
    if (omitted > 0) lines.push(`  …and ${omitted} more sources`)
  }
  return lines.join('\n')
}

/** True when every sub-question is marked supported (the convergence signal). */
export function isFullyCovered(nb: ResearchNotebook): boolean {
  const qs = nb.plan.subQuestions
  return qs.length > 0 && qs.every((q) => nb.coverage[q]?.supported)
}

/** The still-open sub-questions (unmarked or gap), for the next gather round. */
export function openGaps(nb: ResearchNotebook): string[] {
  return nb.plan.subQuestions.filter((q) => !nb.coverage[q]?.supported)
}
