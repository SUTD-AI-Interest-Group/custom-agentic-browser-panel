// Download an image the user clicked in a message carousel (see ImageCarousel).
//
// Cross-origin images can't be saved by a plain <a download>, so we use
// chrome.downloads with saveAs:true to pop the OS Save File dialog. downloads is
// an optional permission (see permissions.ts); we request it on first use from
// within the click gesture. Requesting an already-granted permission resolves
// instantly with no prompt, so it's safe to call on every click. If the user
// declines, we fall back to opening the image in a new tab so they can still
// save it manually.

import { requestCapabilities } from './permissions'

/** Best-effort download filename from a URL's last path segment. */
function filenameFor(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    // Strip characters Chrome rejects in a suggested download filename.
    const clean = decodeURIComponent(base).replace(/[\\/:*?"<>|]/g, '_').trim()
    return clean || 'image'
  } catch {
    return 'image'
  }
}

/**
 * Download a single image URL via the system Save As dialog. Must be called
 * synchronously from a user gesture (a click) so the permission request is
 * allowed. Resolves once the download has started (or the fallback tab opened).
 */
export async function downloadImage(url: string): Promise<void> {
  const granted = await requestCapabilities(['downloads'])
  if (!granted) {
    await chrome.tabs.create({ url })
    return
  }
  await chrome.downloads.download({ url, filename: filenameFor(url), saveAs: true })
}
