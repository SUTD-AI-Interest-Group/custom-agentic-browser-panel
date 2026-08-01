// Shared "is this URL safe for the panel to auto-render with no user click
// and no approval card" guard. Two render surfaces need exactly this
// decision: linkPreview.ts's extracted og:image (a page can declare one
// pointing at an internal target) and blocks.ts's model-authored image
// blocks (a page can prompt-inject the model into emitting image URLs
// pointing at an internal target) — both turn straight into `<img src>` the
// instant the content renders, with no requestApproval gate in between. Any
// future render surface with the same "auto-fetch, no consent" shape should
// route through this rather than re-deriving its own check.

import { isFetchableUrl } from './webFetch'

/** True only when `raw` is safe to auto-render as an `<img src>` (or any
 *  other automatic, no-approval fetch) in the privileged panel. Delegates the
 *  private/loopback/encoding decision to the shared, hardened `isFetchableUrl`
 *  guard (also used by the research browser's fetch/navigate/click paths),
 *  then adds the extra conservative exclusions an unattended, no-consent
 *  render should hold to that the general-purpose guard doesn't need: the
 *  reserved `*.localhost`/`.internal` conventions and the CGNAT range
 *  (100.64.0.0/10, RFC 6598). */
export function isSafeRenderUrl(raw: string): boolean {
  if (!isFetchableUrl(raw).ok) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  return true
}
