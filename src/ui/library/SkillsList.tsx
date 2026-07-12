import { useEffect, useState } from 'react'
import { listSkills, type Skill } from '../../data/skills'
import SkillEditor, { type EditorMode } from '../SkillEditor'

// The Library's Skills tab: the skills library in list form (one row per skill)
// plus the shared create/edit form. Replaces the old masonry grid; clicking a
// row opens the editor (built-in skills open read-only, custom ones editable).

export default function SkillsList() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [editor, setEditor] = useState<EditorMode | null>(null)

  function refresh() {
    void listSkills().then(setSkills)
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
      <div className="library-skills-top">
        <p className="hint">
          Skills are reusable instruction sets. Run one by typing <code>/name</code> in chat, or let the
          agent load a relevant one on its own. Tip: type <code>/create-skill</code> in chat to build one
          with the agent.
        </p>
        <button className="btn primary small" onClick={() => setEditor({ kind: 'new' })}>
          New skill
        </button>
      </div>
      {skills.length === 0 ? (
        <div className="library-empty">No skills yet — click “New skill” to create your first.</div>
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
              <span className={`skill-badge ${s.source}`}>
                {s.source === 'builtin' ? 'Built-in' : 'Custom'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
