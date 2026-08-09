import type { DreamOutcome } from '../agent/dream'

/** One-line summary of a manual dream for the Memory tab's status line. */
export function describeOutcome(res: DreamOutcome): string {
  if (res.status === 'skipped') return res.reason
  // Handed to the offscreen host (the alarm's path); its real outcome is
  // recorded when the host reports back, so there are no counts to show yet.
  if (res.status === 'dispatched') return 'Dreaming in the background…'
  const parts: string[] = []
  if (res.added) parts.push(`${res.added} added`)
  if (res.updated) parts.push(`${res.updated} updated`)
  if (res.deleted) parts.push(`${res.deleted} forgotten`)
  const changes = parts.length > 0 ? parts.join(', ') : 'no changes'
  return `Dreamed over ${res.episodes} conversation${res.episodes === 1 ? '' : 's'} — ${changes}.`
}
