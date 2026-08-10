import type { ControlJournalEntry } from '../tools/pageControlJournal'

// What a just-ended page-control session did, and what can be taken back.
//
// The presence overlay lets you watch the agent work, which is excellent live
// and useless five minutes later. This is the record that survives the turn.
//
// It states what CANNOT be undone as plainly as what can. A user who watched a
// form get filled and submitted will reasonably expect "undo" to cover all of
// it; discovering the limit by clicking is worse than being told.

function Row({ entry }: { entry: ControlJournalEntry }) {
  return (
    <li className={`cj-row ${entry.undoable ? '' : 'permanent'}`}>
      <span className="cj-summary">{entry.summary}</span>
      {entry.redactedValue !== undefined && (
        <span className="cj-value" title={entry.sensitive ? 'Hidden because this was a password or payment field' : undefined}>
          {entry.redactedValue}
        </span>
      )}
    </li>
  )
}

export default function ControlJournalCard({
  entries,
  revertableCount,
  onUndoLast,
  onUndoAll,
  onDismiss,
}: {
  entries: ControlJournalEntry[]
  /** How many entries are still safely revertable *right now* (page unchanged). */
  revertableCount: number
  onUndoLast: () => void
  onUndoAll: () => void
  onDismiss: () => void
}) {
  const permanent = entries.length - revertableCount
  return (
    <div className="control-journal-card">
      <div className="cj-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M2 7h10M2 3.5h10M2 10.5h6"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        <span>What Lychee changed on the page</span>
      </div>
      <ol className="cj-rows">
        {entries.map((e, i) => (
          <Row key={`${e.at}-${i}`} entry={e} />
        ))}
      </ol>
      {permanent > 0 && (
        <div className="cj-note">
          {permanent} of these can't be undone — submitted forms, navigations, and password or
          payment fields are permanent.
        </div>
      )}
      <div className="cj-actions">
        <button className="btn ghost small" disabled={revertableCount === 0} onClick={onUndoLast}>
          Undo last
        </button>
        <button className="btn ghost small" disabled={revertableCount === 0} onClick={onUndoAll}>
          Undo all {revertableCount > 0 ? `(${revertableCount})` : ''}
        </button>
        <button className="btn ghost small cj-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
