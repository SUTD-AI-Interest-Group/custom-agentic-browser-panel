// Visual-region perception: the address space for element-level screenshots.
//
// domIndex.ts answers "what can I click?" — interactive elements, in the
// viewport, because you cannot click what you cannot see. This answers a
// different question: "what can I look at?" — charts, figures, tables, media,
// cards, landmarks — and it indexes the WHOLE DOCUMENT, because you can very
// much screenshot something below the fold. You just scroll to it first.
//
// Two registries, deliberately. Merging them would pollute the action list with
// things the model cannot click (a <figure>) and blow the 200-element cap that
// is already tight on real pages. They are kept apart at the naming level too:
// the action registry addresses `[3]`, this one addresses `[r3]`. Bare integers
// in both would let the model aim a click at a chart, which fails opaquely.

/** What kind of thing a region is — drives dedupe priority and the model's reading. */
export type RegionKind = 'figure' | 'table' | 'media' | 'code' | 'landmark' | 'card'

/** One thing on the page the agent can point a camera at, addressed by `[r{index}]`. */
export interface VisualRegion {
  index: number
  /**
   * The candidate id this region was stamped with during the raw sweep. Dedupe
   * renumbers the survivors, so this is the only way back to the DOM stamp that
   * has to be rewritten to the final `[rN]` address. Never shown to the model.
   */
  sourceId: number
  tag: string
  role?: string
  /** figcaption | caption | contained heading | aria-label | alt | leading text. */
  name: string
  kind: RegionKind
  /** Document-space rect in CSS px (NOT viewport — regions may be below the fold). */
  rect: { x: number; y: number; width: number; height: number }
  /** True when the region is not currently on screen (we scroll to it to shoot it). */
  belowFold: boolean
}

/** A full visual read of the page: the region registry plus its compact text form. */
export interface RegionSnapshot {
  url: string
  title: string
  origin: string
  dpr: number
  regions: VisualRegion[]
  text: string
  truncated: boolean
}

/** A candidate straight out of the page, before dedupe/ranking. */
export interface RawRegion {
  id: number
  /** Nearest ancestor that is also a candidate, or -1. Drives nested dedupe. */
  parentId: number
  tag: string
  role?: string
  name: string
  kind: RegionKind
  rect: { x: number; y: number; width: number; height: number }
  area: number
  belowFold: boolean
}

const ATTR = 'data-agent-region'
const MAX_REGIONS = 60

/**
 * Tags that read as a designed component rather than an arbitrary box. Shared
 * with capture.ts's hover-snapping region picker (which is passed this source
 * string as an argument, since an injected function cannot close over an import)
 * so the agent and the human picker agree on what a "component" is.
 *
 * Match against an UPPERCASED tagName. This matters: SVG elements are XML-cased,
 * so `svg.tagName` is the string `'svg'`, not `'SVG'` — comparing the raw tagName
 * against 'SVG' silently never matches, and every inline-SVG chart on the web
 * becomes invisible to the index.
 */
export const SEMANTIC_TAG_SOURCE =
  '^(FIGURE|TABLE|IMG|SVG|CANVAS|VIDEO|PRE|BLOCKQUOTE|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|FORM|DIALOG|IFRAME|UL|OL)$'

/**
 * Two regions whose boxes are within this factor of each other are "the same
 * thing" — a wrapper hugging its content. Only the higher-priority one survives.
 */
const DEDUPE_RATIO = 1.3

/** Higher wins when two stacked regions describe the same box. */
const KIND_PRIORITY: Record<RegionKind, number> = {
  figure: 5, // a <figure> beats the <img> inside it: it carries the caption too
  table: 5,
  media: 4,
  code: 4,
  landmark: 3,
  card: 1, // a styled <div> is the weakest claim to being a component
}

/**
 * Dedupe nested near-duplicate boxes, cap, and assign the `[rN]` addresses.
 *
 * Real pages wrap everything: a `<div class="card">` around a `<figure>` around
 * an `<img>`, all three within a few pixels of the same box. Offering the model
 * three addresses for one chart wastes its attention and invites it to shoot the
 * wrong one. So when a parent and child describe substantially the same box, the
 * more semantic of the two survives.
 */
export function rankRegions(raw: RawRegion[], max: number = MAX_REGIONS): VisualRegion[] {
  const byId = new Map(raw.map((r) => [r.id, r]))
  const dropped = new Set<number>()

  for (const child of raw) {
    if (child.parentId < 0) continue
    const parent = byId.get(child.parentId)
    if (!parent) continue
    // Not the same box — a genuinely larger container. Both are useful.
    if (parent.area >= DEDUPE_RATIO * child.area) continue
    const pp = KIND_PRIORITY[parent.kind]
    const cp = KIND_PRIORITY[child.kind]
    // Equal priority (section-in-section): keep the child, the tighter crop.
    dropped.add(pp > cp ? child.id : parent.id)
  }

  return raw
    .filter((r) => !dropped.has(r.id))
    .slice(0, max)
    .map((r, index) => ({
      index,
      sourceId: r.id,
      tag: r.tag,
      role: r.role,
      name: r.name,
      kind: r.kind,
      rect: r.rect,
      belowFold: r.belowFold,
    }))
}

/** The compact text form the model reads. Mirrors domIndex's serializeRegistry. */
export function serializeRegions(regions: VisualRegion[]): string {
  if (regions.length === 0) return '(no visual regions found on this page)'
  return regions
    .map((r) => {
      const w = Math.round(r.rect.width)
      const h = Math.round(r.rect.height)
      const bits = [
        r.name ? `"${r.name}"` : '',
        `${w}x${h}`,
        r.belowFold ? '(below fold)' : '',
      ].filter(Boolean)
      return `[r${r.index}]<${r.tag}${r.role ? ` role=${r.role}` : ''}> ${bits.join(' ')}`.trimEnd()
    })
    .join('\n')
}

/** Inject the region indexer; returns the registry + its text form. */
export async function snapshotRegions(tabId: number): Promise<RegionSnapshot> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: buildRegionIndex,
    args: [ATTR, MAX_REGIONS * 4, SEMANTIC_TAG_SOURCE],
  })
  const raw = res?.result
  if (!raw) throw new Error('Could not read the page.')
  const regions = rankRegions(raw.regions as RawRegion[], MAX_REGIONS)
  // Re-stamp: the injection stamped every CANDIDATE, but only the survivors have
  // an [rN] address, and the stamp is how a later injection re-finds the target.
  // Their ids must be rewritten to the post-dedupe indices or [r2] would resolve
  // to whatever candidate happened to be second in the raw sweep.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: restampRegions,
    args: [ATTR, regions.map((r): [number, number] => [r.sourceId, r.index])],
  })
  const truncated = raw.truncated || (raw.regions as RawRegion[]).length > MAX_REGIONS
  return {
    url: raw.url,
    title: raw.title,
    origin: raw.origin,
    dpr: raw.dpr,
    regions,
    text: serializeRegions(regions) + (truncated ? '\n[region list truncated]' : ''),
    truncated,
  }
}

/** Remove all region stamps from the page. */
export async function clearRegions(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: clearRegionIndex, args: [ATTR] })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Injected into the page. Fully self-contained — serialized by executeScript,
// runs in the page's isolated world, shares no JS state with any other
// injection. Everything it needs arrives as args; anything that must outlive it
// is written to the DOM (the `data-agent-region` stamp).
// ---------------------------------------------------------------------------

function buildRegionIndex(attr: string, maxCandidates: number, semanticSource: string) {
  const SEMANTIC = new RegExp(semanticSource)
  const doc = document.documentElement
  const scrollY = window.scrollY
  const vh = window.innerHeight
  const docArea = Math.max(1, doc.scrollWidth * doc.scrollHeight)

  // Below these it is an icon or a rule, not something worth a photograph.
  const MIN_W = 60
  const MIN_H = 40
  // At/above this it is the page, not a region on it — use target:"fullpage".
  const MAX_AREA_RATIO = 0.95

  const kindOf = (el: Element): RegionKind | null => {
    // Uppercase, always: SVG elements are XML-cased, so `svg.tagName` is 'svg'.
    // Comparing the raw tagName against 'SVG' matches nothing, and inline-SVG
    // charts — a big share of what is worth photographing — vanish from the index.
    const tag = el.tagName.toUpperCase()
    const role = el.getAttribute('role') || ''
    if (tag === 'FIGURE' || role === 'figure') return 'figure'
    if (tag === 'TABLE' || role === 'table') return 'table'
    if (tag === 'IMG' || tag === 'SVG' || tag === 'CANVAS' || tag === 'VIDEO' || role === 'img')
      return 'media'
    if (tag === 'PRE' || tag === 'BLOCKQUOTE') return 'code'
    if (
      tag === 'SECTION' ||
      tag === 'ARTICLE' ||
      tag === 'MAIN' ||
      tag === 'HEADER' ||
      tag === 'FOOTER' ||
      tag === 'NAV' ||
      tag === 'ASIDE' ||
      tag === 'FORM' ||
      tag === 'DIALOG' ||
      tag === 'IFRAME' ||
      role === 'region' ||
      role === 'tabpanel'
    )
      return 'landmark'
    // Card heuristic: a plain box only counts as a component if it is visually
    // *presented* as one — rounded, shadowed, or bordered — and holds content.
    if (tag === 'DIV' || tag === 'LI') {
      const s = getComputedStyle(el)
      const styled =
        (s.borderRadius !== '0px' && s.borderRadius !== '') ||
        (s.boxShadow !== 'none' && s.boxShadow !== '') ||
        parseFloat(s.borderTopWidth || '0') > 0
      const substantial = el.childElementCount > 0 || (el.textContent || '').trim().length > 10
      if (styled && substantial) return 'card'
    }
    return null
  }

  const nameOf = (el: Element): string => {
    const cap = el.querySelector('figcaption, caption')
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6')
    const text =
      (cap as HTMLElement | null)?.innerText ||
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      (heading as HTMLElement | null)?.innerText ||
      el.getAttribute('title') ||
      (el as HTMLElement).innerText ||
      ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  const isRendered = (el: Element): boolean => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    return true
  }

  document.querySelectorAll('[' + attr + ']').forEach((n) => n.removeAttribute(attr))

  // Type annotations are erased before this function is serialized into the page,
  // so naming a module type here costs nothing at runtime (same as domIndex).
  const out: RawRegion[] = []
  // Maps an element to its index in `out`, so a child can name its nearest
  // indexed ancestor without a second tree walk.
  const idOf = new Map<Element, number>()
  const all = Array.from(document.querySelectorAll('*'))
  let truncated = false

  for (const el of all) {
    if (out.length >= maxCandidates) {
      truncated = true
      break
    }
    const kind = kindOf(el)
    if (!kind) continue
    if (!isRendered(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < MIN_W || r.height < MIN_H) continue
    const area = r.width * r.height
    // A wrapper spanning the whole document is the page, not a region on it.
    if (area > docArea * MAX_AREA_RATIO) continue
    // A styled <div> claiming most of the page is a layout shell, not a card.
    if (!SEMANTIC.test(el.tagName.toUpperCase()) && kind === 'card' && area > docArea * 0.6) continue

    // Nearest already-indexed ancestor. Walking up from here is cheap because
    // ancestors are always visited before descendants in document order.
    let parentId = -1
    let p: Element | null = el.parentElement
    while (p) {
      const found = idOf.get(p)
      if (found !== undefined) {
        parentId = found
        break
      }
      p = p.parentElement
    }

    const id = out.length
    idOf.set(el, id)
    el.setAttribute(attr, String(id))
    out.push({
      id,
      parentId,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      name: nameOf(el),
      kind,
      rect: { x: r.left + window.scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      area,
      belowFold: r.top > vh || r.bottom < 0,
    })
  }

  return {
    url: location.href,
    title: document.title,
    origin: location.origin,
    dpr: window.devicePixelRatio || 1,
    regions: out,
    truncated,
  }
}

/**
 * Rewrite the candidate stamps to the final `[rN]` addresses, dropping the
 * stamps of candidates that lost dedupe. After this the DOM carries exactly the
 * addresses the model was shown, which is what makes `[r2]` resolvable later.
 */
function restampRegions(attr: string, pairs: Array<[number, number]>): void {
  const keep = new Map(pairs)
  document.querySelectorAll('[' + attr + ']').forEach((el) => {
    const old = Number(el.getAttribute(attr))
    const next = keep.get(old)
    if (next === undefined) el.removeAttribute(attr)
    else el.setAttribute(attr, String(next))
  })
}

function clearRegionIndex(attr: string): void {
  document.querySelectorAll('[' + attr + ']').forEach((n) => n.removeAttribute(attr))
}
