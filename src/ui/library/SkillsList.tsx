import { useEffect, useState } from 'react'
import { listSkills, type Skill } from '../../data/skills'
import SkillEditor, { type EditorMode } from '../SkillEditor'

// The Library's Skills tab: the skills library in list form (one row per skill)
// plus the shared create/edit form. Replaces the old masonry grid; clicking a
// row opens the editor (built-in skills open read-only, custom ones editable).

export default function SkillsList() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [editor, setEditor] = useState<EditorMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    setError(null)
    void listSkills().then(setSkills).catch(error => setError(error instanceof Error ? error.message : String(error)))
  }
  useEffect(refresh, [])

  if (editor) {
    return (
      <SkillEditor
        mode={editor}
        onBack={() => {
          setEditor(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div className="library-skills">
      {error && <div className="surface-error" role="alert">{error}<button className="btn small" onClick={refresh}>Retry</button></div>}
      <div className="library-skills-top">
        <button className="btn primary small" onClick={() => setEditor({ kind: 'new' })}>
          New skill
        </button>
      </div>
      {skills.length === 0 ? (
        <div className="library-empty">No skills</div>
      ) : (
        <div className="library-list">
          {skills.map((s) => (
            <div
              key={s.id}
              className="library-row skill-row"
              role="button"
              tabIndex={0}
              onClick={() =>
                setEditor(s.source === 'builtin' ? { kind: 'view', skill: s } : { kind: 'edit', skill: s })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setEditor(
                    s.source === 'builtin' ? { kind: 'view', skill: s } : { kind: 'edit', skill: s },
                  )
                }
              }}
            >
              <span className="skill-row-icon">{s.icon ?? '🧩'}</span>
              <div className="library-row-main">
                <span className="library-row-title">{s.name}</span>
                <span className="library-row-desc">{s.description}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
