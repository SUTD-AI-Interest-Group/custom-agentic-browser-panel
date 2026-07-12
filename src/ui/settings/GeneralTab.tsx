import { useEffect, useState } from 'react'
import {
  DEFAULT_SYSTEM_PROMPT,
  observabilityConfig,
  type ObservabilityConfig,
  type Settings,
} from '../../data/settings'
import { testLangfuseConnection } from '../../agent/observability'

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

      <h2>Privacy</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.fetchLinkPreviews !== false}
          onChange={(e) => commit({ ...draft, fetchLinkPreviews: e.target.checked })}
        />
        Fetch link previews (contacts linked sites for title/description/image)
      </label>

      <ObservabilitySection draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
    </div>
  )
}

/**
 * Beta: opt-in Langfuse observability. A master toggle reveals key/host inputs
 * and capture options. Text fields buffer on keystroke and persist on blur (like
 * the provider fields); toggles/checkboxes persist immediately. Local `test`
 * state drives the "Test connection" button. Nothing is sent unless enabled.
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

  return (
    <>
      <h2>
        Observability<span className="beta-tag">Beta</span>
      </h2>
      <p className="hint">
        Send a trace of every model call — turns, tool use, token counts and cost — to your own{' '}
        <a href="https://langfuse.com" target="_blank" rel="noreferrer">
          Langfuse
        </a>{' '}
        project. Off by default; nothing is tracked until you turn this on. Keys are stored locally in
        your browser and sent only to your Langfuse host.
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
            Capture prompt &amp; response content (off = token/timing metadata only)
          </label>
          <label className="check sub">
            <input
              type="checkbox"
              checked={obs.captureScreenshots}
              disabled={!obs.captureContent}
              onChange={(e) => patch({ captureScreenshots: e.target.checked }, commit)}
            />
            Include screenshots (heavy; page images leave the browser)
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
    </>
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
