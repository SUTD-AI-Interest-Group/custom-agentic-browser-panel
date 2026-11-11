import { API } from './auth.mjs'

export function responseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw new Error('Invalid ChatGPT request.')
  if (body.background || body.previous_response_id || body.conversation) throw new Error('ChatGPT plan requests must send their context explicitly.')
  return { ...body, store: false, stream: true }
}
export function visibleModels(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter(m => m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .map(m => ({ id: m.slug, displayName: typeof m.display_name === 'string' ? m.display_name : m.slug }))
}
// SSE frames can cross arbitrary network chunks. Require a terminal completion,
// including for generateText callers; an EOF alone must never mean success.
export class CompletionReader {
  buffer = ''
  completed = null
  push(text) {
    this.buffer += text
    this.buffer = this.buffer.replace(/\r\n/g, '\n')
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error('ChatGPT event exceeds the local size limit.')
    let end
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') continue
      const event = JSON.parse(data)
      if (event.type === 'response.completed' && event.response?.status === 'completed') this.completed = event.response
      if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw new Error('ChatGPT did not complete this response. Retry or check Manage usage in ChatGPT settings.')
    }
  }
  finish() {
    this.push('\n\n')
    if (!this.completed) throw new Error('ChatGPT stream ended before response.completed. Try again.')
    return this.completed
  }
}
export async function request(path, token, signal, body) {
  if (path !== '/models' && path !== '/responses') throw new Error('Unsupported ChatGPT endpoint.')
  const response = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(responseBody(body)) } : {}),
    signal, redirect: 'error',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const rawCode = data?.error?.code
    const code = typeof rawCode === 'string' && /^[a-z0-9_]{1,100}$/i.test(rawCode) ? rawCode : ''
    const requestId = response.headers.get('x-request-id') || ''
    const diagnostic = ` (HTTP ${response.status}${code ? `; ${code}` : ''}${/^[a-z0-9_-]{1,100}$/i.test(requestId) ? `; request ${requestId}` : ''})`
    if (response.status === 429) throw new Error('ChatGPT usage limit reached. Manage usage at https://chatgpt.com/settings/usage, wait, or choose another provider.' + diagnostic)
    if (response.status === 401) throw new Error('ChatGPT session or plan permission was not accepted. Sign in again in Settings → Providers.' + diagnostic)
    if (code === 'subscription_sharing_user_not_eligible') throw new Error('ChatGPT plan usage is unavailable for this user or workspace. Choose another eligible account or provider.' + diagnostic)
    if (response.status === 403) throw new Error('ChatGPT denied this request due to a policy or permission restriction. Check account eligibility, model access and serving region.' + diagnostic)
    if (response.status === 503) throw new Error('ChatGPT plan usage is temporarily unavailable. Your connection is saved; try again later.' + diagnostic)
    throw new Error('ChatGPT request failed. Retry or select another model.' + diagnostic)
  }
  return response
}
