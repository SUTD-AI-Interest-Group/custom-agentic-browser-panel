import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ capture: vi.fn(), save: vi.fn(), describe: vi.fn(), classify: vi.fn(), dispose: vi.fn(), foreground: vi.fn() }))
vi.mock('../platform/mirageEngine', () => ({ describeMirage: mocks.describe, classifyMirage: mocks.classify, disposeMirage: mocks.dispose }))
vi.mock('../platform/screenshot', async original => ({ ...(await original<typeof import('../platform/screenshot')>()), capture: mocks.capture }))
vi.mock('../data/screenshots', () => ({ saveShot: mocks.save }))
vi.mock('../platform/splitView', async original => ({ ...(await original<typeof import('../platform/splitView')>()), isTabShowing: mocks.foreground }))
import { createAgentTools, type PageControlGate } from './tools'

const tab = { id: 7, windowId: 1, active: true, url: 'https://example.com/', title: 'Test' } as chrome.tabs.Tab
const full = 'data:image/png;base64,FULL'
const artifact = 'data:image/png;base64,ARTIFACT'
let mode = 'assist'
let decisionMode = 'off'
beforeEach(() => {
  vi.clearAllMocks()
  mode = 'assist'
  decisionMode = 'off'
  vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({ settings: { mirageMode: mode, mirageDecisionMode: decisionMode } })) } } })
  mocks.foreground.mockResolvedValue(true)
  mocks.capture.mockResolvedValue({ shot: { dataUrl: full, width: 800, height: 600 }, artifact: { dataUrl: artifact, width: 400, height: 300 }, meta: { url: tab.url, title: tab.title, label: 'viewport' } })
  mocks.save.mockResolvedValue('saved-shot')
  mocks.describe.mockResolvedValue({ result: { text: [{ string: 'Saved', score: 0.9 }] }, timing: { loadMs: 1, inferenceMs: 2, totalMs: 3 }, heapBytes: 1024 })
})
afterEach(() => vi.unstubAllGlobals())
function build(approval: ReturnType<typeof vi.fn<() => Promise<boolean>>>, owned = false) {
  const control: PageControlGate = { session: () => owned ? { tabId: 7, active: true, origin: 'https://example.com', plan: 'test' } : null, requestSession: async () => false, endSession: () => {} }
  return createAgentTools(approval, 'active-tab', new Set(), control, null, false, [], () => 'ask', 'test', new Set(), undefined, undefined, { resolveTab: async () => tab })
}
async function screenshot(approval: ReturnType<typeof vi.fn<() => Promise<boolean>>>, owned = false, element = false) {
  const tools = build(approval, owned)
  return (tools[element ? 'GetElementScreenshot' : 'GetScreenshot'].execute as Function)({ reason: 'verify', expectedText: 'Saved', ...(element ? { region: 2 } : {}) }, { toolCallId: 'test', messages: [] })
}

describe('approved screenshot → local perception integration', () => {
  it.each([false, true])('denial prevents both capture and inference (element=%s)', async (element) => {
    const approval = vi.fn(async () => false)
    await screenshot(approval, false, element)
    expect(approval).toHaveBeenCalledOnce()
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
  })
  it('uses the full capture only after approval and keeps the user artifact', async () => {
    const approval = vi.fn(async () => true)
    const result = await screenshot(approval)
    expect(approval.mock.invocationCallOrder[0]).toBeLessThan(mocks.capture.mock.invocationCallOrder[0])
    expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(mocks.describe.mock.invocationCallOrder[0])
    expect(mocks.describe).toHaveBeenCalledWith(full)
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: artifact }))
    expect(result).toMatchObject({ ok: true, shotId: 'saved-shot', localPerception: { verification: { status: 'text-observed' } } })
    expect(JSON.stringify(result)).not.toContain('base64')
  })
  it('preserves the existing same-tab page-control permission exemption', async () => {
    const approval = vi.fn(async () => false)
    const result = await screenshot(approval, true)
    expect(approval).not.toHaveBeenCalled()
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(result).toHaveProperty('shotId', 'saved-shot')
  })
  it('parks a background tab before approval, capture or inference', async () => {
    mocks.foreground.mockResolvedValue(false)
    const approval = vi.fn(async () => true)
    expect(await screenshot(approval)).toHaveProperty('parked', true)
    expect(approval).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
  })
  it('keeps the screenshot usable when model inference fails', async () => {
    mocks.describe.mockRejectedValue(new Error('WASM failed'))
    expect(await screenshot(vi.fn(async () => true))).toMatchObject({ ok: true, shotId: 'saved-shot', localPerception: { status: 'unavailable' } })
  })
  it('off retains original screenshot delivery without inference', async () => {
    mode = 'off'
    expect(await screenshot(vi.fn(async () => true))).toMatchObject({ ok: true, shotId: 'saved-shot' })
    expect(mocks.describe).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
  })
  it('shadow never serializes recognized text into the tool result', async () => {
    mode = 'shadow'
    const result = await screenshot(vi.fn(async () => true))
    expect(result.localPerception).toMatchObject({ status: 'completed-locally' })
    expect(JSON.stringify(result.localPerception)).not.toContain('Saved')
  })
})

describe('visual classification stays inside screenshot permission', () => {
  beforeEach(() => {
    decisionMode = 'assist'
    mocks.classify.mockResolvedValue({ result: { form: { screen_type: { value: 'dialog', probabilities: { dialog: 0.9, form: 0.04, document: 0.04, other: 0.02 } } } }, timing: { loadMs: 0, inferenceMs: 4, totalMs: 4 }, heapBytes: 1024 })
  })
  it.each([false, true])('denial prevents classifier even when both modes enabled (element=%s)', async element => {
    await screenshot(vi.fn(async () => false), false, element)
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
  })
  it('uses one capture and the same image for both model passes', async () => {
    const approval = vi.fn(async () => true)
    const result = await screenshot(approval)
    expect(approval).toHaveBeenCalledOnce()
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.describe).toHaveBeenCalledWith(full)
    expect(mocks.classify).toHaveBeenCalledWith(full)
    expect(result).toMatchObject({ ok: true, shotId: 'saved-shot', localPerception: { decisionExperiment: { routingHint: { tool: 'ReadPage' } } } })
    expect(JSON.stringify(result)).not.toContain('base64')
  })
})
