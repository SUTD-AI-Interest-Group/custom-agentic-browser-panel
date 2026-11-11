import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlWebMcpInvocation, inspectWebMcp, discoverWebMcp, executeWebMcp, webMcpDiagnostic, type WebMcpSnapshot } from './webmcp'

const action = { name: 'search', description: 'Find products', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
function api(value: unknown) { Object.defineProperty(document, 'modelContext', { value, configurable: true }) }
function bridge() {
  const executeScript = vi.fn(async ({ func, args }: any) => [{ result: await (0, eval)(`(${func.toString()})`)(...JSON.parse(JSON.stringify(args))), documentId: 'doc-1' }])
  vi.stubGlobal('chrome', { scripting: { executeScript } })
  return executeScript
}
async function discover() {
  const value = await inspectWebMcp()
  if (!('tools' in value)) throw new Error(JSON.stringify(value))
  return value
}
async function inspectCall(snapshot: WebMcpSnapshot, tool = snapshot.tools[0], args = {}) {
  const invocationId = crypto.randomUUID()
  controlWebMcpInvocation(invocationId, 'prepare')
  try { return await inspectWebMcp({ url: snapshot.url, tool, args, revision: snapshot.revision!, invocationId }) }
  finally { controlWebMcpInvocation(invocationId, 'finish') }
}
afterEach(() => {
  api(undefined)
  for (const key of ['modelContext', 'modelContextTesting']) Object.defineProperty(navigator, key, { value: undefined, configurable: true })
  delete (globalThis as any).__lycheeWebMcpRegistry
  for (const id of (globalThis as any).__lycheeWebMcpInvocations?.keys() ?? []) controlWebMcpInvocation(id, 'finish')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('discovery and descriptor identity', () => {
  it('distinguishes unavailable APIs from no registered tools', async () => {
    const unsupported = await discover()
    expect(unsupported).toMatchObject({ status: 'unsupported', tools: [] })
    api({ getTools: async () => [] })
    const empty = await discover()
    expect(empty).toMatchObject({ status: 'empty', tools: [] })
    expect(webMcpDiagnostic(unsupported)).toContain('chrome://flags/#enable-webmcp-testing')
    expect(webMcpDiagnostic(empty)).toContain('no registered actions')
  })
  it('preserves metadata without serializing Window, and hides debugging tools', async () => {
    const metadata = { title: 'Find tea', origin: 'https://example.com', outputSchema: { type: 'object' }, annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true } }
    api({ getTools: async () => [{ ...action, ...metadata, window }, { ...action, name: 'debug', annotations: { debugging: true } }] })
    const snapshot = await discover()
    expect(snapshot.tools).toHaveLength(1)
    expect(snapshot.tools[0]).toEqual({ ...action, ...metadata, handle: expect.any(String) })
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })
  it('keeps handles and revisions stable across reordered descriptors and schema keys', async () => {
    const getTools = vi.fn(async () => [action, { ...action, name: 'other' }])
    api({ getTools })
    const before = await discover()
    getTools.mockResolvedValue([{ ...action, name: 'other' }, { ...action, inputSchema: { properties: { query: { type: 'string' } }, type: 'object' } }])
    const after = await discover()
    expect(after.revision).toBe(before.revision)
    expect(after.tools[1].handle).toBe(before.tools[0].handle)
  })
  it.each([
    { description: 'Changed' }, { title: 'Changed' }, { origin: 'https://other.example' },
    { annotations: { readOnlyHint: true } }, { outputSchema: { type: 'string' } },
    { inputSchema: { type: 'object', properties: { query: { type: 'number' } } } }, { window: {} },
  ])('invalidates a discovered handle on metadata or owner changes: %j', async change => {
    const getTools = vi.fn(async () => [action])
    const executeTool = vi.fn()
    api({ getTools, executeTool })
    const before = await discover()
    getTools.mockResolvedValue([{ ...action, ...change }])
    expect(await inspectCall(before)).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    const after = await discover()
    expect(after.revision).not.toBe(before.revision)
    expect(after.tools[0].handle).not.toBe(before.tools[0].handle)
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('rejects changed URLs, missing tools, forged handles and duplicate names before dispatch', async () => {
    const getTools = vi.fn(async () => [action])
    const executeTool = vi.fn()
    api({ getTools, executeTool })
    const snapshot = await discover()
    expect(await inspectCall({ ...snapshot, url: 'https://changed.example/' })).toMatchObject({ error: expect.stringContaining('page changed'), executionMayHaveRun: false })
    expect(await inspectCall(snapshot, { ...snapshot.tools[0], handle: 'forged' })).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    getTools.mockResolvedValue([])
    expect(await inspectCall(snapshot)).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    getTools.mockResolvedValue([action, action])
    expect(await inspectCall(await discover())).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('invalidates on replacement of the API object even with identical tools', async () => {
    api({ getTools: async () => [action] })
    const before = await discover()
    api({ getTools: async () => [action] })
    expect((await discover()).revision).not.toBe(before.revision)
  })
  it('isolates malformed descriptors and bounds metadata', async () => {
    const cyclic: any = {}; cyclic.self = cyclic
    api({ getTools: async () => [null, {}, { ...action, inputSchema: '{' }, { ...action, inputSchema: [] }, { ...action, inputSchema: cyclic }, { ...action, outputSchema: 'null' }, { ...action, annotations: { readOnlyHint: 'yes' } }, { ...action, description: 'x'.repeat(2001) }, { ...action, inputSchema: { description: 'x'.repeat(65_537) } }, action] })
    const snapshot = await discover()
    expect(snapshot.tools).toHaveLength(1)
    expect(snapshot.diagnostics).toHaveLength(9)
    expect(snapshot.tools[0].name).toBe('search')
  })
  it('rejects a non-array tool list with an explicit discovery error', async () => {
    api({ getTools: async () => ({ tools: [action] }) })
    expect(await inspectWebMcp()).toMatchObject({ phase: 'discovery', executionMayHaveRun: false })
  })
  it('limits discovery and diagnostic counts', async () => {
    api({ getTools: async () => Array.from({ length: 150 }, () => null) })
    const snapshot = await discover()
    expect(snapshot.diagnostics).toHaveLength(20)
    expect(snapshot.diagnostics?.[0]).toContain('100')
  })
})

describe('execution', () => {
  it('passes the original native descriptor, object arguments and an abort signal exactly once', async () => {
    const native = { ...action, window }
    const executeTool = vi.fn(async () => 'done')
    api({ getTools: async () => [native], executeTool })
    expect(await inspectCall(await discover(), undefined, { query: 'tea' })).toEqual({ result: 'done' })
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(native, { query: 'tea' }, { signal: expect.any(AbortSignal) })
  })
  it.each(['legacy', 'transitional', 'older-native'])('supports %s argument encoding without retrying', async kind => {
    const native = { ...action, inputSchema: JSON.stringify(action.inputSchema) }
    const executeTool = vi.fn(async () => 'done')
    if (kind === 'legacy') Object.defineProperty(navigator, 'modelContextTesting', { configurable: true, value: { listTools: () => [native], executeTool } })
    else if (kind === 'transitional') Object.defineProperty(navigator, 'modelContext', { configurable: true, value: { getTools: async () => [native], executeTool } })
    else api({ getTools: async () => [native], executeTool })
    expect(await inspectCall(await discover(), undefined, { query: 'tea' })).toEqual({ result: 'done' })
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(executeTool.mock.calls[0]).toEqual(kind === 'legacy' ? ['search', '{"query":"tea"}'] : [native, '{"query":"tea"}', { signal: expect.any(AbortSignal) }])
  })
  it.each([undefined, null])('marks absent output (%s) unconfirmed', async output => {
    api({ getTools: async () => [action], executeTool: async () => output })
    expect(await inspectCall(await discover())).toMatchObject({ result: { status: 'unconfirmed' } })
  })
  it.each([() => { throw new DOMException('Failed', 'SyntaxError') }, () => ({ value: BigInt(1) }), () => 'x'.repeat(262_145)])('reports failed or unserializable/oversized results without retrying', async execute => {
    const executeTool = vi.fn(async () => execute())
    api({ getTools: async () => [action], executeTool })
    expect(await inspectCall(await discover())).toMatchObject({ executionMayHaveRun: true, error: expect.any(String) })
    expect(executeTool).toHaveBeenCalledTimes(1)
  })
  it('pins preparation, execution, and cleanup to the discovered document', async () => {
    api({ getTools: async () => [action], executeTool: async () => 'done' })
    const executeScript = bridge()
    const snapshot = await discoverWebMcp(8)
    expect(await executeWebMcp(8, snapshot, snapshot.tools[0], {})).toBe('done')
    for (const [request] of executeScript.mock.calls.slice(1)) expect(request.target).toEqual({ tabId: 8, documentIds: ['doc-1'] })
  })
  it('fails closed for unbound discovery snapshots', async () => {
    const executeScript = bridge()
    await expect(executeWebMcp(8, { url: location.href, tools: [action] }, action, {})).rejects.toThrow('Discover')
    expect(executeScript).not.toHaveBeenCalled()
  })
  it('rejects a metadata change during approval without invoking the tool', async () => {
    const executeTool = vi.fn()
    const getTools = vi.fn(async () => [action])
    api({ getTools, executeTool }); bridge()
    const snapshot = await discoverWebMcp(8)
    getTools.mockResolvedValue([{ ...action, description: 'Changed' }])
    await expect(executeWebMcp(8, snapshot, snapshot.tools[0], {})).rejects.toThrow('The action was not executed')
    expect(executeTool).not.toHaveBeenCalled()
  })
})

describe('cancellation and deadlines', () => {
  it('does not dispatch an already cancelled invocation', async () => {
    const executeScript = bridge()
    const signal = AbortSignal.abort()
    await expect(executeWebMcp(8, { url: location.href, documentId: 'doc-1', revision: 'r', tools: [] }, { ...action, handle: 'h' }, {}, { signal })).rejects.toThrow()
    expect(executeScript).not.toHaveBeenCalled()
  })
  it('cancels during preparation without dispatching execution', async () => {
    const controller = new AbortController()
    const executeScript = bridge()
    executeScript.mockImplementationOnce(async ({ func, args }: any) => { const result = await func(...args); controller.abort(); return [{ result, documentId: 'doc-1' }] })
    await expect(executeWebMcp(8, { url: location.href, documentId: 'doc-1', revision: 'r', tools: [] }, { ...action, handle: 'h' }, {}, { signal: controller.signal })).rejects.toThrow()
    expect(executeScript.mock.calls.some(([request]) => request.func === inspectWebMcp)).toBe(false)
    expect((globalThis as any).__lycheeWebMcpInvocations.size).toBe(0)
  })
  it('aborts the page signal and stops waiting even when the callback ignores it', async () => {
    const controller = new AbortController()
    let pageSignal!: AbortSignal
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const executeTool = vi.fn((_tool, _args, options) => { pageSignal = options.signal; started(); return new Promise(() => {}) })
    api({ getTools: async () => [action], executeTool }); bridge()
    const snapshot = await discoverWebMcp(8)
    const promise = executeWebMcp(8, snapshot, snapshot.tools[0], {}, { signal: controller.signal })
    const rejected = expect(promise).rejects.toThrow('do not automatically retry')
    await ready
    controller.abort()
    await rejected
    expect(pageSignal.aborted).toBe(true)
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect((globalThis as any).__lycheeWebMcpInvocations.size).toBe(0)
  })
  it('times out a hanging native execution and cleans up controllers and timers', async () => {
    vi.useFakeTimers()
    const executeTool = vi.fn(async () => new Promise(() => {}))
    api({ getTools: async () => [action], executeTool }); bridge()
    const snapshot = await discoverWebMcp(8)
    const rejected = expect(executeWebMcp(8, snapshot, snapshot.tools[0], {}, { timeoutMs: 50 })).rejects.toThrow(/timed out|TimeoutError/)
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect((globalThis as any).__lycheeWebMcpInvocations.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds discovery during execution without starting the action', async () => {
    vi.useFakeTimers()
    const getTools = vi.fn<() => Promise<unknown>>(async () => [action])
    const executeTool = vi.fn()
    api({ getTools, executeTool }); bridge()
    const snapshot = await discoverWebMcp(8)
    getTools.mockImplementation(() => new Promise(() => {}))
    const rejected = expect(executeWebMcp(8, snapshot, snapshot.tools[0], {}, { timeoutMs: 50 })).rejects.toThrow(/timed out|TimeoutError/)
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('cleans up after successful execution', async () => {
    vi.useFakeTimers()
    let pageSignal!: AbortSignal
    api({ getTools: async () => [action], executeTool: async (_tool: unknown, _args: unknown, options: { signal: AbortSignal }) => { pageSignal = options.signal; return 'done' } }); bridge()
    const snapshot = await discoverWebMcp(8)
    await executeWebMcp(8, snapshot, snapshot.tools[0], {})
    expect(pageSignal.aborted).toBe(false)
    expect((globalThis as any).__lycheeWebMcpInvocations.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})


it('invalidates handles on toolchange even when replacement metadata is identical', async () => {
  const nativeApi = Object.assign(new EventTarget(), { getTools: async () => [action], executeTool: vi.fn() })
  api(nativeApi)
  const before = await discover()
  nativeApi.dispatchEvent(new Event('toolchange'))
  expect(await inspectCall(before)).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
  expect(nativeApi.executeTool).not.toHaveBeenCalled()
})

it('bounds discovery waits and responds to cancellation', async () => {
  vi.useFakeTimers()
  api({ getTools: () => new Promise(() => {}) }); bridge()
  const timedOut = expect(discoverWebMcp(8)).rejects.toThrow('discovery timed out')
  await vi.advanceTimersByTimeAsync(10_001)
  await timedOut
  const controller = new AbortController()
  const cancelled = expect(discoverWebMcp(8, false, { signal: controller.signal })).rejects.toThrow()
  controller.abort()
  await cancelled
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a stalled preparation request without dispatching execution', async () => {
  vi.useFakeTimers()
  const executeScript = bridge()
  executeScript.mockImplementationOnce(() => new Promise(() => {}))
  const rejected = expect(executeWebMcp(8, { url: location.href, documentId: 'doc-1', revision: 'r', tools: [] }, { ...action, handle: 'h' }, {}, { timeoutMs: 50 })).rejects.toThrow('The action was not executed')
  await vi.advanceTimersByTimeAsync(51)
  await rejected
  expect(executeScript.mock.calls.some(([request]) => request.func === inspectWebMcp)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('marks navigation/transport failure as uncertain and never retries', async () => {
  api({ getTools: async () => [action] })
  const executeScript = bridge()
  const snapshot = await discoverWebMcp(8)
  executeScript.mockImplementation(async ({ func, args }: any) => {
    if (func === inspectWebMcp) throw new Error('Document unloaded')
    return [{ result: await func(...args), documentId: 'doc-1' }]
  })
  await expect(executeWebMcp(8, snapshot, snapshot.tools[0], {})).rejects.toThrow('Execution status is unknown')
  expect(executeScript.mock.calls.filter(([request]) => request.func === inspectWebMcp)).toHaveLength(2) // discovery and one execution
})


it('reports a document lost before preparation as unexecuted and asks for rediscovery', async () => {
  const executeScript = bridge()
  executeScript.mockRejectedValueOnce(new Error('No document with id old-document'))
  await expect(executeWebMcp(8, { url: location.href, documentId: 'old-document', revision: 'r', tools: [] }, { ...action, handle: 'h' }, {})).rejects.toThrow('The action was not executed. Discover the page actions again.')
  expect(executeScript.mock.calls.some(([request]) => request.func === inspectWebMcp)).toBe(false)
})
