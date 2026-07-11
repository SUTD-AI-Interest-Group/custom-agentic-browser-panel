// Splits an assistant text part into ordered typed blocks so each renders with
// a dedicated component: runs of image URLs → a carousel, standalone links → link
// cards, standalone JSON → a tree, everything else → markdown. Generalizes the
// former splitImageBlocks. Detection is line-based (with fenced-code awareness)
// and conservative: only whole-line links/images and whole fenced blocks are
// pulled out, so anything inline in prose stays in the markdown block.

/** A link/image reference on its own line. */
export interface LinkRef {
  url: string
  text: string
}

/** An ordered piece of a rendered assistant text part. */
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'images'; urls: string[] }
  | { type: 'links'; links: LinkRef[]; raw: string }
  | { type: 'json'; value: unknown; raw: string }

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
const MD_LINK = /^!?\[([^\]]*)\]\(\s*(\S+?)\s*(?:"[^"]*")?\)$/
const ANGLE = /^<(\S+)>$/
const FENCE = /^\s{0,3}(```|~~~)(.*)$/
/** Cap on JSON body size rendered as a tree; larger falls back to a code block. */
const JSON_MAX = 20000

function asUrl(token: string): URL | null {
  try {
    const u = new URL(token)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

function isImageUrl(u: URL): boolean {
  return IMAGE_EXT.test(u.pathname)
}

interface LineLink {
  url: string
  text: string
  isImage: boolean
}

/** If `line` is *only* a link/image (bare, autolinked, or markdown link),
 *  optionally led by a bullet, return it; else null. */
function extractLineLink(line: string): LineLink | null {
  let rest = line.trim()
  if (!rest) return null
  rest = rest.replace(BULLET, '').trim()
  if (!rest) return null

  const md = rest.match(MD_LINK)
  if (md) {
    const u = asUrl(md[2])
    if (!u) return null
    return { url: md[2], text: md[1] || md[2], isImage: rest.startsWith('!') || isImageUrl(u) }
  }
  const angle = rest.match(ANGLE)
  if (angle) {
    const u = asUrl(angle[1])
    return u ? { url: angle[1], text: angle[1], isImage: isImageUrl(u) } : null
  }
  if (/^\S+$/.test(rest)) {
    // Bare URL — trim trailing sentence punctuation from the href/text.
    const token = rest.replace(/[.,;:!?)]+$/, '')
    const u = asUrl(token)
    return u ? { url: token, text: token, isImage: isImageUrl(u) } : null
  }
  return null
}

/** Parse a fenced block body as JSON only when it is an object/array (and the
 *  info string is `json` or the body clearly looks like JSON). */
function tryJson(lang: string, body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed || trimmed.length > JSON_MAX) return undefined
  if (lang !== 'json' && !/^[[{]/.test(trimmed)) return undefined
  try {
    const v = JSON.parse(trimmed)
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

export function splitBlocks(text: string): Block[] {
  const out: Block[] = []
  let md: string[] = []
  let imgRun: { url: string; line: string }[] = []
  let linkRun: { ref: LinkRef; line: string }[] = []

  const flushMd = () => {
    if (md.length) {
      out.push({ type: 'markdown', text: md.join('\n') })
      md = []
    }
  }
  const flushImg = () => {
    if (imgRun.length >= 2) {
      flushMd()
      out.push({ type: 'images', urls: imgRun.map((r) => r.url) })
    } else {
      for (const r of imgRun) md.push(r.line)
    }
    imgRun = []
  }
  const flushLink = () => {
    if (linkRun.length >= 1) {
      flushMd()
      out.push({
        type: 'links',
        links: linkRun.map((r) => r.ref),
        raw: linkRun.map((r) => r.line).join('\n'),
      })
    }
    linkRun = []
  }
  const flushRuns = () => {
    flushImg()
    flushLink()
  }

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(FENCE)
    if (fence) {
      flushRuns()
      const marker = fence[1]
      const lang = fence[2].trim().toLowerCase()
      const body: string[] = []
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        if (lines[j].trim().startsWith(marker)) {
          closed = true
          break
        }
        body.push(lines[j])
      }
      const end = closed ? j + 1 : j
      const raw = lines.slice(i, end).join('\n')
      const value = tryJson(lang, body.join('\n'))
      if (value !== undefined) {
        flushMd()
        out.push({ type: 'json', value, raw })
      } else {
        md.push(raw)
      }
      i = end
      continue
    }

    const link = extractLineLink(line)
    if (link && link.isImage) {
      flushLink()
      imgRun.push({ url: link.url, line })
      i++
      continue
    }
    if (link) {
      flushImg()
      linkRun.push({ ref: { url: link.url, text: link.text }, line })
      i++
      continue
    }

    flushRuns()
    md.push(line)
    i++
  }
  flushRuns()
  flushMd()
  return out
}
