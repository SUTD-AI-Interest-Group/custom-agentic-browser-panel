// Sanitizer for MCP "html"-kind content (McpContentCard.tsx). This text is an
// MCP tool's raw returned HTML (src/mcp/content.ts passes it through mostly
// verbatim) rendered via dangerouslySetInnerHTML DIRECTLY into the side
// panel's own live DOM — unlike CreateArtifact's HTML, which is isolated in
// a manifest-sandboxed iframe under a default-src 'none' CSP (see
// ArtifactCard.tsx), this content has no sandbox and no CSP at all beyond
// MV3's script-src/object-src default for extension_pages. The ONLY thing
// standing between an MCP server's returned markup and the extension's own
// network reachability is this sanitizer.
//
// POLICY: an explicit ALLOWLIST of tags and attributes, not DOMPurify's
// (much larger) default minus a denylist of known-bad additions. A denylist
// only closes the holes someone thought to name — that is exactly how this
// file shipped vulnerable last wave: `<img src>`/`<video src>`/`<svg><image
// href>` were named and closed, but `srcset` and inline `style="url(...)"`
// were not, and both fire an automatic network request the instant the node
// is parsed, no click required. An allowlist instead names every tag and
// attribute this "static formatted document" card genuinely needs; anything
// not named — including a fetch vector nobody has thought of yet, or a tag
// DOMPurify's own defaults change to permit in some future version — is
// excluded by construction rather than by someone's foresight.
//
// Confirmed empirically (this exact dompurify version, jsdom, before this
// policy existed) that DOMPurify's bare defaults still pass through
// completely unmodified: `<img srcset>` / `<source srcset>` (a
// comma-separated list of URLs, not covered by any single-URL attribute
// check), inline `style="background:url(...)"` (DOMPurify only parses CSS
// inside a `<style>` *element*, never an attribute value), `<video>
// <track src>`, and `<input type="image" src>` (an image-button that fetches
// its `src` exactly like `<img>`). `<style>`, `<link>`, `<meta>`, `<base>`,
// `<object>`, `<embed>` elements, and `<svg>`'s own `<image>`/`<use>` were
// already stripped by DOMPurify's defaults, but are named in this file's
// ALLOWED_TAGS omission anyway — an allowlist doesn't need to "trust" that,
// it simply never re-admits them.
//
// `<math>` is excluded for the same reason `<svg>` is: both are foreign-
// content namespaces whose historical mutation-XSS bypasses (parser/
// namespace confusion between the sanitizer's DOM walk and the browser's own
// re-parse of the serialized string) this render path has no legitimate need
// to risk — a "static formatted document" has no use for embedded vector
// graphics or MathML.
//
// The `style` ATTRIBUTE specifically: the root cause is not "a couple of
// missing property names" (`background`, `list-style-image`), it's that NO
// finite property denylist can ever be complete — `@import`,
// `-webkit-mask-image`, `content: url(...)`, `cursor: url(...)`,
// `border-image-source`, and the SVG resource references `filter: url(#…)` /
// `clip-path: url(#…)` all carry the identical auto-fetch shape, and CSS's
// own obfuscation surface (comments between property and value, escapes,
// vendor prefixes not yet invented) makes "detect a url()/@import inside an
// attribute string" a losing arms race. The fix is not a bigger denylist —
// ALLOWED_ATTR below omits `style` ENTIRELY, so which CSS property or
// function carries the payload is irrelevant; the whole attribute is gone
// before any of it would be parsed. This also means the fix holds regardless
// of `public/manifest.json`'s CSP for extension_pages (which does not
// currently restrict img-src/connect-src/media-src) — this sanitizer was
// never written to depend on a CSP backstop, and still doesn't.

import createDOMPurify from 'dompurify'

// A private sanitizer instance — NOT the module's shared default export —
// so this file's stricter hook never leaks into any other DOMPurify.sanitize
// call in the app (e.g. Markdown.tsx's citation/math rendering). Calling the
// factory again with the same global window yields an independent instance
// with its own hook chain (see mcpHtmlSanitize.test.ts's regression guard).
const purifier = createDOMPurify(window)

/** Every element this card can render, and why each is safe:
 *  - text/typography (`h1`-`h6`, `p`, `br`, `hr`, `strong`, `b`, `em`, `i`,
 *    `u`, `s`, `del`, `ins`, `mark`, `small`, `sub`, `sup`, `code`, `pre`,
 *    `kbd`, `samp`, `var`, `abbr`, `cite`, `q`, `dfn`, `time`, `bdi`, `bdo`,
 *    `wbr`) and structure (`ul`/`ol`/`li`/`dl`/`dt`/`dd`, `div`, `span`,
 *    `blockquote`, `section`/`article`/`header`/`footer`/`nav`/`aside`/
 *    `address`, `details`/`summary`) — none of these can carry a URL-bearing
 *    attribute at all, so none can initiate a fetch no matter what
 *    ALLOWED_ATTR permits.
 *  - `table`/`thead`/`tbody`/`tfoot`/`tr`/`td`/`th`/`caption`/`colgroup`/
 *    `col` — same: the only historically fetch-capable table attribute
 *    (`background`) is simply not in ALLOWED_ATTR below.
 *  - `a` — the one deliberate click-through exception: it only navigates on
 *    a user click (not an auto-fetch), and DOMPurify's own scheme allowlist
 *    additionally strips a `javascript:`/`vbscript:`/non-data `data:` href
 *    regardless of this file's config (see the "a href" cases in
 *    mcpHtmlSanitize.test.ts). `target`/`rel` are deliberately NOT in
 *    ALLOWED_ATTR — this DOMPurify config does not auto-add `rel="noopener"`
 *    for a `target="_blank"` it's told to keep, so admitting `target` here
 *    would open a reverse-tabnabbing path; omitting it instead means every
 *    link navigates same-context, which sidesteps the question entirely.
 *  - `img`, `figure`, `figcaption` — an inline image and its caption.
 *  - `video`, `audio`, `source` — inline media. `src`/`poster` are
 *    hook-restricted to `data:` below; `srcset` is deliberately excluded
 *    (see ALLOWED_ATTR comment).
 *  Deliberately excluded (each one an auto-fetch vector, empirically
 *  confirmed against this exact DOMPurify config): `style`, `link`, `meta`,
 *  `base`, `object`, `embed`, `track`, `input`, `svg`, `math`, `iframe`,
 *  `form`, `script`, `template`, and everything else not named above. */
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time', 'bdi', 'bdo', 'wbr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a',
  'img', 'figure', 'figcaption',
  'video', 'audio', 'source',
  'div', 'span', 'blockquote',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'address',
  'details', 'summary',
]

/** Every attribute this card can render, and why each is safe:
 *  - `href` — click-through only (see the `a` entry above); DOMPurify's own
 *    scheme check guards it independently of this file.
 *  - `src`, `poster` — hook-restricted to `data:` below, so the only network
 *    request an inline image/video/audio can cause is none (the bytes are
 *    already in the string).
 *  - `alt`, `title` — plain text metadata, never a URL.
 *  - `width`, `height` — numeric layout hints, never a URL.
 *  - `controls` — a boolean that toggles the native media UI, never a URL.
 *  - `colspan`, `rowspan` — numeric table layout, never a URL.
 *  Deliberately excluded, each one an auto-fetch vector this card has no
 *  genuine need for: `srcset`/`imagesrcset` (a comma-separated list of URLs
 *  — parsing that grammar just to allowlist `data:` entries inside it is
 *  strictly more attack surface than a card with no responsive-image use
 *  case needs to accept), `style` in its ENTIRETY, not just its known-bad
 *  property names (`background`, `@import`, `-webkit-mask-image`,
 *  `content`/`cursor`/`border-image-source: url(...)`, the SVG resource
 *  references `filter`/`clip-path: url(#...)`, and CSS's own obfuscation
 *  surface — comments between property and value, escapes, a vendor prefix
 *  not yet invented — all carry the identical shape; no finite property
 *  denylist can ever be complete, so the fix is root-cause removal of the
 *  whole attribute, not a longer list of names to block), `background` as an
 *  HTML attribute (the same class of vector `style` is, superseded by it),
 *  `ping` (a click still fires a hidden POST beacon the
 *  user never consented to), `formaction`/`action`/`method` (form-only;
 *  `form` isn't in ALLOWED_TAGS), `data`/`codebase` (object/applet-only;
 *  neither is in ALLOWED_TAGS), `target`/`rel` (see the `a` entry above),
 *  `class`/`id` (no rendering need — this card supplies its own wrapper
 *  class in McpContentCard.tsx; admitting arbitrary `id`s also risks
 *  collisions with the panel's own DOM). */
const ALLOWED_ATTR = ['href', 'src', 'poster', 'alt', 'title', 'width', 'height', 'controls', 'colspan', 'rowspan']

/** Attributes whose *mere presence* triggers an automatic fetch — as opposed
 *  to `href` (see ALLOWED_ATTR above), which only navigates on a user click
 *  and is guarded separately. Restricting these to `data:` keeps genuinely
 *  inline media (an MCP tool embedding a base64 image/clip in its own
 *  response) while cutting off every remaining path to an attacker-
 *  controlled host — including one this card's ALLOWED_TAGS/ALLOWED_ATTR
 *  didn't anticipate, since this hook runs on every attribute DOMPurify is
 *  about to keep, not just these two names' worth of foresight. */
const AUTO_FETCH_URL_ATTRS = new Set(['src', 'poster'])

purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (!AUTO_FETCH_URL_ATTRS.has(data.attrName)) return
  // Anchored at the start (not `.includes('data:')`) so a value like
  // `"javascript:alert(1)//data:"` — "data:" appears, just not as the
  // scheme — is correctly rejected rather than waved through.
  if (data.attrValue && !/^data:/i.test(data.attrValue)) data.keepAttr = false
})

export function sanitizeMcpHtml(html: string): string {
  return purifier.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
}
