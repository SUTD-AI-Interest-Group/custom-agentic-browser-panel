// Splits an assistant text part into ordered segments so that runs of image
// URLs render as an interactive carousel (see ImageCarousel) instead of a plain
// markdown link list, while surrounding prose still renders as markdown.
//
// The agent emits image URLs as free-form markdown — e.g. the get-images skill
// prints a bulleted list of URLs. We detect them heuristically rather than via a
// structured format, so any reply that lists images benefits. Only a run of 2+
// *consecutive* image lines becomes a carousel, which keeps a lone image URL
// mentioned inside prose from hijacking the layout.

/** An ordered piece of a rendered assistant text part. */
export type ImageBlockSegment =
  | { type: 'markdown'; text: string }
  | { type: 'images'; urls: string[] }

/** A path ending in a known raster/vector image extension. */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i

/** A leading list marker: `- `, `* `, `+ `, `1. `, `2) `. */
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/

/** `[text](url)` or `![alt](url)`, optionally with a "title", and nothing else. */
const MD_LINK = /^!?\[[^\]]*\]\(\s*(\S+?)\s*(?:"[^"]*")?\)$/

/** An autolink `<url>`. */
const ANGLE = /^<(\S+)>$/

/** Whether `token` is an http(s) URL whose path ends in an image extension. */
function isImageUrl(token: string): boolean {
  let url: URL
  try {
    url = new URL(token)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // Test the pathname only, so query strings (?w=64) and fragments don't hide
  // the extension and non-image URLs with a "png" query param don't match.
  return IMAGE_EXT.test(url.pathname)
}

/**
 * If `line` is *only* an image URL (bare, autolinked, or a markdown link/image),
 * optionally led by a list bullet, return that URL. Otherwise null — so a prose
 * sentence that merely mentions an image URL is not treated as a gallery item.
 */
function extractImageUrl(line: string): string | null {
  let rest = line.trim()
  if (!rest) return null
  rest = rest.replace(BULLET, '').trim()
  if (!rest) return null

  const mdLink = rest.match(MD_LINK)
  if (mdLink) return isImageUrl(mdLink[1]) ? mdLink[1] : null

  const angle = rest.match(ANGLE)
  if (angle) return isImageUrl(angle[1]) ? angle[1] : null

  // A bare URL: the remainder must be a single token that is an image URL.
  if (/^\S+$/.test(rest)) return isImageUrl(rest) ? rest : null

  return null
}

/**
 * Break `text` into ordered markdown/images segments. Consecutive image-only
 * lines (2 or more) collapse into one `images` segment; everything else,
 * including a lone image line, stays markdown. Original ordering is preserved.
 */
export function splitImageBlocks(text: string): ImageBlockSegment[] {
  const segments: ImageBlockSegment[] = []
  let mdBuffer: string[] = []
  let run: { url: string; line: string }[] = []

  const flushMarkdown = () => {
    if (mdBuffer.length) {
      segments.push({ type: 'markdown', text: mdBuffer.join('\n') })
      mdBuffer = []
    }
  }

  const endRun = () => {
    if (run.length >= 2) {
      flushMarkdown()
      segments.push({ type: 'images', urls: run.map((r) => r.url) })
    } else {
      // A single image line isn't a gallery — fold it back into the markdown.
      for (const r of run) mdBuffer.push(r.line)
    }
    run = []
  }

  for (const line of text.split('\n')) {
    const url = extractImageUrl(line)
    if (url) {
      run.push({ url, line })
    } else {
      endRun()
      mdBuffer.push(line)
    }
  }
  endRun()
  flushMarkdown()

  return segments
}
