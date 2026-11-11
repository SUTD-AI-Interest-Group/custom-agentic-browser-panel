import { TabStrip } from '../TabStrip'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Settings } from '../../data/settings'
import { mergeSettingsDraft } from '../settingsSync'
const McpSection = lazy(() => import('./McpSection'))
import { normalizeSettings } from './normalizeSettings'
const GeneralTab = lazy(() => import('./GeneralTab'))
const ProvidersTab = lazy(() => import('./ProvidersTab'))
const PermissionsTab = lazy(() => import('./PermissionsTab'))
const MemoryTab = lazy(() => import('./MemoryTab'))
const SkillsTab = lazy(() => import('./SkillsTab'))
const DataTab = lazy(() => import('./DataTab'))

type TabKey = 'connections' | 'general' | 'providers' | 'permissions' | 'memory' | 'skills' | 'data'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'connections', label: 'Connections' },
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
  onChange: (next: Settings) => Promise<boolean>
  onOpenSkills: () => void
  onClose: () => void
  /** Called after a full erase — App reloads settings, which re-enters onboarding. */
  onErased: () => void
}) {
  const [tab, setTab] = useState<TabKey>('general')
  const [localDraft, setDraft] = useState<Settings>(() => structuredClone(settings))
  const base = useRef(settings)
  const draft = mergeSettingsDraft(base.current, localDraft, settings)
  // draftRef holds the latest draft synchronously so onBlur can commit without
  // waiting for a re-render.
  const draftRef = useRef(draft)
  const [error, setError] = useState('')
  const saveSequence = useRef(0)
  draftRef.current = draft
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

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
    persist(next)
  }

  /** Persist the currently-buffered draft. For text fields committing on blur. */
  function commitDraft() {
    persist(draftRef.current)
  }

  function persist(next: Settings) {
    const normalized = normalizeSettings(mergeSettingsDraft(base.current, next, settings))
    if (!error && JSON.stringify(normalized) === JSON.stringify(settings)) return
    base.current = normalized
    buffer(normalized)
    const sequence = ++saveSequence.current
    setSaved(false); setError('')
    void onChange(normalized).then(ok => {
      if (sequence !== saveSequence.current) return
      if (ok) flashSaved()
      else setError('Settings could not be saved. Retry your changes.')
    }).catch(() => { if (sequence === saveSequence.current) setError('Settings could not be saved. Retry your changes.') })
  }

  return (
    <div className="settings">
      <div className="settings-topbar">
        <TabStrip id="settings" label="Settings" tabs={TABS} value={tab} onChange={setTab} className="settings-tabs" tabClassName="settings-tab" />
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

      <div className="settings-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-${tab}`}>
        <Suspense fallback={<div className="surface-loading" role="status">Loading…</div>}>
        {error && <p role="alert">{error} <button onClick={commitDraft}>Retry save</button></p>}
        <p className="hint">Lychee {chrome.runtime.getManifest().version} · {import.meta.env.VITE_BUILD_COMMIT ?? 'development'}</p>
        {tab === 'connections' && <div className="settings-tabpane"><McpSection draft={draft} commit={commit} /></div>}
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
        </Suspense>
      </div>
    </div>
  )
}
