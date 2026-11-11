import ChatGPTProvider from './settings/ChatGPTProvider'
import { useEffect, useRef, useState } from 'react'
import { testModel, type TestResult } from '../agent/provider'
import {
  type ProviderConfig,
  type Settings,
  type TabAccess,
} from '../data/settings'

// First-run wizard: configure a model endpoint, prove it works with a live
// test call, and choose how much tab visibility the agent gets. Completes by
// saving settings with onboarded: true; Settings remains the place to change
// any of this later.

const PRESETS: Array<{ name: string; baseURL: string; placeholderModel: string; keyHint: string }> = [
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', placeholderModel: 'gpt-4o-mini', keyHint: 'sk-…' },
  { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', placeholderModel: 'claude-sonnet-5', keyHint: 'sk-ant-…' },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', placeholderModel: 'anthropic/claude-sonnet-5', keyHint: 'sk-or-…' },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', placeholderModel: 'llama-3.3-70b-versatile', keyHint: 'gsk_…' },
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', placeholderModel: 'llama3.1', keyHint: 'not needed' },
  { name: 'Custom', baseURL: '', placeholderModel: 'model-id', keyHint: 'optional' },
]

type Step = 'endpoint' | 'test' | 'access'

/**
 * The provider-shaped subset of onboarding state that a preset pick replaces
 * wholesale. `apiKey` lives here deliberately alongside `baseURL`/`modelId`:
 * every preset is a distinct authentication realm (OpenAI/Anthropic/
 * OpenRouter/Groq each mint their own key format — see PRESETS' `keyHint`),
 * so a key typed for one must never survive a switch to another — carrying
 * it over would silently send it to a different endpoint as a Bearer/
 * x-api-key header (the model-list-less "test" call, or the first chat
 * request).
 */
export interface OnboardingDraft {
  presetName: string | null
  name: string
  baseURL: string
  apiKey: string
  modelId: string
}

/**
 * Applies a preset pick to the current draft. Every field below is replaced
 * wholesale, never merged from `draft` — `apiKey` most importantly, since it
 * is exactly the field the previous version of this wizard forgot to reset
 * (see the CRITICAL cross-provider key disclosure this locks down). Exported
 * and pure so the regression test doesn't need to mount the component.
 */
export function applyPreset(
  draft: OnboardingDraft,
  preset: Pick<(typeof PRESETS)[number], 'name' | 'baseURL'>,
): OnboardingDraft {
  return {
    ...draft,
    presetName: preset.name,
    name: preset.name === 'Custom' ? '' : preset.name,
    baseURL: preset.baseURL,
    apiKey: '',
    modelId: '',
  }
}

/**
 * This wizard only ever configures an HTTP(S) API endpoint — reject any other
 * scheme (`javascript:`, `file:`, `data:`, a bare `localhost:` typo missing
 * its leading `//`, ...) so "Continue" can't be reached with one, rather than
 * accepting literally any non-empty string and only failing later at fetch.
 */
export function hasValidEndpointScheme(url: string): boolean {
  try {
    const scheme = new URL(url.trim()).protocol
    return scheme === 'http:' || scheme === 'https:'
  } catch {
    return false
  }
}

export default function Onboarding({
  settings,
  onComplete,
}: {
  settings: Settings
  onComplete: (next: Settings) => void
}) {
  const [chatGPT, setChatGPT] = useState<ProviderConfig>(() => ({ id: crypto.randomUUID(), name: 'ChatGPT plan', kind: 'chatgpt', baseURL: 'https://api.openai.com/v1', apiKey: '', models: [] }))
  const [step, setStep] = useState<Step>('endpoint')
  const [draft, setDraft] = useState<OnboardingDraft>({ presetName: null, name: '', baseURL: '', apiKey: '', modelId: '' })
  const { presetName, name, baseURL, apiKey, modelId } = draft
  const patchDraft = (patch: Partial<OnboardingDraft>) => setDraft(current => ({ ...current, ...patch }))
  const [tabAccess, setTabAccess] = useState<TabAccess>('active-tab')
  const [test, setTest] = useState<{ status: 'idle' | 'testing' } | { status: 'done'; result: TestResult }>({ status: 'idle' })
  const testing = test.status === 'testing'
  const result = test.status === 'done' ? test.result : null
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  function clearTest() { pending.current?.abort(); pending.current = null; setTest({ status: 'idle' }) }

  const preset = PRESETS.find((p) => p.name === presetName)
  const isChatGPT = presetName === 'ChatGPT plan'
  const endpointValid = isChatGPT ? chatGPT.models.includes(modelId) :
    baseURL.trim().length > 0 && modelId.trim().length > 0 && hasValidEndpointScheme(baseURL)

  function pickPreset(p: (typeof PRESETS)[number]) {
    clearTest()
    setDraft(current => applyPreset(current, p))
  }

  function draftProvider(): ProviderConfig {
    if (isChatGPT) return { ...chatGPT, models: [modelId, ...chatGPT.models.filter(id => id !== modelId)] }
    return {
      id: crypto.randomUUID(),
      name: name.trim() || 'My provider',
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: apiKey.trim(),
      models: [modelId.trim()],
    }
  }

  async function runTest() {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setTest({ status: 'testing' })
    const result = await testModel(draftProvider(), modelId.trim(), controller.signal)
    if (controller.signal.aborted) return
    pending.current = null
    setTest({ status: 'done', result })
  }

  function finish() {
    const provider = draftProvider()
    onComplete({
      ...settings,
      providers: [...settings.providers, provider],
      selected: { providerId: provider.id, modelId: provider.models[0] },
      tabAccess,
      onboarded: true,
    })
  }

  const steps: Step[] = ['endpoint', 'test', 'access']

  return (
    <div className="onboarding">
      <div className="onboard-progress">
        {steps.map((s, i) => (
          <span key={s} className={`onboard-dot ${steps.indexOf(step) >= i ? 'on' : ''}`} />
        ))}
      </div>

      {step === 'endpoint' && (
        <>
          <h1>Connect a model</h1>
          <div className="preset-row">
            <button className={`btn small ${isChatGPT ? 'primary' : 'ghost'}`} onClick={() => {
              clearTest(); setDraft({ presetName: 'ChatGPT plan', name: 'ChatGPT plan', baseURL: 'https://api.openai.com/v1', apiKey: '', modelId: chatGPT.models[0] || '' })
            }}>ChatGPT plan</button>
            {PRESETS.map((p) => (
              <button
                key={p.name}
                className={`btn small ${presetName === p.name ? 'primary' : 'ghost'}`}
                onClick={() => pickPreset(p)}
              >
                {p.name}
              </button>
            ))}
          </div>

          {isChatGPT && <div className="provider-card onboard-form">
            <ChatGPTProvider provider={chatGPT} onChange={patch => {
              setChatGPT(current => ({ ...current, ...patch }))
              if (patch.models) patchDraft({ modelId: patch.models[0] || '' })
              clearTest()
            }} />
            {chatGPT.models.length > 0 && <label>Model<select value={modelId} onChange={event => patchDraft({ modelId: event.target.value })}>
              {chatGPT.models.map(id => <option key={id} value={id}>{chatGPT.modelNames?.[id] || id}</option>)}
            </select></label>}
          </div>}
          {preset && (
            <div className="provider-card onboard-form">
              {preset.name === 'Custom' && (
                <label>
                  Name
                  <input value={name} placeholder="My endpoint" onChange={(e) => patchDraft({ name: e.target.value })} />
                </label>
              )}
              <label>
                Base URL
                <input
                  value={baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => patchDraft({ baseURL: e.target.value })}
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  placeholder={preset.keyHint}
                  onChange={(e) => patchDraft({ apiKey: e.target.value })}
                />
              </label>
              <label>
                Model id
                <input
                  value={modelId}
                  placeholder={preset.placeholderModel}
                  onChange={(e) => patchDraft({ modelId: e.target.value })}
                />
              </label>
            </div>
          )}

          <div className="onboard-footer">
            <span />
            <button
              className="btn primary"
              disabled={!endpointValid}
              onClick={() => {
                clearTest()
                setStep('test')
              }}
            >
              Continue
            </button>
          </div>
        </>
      )}

      {step === 'test' && (
        <>
          <h1>Test connection</h1>
          {isChatGPT && <p className="hint">This test uses your ChatGPT plan or credits.</p>}
          <dl className="connection-summary"><dt>Model</dt><dd>{modelId.trim()}</dd><dt>Endpoint</dt><dd>{baseURL.trim()}</dd></dl>
          <button className="btn primary" disabled={testing} onClick={() => void runTest()}>
            {testing ? 'Testing…' : result ? 'Test again' : 'Run test'}
          </button>

          {result && (
            <div className={`test-result ${result.ok ? 'ok' : 'fail'}`}>
              {result.ok ? (
                <>
                  <b>Connected</b> in {(result.latencyMs / 1000).toFixed(1)}s — the model replied:
                  “{result.message}”
                </>
              ) : (
                <>
                  <b>Failed:</b> {result.message}
                </>
              )}
            </div>
          )}

          <div className="onboard-footer">
            <button className="btn ghost" onClick={() => { clearTest(); setStep('endpoint') }}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={!result?.ok}
              onClick={() => setStep('access')}
            >
              Continue
            </button>
          </div>
        </>
      )}

      {step === 'access' && (
        <>
          <h1>Tab visibility</h1>

          <label className={`access-option ${tabAccess === 'active-tab' ? 'chosen' : ''}`}>
            <input
              type="radio"
              name="tabAccess"
              checked={tabAccess === 'active-tab'}
              onChange={() => setTabAccess('active-tab')}
            />
            <div>
              <div className="access-title">Only my current tab</div>
            </div>
          </label>

          <label className={`access-option ${tabAccess === 'all-tabs' ? 'chosen' : ''}`}>
            <input
              type="radio"
              name="tabAccess"
              checked={tabAccess === 'all-tabs'}
              onChange={() => setTabAccess('all-tabs')}
            />
            <div>
              <div className="access-title">All open tabs</div>
            </div>
          </label>

          <div className="onboard-footer">
            <button className="btn ghost" onClick={() => setStep('test')}>
              Back
            </button>
            <button className="btn primary" onClick={finish}>
              Open chat
            </button>
          </div>
        </>
      )}
    </div>
  )
}
