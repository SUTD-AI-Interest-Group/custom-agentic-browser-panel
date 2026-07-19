import { useState } from 'react'
import { providerKind, type ModelConfig, type ProviderConfig, type ReasoningEffort, type Settings } from '../../data/settings'
import { profileFor } from '../../data/providerProfiles'
import { fetchModelList } from '../../platform/modelList'
import { Section, Select } from './primitives'

// Common endpoints, offered as one-click starting points, each tagged with the
// `kind` that selects its capability profile. Anything not listed still works via
// "Custom" (the generic OpenAI-compatible profile).
const PRESETS: Array<Pick<ProviderConfig, 'name' | 'baseURL' | 'kind'> & { models: string[] }> = [
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', kind: 'openai', models: ['gpt-4o-mini'] },
  { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', kind: 'anthropic', models: ['claude-sonnet-5'] },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', kind: 'openrouter', models: [] },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', kind: 'groq', models: [] },
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', kind: 'ollama', models: ['llama3.1'] },
  { name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', kind: 'lmstudio', models: [] },
  { name: 'Custom', baseURL: '', kind: 'custom', models: [] },
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
  // "Refresh models" state: the provider id currently loading, plus the last
  // result/error line per provider id.
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [refreshMsg, setRefreshMsg] = useState<Record<string, string>>({})

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Text fields buffer on keystroke and persist on blur; a discrete control (a
  // dropdown) has no blur, so it persists straight away with `persist`.
  function updateProvider(id: string, patch: Partial<ProviderConfig>, persist = false) {
    const next = {
      ...draft,
      providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }
    ;(persist ? commit : buffer)(next)
  }

  function addProvider(preset: (typeof PRESETS)[number]) {
    const provider: ProviderConfig = {
      id: crypto.randomUUID(),
      name: preset.name === 'Custom' ? '' : preset.name,
      baseURL: preset.baseURL,
      apiKey: '',
      kind: preset.kind,
      models: [...preset.models],
    }
    commit({ ...draft, providers: [...draft.providers, provider] })
    // A brand-new provider has no key yet — open it so the user can fill it in.
    setOpen((prev) => new Set(prev).add(provider.id))
  }

  /**
   * Populate a provider's model list from its live endpoint (per the profile's
   * models endpoint + auth). Also seeds a manual reasoning flag where the API
   * reports one that the id heuristic would miss (mainly OpenRouter), keeping
   * modelConfigs sparse. Best-effort: failures surface inline, nothing else changes.
   */
  async function refreshModels(p: ProviderConfig) {
    setRefreshingId(p.id)
    setRefreshMsg((m) => ({ ...m, [p.id]: '' }))
    try {
      const fetched = await fetchModelList(p)
      const models = fetched.map((f) => f.id).sort((a, b) => a.localeCompare(b))
      const detect = profileFor(providerKind(p)).detectReasoning
      const modelConfigs: Record<string, ModelConfig> = { ...p.modelConfigs }
      for (const f of fetched) {
        if (f.reasoning === true && !detect(f.id)) {
          modelConfigs[f.id] = { ...modelConfigs[f.id], reasoning: true }
        }
      }
      commit({
        ...draft,
        providers: draft.providers.map((q) => (q.id === p.id ? { ...q, models, modelConfigs } : q)),
      })
      setRefreshMsg((m) => ({ ...m, [p.id]: `Loaded ${models.length} model${models.length === 1 ? '' : 's'}.` }))
    } catch (err) {
      setRefreshMsg((m) => ({
        ...m,
        [p.id]: `Couldn't load models: ${err instanceof Error ? err.message : String(err)}`,
      }))
    } finally {
      setRefreshingId(null)
    }
  }

  function removeProvider(id: string) {
    commit({
      ...draft,
      providers: draft.providers.filter((p) => p.id !== id),
      selected: draft.selected?.providerId === id ? null : draft.selected,
      // Drop a namer that pointed here, so it reverts to "same as chat model"
      // rather than lingering as a pick the dropdown can no longer show.
      titleModel: draft.titleModel?.providerId === id ? null : draft.titleModel,
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
                  <div className="models-field">
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
                    <div className="models-field-actions">
                      <button
                        className="link-btn tiny"
                        disabled={refreshingId === p.id}
                        onClick={() => refreshModels(p)}
                      >
                        {refreshingId === p.id ? 'Refreshing…' : 'Refresh from endpoint'}
                      </button>
                      {refreshMsg[p.id] && <span className="hint">{refreshMsg[p.id]}</span>}
                    </div>
                  </div>
                  <Select
                    label="Reasoning effort"
                    value={p.reasoningEffort ?? ''}
                    onChange={(value) =>
                      updateProvider(
                        p.id,
                        { reasoningEffort: (value || undefined) as ReasoningEffort | undefined },
                        true,
                      )
                    }
                  >
                    <option value="">Provider default</option>
                    <option value="none">none</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </Select>
                  <p className="hint">
                    Sent as <code>reasoning_effort</code>. Set to <code>none</code> for an OpenAI
                    gpt-5 reasoning model, whose default effort is rejected alongside the agent's
                    tools; leave on <em>Provider default</em> otherwise.
                  </p>
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

      <Section
        title="Chat naming"
        hint="Chats are named from their first message once the reply lands. A small, fast model does this best — a reasoning model can spend 20s and thousands of thinking tokens on four words."
      >
        <Select
          label="Model"
          value={draft.titleModel ? `${draft.titleModel.providerId}::${draft.titleModel.modelId}` : ''}
          onChange={(value) => {
            const [providerId, ...rest] = value.split('::')
            commit({
              ...draft,
              titleModel: value ? { providerId, modelId: rest.join('::') } : null,
            })
          }}
        >
          <option value="">Same as chat model</option>
          {draft.providers.flatMap((p) =>
            p.models
              .filter((m) => m.trim())
              .map((m) => (
                <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                  {m} · {p.name || 'Unnamed provider'}
                </option>
              )),
          )}
        </Select>
      </Section>
    </div>
  )
}
