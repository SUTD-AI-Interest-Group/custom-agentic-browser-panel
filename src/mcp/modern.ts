// MCP revision 2026-07-28. Kept separate from the 1.x SDK, which remains the
// legacy transport/auth adapter. No initialize, session, GET stream or resume.
import { collectInputs, type ElicitReply } from './elicitation'
import { UnauthorizedError, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import type { CallToolResult, GetPromptResult, Prompt, ReadResourceResult, Resource, Tool } from '@modelcontextprotocol/sdk/types.js'

export const MODERN_PROTOCOL = '2026-07-28'
const PREFIX = 'io.modelcontextprotocol/'
const MAX_BYTES = 4 * 1024 * 1024
const contentType = (response: Response) => response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
export type JsonObject = Record<string, unknown>
export const isObject = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x)
export interface ModernCapabilities extends JsonObject {
  tools?: { listChanged?: boolean }
  resources?: { listChanged?: boolean; subscribe?: boolean }
  prompts?: { listChanged?: boolean }
}
export interface SubscriptionFilter {
  toolsListChanged?: boolean
  promptsListChanged?: boolean
  resourcesListChanged?: boolean
  resourceSubscriptions?: string[]
}
export type SubscriptionState = 'off' | 'connecting' | 'listening' | 'retrying' | 'error'
export interface RequestOptions {
  signal?: AbortSignal
  timeout?: number
  taskStorageEpoch?: number
  conversationId?: string
  maxResponseBytes?: number
}
export class ModernRpcError extends Error {
  constructor(public code: number, public data?: unknown) { super(`MCP request failed (${code}).`) }
}
export class LegacyServerError extends Error {}
export class InputRequiredError extends Error {
  constructor() { super('This MCP server requested additional client input. This request has no supported interactive handler; sampling and roots remain disabled.') }
}

export function encodeHeader(value: string): string {
  if (/^[\x09\x20-\x7e]*$/.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?='))) return value
  const bytes = new TextEncoder().encode(value)
  return `=?base64?${btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))}?=`
}
interface HeaderField { name: string; path: string[]; type: string }
/** Reject malformed annotations, including ones under $ref/composition/arrays. */
export function headerFields(schema: unknown): HeaderField[] {
  const fields: HeaderField[] = [], names = new Set<string>()
  let nodes = 0
  function walk(value: unknown, path: string[], reachable: boolean, depth: number) {
    if (++nodes > 10_000 || depth > 32) throw new Error('Tool schema exceeds limits.')
    if (!isObject(value) && !Array.isArray(value)) return
    if (isObject(value) && 'x-mcp-header' in value) {
      const name = value['x-mcp-header']
      if (!reachable || path.length === 0 || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || names.has(name.toLowerCase()) || !['string', 'integer', 'boolean'].includes(value.type as string)) throw new Error('Invalid MCP header annotation.')
      names.add(name.toLowerCase()); fields.push({ name, path, type: value.type as string })
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && isObject(child) && reachable) {
        for (const [property, sub] of Object.entries(child)) walk(sub, [...path, property], true, depth + 1)
      } else if (typeof child === 'object' && child !== null) walk(child, path, false, depth + 1)
    }
  }
  walk(schema, [], true, 0)
  return fields
}

// Bounded streaming parser: handles split UTF-8, CRLF, multiline data, comments
// and blank keepalives. id/retry fields are deliberately ignored (no resume).
export async function* sseMessages(response: Response, signal: AbortSignal, maxBytes = MAX_BYTES): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('MCP stream has no body.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', data: string[] = [], eventSize = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })
      if (new TextEncoder().encode(buffer).byteLength > maxBytes) throw new Error('MCP stream frame exceeds limits.')
      let pos: number
      while ((pos = buffer.search(/[\r\n]/)) >= 0) {
        // Hold a final CR until the next chunk distinguishes CRLF from CR.
        if (buffer[pos] === '\r' && pos === buffer.length - 1 && !done) break
        const line = buffer.slice(0, pos)
        const separatorLength = buffer[pos] === '\r' && buffer[pos + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(pos + separatorLength)
        if (line === '') {
          if (data.length) { const text = data.join('\n'); data = []; eventSize = 0; signal.throwIfAborted(); yield JSON.parse(text) }
        } else if (line.startsWith('data:')) {
          const text = line.slice(5).replace(/^ /, '')
          eventSize += new TextEncoder().encode(text).byteLength + 1
          if (eventSize > maxBytes) throw new Error('MCP event exceeds limits.')
          data.push(text)
        }
      }
      if (done) return // an unterminated event is not delivered
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class ModernMcpClient {
  readonly protocolVersion = MODERN_PROTOCOL
  onclose?: () => void
  private closed = false
  private controllers = new Set<AbortController>()
  private capabilities: ModernCapabilities = {}
  private schemaGeneration = 0
  private schemas = new Map<string, HeaderField[]>()
  private listenController?: AbortController
  private retryTimer?: ReturnType<typeof setTimeout>
  private generation = 0
  private sequence = 0
  private cache = new Map<string, { expires: number; result: JsonObject }>()
  private cacheEpoch = 0
  invalidateCache(): void { this.cacheEpoch++; this.cache.clear() }
  constructor(private url: URL, private options: {
    headers?: Record<string, string>
    token?: () => Promise<string | undefined>
    fetch?: typeof fetch
    refreshToken?: (signal: AbortSignal) => Promise<void>
    elicit?: (params: unknown, signal: AbortSignal) => Promise<ElicitReply>
    onTask?: (task: JsonObject, params: JsonObject, opts: RequestOptions) => Promise<JsonObject>
    onAuthRequired?: (challenge: { scope?: string; resourceMetadataUrl?: URL }) => void
  } = {}) {}

  async discover(): Promise<void> {
    const result = await this.request('server/discover', {}, { timeout: 15_000 }, true)
    if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(MODERN_PROTOCOL) || !isObject(result.capabilities)) throw new Error('Server does not support MCP 2026-07-28.')
    this.capabilities = result.capabilities as ModernCapabilities
  }
  getServerCapabilities(): ModernCapabilities { return this.capabilities }

  private async post(method: string, params: JsonObject, signal: AbortSignal, probe: boolean, retriedAuth = false): Promise<{ response: Response; id: string }> {
    signal.throwIfAborted()
    const id = `lychee-${++this.sequence}`
    const headers = new Headers(this.options.headers)
    // Never inherit legacy/session/routing headers from copied configuration.
    for (const key of [...headers.keys()]) if (/^(mcp-|last-event-id$)/i.test(key)) headers.delete(key)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    headers.set('MCP-Protocol-Version', MODERN_PROTOCOL)
    headers.set('Mcp-Method', method)
    if (['tools/call', 'prompts/get', 'resources/read'].includes(method)) {
      const name = method === 'resources/read' ? params.uri : params.name
      if (typeof name !== 'string') throw new Error('Missing MCP name.')
      headers.set('Mcp-Name', encodeHeader(name))
    }
    if (method === 'tools/call') for (const field of this.schemas.get(params.name as string) ?? []) {
      let value: unknown = params.arguments
      for (const key of field.path) value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined
      if (value == null) continue
      if ((field.type === 'integer' && !Number.isSafeInteger(value)) || (field.type !== 'integer' && typeof value !== field.type)) throw new Error('Invalid MCP header parameter value.')
      headers.set(`Mcp-Param-${field.name}`, encodeHeader(String(value)))
    }
    const token = await this.options.token?.()
    signal.throwIfAborted()
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    const response = await (this.options.fetch ?? fetch)(this.url, {
      method: 'POST', headers, signal, redirect: 'error', credentials: 'omit',
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        ...(isObject(params._meta) ? params._meta : {}),
        [`${PREFIX}protocolVersion`]: MODERN_PROTOCOL,
        [`${PREFIX}clientCapabilities`]: {
          ...(this.options.elicit ? { elicitation: { form: {}, url: {} } } : {}),
          ...(this.options.onTask && (method === 'tools/call' || method.startsWith('tasks/')) ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}),
        },
        [`${PREFIX}clientInfo`]: { name: 'lychee-ai', version: '0.5.0' },
      } } }),
    })
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted() }
    const challenge = extractWWWAuthenticateParams(response)
    if (response.status === 401 || (response.status === 403 && challenge.error === 'insufficient_scope')) {
      await response.body?.cancel()
      if (response.status === 401 && !challenge.scope && !retriedAuth && this.options.refreshToken) {
        let refreshed = false
        try {
          await abortable(this.options.refreshToken(signal), signal)
          refreshed = true
        } catch (err) {
          if (signal.aborted) throw err
        }
        signal.throwIfAborted()
        // Only a failed refresh is an auth failure. Never hide the uncertain
        // outcome of the retried operation behind an authorization message.
        if (refreshed) return await this.post(method, params, signal, probe, true)
      }
      this.invalidateCache()
      this.options.onAuthRequired?.(challenge)
      throw new UnauthorizedError()
    }
    if (!response.ok) {
      const text = await readBounded(response, signal)
      let body: unknown
      try { body = JSON.parse(text) } catch { /* legacy often sends plain text */ }
      const error = isObject(body) && body.jsonrpc === '2.0' && isObject(body.error) ? body.error : undefined
      const modern = error && ([-32020, -32021, -32022].includes(error.code as number) || (response.status === 404 && error.code === -32601))
      if (probe && [400, 404, 405].includes(response.status) && !modern) throw new LegacyServerError('Legacy MCP transport.')
      if (error && typeof error.code === 'number') throw new ModernRpcError(error.code, error.data)
      throw new Error(`MCP HTTP ${response.status}.`)
    }
    return { response, id }
  }

  async request(method: string, params: JsonObject = {}, opts: RequestOptions = {}, probe = false): Promise<JsonObject> {
    const lifetime = new AbortController()
    const abort = () => lifetime.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) abort()
    this.controllers.add(lifetime)
    try {
      let next = params
      for (let round = 0; round < 8; round++) {
        lifetime.signal.throwIfAborted()
        const result = await this.requestOnce(method, next, { ...opts, signal: lifetime.signal }, probe)
        if (result.resultType === 'task') {
          if (method !== 'tools/call' || !this.options.onTask || !this.supportsExtension('io.modelcontextprotocol/tasks')) throw Error('Unnegotiated MCP task.')
          return await this.options.onTask(result, params, opts)
        }
        if (result.resultType !== 'input_required') return result
        if (!this.options.elicit || !['tools/call', 'resources/read', 'prompts/get'].includes(method)) throw new InputRequiredError()
        if (result.requestState !== undefined && typeof result.requestState !== 'string') throw Error('Invalid MCP request state.')
        const inputResponses = await collectInputs(result.inputRequests, this.options.elicit, lifetime.signal)
        const { requestState: _state, inputResponses: _responses, ...original } = params
        next = { ...original, inputResponses, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) }
      }
      throw Error('MCP clarification round limit reached; operation was not repeated further.')
    } finally { opts.signal?.removeEventListener('abort', abort); this.controllers.delete(lifetime) }
  }
  supportsExtension(name: string): boolean {
    return isObject(this.capabilities.extensions) && isObject(this.capabilities.extensions[name])
  }
  private async requestOnce(method: string, params: JsonObject, opts: RequestOptions, probe: boolean): Promise<JsonObject> {
    if (this.closed) throw new Error('MCP client is closed.')
    opts.signal?.throwIfAborted()
    const cacheable = opts.maxResponseBytes === undefined && !('inputResponses' in params) && !('requestState' in params) && ['tools/list', 'resources/list', 'prompts/list', 'resources/read', 'resources/templates/list'].includes(method)
    const cacheEpoch = this.cacheEpoch
    const cacheKey = JSON.stringify([method, params])
    const cached = this.cache.get(cacheKey)
    if (cacheable && cached && cached.expires > Date.now()) return structuredClone(cached.result)
    this.cache.delete(cacheKey)
    const controller = new AbortController(); this.controllers.add(controller)
    const abort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new Error('MCP request timed out.')), opts.timeout ?? 60_000)
    try {
      const { response, id } = await this.post(method, params, controller.signal, probe)
      let result: JsonObject | undefined
      if (contentType(response) === 'text/event-stream') {
        for await (const message of sseMessages(response, controller.signal, opts.maxResponseBytes)) {
          if (isObject(message) && message.jsonrpc === '2.0' && !('id' in message) && typeof message.method === 'string') continue // request notifications are data, never commands
          result = parseResult(message, id); break
        }
        if (!result) throw new Error('MCP response stream disconnected; outcome is unknown. Do not automatically repeat a mutating call.')
      } else if (contentType(response) === 'application/json') result = parseResult(JSON.parse(await readBounded(response, controller.signal, opts.maxResponseBytes)), id)
      else { await response.body?.cancel(); throw new Error('Unsupported MCP response content type.') }
      controller.signal.throwIfAborted()
      if (result.resultType === 'input_required' || result.resultType === 'task') return result
      if (result.resultType !== 'complete') throw new Error('Invalid modern MCP resultType.')
      if (cacheable && cacheEpoch === this.cacheEpoch && Number.isSafeInteger(result.ttlMs) && (result.ttlMs as number) > 0 && ['public', 'private'].includes(result.cacheScope as string)) {
        // Per-client memory only, never shared between endpoints/accounts.
        if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(cacheKey, { expires: Date.now() + Math.min(result.ttlMs as number, 300_000), result: structuredClone(result) })
      }
      return result
    } finally {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); this.controllers.delete(controller)
    }
  }

  private async list<T>(method: string, field: string): Promise<T[]> {
    const items: T[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, cursor ? { cursor } : {})
      if (!Array.isArray(result[field])) throw new Error('Malformed MCP catalog.')
      items.push(...result[field] as T[])
      if (items.length > 10_000) throw new Error('MCP catalog exceeds limits.')
      if (result.nextCursor === undefined) return items
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('Invalid MCP pagination cursor.')
      cursor = result.nextCursor; cursors.add(cursor)
    }
    throw new Error('MCP catalog pagination limit exceeded.')
  }
  async listTools(): Promise<{ tools: Tool[] }> {
    const generation = ++this.schemaGeneration
    const tools = await this.list<Tool>('tools/list', 'tools'), schemas = new Map<string, HeaderField[]>()
    const valid = tools.filter(t => {
      if (!isObject(t) || typeof t.name !== 'string' || !isObject(t.inputSchema)) return false
      try { schemas.set(t.name, headerFields(t.inputSchema)); return true } catch { return false }
    })
    if (generation === this.schemaGeneration) this.schemas = schemas
    return { tools: valid }
  }
  async listResources(): Promise<{ resources: Resource[] }> { return { resources: await this.list<Resource>('resources/list', 'resources') } }
  async listPrompts(): Promise<{ prompts: Prompt[] }> { return { prompts: await this.list<Prompt>('prompts/list', 'prompts') } }
  async callTool(params: { name: string; arguments?: JsonObject }, _schema?: unknown, opts?: RequestOptions): Promise<CallToolResult> {
    return await this.request('tools/call', params, opts) as unknown as CallToolResult
  }
  async readResource(params: { uri: string }, opts?: RequestOptions): Promise<ReadResourceResult> { return await this.request('resources/read', params, opts) as unknown as ReadResourceResult }
  async getPrompt(params: { name: string; arguments?: Record<string, string> }, opts?: RequestOptions): Promise<GetPromptResult> { return await this.request('prompts/get', params, opts) as unknown as GetPromptResult }

  stopSubscriptions(): void {
    this.generation++
    this.listenController?.abort(); this.listenController = undefined
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
  listen(filter: SubscriptionFilter, onChange: (method: string, params: JsonObject) => void, onState: (state: SubscriptionState) => void): void {
    this.stopSubscriptions()
    if (this.closed) return
    const acceptedFilter: SubscriptionFilter = {}
    if (filter.toolsListChanged && this.capabilities.tools?.listChanged) acceptedFilter.toolsListChanged = true
    if (filter.promptsListChanged && this.capabilities.prompts?.listChanged) acceptedFilter.promptsListChanged = true
    if (filter.resourcesListChanged && this.capabilities.resources?.listChanged) acceptedFilter.resourcesListChanged = true
    if (filter.resourceSubscriptions?.length && this.capabilities.resources?.subscribe) acceptedFilter.resourceSubscriptions = filter.resourceSubscriptions.slice(0, 100)
    if (!Object.keys(acceptedFilter).length) { onState('off'); return }
    const gen = this.generation
    let failures = 0
    const run = async () => {
      if (this.closed || this.generation !== gen) return
      const controller = new AbortController(); this.listenController = controller
      onState(failures ? 'retrying' : 'connecting')
      const ackTimeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const { response, id } = await this.post('subscriptions/listen', { notifications: acceptedFilter }, controller.signal, false)
        if (contentType(response) !== 'text/event-stream') { await response.body?.cancel(); throw new Error('MCP subscriptions require SSE.') }
        let acknowledged: SubscriptionFilter | undefined
        const started = Date.now()
        for await (const message of sseMessages(response, controller.signal)) {
          if (this.closed || this.generation !== gen) return
          if (!isObject(message) || message.jsonrpc !== '2.0') throw new Error('Invalid subscription message.')
          if ('id' in message) {
            const result = parseResult(message, id)
            if (!acknowledged || result.resultType !== 'complete' || !isObject(result._meta) || result._meta[`${PREFIX}subscriptionId`] !== id) throw new Error('Invalid subscription completion.')
            onState('off')
            return
          }
          const params = message.params
          if (!isObject(params) || !isObject(params._meta) || params._meta[`${PREFIX}subscriptionId`] !== id) throw new Error('Invalid subscription correlation.')
          if (!acknowledged) {
            if (message.method !== 'notifications/subscriptions/acknowledged' || !isObject(params.notifications)) throw new Error('Missing subscription acknowledgement.')
            acknowledged = validateAcceptedFilters(params.notifications, acceptedFilter)
            clearTimeout(ackTimeout); onState('listening'); continue
          }
          const method = message.method
          const allowed = method === 'notifications/tools/list_changed' ? acknowledged.toolsListChanged
            : method === 'notifications/prompts/list_changed' ? acknowledged.promptsListChanged
            : method === 'notifications/resources/list_changed' ? acknowledged.resourcesListChanged
            : method === 'notifications/resources/updated' ? typeof params.uri === 'string' && acknowledged.resourceSubscriptions?.includes(params.uri) : false
          if (!allowed) throw new Error('Unrequested subscription notification.')
          if (Date.now() - started > 30_000) failures = 0
          onChange(method as string, params)
        }
      } catch (err) {
        if (this.closed || this.generation !== gen) return
        if (err instanceof UnauthorizedError || err instanceof ModernRpcError) { onState('error'); return }
      } finally { clearTimeout(ackTimeout) }
      if (this.closed || this.generation !== gen) return
      onState('retrying')
      // A fresh request ID, no replay. Only this non-mutating listen is retried.
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void run() }, Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)))
    }
    void run()
  }
  async close(): Promise<void> {
    this.closed = true; this.stopSubscriptions()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear(); this.schemas.clear(); this.invalidateCache()
  }
}
function validateAcceptedFilters(value: JsonObject, requested: SubscriptionFilter): SubscriptionFilter {
  const accepted: SubscriptionFilter = {}
  for (const key of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid accepted filter.')
    if (value[key] === true) { if (!requested[key]) throw new Error('Unrequested filter.'); accepted[key] = true }
  }
  if (value.resourceSubscriptions !== undefined) {
    if (!Array.isArray(value.resourceSubscriptions) || !value.resourceSubscriptions.every(x => typeof x === 'string' && requested.resourceSubscriptions?.includes(x))) throw new Error('Unrequested resource subscription.')
    accepted.resourceSubscriptions = value.resourceSubscriptions as string[]
  }
  return accepted
}
function parseResult(message: unknown, id: string): JsonObject {
  if (!isObject(message) || message.jsonrpc !== '2.0' || message.id !== id) throw new Error('Invalid MCP response correlation.')
  if (isObject(message.error) && typeof message.error.code === 'number') throw new ModernRpcError(message.error.code, message.error.data)
  if (!isObject(message.result) || 'error' in message) throw new Error('Invalid MCP response.')
  return message.result
}
async function readBounded(response: Response, signal: AbortSignal, maxBytes = MAX_BYTES): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = '', size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > maxBytes) throw new Error('MCP response exceeds limits.')
      text += decoder.decode(value, { stream: true })
    }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
