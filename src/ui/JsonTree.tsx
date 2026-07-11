import { useState } from 'react'

// Renders a parsed JSON value (from a standalone ```json block) as a collapsible
// key/value tree. Objects/arrays are expandable; primitives are shown inline
// with type coloring. Deep nodes start collapsed to keep large payloads compact.

export default function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree">
      <Node k={null} value={value} depth={0} />
    </div>
  )
}

function Node({ k, value, depth }: { k: string | null; value: unknown; depth: number }) {
  const isContainer = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < 2)

  if (!isContainer) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * 14 }}>
        {k !== null && <span className="json-key">{k}:</span>}
        <span className={`json-val json-${valueType(value)}`}>{format(value)}</span>
      </div>
    )
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const brace = Array.isArray(value) ? ['[', ']'] : ['{', '}']

  return (
    <div className="json-node">
      <div className="json-row json-branch" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((o) => !o)}>
        <span className="json-caret">{open ? '▾' : '▸'}</span>
        {k !== null && <span className="json-key">{k}:</span>}
        <span className="json-brace">{brace[0]}{!open && `… ${entries.length}`}{!open && brace[1]}</span>
      </div>
      {open && (
        <>
          {entries.map(([ck, cv]) => (
            <Node key={ck} k={ck} value={cv} depth={depth + 1} />
          ))}
          <div className="json-row json-brace" style={{ paddingLeft: depth * 14 }}>{brace[1]}</div>
        </>
      )}
    </div>
  )
}

function valueType(v: unknown): string {
  if (v === null) return 'null'
  return typeof v
}
function format(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : String(v)
}
