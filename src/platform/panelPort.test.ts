import { test, expect, vi, afterEach } from 'vitest'
import { connectPanelPort } from './panelPort'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A fake chrome.runtime.Port that records its listeners so a test can fire
 *  'close' messages or a disconnect, the same way the real Port would. */
function fakePort() {
  const messageListeners: Array<(msg: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  return {
    onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    postMessage: vi.fn(),
    fireMessage: (msg: unknown) => messageListeners.slice().forEach((fn) => fn(msg)),
    fireDisconnect: () => disconnectListeners.slice().forEach((fn) => fn()),
  }
}

test('announces its windowId via a hello message once chrome.windows.getCurrent resolves', async () => {
  const port = fakePort()
  const connect = vi.fn(() => port)
  vi.stubGlobal('chrome', { runtime: { connect }, windows: { getCurrent: vi.fn(async () => ({ id: 7 })) } })

  connectPanelPort()
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: 'hello', windowId: 7 }))
})

test('a close message from the SW closes the panel document', () => {
  const port = fakePort()
  const connect = vi.fn(() => port)
  const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  vi.stubGlobal('chrome', { runtime: { connect }, windows: { getCurrent: vi.fn(async () => ({ id: 1 })) } })

  connectPanelPort()
  port.fireMessage({ type: 'close' })

  expect(closeSpy).toHaveBeenCalledTimes(1)
})

// F3: MV3 kills the service worker after ~30s idle, which tears down every Port
// it held (including this one) and fires the PANEL side's onDisconnect. Before
// this fix there was no onDisconnect listener at all, so the panel never
// reconnected — the new SW instance's openPanels map (background.ts) would never
// learn about a panel that outlived one restart, and the toggle shortcut would
// then treat an already-open panel as closed.
test('reconnects after the port disconnects, so a fresh SW instance learns about this panel again', () => {
  const ports: ReturnType<typeof fakePort>[] = []
  const connect = vi.fn(() => {
    const p = fakePort()
    ports.push(p)
    return p
  })
  vi.stubGlobal('chrome', { runtime: { connect }, windows: { getCurrent: vi.fn(async () => ({ id: 1 })) } })

  connectPanelPort()
  expect(connect).toHaveBeenCalledTimes(1)

  ports[0].fireDisconnect() // simulates the SW (and its Port) being torn down

  expect(connect).toHaveBeenCalledTimes(2)
})

test('a reconnected port re-announces windowId, and still closes on a close message', async () => {
  const ports: ReturnType<typeof fakePort>[] = []
  const connect = vi.fn(() => {
    const p = fakePort()
    ports.push(p)
    return p
  })
  const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  vi.stubGlobal('chrome', { runtime: { connect }, windows: { getCurrent: vi.fn(async () => ({ id: 3 })) } })

  connectPanelPort()
  ports[0].fireDisconnect()
  await vi.waitFor(() => expect(ports[1].postMessage).toHaveBeenCalledWith({ type: 'hello', windowId: 3 }))

  ports[1].fireMessage({ type: 'close' })
  expect(closeSpy).toHaveBeenCalledTimes(1)
})

// Bundled LOW (noted in passing by d05, assigned here since this owner already
// touches the file for F3): chrome.windows.getCurrent().then(...) had no
// .catch() — a rejection (however unlikely) would have been an unhandled
// rejection instead of the same "log and move on" treatment the outer
// chrome.runtime.connect() try/catch already gives a connect failure.
test('a getCurrent() failure while announcing hello is caught and logged, not left as an unhandled rejection', async () => {
  const port = fakePort()
  const connect = vi.fn(() => port)
  const err = new Error('boom')
  vi.stubGlobal('chrome', {
    runtime: { connect },
    windows: {
      getCurrent: vi.fn(() => Promise.reject(err)),
    },
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  connectPanelPort()

  await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith('panel port hello failed', err))
})

test('a thrown chrome.runtime.connect is caught and logged, not propagated', () => {
  const err = new Error('no such port')
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => {
        throw err
      }),
    },
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(() => connectPanelPort()).not.toThrow()
  expect(errSpy).toHaveBeenCalledWith('panel port failed', err)
})
