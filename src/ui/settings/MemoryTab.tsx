import type { Settings } from '../../data/settings'
import MemoryView from '../Memory'

/** Memory tab: the memory manager + dreaming controls, lifted out of the old collapsed section. */
export default function MemoryTab({
  draft,
  commit,
}: {
  draft: Settings
  commit: (next: Settings) => void
}) {
  return (
    <div className="settings-tabpane">
      <MemoryView draft={draft} commit={commit} />
    </div>
  )
}
