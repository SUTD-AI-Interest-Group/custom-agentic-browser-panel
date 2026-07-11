// The structured research notebook: the long-horizon memory that replaces
// "just grow the message array". The controller (research.ts) and the ungated
// Notebook.* tools (tools/research.ts) both mutate one NotebookHandle; the
// controller persists it onto the ResearchTask and injects a compact summary
// into each phase's context (so context doesn't explode on big topics).
//
// Everything here is pure/Chrome-independent (unit-tested in notebook.test.ts):
// ids come from an internal counter, hashing is a small non-crypto djb2 so it
// stays synchronous, and dedup is by URL / content hash.

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
  /** djb2 of the normalized URL — cheap dedup key. */
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
export function summarizeNotebook(nb: ResearchNotebook, opts?: { maxFindings?: number }): string {
  const maxFindings = opts?.maxFindings ?? 25
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
    lines.push('SOURCES:')
    for (const s of nb.sources) {
      lines.push(`  [${s.n}] ${s.title} — ${s.url}${s.credibility ? ` (${s.credibility})` : ''}`)
    }
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
