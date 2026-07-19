import { useRef, useState } from 'react'
import {
  getSelectedProvider,
  resolveReasoningEffort,
  type ModelConfig,
  type ProviderConfig,
  type ReasoningEffort,
  type Settings,
} from '../data/settings'
import { isReasoningModel, reasoningLevelsFor } from '../data/providerProfiles'
import { useDismissOnOutside } from './hooks'

/**
 * The composer's model picker: a button that opens a dropdown of every configured
 * model grouped by provider, with a reasoning-effort slider pinned at the bottom
 * for the selected model (only when it is a reasoning model). Replaces the bare
 * native <select> so the slider can live inside the menu (a <select> can't hold
 * one). Reasoning capability and the slider's rungs come from the provider profile
 * (src/data/providerProfiles.ts); the chosen effort is stored per model.
 */
export default function ModelPicker({
  settings,
  onUpdateSettings,
  onOpenSettings,
}: {
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(open, ref, () => setOpen(false))

  const selected = getSelectedProvider(settings)
  const hasModels = settings.providers.some((p) => p.models.some((m) => m.trim()))
  if (!hasModels) {
    return (
      <button className="link-btn" onClick={onOpenSettings}>
        Set up a provider
      </button>
    )
  }

  function selectModel(providerId: string, modelId: string) {
    onUpdateSettings({ ...settings, selected: { providerId, modelId } })
    setOpen(false)
  }

  /** Merge a patch into one model's config on one provider, immutably and sparsely. */
  function patchModel(providerId: string, modelId: string, patch: Partial<ModelConfig>) {
    onUpdateSettings({
      ...settings,
      providers: settings.providers.map((p) => {
        if (p.id !== providerId) return p
        return {
          ...p,
          modelConfigs: { ...p.modelConfigs, [modelId]: { ...p.modelConfigs?.[modelId], ...patch } },
        }
      }),
    })
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-select-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-select-label">{selected ? selected.modelId : 'Select model'}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 3.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="model-menu" role="menu">
          <div className="model-menu-list">
            {settings.providers.map((p) => {
              const models = p.models.filter((m) => m.trim())
              if (models.length === 0) return null
              return (
                <div key={p.id} className="model-menu-group">
                  <div className="model-menu-group-label">{p.name || 'Unnamed provider'}</div>
                  {models.map((m) => {
                    const active = selected?.provider.id === p.id && selected.modelId === m
                    return (
                      <button
                        key={m}
                        role="menuitemradio"
                        aria-checked={active}
                        className={`model-menu-item ${active ? 'active' : ''}`}
                        onClick={() => selectModel(p.id, m)}
                      >
                        <span className="model-menu-item-name">{m}</span>
                        {active && (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {selected && (
            <EffortControl
              provider={selected.provider}
              modelId={selected.modelId}
              onSetEffort={(effort) => patchModel(selected.provider.id, selected.modelId, { reasoningEffort: effort })}
              onSetReasoning={(reasoning) => patchModel(selected.provider.id, selected.modelId, { reasoning })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** The reasoning-effort footer for the selected model: a snap-slider when it reasons, else an enable affordance. */
function EffortControl({
  provider,
  modelId,
  onSetEffort,
  onSetReasoning,
}: {
  provider: ProviderConfig
  modelId: string
  onSetEffort: (effort: ReasoningEffort) => void
  onSetReasoning: (reasoning: boolean) => void
}) {
  const reasoning = isReasoningModel(provider, modelId)

  if (!reasoning) {
    return (
      <div className="model-menu-effort off">
        <span className="effort-title">Reasoning</span>
        <span className="effort-off-note">off</span>
        <button className="link-btn tiny" onClick={() => onSetReasoning(true)}>
          Enable
        </button>
      </div>
    )
  }

  const levels = reasoningLevelsFor(provider, modelId)
  const current = resolveReasoningEffort(provider, modelId)
  const index = current ? Math.max(0, levels.indexOf(current)) : 0
  const pct = levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0

  return (
    <div className="model-menu-effort">
      <div className="effort-head">
        <span className="effort-title">Effort</span>
        <span className="effort-value">{current ?? 'default'}</span>
        <span
          className="effort-help"
          title="Higher effort makes the model think longer before answering — better on hard tasks, but slower and more tokens."
          aria-label="About reasoning effort"
        >
          ?
        </span>
      </div>
      <input
        type="range"
        className="effort-slider"
        min={0}
        max={levels.length - 1}
        step={1}
        value={index}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => onSetEffort(levels[Number(e.target.value)])}
        aria-label="Reasoning effort"
      />
      <div className="effort-ends">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      {provider.modelConfigs?.[modelId]?.reasoning === undefined && (
        <button className="link-btn tiny effort-not" onClick={() => onSetReasoning(false)}>
          Not a reasoning model
        </button>
      )}
    </div>
  )
}
