import { useEffect, useState } from 'react'
import { DEFAULT_SYSTEM_PROMPT, type ProviderConfig, type Settings } from '../../data/settings'

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

/**
 * General tab: system prompt, keyboard shortcut, providers. Text fields buffer
 * on keystroke (`buffer`) and persist on blur (`commitDraft`); structural
 * changes (add/remove/reset) persist immediately (`commit`).
 */
export default function GeneralTab({
  draft,
  buffer,
  commit,
  commitDraft,
}: {
  draft: Settings
  buffer: (next: Settings) => void
  commit: (next: Settings) => void
  commitDraft: () => void
}) {
  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    buffer({
      ...draft,
      providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })
  }

  function addProvider(preset: (typeof PRESETS)[number]) {
    const provider: ProviderConfig = {
      id: crypto.randomUUID(),
      name: preset.name === 'Custom' ? '' : preset.name,
      baseURL: preset.baseURL,
      apiKey: '',
      models: [...preset.models],
    }
    commit({ ...draft, providers: [...draft.providers, provider] })
  }

  function removeProvider(id: string) {
    commit({
      ...draft,
      providers: draft.providers.filter((p) => p.id !== id),
      selected: draft.selected?.providerId === id ? null : draft.selected,
    })
  }

  return (
    <div className="settings-tabpane">
      <h2>System prompt</h2>
      <textarea
        className="system-prompt"
        rows={8}
        value={draft.systemPrompt}
        onChange={(e) => buffer({ ...draft, systemPrompt: e.target.value })}
        onBlur={commitDraft}
      />
      <button
        className="link-btn"
        onClick={() => commit({ ...draft, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
      >
        Reset to default
      </button>

      <ShortcutSection />

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
                onBlur={commitDraft}
              />
            </label>
            <button
              className="icon-btn danger"
              title="Remove provider"
              onClick={() => removeProvider(p.id)}
            >
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
              onBlur={commitDraft}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={p.apiKey}
              placeholder="sk-…"
              onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
              onBlur={commitDraft}
            />
          </label>
          <label>
            Models (one per line)
            <textarea
              rows={3}
              value={p.models.join('\n')}
              placeholder={'gpt-4o-mini\ngpt-4o'}
              onChange={(e) => updateProvider(p.id, { models: e.target.value.split('\n') })}
              onBlur={commitDraft}
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
