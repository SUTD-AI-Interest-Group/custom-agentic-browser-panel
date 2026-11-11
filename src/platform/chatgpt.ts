/** Native messaging keeps OAuth credentials outside Chrome storage and page scripts. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
const HOST = 'app.lychee.chatgpt'
export interface ChatGPTSession { connected: boolean; sharing: boolean; email: string; revoked?: boolean }
export interface ChatGPTModel { id: string; displayName: string }
export type ChatGPTMethod = 'status' | 'signIn' | 'signOut' | 'models' | 'responses'

export function companionCall<T>(method: ChatGPTMethod, profileId: string, options: { body?: unknown; signal?: AbortSignal | null } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return }
    let port: chrome.runtime.Port
    try { port = chrome.runtime.connectNative(HOST) }
    catch { reject(new Error('Install the Lychee ChatGPT companion and enable its browser permission. See the setup instructions below sign-in.')); return }
    let settled = false
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const cleanup = () => {
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      port.disconnect()
    }
    const fail = (error: unknown) => {
      if (settled) return
      stream?.error(error)
      reject(error)
      cleanup()
    }
    const abort = () => fail(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
    const timeout = setTimeout(() => fail(new Error('ChatGPT operation timed out. Please try again.')), method === 'responses' ? 660_000 : method === 'signIn' ? 330_000 : 60_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    port.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError
      if (!settled) fail(new Error(lastError ? 'ChatGPT companion unavailable. Install it for this extension ID, then retry.' : 'ChatGPT companion disconnected before completing the request.'))
    })
    port.onMessage.addListener((message: { type: string; value?: T; message?: string; text?: string; json?: boolean }) => {
      if (settled) return
      if (message.type === 'error') fail(new Error(message.message || 'ChatGPT request failed.'))
      else if (message.type === 'result') { resolve(message.value as T); cleanup() }
      else if (message.type === 'headers' && !stream) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller }, cancel() { cleanup() } })
        resolve(new Response(body, { headers: { 'Content-Type': message.json ? 'application/json' : 'text/event-stream' } }) as T)
      } else if (message.type === 'chunk' && stream) stream.enqueue(new TextEncoder().encode(message.text))
      else if (message.type === 'end' && stream) { stream.close(); cleanup() }
      else fail(new Error('Invalid ChatGPT companion response.'))
    })
    try { port.postMessage({ method, profileId, ...(options.body ? { body: options.body } : {}) }) }
    catch (error) { fail(error) }
  })
}

/** SDK-compatible fetch, pinned to the Responses API. No bearer token enters JS. */
export function chatGPTFetch(profileId: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error('ChatGPT plan supports only Responses API requests.')
    }
    return companionCall<Response>('responses', profileId, { body: JSON.parse(init.body), signal: init.signal })
  }
}
