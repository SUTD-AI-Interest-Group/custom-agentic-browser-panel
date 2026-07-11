// Chrome's built-in, on-device favicon cache — keeps visited URLs local rather
// than shipping them to a third-party favicon service. Needs the "favicon"
// manifest permission. Returns a chrome-extension:// URL that always resolves to
// *some* icon (the site's, or Chrome's generic globe when none is cached), so
// callers rarely need a broken-image fallback.
export function faviconUrl(pageUrl: string, size = 32): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'))
  u.searchParams.set('pageUrl', pageUrl)
  u.searchParams.set('size', String(size))
  return u.toString()
}
