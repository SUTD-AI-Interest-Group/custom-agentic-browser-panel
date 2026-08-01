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
// DOMPurify's own defaults already strip <script>, <style>, <link>, <base>,
// <meta>, <object>, and <embed>, and neutralize javascript:/on* handlers —
// but empirically (verified against this exact config before this file
// existed) still pass through <img src>, <video src>, <audio src>, and
// <svg><image href> completely unmodified, plus the legacy <… background>
// attribute. Every one of those fires an automatic network request the
// instant the card renders, with no click required — a silent
// exfiltration/beacon channel from a tool result, not something the user's
// tool-call approval consented to. The fix mirrors the same tradeoff
// CreateArtifact's sandbox CSP already makes: images are fine, but only as
// inline data: URIs — never a remote host. A normal http(s) <a href> is left
// alone; a link a user must consciously click is the same trust level as
// any other link this app renders (see LinkCard.tsx), not an auto-fetch.

import createDOMPurify from 'dompurify'

// A private sanitizer instance — NOT the module's shared default export —
// so this file's stricter hook never leaks into any other DOMPurify.sanitize
// call in the app (e.g. Markdown.tsx's citation/math rendering). Calling the
// factory again with the same global window yields an independent instance
// with its own hook chain (see mcpHtmlSanitize.test.ts's regression guard).
const purifier = createDOMPurify(window)

/** Tags whose *mere presence* triggers an automatic fetch — as opposed to
 *  <a>/<area>, which only navigate on a user click. */
const AUTO_FETCH_URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'background', 'poster'])
const CLICK_THROUGH_TAGS = new Set(['a', 'area'])

purifier.addHook('uponSanitizeAttribute', (node, data) => {
  if (!AUTO_FETCH_URL_ATTRS.has(data.attrName)) return
  const tag = node.tagName?.toLowerCase()
  if (tag && CLICK_THROUGH_TAGS.has(tag)) return
  if (data.attrValue && !/^data:/i.test(data.attrValue)) data.keepAttr = false
})

export function sanitizeMcpHtml(html: string): string {
  // <svg> is forbidden outright rather than patched attribute-by-attribute:
  // it has its own large surface of auto-fetch vectors (<use href>,
  // <feImage>, pattern fills, …) beyond the plain <image> case, and this
  // "static formatted document" render path has no real need for embedded
  // vector graphics — CreateArtifact is the documented path for genuine
  // interactive/graphical content (see McpContentCard.tsx's own comment).
  return purifier.sanitize(html, { FORBID_TAGS: ['iframe', 'form', 'svg'] })
}
