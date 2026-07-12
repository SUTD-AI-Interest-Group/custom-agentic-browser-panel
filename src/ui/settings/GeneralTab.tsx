import { useEffect, useState } from 'react'
import {
  DEFAULT_SYSTEM_PROMPT,
  observabilityConfig,
  type ObservabilityConfig,
  type Settings,
} from '../../data/settings'
import { testLangfuseConnection } from '../../agent/observability'
import { Disclosure, Section } from './primitives'

/**
 * General tab: system prompt, keyboard shortcut, privacy, observability. Text
 * fields buffer on keystroke (`buffer`) and persist on blur (`commitDraft`);
 * toggles persist immediately (`commit`). Providers live in their own tab.
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
  const customPrompt = draft.systemPrompt !== DEFAULT_SYSTEM_PROMPT

  return (
    <div className="settings-tabpane">
      <Section
        title="System prompt"
        action={
          // Only offer the reset when there is something to reset — an
          // always-visible "Reset to default" beside an untouched default is noise.
          customPrompt ? (
            <button
              className="link-btn"
              onClick={() => commit({ ...draft, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
            >
              Reset to default
            </button>
          ) : undefined
        }
      >
        <textarea
          className="system-prompt"
          rows={5}
          value={draft.systemPrompt}
          onChange={(e) => buffer({ ...draft, systemPrompt: e.target.value })}
          onBlur={commitDraft}
        />
      </Section>

      <ShortcutSection />

      <Section title="Privacy">
        <label className="check">
          <input
            type="checkbox"
            checked={draft.fetchLinkPreviews !== false}
            onChange={(e) => commit({ ...draft, fetchLinkPreviews: e.target.checked })}
          />
          Fetch link previews
        </label>
        <p className="hint">Contacts linked sites for their title, description and image.</p>
      </Section>

      <ObservabilitySection draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
    </div>
  )
}

/**
 * Beta: opt-in Langfuse observability. Collapsed by default — it is beta, niche and
 * six controls deep, and it used to dominate the General tab. The closed summary
 * still reports whether it is on, so folding it away never hides that.
 *
 * Text fields buffer on keystroke and persist on blur (like the provider fields);
 * toggles persist immediately. Nothing is sent unless enabled.
 */
function ObservabilitySection({
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
  const obs = observabilityConfig(draft)
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'err'; message: string }>({
    state: 'idle',
    message: '',
  })

  // Apply an observability patch, either buffering (text) or committing (toggles).
  const patch = (p: Partial<ObservabilityConfig>, persist: (next: Settings) => void) =>
    persist({ ...draft, observability: { ...obs, ...p } })

  const host = obs.host.replace(/^https?:\/\//, '')

  return (
    <Section title="Observability">
      <Disclosure summary="Langfuse tracing (beta)" status={obs.enabled ? `On · ${host}` : 'Off'}>
      <p className="hint">
        Trace every model call — turns, tools, tokens, cost — to your own{' '}
        <a href="https://langfuse.com" target="_blank" rel="noreferrer">
          Langfuse
        </a>{' '}
        project. Nothing leaves the browser until you turn this on.
      </p>
      <div className="switch-row">
        <span className="switch-label">Enable Langfuse observability</span>
        <label className="switch-toggle">
          <input
            type="checkbox"
            checked={obs.enabled}
            onChange={(e) => patch({ enabled: e.target.checked }, commit)}
          />
          <span className="track" />
          <span className="thumb" />
        </label>
      </div>

      {obs.enabled && (
        <div className="obs-panel">
          <label>
            Public key
            <input
              value={obs.publicKey}
              placeholder="pk-lf-…"
              onChange={(e) => patch({ publicKey: e.target.value }, buffer)}
              onBlur={commitDraft}
            />
          </label>
          <label>
            Secret key
            <input
              type="password"
              value={obs.secretKey}
              placeholder="sk-lf-…"
              onChange={(e) => patch({ secretKey: e.target.value }, buffer)}
              onBlur={commitDraft}
            />
          </label>
          <label>
            Host
            <input
              value={obs.host}
              placeholder="https://cloud.langfuse.com"
              onChange={(e) => patch({ host: e.target.value }, buffer)}
              onBlur={commitDraft}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={obs.captureContent}
              onChange={(e) => patch({ captureContent: e.target.checked }, commit)}
            />
            Capture prompt &amp; response content
          </label>
          <label className="check sub">
            <input
              type="checkbox"
              checked={obs.captureScreenshots}
              disabled={!obs.captureContent}
              onChange={(e) => patch({ captureScreenshots: e.target.checked }, commit)}
            />
            Include screenshots (heavy)
          </label>
          <div className="obs-actions">
            <button
              className="btn ghost small"
              disabled={test.state === 'testing' || !obs.publicKey || !obs.secretKey || !obs.host}
              onClick={async () => {
                setTest({ state: 'testing', message: 'Testing…' })
                const r = await testLangfuseConnection(obs.host, obs.publicKey, obs.secretKey)
                setTest({ state: r.ok ? 'ok' : 'err', message: r.message })
              }}
            >
              Test connection
            </button>
            {test.state !== 'idle' && (
              <span className={`obs-status ${test.state === 'ok' ? 'ok' : test.state === 'err' ? 'err' : ''}`}>
                {test.message}
              </span>
            )}
          </div>
        </div>
      )}
      </Disclosure>
    </Section>
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
    <Section
      title="Keyboard shortcut"
      hint="Chrome owns global shortcuts, so rebinding opens its shortcuts page."
    >
      <div className="shortcut-row">
        <span className="shortcut-label">Toggle sidebar</span>
        <kbd className="shortcut-key">{loaded ? shortcut ?? 'Not set' : '…'}</kbd>
        <button
          className="btn ghost small"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          Change ↗
        </button>
      </div>
    </Section>
  )
}
