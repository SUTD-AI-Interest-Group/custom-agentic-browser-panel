import { useEffect, useId, useRef, useState } from 'react'
import type { ProviderConfig } from '../../data/settings'
import { companionCall, CHATGPT_USAGE_URL, type ChatGPTModel, type ChatGPTSession } from '../../platform/chatgpt'

export function ChatGPTPrivacy() {
  const titleId = useId()
  const introId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  return <>
    <button className="link-btn chatgpt-privacy-link" onClick={() => dialog.current?.showModal()}>
      How your data is shared
    </button>
    <dialog ref={dialog} className="chatgpt-privacy" aria-labelledby={titleId} aria-describedby={introId}>
      <div className="chatgpt-privacy-heading">
        <span className="chatgpt-eyebrow">PROVIDER PRIVACY</span>
        <button className="icon-btn" aria-label="Close privacy details" autoFocus onClick={() => dialog.current?.close()}>×</button>
      </div>
      <h2 id={titleId}>ChatGPT, Lychee & your data</h2>
      <p id={introId}>OpenAI processes the context Lychee sends to answer your requests. Where that data travels depends on how Lychee connects.</p>
      <div className="chatgpt-privacy-label">
        <section>
          <h3>Current connection: local companion</h3>
          <p className="chatgpt-category">This build · Device → OpenAI</p>
          <p>This build sends ChatGPT requests through the companion on your device directly to OpenAI. It does not send ChatGPT-provider data to Supabase.</p>
          <p>A hosted Supabase connection is planned but is not enabled. The hosted details below describe that proposal, not a service you are currently using.</p>
        </section>
        <section>
          <h3>Sent to OpenAI</h3>
          <p className="chatgpt-category">User content · Browser context · Tool results</p>
          <p>Your messages, conversation context, instructions, relevant memories and skills, and attached images or documents included in a request. Page titles, URLs, page text, screenshots, and browser or MCP tool results are sent when included by Lychee’s context features or allowed tools.</p>
          <p>This can include personal or sensitive information on pages you are signed in to. Your tab-access and tool-permission settings still apply.</p>
        </section>
        <section>
          <h3>Associated with your account</h3>
          <p className="chatgpt-category">Account · App installation · Usage</p>
          <p>With the current local connection, OpenAI receives Lychee’s app name and a stable installation ID during sign-in. Requests use your authorized account and workspace and count toward your eligible plan usage or credits. OpenAI also receives connection information such as your device’s public IP address.</p>
          <p>Model tests, chat naming, summaries, research and memory processing can also use your plan when they use this provider.</p>
        </section>
        <section>
          <h3>What Lychee receives</h3>
          <p className="chatgpt-category">Verified identity · Permission · Model responses</p>
          <p>The local companion receives your account identifier, email when provided, granted permissions and sign-in tokens. Lychee can use the models your account makes available and receives their responses.</p>
          <p>Sign-in does not grant Lychee access to your existing ChatGPT conversations or your ChatGPT password.</p>
        </section>
        <section>
          <h3>Stored on this device</h3>
          <p className="chatgpt-category">Connection · Chat history</p>
          <p>In the current local connection, sign-in tokens stay in owner-only files managed by the companion, outside browser storage. These files are not encrypted by the companion. Lychee stores provider settings and its own chat data locally. Signing out clears companion tokens and attempts to revoke the remote session; it does not delete your Lychee chats.</p>
          <p>Requests set <code>store: false</code>. This is not a promise of zero retention or no training; OpenAI’s applicable policies and your account controls govern its handling of data.</p>
        </section>
        <section>
          <h3>Planned: hosted through Supabase</h3>
          <p className="chatgpt-category">Not enabled · Device → Lychee backend on Supabase → OpenAI</p>
          <p>A hosted connection would send the request content described above through a Lychee-operated backend on Supabase. That backend would process your prompts, included browser context and attachments, tool results, and OpenAI’s responses.</p>
          <p>The backend would also need to manage your account identifiers, granted permissions, and OpenAI access and refresh tokens. Those tokens would no longer be stored only on your device. Lychee’s backend and its hosting provider would be additional data handlers; the backend would be able to read the data it processes.</p>
          <p>Supabase would receive connection information such as your IP address. OpenAI would receive requests from the backend, while direct sign-in to OpenAI would still expose your browser’s connection information to OpenAI.</p>
          <p>Hosted token protection, logging, retention, backups and deletion behavior have not been implemented or verified. Creating a Supabase project alone does not enable this connection. We will update these details before offering hosted sign-in.</p>
        </section>
        <section>
          <h3>Other destinations you enable</h3>
          <p>If you enable Langfuse tracing, prompt and response content may also go to your configured Langfuse service. Connected MCP tools receive their own tool inputs. Review those settings separately.</p>
        </section>
      </div>
      <p className="hint">Connecting alone does not upload your browser history. Data is shared as Lychee runs model requests and permitted tools.</p>
      <div className="chatgpt-links">
        <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage & app access</a>
        <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI privacy policy</a>
        <a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">Supabase privacy policy (planned hosting)</a>
      </div>
      <button className="btn" onClick={() => dialog.current?.close()}>Done</button>
    </dialog>
  </>
}

export default function ChatGPTProvider({ provider, onChange }: {
  provider: ProviderConfig
  onChange: (patch: Partial<ProviderConfig>) => void
}) {
  const [session, setSession] = useState<ChatGPTSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [setup, setSetup] = useState(false)
  const statusRequest = useRef<AbortController | null>(null)
  const pending = useRef<AbortController | null>(null)
  const change = useRef(onChange)
  change.current = onChange
  useEffect(() => {
    const controller = new AbortController()
    statusRequest.current = controller
    void companionCall<ChatGPTSession>('status', provider.id, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSession(value) }).catch(() => { if (!controller.signal.aborted) setSetup(true) })
    return () => { controller.abort(); pending.current?.abort() }
  }, [provider.id])

  async function run(action: 'signIn' | 'signOut' | 'models') {
    if (pending.current) return
    statusRequest.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setMessage('')
    try {
      if (action === 'signIn') {
        // This call stays in the click gesture; other providers need no new permission.
        const allowed = await chrome.permissions.request({ permissions: ['nativeMessaging'] })
        if (!allowed) throw new Error('Browser permission was declined. Allow native messaging to connect the local companion.')
      }
      if (action !== 'models') {
        const next = await companionCall<ChatGPTSession>(action, provider.id, { signal: controller.signal })
        if (controller.signal.aborted) return
        setSession(next); setSetup(false)
        // Clear the previous catalog before discovering the newly authorized grant.
        change.current({ models: [], modelNames: {} })
        if (action === 'signOut') {
          setMessage(next.revoked ? 'Signed out. Local tokens cleared.' : 'Signed out locally. Remote revocation was not confirmed; disconnect Lychee in ChatGPT settings.')
          return
        }
        if (!next.sharing) { setMessage('Signed in, but ChatGPT plan usage was not granted. Continue with ChatGPT to authorize plan usage.'); return }
        setMessage('Connected. Eligible requests use your ChatGPT plan or credits. Loading models…')
      }
      const models = await companionCall<ChatGPTModel[]>('models', provider.id, { signal: controller.signal })
      if (controller.signal.aborted) return
      change.current({ models: models.map(m => m.id), modelNames: Object.fromEntries(models.map(m => [m.id, m.displayName])) })
      setMessage(models.length ? `Using ChatGPT plan · ${models.length} model${models.length === 1 ? '' : 's'} available.` : 'Connected, but no models are available for this account.')
    } catch (error) {
      if (!controller.signal.aborted) { setMessage(error instanceof Error ? error.message : 'Could not connect to ChatGPT.'); setSetup(true) }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  return <div className="chatgpt-provider">
    <p className="hint">Use eligible ChatGPT plan usage or credits. No API key needed. Requires the local companion on macOS or Linux.</p>
    {session?.connected && <p className="chatgpt-account"><strong>{session.email || 'ChatGPT account connected'}</strong><br />{session.sharing ? 'ChatGPT plan usage enabled' : 'Plan usage not enabled'}</p>}
    <button className="chatgpt-signin" disabled={busy} onClick={() => void run('signIn')}>Continue with ChatGPT</button>
    <ChatGPTPrivacy />
    <div className="chatgpt-links">
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
      {session?.connected && <>
        <button className="link-btn" disabled={busy} onClick={() => void run('models')}>Refresh models</button>
        <button className="link-btn" disabled={busy} onClick={() => void run('signOut')}>Sign out</button>
      </>}
      {busy && <button className="link-btn" onClick={() => { pending.current?.abort(); setMessage('Cancelled. Check connection status by reopening this provider.'); }}>Cancel</button>}
    </div>
    <p className="hint" role="status" aria-live="polite">{busy ? 'Working… Complete any sign-in steps in your browser.' : message}</p>
    {provider.models.length > 0 && <p className="hint">Models: {provider.models.map(id => provider.modelNames?.[id] || id).join(', ')}. Choose a model in the chat’s model picker.</p>}
    <details open={setup} onToggle={event => setSetup(event.currentTarget.open)}>
      <summary>Local companion setup</summary>
      <p className="hint">From the Lychee source folder, run these commands once. Use Node.js 22 or later. Keep the folder in place so the browser can launch it.</p>
      <pre className="chatgpt-setup">npm ci --prefix companion/chatgpt{'\n'}node companion/chatgpt/install.mjs {typeof chrome !== 'undefined' ? chrome.runtime?.id || 'YOUR_EXTENSION_ID' : 'YOUR_EXTENSION_ID'}</pre>
      <p className="hint">The default browser is Chrome. Append <code>edge</code>, <code>brave</code> or <code>chromium</code> for another browser. Reload the extension after setup. Each browser installation needs its own registration.</p>
      <a href="https://developers.openai.com/siwc/token-sharing-open-source" target="_blank" rel="noreferrer">About ChatGPT plan eligibility</a>
    </details>
  </div>
}
