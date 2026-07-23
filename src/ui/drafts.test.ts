import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearDraft, draftKey, loadDraft, saveDraft } from './drafts'

// Minimal chrome.storage.local stub — an in-memory object plus the get/set/
// remove surface the module actually calls. No other chrome.* API is touched
// by drafts.ts, so this is the whole fake.
function stubChromeStorage() {
  const store: Record<string, unknown> = {}
  const chromeStub = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
      },
    },
  }
  vi.stubGlobal('chrome', chromeStub)
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('draftKey namespaces by conversation id', () => {
  expect(draftKey('abc-123')).toBe('draft:abc-123')
  expect(draftKey('')).toBe('draft:')
})

test('loadDraft returns empty string when nothing is stored', async () => {
  stubChromeStorage()
  await expect(loadDraft('conv-1')).resolves.toBe('')
})

test('saveDraft debounces: only the last call within the window is written', async () => {
  const store = stubChromeStorage()
  saveDraft('conv-1', 'h')
  saveDraft('conv-1', 'he')
  saveDraft('conv-1', 'hel')
  saveDraft('conv-1', 'hello')
  // Nothing hits storage until the debounce window elapses.
  expect(store['draft:conv-1']).toBeUndefined()
  await vi.advanceTimersByTimeAsync(400)
  expect(store['draft:conv-1']).toBe('hello')
  await expect(loadDraft('conv-1')).resolves.toBe('hello')
})

test('saveDraft keys are independent — switching conversation does not cancel the other timer', async () => {
  const store = stubChromeStorage()
  saveDraft('conv-1', 'first chat draft')
  saveDraft('conv-2', 'second chat draft')
  await vi.advanceTimersByTimeAsync(400)
  expect(store['draft:conv-1']).toBe('first chat draft')
  expect(store['draft:conv-2']).toBe('second chat draft')
})

test('clearDraft removes the stored value and cancels a pending write', async () => {
  const store = stubChromeStorage()
  saveDraft('conv-1', 'about to send')
  await clearDraft('conv-1')
  await vi.advanceTimersByTimeAsync(400)
  // The debounced write from before clearDraft must not resurrect the value.
  expect(store['draft:conv-1']).toBeUndefined()
  await expect(loadDraft('conv-1')).resolves.toBe('')
})

test('clearDraft on an already-empty key is a harmless no-op', async () => {
  stubChromeStorage()
  await expect(clearDraft('never-saved')).resolves.toBeUndefined()
})
