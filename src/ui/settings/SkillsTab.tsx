import { useEffect, useState } from 'react'
import { listSkills, setSkillEnabled, type Skill } from '../../data/skills'

/**
 * Skills tab: a lightweight on/off list. Disabling a skill hides it from the
 * agent catalog, the "/" menu and ReadSkill (via the `enabled` flag). Creating
 * and editing still happen in the full Skills Library, reached via the link.
 */
export default function SkillsTab({
  onOpenSkills,
  onSaved,
}: {
  onOpenSkills: () => void
  onSaved: () => void
}) {
  const [skills, setSkills] = useState<Skill[]>([])

  function refresh() {
    void listSkills().then(setSkills).catch(() => {})
  }
  useEffect(refresh, [])

  async function toggle(name: string, enabled: boolean) {
    // Optimistic flip so the switch feels instant, then persist + refresh.
    setSkills((list) => list.map((s) => (s.name === name ? { ...s, enabled } : s)))
    await setSkillEnabled(name, enabled).catch(() => {})
    onSaved()
    refresh()
  }

  return (
    <div className="settings-tabpane">
      <div className="skills-tab-head">
        <h2>Skills</h2>
        <button className="link-btn" onClick={onOpenSkills}>
          Manage in Skills Library →
        </button>
      </div>
      <p className="hint">
        Turn skills on or off for the agent. A disabled skill won't appear in the agent's catalog
        or the “/” menu. Create and edit skills in the Skills Library.
      </p>

      {skills.length === 0 ? (
        <p className="hint">No skills yet — open the Skills Library to create one.</p>
      ) : (
        <div className="skill-toggle-list">
          {skills.map((s) => {
            const on = s.enabled !== false
            return (
              <label className="skill-toggle-row" key={s.id}>
                <span className="skill-toggle-icon">{s.icon ?? '🧩'}</span>
                <span className="skill-toggle-text">
                  <span className="skill-toggle-name">
                    {s.name}
                    <span className={`skill-badge ${s.source}`}>
                      {s.source === 'builtin' ? 'Built-in' : 'Custom'}
                    </span>
                  </span>
                  <span className="skill-toggle-desc">{s.description}</span>
                </span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={on}
                  onChange={(e) => void toggle(s.name, e.target.checked)}
                />
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
