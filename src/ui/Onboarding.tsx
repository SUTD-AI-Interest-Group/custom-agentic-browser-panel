import { useRef, useState } from 'react'
import { fetchModelList } from '../platform/modelList'
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
  { name: 'LM Studio (local)', baseURL: 'http://127.0.0.1:1234/v1', placeholderModel: 'google/gemma-4-26b-a4b', keyHint: 'not needed' },
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
  const [models,setModels] = useState<string[]>([])
  const [discoveryError,setDiscoveryError] = useState('')
  const [discovering,setDiscovering] = useState(false)
  const discoverySequence = useRef(0)
  const [step, setStep] = useState<Step>('endpoint')
  const [presetName, setPresetName] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [tabAccess, setTabAccess] = useState<TabAccess>('active-tab')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const preset = PRESETS.find((p) => p.name === presetName)
  const endpointValid =
    baseURL.trim().length > 0 && modelId.trim().length > 0 && hasValidEndpointScheme(baseURL)

  function pickPreset(p: (typeof PRESETS)[number]) {
    discoverySequence.current++; setModels([]);setDiscovering(false);setDiscoveryError('')
    const next = applyPreset({ presetName, name, baseURL, apiKey, modelId }, p)
    setPresetName(next.presetName)
    setName(next.name)
    setBaseURL(next.baseURL)
    setApiKey(next.apiKey)
    setModelId(next.modelId)
    setResult(null)
  }

  function draftProvider(): ProviderConfig {
    return {
      id: crypto.randomUUID(),
      name: name.trim() || 'My provider',
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: apiKey.trim(),
      models: [modelId.trim()],
    }
  }

  async function runTest() {
    setTesting(true)
    setResult(null)
    setResult(await testModel(draftProvider(), modelId.trim()))
    setTesting(false)
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
          <span key={s} aria-label={`${i+1}: ${s === 'endpoint' ? 'Choose provider' : s === 'test' ? 'Test connection' : 'Choose tab access'}`} aria-current={step===s?'step':undefined} className={`onboard-dot ${steps.indexOf(step) >= i ? 'on' : ''}`} />
        ))}
      </div>

      {step === 'endpoint' && (
        <>
          <h1>Welcome 👋</h1>
          <p className="hint">
            This agent runs in your browser with OpenAI-compatible or Anthropic endpoints, including local model servers.
            Pick where your model lives:
          </p>
          <div className="preset-row">
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

          {preset && (
            <div className="provider-card onboard-form">
              {preset.name === 'Custom' && (
                <label>
                  Name
                  <input value={name} placeholder="My endpoint" onChange={(e) => setName(e.target.value)} />
                </label>
              )}
              <label>
                Base URL
                <input
                  value={baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => {discoverySequence.current++;setModels([]);setDiscovering(false);setBaseURL(e.target.value)}}
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  placeholder={preset.keyHint}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              <label>
                Model id
                <input
                  value={modelId}
                  list="onboarding-models"
                  placeholder={preset.placeholderModel}
                  onChange={(e) => setModelId(e.target.value)}
                />
              </label>
            </div>
          )}

          <datalist id="onboarding-models">{models.map(id=><option key={id} value={id}/>)}</datalist>
          <button disabled={!hasValidEndpointScheme(baseURL)||discovering} onClick={()=>{
            const sequence=++discoverySequence.current;setDiscovering(true);setDiscoveryError('')
            void fetchModelList(draftProvider()).then(rows=>{if(sequence===discoverySequence.current)setModels(rows.map(r=>r.id))}).catch(()=>{if(sequence===discoverySequence.current)setDiscoveryError('Could not discover models. Check the endpoint or enter a model ID.')}).finally(()=>{if(sequence===discoverySequence.current)setDiscovering(false)})
          }}>{discovering?'Discovering…':'Discover models'}</button>
          {discoveryError&&<p role="alert">{discoveryError}</p>}
          <p className="hint">Model discovery contacts the configured endpoint using its key. Chats send your messages and attached page or file content to that endpoint. The connection test sends only a synthetic message, without your tabs or files.</p>
          <div className="onboard-footer">
            <span />
            <button
              className="btn primary"
              disabled={!endpointValid}
              onClick={() => {
                setResult(null)
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
          <h1>Test your endpoint</h1>
          <p className="hint">
            One tiny message is sent to <b>{modelId.trim()}</b> at <b>{baseURL.trim()}</b> to make
            sure everything is wired up.
          </p>
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
            <button className="btn ghost" onClick={() => setStep('endpoint')}>
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
          <p className="hint">
            Visibility controls which tabs the agent can list. A readable current page attaches to your
            first message unless you remove it. @mentions explicitly share pages. Other reads follow
            your tool approval settings. You can change these choices in Settings.
          </p>

          <label className={`access-option ${tabAccess === 'active-tab' ? 'chosen' : ''}`}>
            <input
              type="radio"
              name="tabAccess"
              checked={tabAccess === 'active-tab'}
              onChange={() => setTabAccess('active-tab')}
            />
            <div>
              <div className="access-title">Only my current tab</div>
              <div className="access-desc">
                The agent can only ever see the tab you're looking at. @mentions offer just the
                current tab.
              </div>
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
              <div className="access-desc">
                The agent can list and (with permission) read any open tab, and you can @mention
                any of them.
              </div>
            </div>
          </label>

          <div className="onboard-footer">
            <button className="btn ghost" onClick={() => setStep('test')}>
              Back
            </button>
            <button className="btn primary" onClick={finish}>
              Start chatting
            </button>
          </div>
        </>
      )}
    </div>
  )
}
