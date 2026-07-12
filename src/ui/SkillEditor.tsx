import { useState } from 'react'
import {
  deleteSkill,
  getSkill,
  parseSkillMarkdown,
  saveSkill,
  serializeSkill,
  validateSkill,
  type Skill,
} from '../data/skills'

// The skill create/edit/view form, extracted from the old SkillsLibrary so the
// Library's Skills tab (src/ui/library/SkillsList.tsx) can reuse it unchanged.

export type EditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; skill: Skill }
  | { kind: 'view'; skill: Skill } // built-in: read-only, duplicate to customize

export default function SkillEditor({ mode, onBack }: { mode: EditorMode; onBack: () => void }) {
  const initial = mode.kind === 'new' ? null : mode.skill
  const readOnly = mode.kind === 'view'
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [userInvocable, setUserInvocable] = useState(initial?.userInvocable ?? true)
  const [modelInvocable, setModelInvocable] = useState(initial?.modelInvocable ?? true)
  const [notice, setNotice] = useState<string | null>(null)

  async function save() {
    const err = validateSkill({ name, description, body })
    if (err) {
      setNotice(err)
      return
    }
    const originalName = mode.kind === 'edit' ? mode.skill.name : null
    const renaming = originalName !== null && originalName !== name
    // A rename must not collide with a different existing skill, and must
    // remove the old record rather than leaving an orphaned duplicate.
    if (renaming) {
      const clash = await getSkill(name)
      if (clash) {
        setNotice(`A skill named “${name}” already exists.`)
        return
      }
    }
    try {
      await saveSkill({ name, description, body, icon: icon || undefined, userInvocable, modelInvocable })
      if (renaming && originalName) await deleteSkill(originalName)
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function duplicate() {
    // Find a free "-copy" name so duplicating twice never overwrites the first copy.
    let candidate = `${name}-copy`
    let n = 2
    while (await getSkill(candidate)) {
      candidate = `${name}-copy-${n}`
      n++
    }
    try {
      await saveSkill({
        name: candidate,
        description,
        body,
        icon: icon || undefined,
        userInvocable,
        modelInvocable,
      })
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove() {
    if (!initial) return
    if (!window.confirm(`Delete the “${initial.name}” skill?`)) return
    try {
      await deleteSkill(initial.name)
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  function exportMd() {
    const md = serializeSkill({
      id: initial?.id ?? '',
      name,
      description,
      body,
      icon: icon || undefined,
      color: initial?.color,
      source: initial?.source ?? 'user',
      userInvocable,
      modelInvocable,
      enabled: initial?.enabled ?? true,
      createdAt: 0,
      updatedAt: 0,
    })
    void navigator.clipboard.writeText(md)
    setNotice('Copied SKILL.md to clipboard.')
  }

  function importMd(text: string) {
    const p = parseSkillMarkdown(text)
    setName(p.name)
    setDescription(p.description)
    setBody(p.body)
    if (p.icon) setIcon(p.icon)
    setUserInvocable(p.userInvocable)
    setModelInvocable(p.modelInvocable)
    setNotice('Imported — review and Save.')
  }

  return (
    <div className="skill-editor">
      <div className="skills-header">
        <button className="link-btn" onClick={onBack}>
          ‹ Back
        </button>
        <h2>{mode.kind === 'new' ? 'New skill' : readOnly ? name : `Edit ${name}`}</h2>
      </div>
      {readOnly && (
        <p className="hint">This is a built-in skill and can't be edited. Duplicate it to customize.</p>
      )}

      <label className="field">
        Icon
        <input
          className="skill-input"
          value={icon}
          maxLength={4}
          disabled={readOnly}
          placeholder="🧩"
          onChange={(e) => setIcon(e.target.value)}
        />
      </label>
      <label className="field">
        Name
        <input
          className="skill-input"
          value={name}
          disabled={readOnly}
          placeholder="summarizing-pages"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        Description (what it does + when to use it)
        <textarea
          className="skill-input"
          rows={3}
          value={description}
          disabled={readOnly}
          placeholder="Summarizes the current page… Use when the user asks to summarize or TL;DR a page."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        Instructions
        <textarea
          className="skill-input mono"
          rows={12}
          value={body}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="check">
          <input
            type="checkbox"
            checked={userInvocable}
            disabled={readOnly}
            onChange={(e) => setUserInvocable(e.target.checked)}
          />
          Show in the “/” menu
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={modelInvocable}
            disabled={readOnly}
            onChange={(e) => setModelInvocable(e.target.checked)}
          />
          Let the agent auto-load it
        </label>
      </div>

      {notice && <div className="skill-notice">{notice}</div>}

      <div className="skill-editor-actions">
        <button className="btn ghost small" onClick={exportMd}>
          Export .md
        </button>
        {!readOnly && (
          <label className="btn ghost small">
            Import .md
            <input
              type="file"
              accept=".md,.markdown,text/markdown"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) importMd(await file.text())
                e.target.value = ''
              }}
            />
          </label>
        )}
        <span className="spacer" />
        {mode.kind === 'edit' && (
          <button className="btn ghost small danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
        {readOnly ? (
          <button className="btn primary small" onClick={() => void duplicate()}>
            Duplicate to customize
          </button>
        ) : (
          <button className="btn primary small" onClick={() => void save()}>
            Save
          </button>
        )}
      </div>
    </div>
  )
}
