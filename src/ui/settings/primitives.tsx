import { useState, type ReactNode } from 'react'

/**
 * A settings section: heading, optional one-line hint, optional right-aligned
 * action. Exists so panes stop hand-rolling `<h2>` + `<p className="hint">` —
 * that pattern is what let the prose grow unchecked, and a shared component is
 * the only thing that stops the de-cluttering from regrowing.
 *
 * A hint is one line. A section that needs a paragraph needs a Disclosure.
 */
export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-section-block">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

/**
 * A labelled dropdown. Exists because a bare `<select>` is the one control the
 * panel cannot style into line: its caret is drawn by the OS, so it renders as
 * native chrome amid a flat, tokenised UI. Here the native caret is suppressed
 * (see `.settings-tabpane select`) and the panel's own chevron drawn over it —
 * the same one Section/Disclosure use.
 *
 * Reach for this rather than a raw `<select>`, the way panes reach for `Section`
 * rather than a hand-rolled `<h2>`.
 */
export function Select({
  label,
  value,
  onChange,
  children,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="field">
      {label}
      <span className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {children}
        </select>
        <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M1 3.5l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </label>
  )
}

/**
 * A collapsible block whose closed state still says where it stands — `status`
 * renders muted beside the summary (e.g. "Off", "On · cloud.langfuse.com"), so
 * folding a section away never hides whether it is doing something.
 */
export function Disclosure({
  summary,
  status,
  defaultOpen = false,
  children,
}: {
  summary: string
  status?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`disclosure ${open ? 'open' : ''}`}>
      <button className="disclosure-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M3 1l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="disclosure-summary">{summary}</span>
        {status && <span className="disclosure-status">{status}</span>}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  )
}
