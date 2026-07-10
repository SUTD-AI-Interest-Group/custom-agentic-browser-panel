import { useEffect, useState } from 'react'
import {
  DEFAULT_SYSTEM_PROMPT,
  type ProviderConfig,
  type Settings,
} from '../data/settings'
import MemoryView from './Memory'
import {
  BROWSING_CAPABILITIES,
  type BrowsingCapability,
  grantedCapabilities,
  requestCapabilities,
  removeCapabilities,
} from '../platform/permissions'

// Common OpenAI-compatible endpoints, offered as one-click starting points.
// Anything not listed still works via "Custom".
const PRESETS: Array<Pick<ProviderConfig, 'name' | 'baseURL'> & { models: string[] }> = [
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', models: ['claude-sonnet-5'] },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', models: [] },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', models: [] },
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', models: ['llama3.1'] },
  { name: 'Custom', baseURL: '', models: [] },
]

export default function SettingsView({
  settings,
  onSave,
}: {
  settings: Settings
  onSave: (next: Settings) => void
}) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings))

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    setDraft((d) => ({
      ...d,
      providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }

  function addProvider(preset: (typeof PRESETS)[number]) {
    const provider: ProviderConfig = {
      id: crypto.randomUUID(),
      name: preset.name === 'Custom' ? '' : preset.name,
      baseURL: preset.baseURL,
      apiKey: '',
      models: [...preset.models],
    }
    setDraft((d) => ({ ...d, providers: [...d.providers, provider] }))
  }

  function removeProvider(id: string) {
    setDraft((d) => ({
      ...d,
      providers: d.providers.filter((p) => p.id !== id),
      selected: d.selected?.providerId === id ? null : d.selected,
    }))
  }

  function save() {
    const next = structuredClone(draft)
    // Drop empty model lines, keep selection valid, auto-select first model.
    next.providers = next.providers.map((p) => ({
      ...p,
      models: p.models.map((m) => m.trim()).filter(Boolean),
    }))
    const valid =
      next.selected &&
      next.providers.some(
        (p) => p.id === next.selected!.providerId && p.models.includes(next.selected!.modelId),
      )
    if (!valid) {
      const first = next.providers.find((p) => p.models.length > 0)
      next.selected = first ? { providerId: first.id, modelId: first.models[0] } : null
    }
    onSave(next)
  }

  return (
    <div className="settings">
      <h2>Providers</h2>
      <p className="hint">
        Any OpenAI-compatible endpoint works. Keys are stored locally in your browser and sent
        only to the endpoint you configure.
      </p>

      {draft.providers.map((p) => (
        <div className="provider-card" key={p.id}>
          <div className="field-row">
            <label>
              Name
              <input
                value={p.name}
                placeholder="e.g. OpenRouter"
                onChange={(e) => updateProvider(p.id, { name: e.target.value })}
              />
            </label>
            <button className="icon-btn danger" title="Remove provider" onClick={() => removeProvider(p.id)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <label>
            Base URL
            <input
              value={p.baseURL}
              placeholder="https://api.example.com/v1"
              onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={p.apiKey}
              placeholder="sk-…"
              onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
            />
          </label>
          <label>
            Models (one per line)
            <textarea
              rows={3}
              value={p.models.join('\n')}
              placeholder={'gpt-4o-mini\ngpt-4o'}
              onChange={(e) => updateProvider(p.id, { models: e.target.value.split('\n') })}
            />
          </label>
        </div>
      ))}

      <div className="preset-row">
        {PRESETS.map((preset) => (
          <button key={preset.name} className="btn ghost small" onClick={() => addProvider(preset)}>
            + {preset.name}
          </button>
        ))}
      </div>

      <h2>Tab visibility</h2>
      <p className="hint">
        How much of your browsing the agent may see. Individual reads still ask for permission.
      </p>
      <label className={`access-option ${draft.tabAccess === 'active-tab' ? 'chosen' : ''}`}>
        <input
          type="radio"
          name="tabAccessSetting"
          checked={draft.tabAccess === 'active-tab'}
          onChange={() => setDraft((d) => ({ ...d, tabAccess: 'active-tab' }))}
        />
        <div>
          <div className="access-title">Only my current tab</div>
          <div className="access-desc">
            The agent can only see the tab you're on; @mentions offer just the current tab.
          </div>
        </div>
      </label>
      <label className={`access-option ${draft.tabAccess === 'all-tabs' ? 'chosen' : ''}`}>
        <input
          type="radio"
          name="tabAccessSetting"
          checked={draft.tabAccess === 'all-tabs'}
          onChange={() => setDraft((d) => ({ ...d, tabAccess: 'all-tabs' }))}
        />
        <div>
          <div className="access-title">All open tabs</div>
          <div className="access-desc">
            The agent can list and (with permission) read any open tab; @mention any of them.
          </div>
        </div>
      </label>

      <BrowsingInsightsSection />

      <ShortcutSection />

      <h2>System prompt</h2>
      <textarea
        className="system-prompt"
        rows={8}
        value={draft.systemPrompt}
        onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
      />
      <button
        className="link-btn"
        onClick={() => setDraft((d) => ({ ...d, systemPrompt: DEFAULT_SYSTEM_PROMPT }))}
      >
        Reset to default
      </button>

      <details className="settings-section">
        <summary>Memory &amp; dreaming</summary>
        <MemoryView />
      </details>

      <div className="settings-footer">
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

// Chrome owns browser-global shortcuts: an extension can read its current
// binding but cannot set it, so rebinding delegates to Chrome's shortcuts page.
// We refresh on window focus to reflect a change made there without a reload.
function ShortcutSection() {
  const [shortcut, setShortcut] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const refresh = () =>
      chrome.commands
        .getAll()
        .then((cmds) => {
          const c = cmds.find((x) => x.name === 'toggle-panel')
          setShortcut(c?.shortcut ? c.shortcut : null)
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  return (
    <>
      <h2>Keyboard shortcut</h2>
      <p className="hint">
        Toggle this side panel from anywhere in the browser (default Ctrl/Cmd + E). Chrome
        manages global shortcuts, so rebinding opens Chrome's shortcuts page; your choice is
        saved there.
      </p>
      <div className="shortcut-row">
        <span className="shortcut-label">Toggle sidebar</span>
        <kbd className="shortcut-key">{loaded ? shortcut ?? 'Not set' : '…'}</kbd>
        <button
          className="btn ghost small"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          Change shortcut ↗
        </button>
      </div>
    </>
  )
}

// Browsing-data capabilities are Chrome optional permissions, not part of
// Settings — so this section acts immediately (grant/revoke on toggle), not on
// Save, and reads its state live from chrome.permissions. It stays in sync when
// the user grants/revokes elsewhere (e.g. chrome://extensions).
const CAPABILITY_LABELS: Record<BrowsingCapability, string> = {
  history: 'Browsing history',
  bookmarks: 'Bookmarks',
  topSites: 'Top sites',
  downloads: 'Downloads',
}

function BrowsingInsightsSection() {
  const [granted, setGranted] = useState<Set<BrowsingCapability>>(new Set())

  useEffect(() => {
    const refresh = () => grantedCapabilities().then(setGranted).catch(() => {})
    refresh()
    chrome.permissions.onAdded.addListener(refresh)
    chrome.permissions.onRemoved.addListener(refresh)
    return () => {
      // @types/chrome 0.0.280 omits removeListener from these permission
      // events, though Chrome provides it at runtime.
      type PermEvent = { removeListener(cb: () => void): void }
      ;(chrome.permissions.onAdded as unknown as PermEvent).removeListener(refresh)
      ;(chrome.permissions.onRemoved as unknown as PermEvent).removeListener(refresh)
    }
  }, [])

  // request/remove must be called from this click handler (the user gesture).
  // We re-read afterward so a denied prompt reverts the checkbox from state.
  async function toggle(caps: BrowsingCapability[], on: boolean) {
    if (on) await requestCapabilities(caps)
    else await removeCapabilities(caps)
    setGranted(await grantedCapabilities())
  }

  const allOn = BROWSING_CAPABILITIES.every((c) => granted.has(c))
  const missing = BROWSING_CAPABILITIES.filter((c) => !granted.has(c))

  return (
    <>
      <h2>Browsing insights</h2>
      <p className="hint">
        Let the agent look up your history, bookmarks, top sites and downloads to enrich answers.
        Each lookup still asks for permission. Granting happens here and can be revoked anytime.
      </p>
      <label className="toggle-row master">
        <div className="access-title">Enable all browsing insights</div>
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) =>
            void toggle(e.target.checked ? missing : BROWSING_CAPABILITIES, e.target.checked)
          }
        />
      </label>
      {BROWSING_CAPABILITIES.map((cap) => (
        <label className="toggle-row" key={cap}>
          <div className="access-desc">{CAPABILITY_LABELS[cap]}</div>
          <input
            type="checkbox"
            checked={granted.has(cap)}
            onChange={(e) => void toggle([cap], e.target.checked)}
          />
        </label>
      ))}
    </>
  )
}
