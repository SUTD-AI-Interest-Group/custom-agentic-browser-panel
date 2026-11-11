/** One keyboard interaction for Settings and Library: arrows wrap, Home/End
 * jump, and only the selected tab occupies the document's Tab sequence. */
export function TabStrip<T extends string>({ id, label, tabs, value, onChange, className, tabClassName }: {
  id: string
  label: string
  tabs: ReadonlyArray<{ key: T; label: string }>
  value: T
  onChange: (value: T) => void
  className: string
  tabClassName: string
}) {
  return <div className={className} role="tablist" aria-label={label} onKeyDown={event => {
    const index = tabs.findIndex(tab => tab.key === value)
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    onChange(tabs[next].key)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }}>
    {tabs.map(tab => <button key={tab.key} id={`${id}-${tab.key}`} role="tab"
      aria-selected={value === tab.key} aria-controls={`${id}-panel`} tabIndex={value === tab.key ? 0 : -1}
      className={`${tabClassName} ${value === tab.key ? 'active' : ''}`} onClick={() => onChange(tab.key)}>
      {tab.label}
    </button>)}
  </div>
}
