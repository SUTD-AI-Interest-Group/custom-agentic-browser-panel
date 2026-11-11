import ChatGPTProvider from './settings/ChatGPTProvider'
import { useEffect, useRef, useState } from 'react'
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
  const discoveryController = useRef<AbortController | null>(null)
  function clearDiscovery() {
    discoverySequence.current++; discoveryController.current?.abort(); discoveryController.current = null
    setModels([]); setDiscovering(false); setDiscoveryError('')
  }
  useEffect(() => () => { discoverySequence.current++; discoveryController.current?.abort() }, [])
  const [chatGPT, setChatGPT] = useState<ProviderConfig>(() => ({ id: crypto.randomUUID(), name: 'ChatGPT plan', kind: 'chatgpt', baseURL: 'https://api.openai.com/v1', apiKey: '', models: [] }))
  const [step, setStep] = useState<Step>('endpoint')
  const [draft, setDraft] = useState<OnboardingDraft>({ presetName: null, name: '', baseURL: '', apiKey: '', modelId: '' })
  const { presetName, name, baseURL, apiKey, modelId } = draft
  const patchDraft = (patch: Partial<OnboardingDraft>) => {
    if ('baseURL' in patch || 'apiKey' in patch) clearDiscovery()
    clearTest()
    setDraft(current => ({ ...current, ...patch }))
  }
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
    clearDiscovery()
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
          <span key={s} aria-label={`${i+1}: ${s === 'endpoint' ? 'Choose provider' : s === 'test' ? 'Test connection' : 'Choose tab access'}`} aria-current={step===s?'step':undefined} className={`onboard-dot ${steps.indexOf(step) >= i ? 'on' : ''}`} />
        ))}
      </div>

      {step === 'endpoint' && (
        <>
          <h1>Connect a model</h1>
          <div className="preset-row">
            <button className={`btn small ${isChatGPT ? 'primary' : 'ghost'}`} onClick={() => {
              clearDiscovery(); clearTest(); setDraft({ presetName: 'ChatGPT plan', name: 'ChatGPT plan', baseURL: 'https://api.openai.com/v1', apiKey: '', modelId: chatGPT.models[0] || '' })
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
                  list="onboarding-models"
                  placeholder={preset.placeholderModel}
                  onChange={(e) => patchDraft({ modelId: e.target.value })}
                />
              </label>
            </div>
          )}

          {!isChatGPT && <>
          <datalist id="onboarding-models">{models.map(id=><option key={id} value={id}/>)}</datalist>
          <button disabled={!hasValidEndpointScheme(baseURL)||discovering} onClick={()=>{
            const sequence=++discoverySequence.current;setDiscovering(true);setDiscoveryError('')
            discoveryController.current?.abort(); const controller = new AbortController(); discoveryController.current = controller
            void fetchModelList(draftProvider(), controller.signal).then(rows=>{if(sequence===discoverySequence.current)setModels(rows.map(r=>r.id))}).catch(()=>{if(sequence===discoverySequence.current)setDiscoveryError('Could not discover models. Check the endpoint or enter a model ID.')}).finally(()=>{if(sequence===discoverySequence.current)setDiscovering(false)})
          }}>{discovering?'Discovering…':'Discover models'}</button>
          {discoveryError&&<p role="alert">{discoveryError}</p>}
          <p className="hint">Model discovery contacts the configured endpoint using its key. Chats send your messages and attached page or file content to that endpoint. The connection test sends only a synthetic message, without your tabs or files.</p>
          </>}
          <div className="onboard-footer">
            <span />
            <button
              className="btn primary"
              disabled={!endpointValid}
              onClick={() => {
                clearTest()
                clearDiscovery(); setStep('test')
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
