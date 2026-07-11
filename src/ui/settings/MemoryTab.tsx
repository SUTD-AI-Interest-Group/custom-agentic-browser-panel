import MemoryView from '../Memory'

/** Memory tab: the existing memory manager, lifted out of the old collapsed section. */
export default function MemoryTab() {
  return (
    <div className="settings-tabpane">
      <MemoryView />
    </div>
  )
}
