import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatGPTFetch, companionCall } from './chatgpt'

function nativeMock() {
  let receive: (value: unknown) => void = () => {}
  let disconnect: () => void = () => {}
  const port = {
    postMessage: vi.fn(), disconnect: vi.fn(),
    onMessage: { addListener: vi.fn(fn => { receive = fn }) },
    onDisconnect: { addListener: vi.fn(fn => { disconnect = fn }) },
  }
  vi.stubGlobal('chrome', { runtime: { connectNative: vi.fn(() => port) } })
  return { port, send: (value: unknown) => receive(value), disconnect: () => disconnect() }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('ChatGPT companion transport', () => {
  it('returns metadata and closes native ports', async () => {
    const native = nativeMock()
    const result = companionCall('status', 'profile')
    native.send({ type: 'result', value: { connected: false } })
    expect(await result).toEqual({ connected: false })
    expect(native.port.disconnect).toHaveBeenCalledOnce()
  })
  it('pins the API and never forwards the SDK Authorization header', async () => {
    const native = nativeMock()
    const request = chatGPTFetch('profile')('https://api.openai.com/v1/responses', {
      method: 'POST', body: JSON.stringify({ model: 'm', stream: true }), headers: { Authorization: 'Bearer must-not-forward' },
    })
    native.send({ type: 'headers' })
    native.send({ type: 'chunk', text: 'data: hello\n\n' })
    native.send({ type: 'end' })
    expect(await (await request).text()).toBe('data: hello\n\n')
    expect(native.port.postMessage).toHaveBeenCalledWith({ method: 'responses', profileId: 'profile', body: { model: 'm', stream: true } })
    await expect(chatGPTFetch('profile')('https://attacker.invalid/responses', { method: 'POST', body: '{}' })).rejects.toThrow('only Responses')
  })
  it('reports premature disconnect after headers as a failed stream', async () => {
    const native = nativeMock()
    const request = companionCall<Response>('responses', 'profile')
    native.send({ type: 'headers' })
    const response = await request
    native.disconnect()
    await expect(response.text()).rejects.toThrow('disconnected before completing')
  })
  it('abort closes the port and rejects pending auth', async () => {
    const native = nativeMock(), controller = new AbortController()
    const request = companionCall('signIn', 'profile', { signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.port.disconnect).toHaveBeenCalledOnce()
  })
  it('propagates an actionable usage error', async () => {
    const native = nativeMock()
    const request = companionCall('responses', 'profile')
    native.send({ type: 'error', message: 'ChatGPT usage limit reached. Manage usage.' })
    await expect(request).rejects.toThrow('Manage usage')
  })
})
