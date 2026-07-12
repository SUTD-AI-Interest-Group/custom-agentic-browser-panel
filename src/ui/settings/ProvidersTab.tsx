import { useState } from 'react'
import type { ProviderConfig, Settings } from '../../data/settings'
import { Section } from './primitives'

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

/** Drop the scheme so a collapsed card reads "api.openai.com/v1", not the whole URL. */
function hostLabel(baseURL: string): string {
  return baseURL.replace(/^https?:\/\//, '') || 'not configured'
}

/**
 * Providers tab: every OpenAI-compatible endpoint the user has configured. Text
 * fields buffer on keystroke and persist on blur; add/remove persist immediately.
 *
 * A configured provider collapses to a single summary line — the panel is ~400px
 * wide, and a stack of expanded cards used to bury everything below them. A card
 * the user just added starts open, since it is by definition unconfigured.
 */
export default function ProvidersTab({
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
  // Which cards are expanded. Not persisted: reopening Settings starts collapsed.
  const [open, setOpen] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    // A brand-new provider has no key yet — open it so the user can fill it in.
    setOpen((prev) => new Set(prev).add(provider.id))
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
      <Section
        title="Providers"
        hint="Any OpenAI-compatible endpoint. Keys stay in your browser and are sent only to that endpoint."
      >
        {draft.providers.length === 0 && (
          <p className="hint">No providers yet — add one below to get started.</p>
        )}

        {draft.providers.map((p) => {
          const expanded = open.has(p.id)
          const active = draft.selected?.providerId === p.id
          return (
            <div className={`provider-card ${expanded ? 'open' : ''}`} key={p.id}>
              <button className="provider-head" aria-expanded={expanded} onClick={() => toggle(p.id)}>
                <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M3 1l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="provider-name">{p.name || 'Unnamed provider'}</span>
                {active && <span className="provider-active">Active</span>}
                <span className="provider-meta">
                  {hostLabel(p.baseURL)} · {p.models.length}{' '}
                  {p.models.length === 1 ? 'model' : 'models'}
                </span>
              </button>

              {expanded && (
                <div className="provider-body">
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
                        <path
                          d="M3 3l8 8M11 3l-8 8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
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
              )}
            </div>
          )
        })}

        <div className="preset-row">
          {PRESETS.map((preset) => (
            <button key={preset.name} className="btn ghost small" onClick={() => addProvider(preset)}>
              + {preset.name}
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}
