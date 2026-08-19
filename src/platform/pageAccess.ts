// Why a tab's contents are out of reach — and, for the one case the user can
// actually fix, what to tell them to click.
//
// Chrome refuses injection into a page for several unrelated reasons and
// reports them all as the same opaque string ("Cannot access contents of url
// ... Extension manifest must request permission to access this host"). That
// message is actively misleading for local files: nothing about the manifest is
// wrong, `<all_urls>` already covers `file://`, and the only thing missing is a
// per-extension switch that ONLY the user can flip. Verified in a real browser:
// with "Allow access to file URLs" on, `chrome.permissions.contains({origins:
// ['file:///*']})` is true and executeScript / captureVisibleTab / fetch all
// succeed against a file:// tab with no manifest change at all.
//
// The classifier below is pure so the policy is testable; `fileAccessGranted`
// is the one Chrome-coupled helper (same split as tabIndex.ts).

/** What is standing between us and this page's contents. */
export type PageAccessKind =
  /** Readable — inject away. */
  | 'ok'
  /** A local file, and the user has not granted file-scheme access. */
  | 'needs-file-access'
  /** chrome://, devtools://, another extension, data:/blob: — permanently closed. */
  | 'browser-internal'
  /** The Chrome Web Store, which blocks injection on every one of its hostnames. */
  | 'web-store'
  /** No address to judge (a tab still opening, or a malformed URL). */
  | 'no-url'

export interface PageAccess {
  kind: PageAccessKind
  /** One sentence for the user. Empty when `kind` is 'ok'. */
  reason: string
  /** True only when the user can lift this themselves, in chrome://extensions. */
  fixable: boolean
}

/**
 * The fix, in the user's words. Exported so the UI can render it beside a
 * button and the tools can hand the same sentence to the model — one wording,
 * one place to change it.
 */
export const FILE_ACCESS_HINT =
  'Lychee needs “Allow access to file URLs” turned on for local files. Open chrome://extensions, ' +
  'find Lychee, click Details, and switch it on — then reload the page.'

/**
 * Thrown when a page's contents are out of reach for a reason we can name.
 * Carries the classification so the UI can offer the fix (a button into
 * chrome://extensions) rather than making the user parse a sentence — the
 * whole point of distinguishing 'needs-file-access' from the dead ends.
 */
export class PageAccessError extends Error {
  readonly kind: PageAccessKind
  readonly fixable: boolean
  constructor(access: PageAccess) {
    super(access.reason)
    this.name = 'PageAccessError'
    this.kind = access.kind
    this.fixable = access.fixable
  }
}

/** Schemes no permission can ever unlock. */
const INTERNAL_SCHEMES = new Set([
  'chrome:', 'edge:', 'brave:', 'about:', 'devtools:', 'view-source:',
  'chrome-extension:', 'moz-extension:', 'chrome-search:', 'chrome-untrusted:',
  'data:', 'blob:', 'javascript:', 'filesystem:',
])

/** Chrome blocks injection into its own store, on any of its hostnames. */
const WEB_STORE = /^(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i

/**
 * Decide whether this URL's contents can be reached, and why not when they
 * can't. `fileAccess` is the user's "Allow access to file URLs" switch, read by
 * `fileAccessGranted()` — it is passed in rather than probed here so this stays
 * pure and so a caller reading twenty tabs pays for one probe, not twenty.
 */
export function classifyPageAccess(
  url: string | undefined | null,
  opts: { fileAccess: boolean },
): PageAccess {
  const ok: PageAccess = { kind: 'ok', reason: '', fixable: false }
  if (!url) return { kind: 'no-url', reason: 'This tab has no address yet.', fixable: false }

  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'no-url', reason: 'This tab has no address we can read.', fixable: false }
  }

  if (u.protocol === 'file:') {
    return opts.fileAccess
      ? ok
      : { kind: 'needs-file-access', reason: FILE_ACCESS_HINT, fixable: true }
  }
  if (INTERNAL_SCHEMES.has(u.protocol)) {
    return {
      kind: 'browser-internal',
      reason: 'This is a browser-internal page, which Chrome closes to every extension.',
      fixable: false,
    }
  }
  if (WEB_STORE.test(`${u.host}${u.pathname}`)) {
    return {
      kind: 'web-store',
      reason: 'Chrome blocks extensions from reading the Chrome Web Store.',
      fixable: false,
    }
  }
  return ok
}

// ---------------------------------------------------------------------------

/**
 * Whether the user has granted this extension access to `file://` URLs.
 *
 * Cached for the life of the context, which is safe rather than merely
 * convenient: flipping the switch in chrome://extensions RELOADS the extension
 * (confirmed against a real Chromium — the reload is what tears down the old
 * service worker), so a value cached here cannot outlive the state it read.
 *
 * Two-tier because the API surface differs by realm: `chrome.extension` exists
 * in the service worker and in extension pages, but the offscreen document
 * supports `runtime` only. Where it is missing we ask the permissions API the
 * same question, and if even that is unavailable we assume no access — the
 * conservative answer, since it produces an explanation rather than a raw
 * Chrome error.
 */
let fileAccessCache: Promise<boolean> | null = null

export function fileAccessGranted(): Promise<boolean> {
  fileAccessCache ??= probeFileAccess()
  return fileAccessCache
}

async function probeFileAccess(): Promise<boolean> {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.isAllowedFileSchemeAccess) {
      return await chrome.extension.isAllowedFileSchemeAccess()
    }
    if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
      return await chrome.permissions.contains({ origins: ['file:///*'] })
    }
  } catch {
    // Fall through: an unreachable probe is indistinguishable from a denial for
    // every purpose this value serves.
  }
  return false
}

/** Test seam — drops the cached probe so a later call re-reads it. */
export function resetFileAccessCache(): void {
  fileAccessCache = null
}
