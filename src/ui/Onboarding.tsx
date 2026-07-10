import { useState } from 'react'
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

export default function Onboarding({
  settings,
  onComplete,
}: {
  settings: Settings
  onComplete: (next: Settings) => void
}) {
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
  const endpointValid = baseURL.trim().length > 0 && modelId.trim().length > 0

  function pickPreset(p: (typeof PRESETS)[number]) {
    setPresetName(p.name)
    setName(p.name === 'Custom' ? '' : p.name)
    setBaseURL(p.baseURL)
    setModelId('')
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
          <span key={s} className={`onboard-dot ${steps.indexOf(step) >= i ? 'on' : ''}`} />
        ))}
      </div>

      {step === 'endpoint' && (
        <>
          <h1>Welcome 👋</h1>
          <p className="hint">
            This agent runs entirely in your browser against any OpenAI-compatible endpoint.
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
                  onChange={(e) => setBaseURL(e.target.value)}
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
                  placeholder={preset.placeholderModel}
                  onChange={(e) => setModelId(e.target.value)}
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
            Choose what the agent is allowed to see. Every individual read still asks for your
            permission in the chat, and you can @mention tabs to share them explicitly. Changeable
            any time in Settings.
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
