import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ research: vi.fn(), dream: vi.fn(), chat: false, dom: false, post: vi.fn() }))
vi.mock('../agent/research', () => ({ runResearch: mocks.research }))
vi.mock('../agent/dream', () => ({ runDreamCycle: mocks.dream }))
vi.mock('../data/researchTasks', () => ({ postResearchMsg: mocks.post }))
vi.mock('../data/dreamMessages', () => ({ postDreamMsg: vi.fn() }))
vi.mock('./chatHost', () => ({ installChatHost: vi.fn(), hasChatWork: () => mocks.chat }))
vi.mock('./domHost', () => ({ installDomHost: vi.fn(), hasDomWork: () => mocks.dom }))
let listeners: Array<(msg: any, sender: any, reply: (value: any) => void) => void>
function send(msg: any) { const reply = vi.fn(); listeners.forEach(listener => listener(msg, {}, reply)); return reply.mock.calls.at(-1)?.[0] }
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers()
  listeners = []; mocks.chat = false; mocks.dom = false
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (fn: any) => listeners.push(fn) }, sendMessage: vi.fn(async () => {}) } })
  await import('./offscreen')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('counts DOM work and memory consolidation alongside chat and research', async () => {
  expect(send({ type: 'offscreen.status' })).toEqual({ busy: false })
  mocks.dom = true
  expect(send({ type: 'offscreen.status' })).toEqual({ busy: true })
  mocks.dom = false
  let finish!: (result: any) => void
  mocks.dream.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  send({ type: 'dream.run', token: 'test', job: {} })
  expect(send({ type: 'offscreen.status' })).toEqual({ busy: true })
  finish({})
  await vi.advanceTimersByTimeAsync(0)
  expect(send({ type: 'offscreen.status' })).toEqual({ busy: false })
  await vi.advanceTimersByTimeAsync(2000)
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'offscreen.idle' })
})
it('stops heartbeat timers on cancellation even if the underlying task never settles', async () => {
  mocks.research.mockImplementation(() => new Promise(() => {}))
  send({ type: 'research.start', taskId: 'task' })
  const options = mocks.research.mock.calls[0][0]
  send({ type: 'research.cancel', taskId: 'task' })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(options.signal.aborted).toBe(true)
  expect(mocks.post).not.toHaveBeenCalledWith({ type: 'research.heartbeat', taskId: 'task' })
  expect(await options.renderBroker.render('https://example.com/')).toEqual({ error: 'aborted' })
  expect(mocks.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'research.renderPage' }))
})
