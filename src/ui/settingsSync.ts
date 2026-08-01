// Cross-window Settings sync (App.tsx's chrome.storage.onChanged listener).
//
// Chrome side panels are per-window: two windows open at once each run their
// own App instance with its own in-memory Settings, loaded once at mount and
// otherwise updated only by this window's own edits. Without a listener on
// the stored 'settings' key, window B saving a new provider (or any field) is
// silently overwritten the moment window A next persists any unrelated
// change — updateSettings does a plain read-modify-write of whatever this
// window last saw.
//
// Comparing serialized snapshots (rather than tagging "did I just write
// this") is deliberate: chrome.storage.onChanged fires in the writer's own
// context too, so this window's own save always re-triggers the listener.
// Comparing the freshly-reloaded value against what this window's `settings`
// state already holds makes that reflected event a harmless no-op — the
// JSON is identical, so there is nothing to adopt — while a genuinely
// different value (a concurrent window's save) is adopted immediately.
export function shouldAdoptExternalSettings(currentJson: string | null, incomingJson: string): boolean {
  if (currentJson === null) return true
  return incomingJson !== currentJson
}
