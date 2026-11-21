import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Settings } from '../../data/settings'

// The decision model's panel-side pieces, as the Experimental tab drives them (final review I3, M5,
// M7, M9). The engine, OPFS storage and the shadow store are all stand-ins: this checks the tab's
// own decisions — when Delete is offered, what Off does, which addresses it refuses.
const engine = vi.hoisted(() => ({ dispose: vi.fn(async () => {}), resetFailures: vi.fn(), warm: vi.fn(async () => {}), decide: vi.fn() }))
const store = vi.hoisted(() => ({ status: { state: 'absent' } as unknown, files: false }))
vi.mock('../../decider/engine', () => ({ getDeciderEngine: () => engine }))
vi.mock('../../decider/shadowStore', () => ({ listShadow: vi.fn(async () => []), clearShadow: vi.fn(async () => {}) }))
vi.mock('../../decider/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../decider/storage')>()),
  getModelStatus: vi.fn(async () => store.status),
  hasModelFiles: vi.fn(async () => store.files),
  importModel: vi.fn(async () => {}),
  deleteModel: vi.fn(async () => {}),
}))

import ExperimentalTab from './ExperimentalTab'
import { deleteModel, importModel } from '../../decider/storage'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  store.status = { state: 'absent' }
  store.files = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(mode: string, commit = vi.fn()) {
  const draft = { decider: { mode } } as unknown as Settings
  await act(async () => root.render(createElement(ExperimentalTab, { draft, buffer: vi.fn(), commit, commitDraft: vi.fn() })))
  await act(async () => {}) // the status/OPFS reads settle
  return commit
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)!

it('offers Delete whenever model files are in OPFS, even when the status record says absent (I3)', async () => {
  await render('off')
  expect(button('Delete').disabled).toBe(true) // nothing recorded, nothing on disk
  await act(async () => root.unmount())
  root = createRoot(host)
  store.files = true // e.g. the record was wiped but the 4.6 GB stayed
  await render('off')
  expect(button('Delete').disabled).toBe(false)
  await act(async () => button('Delete').click())
  await act(async () => button('Sure?').click())
  expect(engine.dispose).toHaveBeenCalled()
  expect(deleteModel).toHaveBeenCalledTimes(1)
})

it('switching to Off disposes the engine; any other mode lets a blocked engine try again (M7, M5)', async () => {
  const commit = await render('shadow')
  const select = host.querySelector('select')!
  await act(async () => {
    select.value = 'off'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ decider: { mode: 'off' } }))
  expect(engine.dispose).toHaveBeenCalledTimes(1)
  expect(engine.resetFailures).not.toHaveBeenCalled()
  await act(async () => {
    select.value = 'assist'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(engine.resetFailures).toHaveBeenCalledTimes(1)
  expect(engine.dispose).toHaveBeenCalledTimes(1)
})

it('refuses a plain-http import from another host, before anything is fetched (M9)', async () => {
  await render('off')
  const input = host.querySelector('input[type=url]') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  for (const [address, imported] of [['http://example.com/model', false], ['http://127.0.0.1:8790', true]] as const) {
    vi.mocked(importModel).mockClear()
    await act(async () => {
      setValue.call(input, address)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Import from URL…').click())
    expect(vi.mocked(importModel).mock.calls.length > 0, address).toBe(imported)
  }
})

it('discloses the profile-structuring call to the chat model (M8)', async () => {
  await render('off')
  expect(host.textContent).toContain('once per panel session (if you have any) it sends them to your chat model to structure')
})
