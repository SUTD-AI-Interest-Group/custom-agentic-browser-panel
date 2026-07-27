import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * The engineering log and the privacy policy are authored elsewhere — the
 * GitHub wiki and the repo's PRIVACY.md — and vendored into src/content by
 * scripts/sync-content.mjs. This module is the only place that knows how that
 * Markdown becomes a page.
 *
 * Everything is `eager` so the whole log ships in the bundle: it is ~130 KB of
 * text, there is no server to fetch from on GitHub Pages, and an article that
 * renders instantly beats one that flashes a spinner.
 */

const wikiFiles = import.meta.glob('../content/wiki/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// Globbed rather than dynamically imported so the module stays synchronous —
// a top-level await here would make every importer async.
const privacyRaw = (
  import.meta.glob('../content/privacy.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['../content/privacy.md']

export interface Article {
  /** URL slug — the wiki's own filename, which is also its wiki-link target. */
  slug: string
  title: string
  /** First substantive paragraph, flattened to plain text for the index card. */
  excerpt: string
  body: string
  /** Rough read time; derived, never invented. */
  minutes: number
}

function fileToSlug(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '')
}

/** Strip inline Markdown so an excerpt reads as prose, not source. */
function flatten(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parse(slug: string, raw: string): Article {
  const lines = raw.split('\n')
  const h1 = lines.find((l) => l.startsWith('# '))
  const title = h1 ? h1.replace(/^#\s+/, '').trim() : slug.replace(/-/g, ' ')

  // First non-empty, non-heading, non-table, non-rule line after the title.
  const start = h1 ? lines.indexOf(h1) + 1 : 0
  let excerpt = ''
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('---')) continue
    const block: string[] = []
    for (let j = i; j < lines.length && lines[j].trim(); j++) block.push(lines[j])
    excerpt = flatten(block.join(' '))
    break
  }
  if (excerpt.length > 240) excerpt = excerpt.slice(0, 237).trimEnd() + '…'

  const words = raw.split(/\s+/).length
  return { slug, title, excerpt, body: raw, minutes: Math.max(1, Math.round(words / 220)) }
}

const bySlug = new Map<string, Article>()
for (const [path, raw] of Object.entries(wikiFiles)) {
  const slug = fileToSlug(path)
  if (slug === '_Sidebar') continue
  bySlug.set(slug, parse(slug, raw))
}

export interface Section {
  heading: string
  articles: Article[]
}

/**
 * The wiki's own `_Sidebar.md` is the ordering. Reading it rather than
 * hard-coding a list means the site follows the author's grouping, and a page
 * added to the wiki lands in the right section on the next sync without a code
 * change. Anything the sidebar omits is collected under "More" so a new page
 * can never silently vanish from the index.
 */
function buildSections(): Section[] {
  const sidebar = wikiFiles['../content/wiki/_Sidebar.md'] ?? ''
  const sections: Section[] = []
  let current: Section | null = null
  const seen = new Set<string>()

  for (const line of sidebar.split('\n')) {
    const heading = line.match(/^\*\*(.+?)\*\*\s*$/)
    if (heading && !heading[1].includes('[')) {
      current = { heading: heading[1].trim(), articles: [] }
      sections.push(current)
      continue
    }
    const link = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)/)
    if (link && current) {
      const article = bySlug.get(link[2].trim())
      if (article && !seen.has(article.slug)) {
        current.articles.push(article)
        seen.add(article.slug)
      }
    }
  }

  const rest = [...bySlug.values()].filter((a) => !seen.has(a.slug) && a.slug !== 'Home')
  if (rest.length) sections.push({ heading: 'More', articles: rest })

  return sections.filter((s) => s.articles.length)
}

export const sections = buildSections()
export const articles = [...bySlug.values()]

export function getArticle(slug: string): Article | undefined {
  return bySlug.get(slug)
}

/** The wiki's Home page doubles as the log's introduction. */
export const logIntro = bySlug.get('Home')

export const privacy = parse('privacy', privacyRaw)

const renderer = new marked.Renderer()

/**
 * Wiki links are bare page names (`[Page Control](Page-Control)`), which would
 * 404 against this site. Rewrite the ones we host to in-app routes and leave
 * genuine external links alone (opened safely in a new tab).
 */
// Not an arrow function: marked binds `this` to the renderer, and `this.parser`
// is what turns the link's child tokens back into inline HTML.
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens)
  const t = title ? ` title="${title}"` : ''
  if (/^https?:\/\//.test(href)) {
    return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  const slug = href.replace(/^\.?\//, '').replace(/\.md$/, '')
  if (bySlug.has(slug)) return `<a href="#/log/${slug}"${t}>${text}</a>`
  if (slug.startsWith('#')) return `<a href="${slug}"${t}>${text}</a>`
  return `<a href="${href}"${t}>${text}</a>`
}

marked.use({ renderer, gfm: true, breaks: false })

/** Render trusted-but-sanitised Markdown. Sanitised anyway: defence in depth. */
export function render(md: string): string {
  const html = marked.parse(md, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] })
}

/** Drop the leading `# Title` — the page renders its own header. */
export function bodyWithoutTitle(md: string): string {
  return md.replace(/^#\s+.+\n/, '')
}
