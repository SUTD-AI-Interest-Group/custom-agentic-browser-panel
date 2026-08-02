import { useRef, useState } from 'react'
import type { Settings } from '../../data/settings'
import GeneralTab from './GeneralTab'
import ProvidersTab from './ProvidersTab'
import PermissionsTab from './PermissionsTab'
import MemoryTab from './MemoryTab'
import SkillsTab from './SkillsTab'
import DataTab from './DataTab'
import { normalizeSettings } from './normalizeSettings'

type TabKey = 'general' | 'providers' | 'permissions' | 'memory' | 'skills' | 'data'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'providers', label: 'Providers' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'memory', label: 'Memory' },
  { key: 'skills', label: 'Skills' },
  { key: 'data', label: 'Data' },
]

/**
 * Tabbed settings surface. Changes apply instantly (no Save button): a local
 * `draft` mirrors the persisted settings for responsive typing, while `commit`
 * persists (normalized) and flashes a brief "Saved ✓". Text fields buffer on
 * keystroke and commit on blur to avoid a chrome.storage write per character;
 * toggles/radios/policies commit immediately.
 */
export default function SettingsView({
  settings,
  onChange,
  onOpenSkills,
  onClose,
  onErased,
}: {
  settings: Settings
  onChange: (next: Settings) => void
  onOpenSkills: () => void
  onClose: () => void
  /** Called after a full erase — App reloads settings, which re-enters onboarding. */
  onErased: () => void
}) {
  const [tab, setTab] = useState<TabKey>('general')
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings))
  // draftRef holds the latest draft synchronously so onBlur can commit without
  // waiting for a re-render.
  const draftRef = useRef(draft)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function flashSaved() {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1600)
  }

  /** Buffer a draft change locally without persisting (text keystrokes). */
  function buffer(next: Settings) {
    draftRef.current = next
    setDraft(next)
  }

  /** Buffer + persist (normalized) + flash. For immediate controls. */
  function commit(next: Settings) {
    buffer(next)
    onChange(normalizeSettings(next))
    flashSaved()
  }

  /** Persist the currently-buffered draft. For text fields committing on blur. */
  function commitDraft() {
    onChange(normalizeSettings(draftRef.current))
    flashSaved()
  }

  return (
    <div className="settings">
      <div className="settings-topbar">
        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-topbar-right">
          <span className={`saved-pill ${saved ? 'show' : ''}`} aria-live="polite">
            Saved ✓
          </span>
          <button className="icon-btn" title="Close settings" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="settings-body">
        {tab === 'general' && (
          <GeneralTab draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
        )}
        {tab === 'providers' && (
          <ProvidersTab draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
        )}
        {tab === 'permissions' && (
          <PermissionsTab draft={draft} commit={commit} onSaved={flashSaved} />
        )}
        {tab === 'memory' && <MemoryTab draft={draft} commit={commit} />}
        {tab === 'skills' && <SkillsTab onOpenSkills={onOpenSkills} onSaved={flashSaved} />}
        {tab === 'data' && <DataTab draft={draft} commit={commit} onErased={onErased} />}
      </div>
    </div>
  )
}
