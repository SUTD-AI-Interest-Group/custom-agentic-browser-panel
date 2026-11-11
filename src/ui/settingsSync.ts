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

/** Keep external edits to untouched fields while preserving a local text draft.
 * Provider rows merge by id so editing one does not overwrite another. */
export function mergeSettingsDraft<T>(base: T, draft: T, current: T): T {
  if (JSON.stringify(base) === JSON.stringify(draft)) return current
  if (Array.isArray(base) && Array.isArray(draft) && Array.isArray(current) &&
      [...base, ...draft, ...current].every(row => row && typeof row.id === 'string')) {
    const before = new Map(base.map(row => [row.id, row]))
    const edited = new Map(draft.map(row => [row.id, row]))
    const merged = current.filter(row => !before.has(row.id) || edited.has(row.id)).map(row =>
      edited.has(row.id) ? mergeSettingsDraft(before.get(row.id), edited.get(row.id), row) : row)
    for (const row of draft) if (!before.has(row.id) && !current.some(item => item.id === row.id)) merged.push(row)
    return merged as T
  }
  if (base && draft && current && typeof base === 'object' && typeof draft === 'object' && typeof current === 'object' &&
      !Array.isArray(base) && !Array.isArray(draft) && !Array.isArray(current)) {
    const result = { ...current } as Record<string, unknown>
    const old = base as Record<string, unknown>, next = draft as Record<string, unknown>
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (JSON.stringify(old[key]) === JSON.stringify(next[key])) continue
      if (!(key in next)) delete result[key]
      else result[key] = mergeSettingsDraft(old[key], next[key], result[key])
    }
    return result as T
  }
  return draft
}
