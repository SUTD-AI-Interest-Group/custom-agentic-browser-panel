import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectWebMcp, discoverWebMcp, executeWebMcp, webMcpDiagnostic } from './webmcp'

const action = { name: 'search', description: 'Find products', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
function api(value: unknown) { Object.defineProperty(document, 'modelContext', { value, configurable: true }) }
afterEach(() => {
  api(undefined)
  Object.defineProperty(navigator, 'modelContextTesting', { value: undefined, configurable: true })
  vi.unstubAllGlobals()
})
describe('WebMCP page adapter', () => {
  it('treats unsupported pages as empty, not as supported just because the browser has an API', async () => {
    expect(await inspectWebMcp()).toMatchObject({ tools: [] })
    api({ getTools: async () => [] })
    expect(await inspectWebMcp()).toMatchObject({ tools: [] })
  })
  it('serializes native descriptors without their Window and hides debugging tools', async () => {
    api({ getTools: async () => [{ ...action, window }, { ...action, name: 'debug', annotations: { debugging: true } }] })
    expect(await inspectWebMcp()).toEqual({ url: location.href, tools: [action], status: 'ready' })
  })
  it('passes the original native descriptor and object arguments to execution exactly once', async () => {
    const native = { ...action, window }
    const executeTool = vi.fn(async () => 'done')
    api({ getTools: async () => [native], executeTool })
    expect(await inspectWebMcp({ url: location.href, tool: action, args: { query: 'tea' } })).toEqual({ result: 'done' })
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(native, { query: 'tea' })
  })
  it('supports the legacy listTools/executeTool API and string schemas', async () => {
    const executeTool = vi.fn(async () => 'legacy')
    Object.defineProperty(navigator, 'modelContextTesting', { configurable: true, value: {
      listTools: () => [{ ...action, inputSchema: JSON.stringify(action.inputSchema) }], executeTool,
    } })
    expect(await inspectWebMcp()).toMatchObject({ tools: [action] })
    await inspectWebMcp({ url: location.href, tool: action, args: { query: 'tea' } })
    expect(executeTool).toHaveBeenCalledExactlyOnceWith('search', '{"query":"tea"}')
  })
  it('rejects changed pages, changed descriptors, missing tools and duplicate names without execution', async () => {
    const executeTool = vi.fn()
    const getTools = vi.fn(async () => [action])
    api({ getTools, executeTool })
    const call = { url: location.href, tool: action, args: {} }
    await expect(inspectWebMcp({ ...call, url: 'https://changed.example/' })).resolves.toMatchObject({ phase: 'validation', executionMayHaveRun: false, error: expect.stringContaining('page changed') })
    getTools.mockResolvedValue([{ ...action, description: 'Changed' }])
    await expect(inspectWebMcp(call)).resolves.toMatchObject({ phase: 'validation', executionMayHaveRun: false, error: expect.stringContaining('changed or is ambiguous') })
    getTools.mockResolvedValue([])
    await expect(inspectWebMcp(call)).resolves.toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    getTools.mockResolvedValue([action, action])
    await expect(inspectWebMcp(call)).resolves.toMatchObject({ phase: 'validation', executionMayHaveRun: false })
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('pins execution to the discovered document ID, including same-URL reloads', async () => {
    const executeScript = vi.fn().mockResolvedValueOnce([{ result: { url: location.href, tools: [action] }, documentId: 'doc-1' }]).mockResolvedValueOnce([{ result: { result: 'ok' } }])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    const snapshot = await discoverWebMcp(8)
    await executeWebMcp(8, snapshot, action, {})
    expect(executeScript.mock.calls[1][0].target).toEqual({ tabId: 8, documentIds: ['doc-1'] })
  })
})

it('distinguishes an unavailable API from an API with no registered actions', async () => {
  const unsupported = await inspectWebMcp()
  expect(unsupported).toMatchObject({ status: 'unsupported', tools: [] })
  api({ getTools: async () => [] })
  const empty = await inspectWebMcp()
  expect(empty).toMatchObject({ status: 'empty', tools: [] })
  if ('tools' in unsupported && 'tools' in empty) {
    expect(webMcpDiagnostic(unsupported)).toContain('chrome://flags/#enable-webmcp-testing')
    expect(webMcpDiagnostic(empty)).toContain('no registered actions')
  }
})

it('uses JSON text with the older native descriptor API without retrying', async () => {
  const native = { ...action, inputSchema: JSON.stringify(action.inputSchema) }
  const executeTool = vi.fn(async (_tool, input) => {
    // Older WebIDL DOMString bindings coerce a plain object to [object Object].
    const parsed = JSON.parse(String(input))
    return { content: [{ type: 'text', text: parsed.query }] }
  })
  api({ getTools: async () => [native], executeTool })
  expect(await inspectWebMcp({ url: location.href, tool: action, args: { query: 'tea' } })).toEqual({ result: { content: [{ type: 'text', text: 'tea' }] } })
  expect(executeTool).toHaveBeenCalledExactlyOnceWith(native, '{"query":"tea"}')
})

it('transports rejected execution promises as JSON-safe errors, with no retry', async () => {
  const executeTool = vi.fn(async () => { throw new DOMException('Failed to parse input arguments', 'SyntaxError') })
  api({ getTools: async () => [action], executeTool })
  const response = await inspectWebMcp({ url: location.href, tool: action, args: {} })
  expect(JSON.parse(JSON.stringify(response))).toEqual({ error: 'SyntaxError: Failed to parse input arguments', phase: 'execution', executionMayHaveRun: true })
  expect(executeTool).toHaveBeenCalledTimes(1)
})

it.each([undefined, null])('marks absent output (%s) as unconfirmed instead of losing the response', async output => {
  api({ getTools: async () => [action], executeTool: async () => output })
  expect(await inspectWebMcp({ url: location.href, tool: action, args: {} })).toMatchObject({ result: { status: 'unconfirmed' } })
})

it('reports serialization errors after execution without re-running the action', async () => {
  const executeTool = vi.fn(async () => ({ value: BigInt(1) }))
  api({ getTools: async () => [action], executeTool })
  expect(await inspectWebMcp({ url: location.href, tool: action, args: {} })).toMatchObject({ phase: 'serialization', executionMayHaveRun: true })
  expect(executeTool).toHaveBeenCalledTimes(1)
})

it('surfaces the actual injected error rather than replacing it with no result', async () => {
  vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async () => [{ result: { error: 'SyntaxError: Failed to parse input arguments', phase: 'execution', executionMayHaveRun: true } }]) } })
  await expect(executeWebMcp(8, { url: location.href, tools: [action], documentId: 'doc-1' }, action, {})).rejects.toThrow('WebMCP execution failed: SyntaxError: Failed to parse input arguments')
})

it('accepts equivalent descriptors after Chrome reorders dictionary keys across the injection boundary', async () => {
  const native = { name: 'add', description: 'Add an item', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Item title' }, hour: { type: 'number' } }, required: ['title'] } }
  // Same data, reordered at both the descriptor and nested schema levels.
  const transported = { description: 'Add an item', inputSchema: { properties: { hour: { type: 'number' }, title: { description: 'Item title', type: 'string' } }, required: ['title'], type: 'object' }, name: 'add' }
  const executeTool = vi.fn(async () => 'added')
  api({ getTools: async () => [native], executeTool })
  expect(await inspectWebMcp({ url: location.href, tool: transported, args: { title: 'Tea', hour: 18 } })).toEqual({ result: 'added' })
  expect(executeTool).toHaveBeenCalledExactlyOnceWith(native, { title: 'Tea', hour: 18 })
})

it('still rejects a changed nested schema before execution', async () => {
  const executeTool = vi.fn()
  api({ getTools: async () => [action], executeTool })
  const changed = { ...action, inputSchema: { type: 'object', properties: { query: { type: 'number' } } } }
  expect(await inspectWebMcp({ url: location.href, tool: changed, args: {} })).toMatchObject({ phase: 'validation', executionMayHaveRun: false })
  expect(executeTool).not.toHaveBeenCalled()
})
