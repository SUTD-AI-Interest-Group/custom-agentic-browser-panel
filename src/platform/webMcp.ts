// Native, document-local WebMCP. No polyfill, MAIN-world bridge, remote MCP
// transport, broad frame discovery, or permission requests. The native API is
// exposed in the extension's isolated world, so page JS cannot replace it.
// API checked 2026-10-06 against Chrome's imperative-api documentation and
// https://webmachinelearning.github.io/webmcp/ (2 October 2026 draft).

export interface SiteTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface SiteBinding {
  tabId: number
  documentId: string
  origin: string
  url: string
  revision: number
  generation: number
}
export interface SiteCatalog {
  status: 'loading' | 'ready' | 'unsupported' | 'unavailable' | 'error'
  message: string
  tools: SiteTool[]
  binding?: SiteBinding
}
interface WireResult {
  status: SiteCatalog['status']
  message: string
  tools?: SiteTool[]
  origin?: string
  url?: string
  revision?: number
  result?: string | null
  truncated?: boolean
}
interface PageRequest {
  action: 'discover' | 'execute' | 'cancel'
  callId?: string
  origin?: string
  url?: string
  revision?: number
  tool?: SiteTool
  args?: Record<string, unknown>
}

/** Serialized by Chrome: keep every dependency inside this function. */
export async function nativeWebMcp(request: PageRequest): Promise<WireResult> {
  interface NativeTool extends SiteTool { window: Window; origin: string; annotations?: { debugging?: boolean } }
  interface NativeContext extends EventTarget {
    getTools(options?: { fromOrigins: string[] }): Promise<NativeTool[]>
    executeTool(tool: NativeTool, args: Record<string, unknown>, options: { signal: AbortSignal }): Promise<string | null>
  }
  interface State { context: NativeContext; revision: number; calls: Map<string, AbortController>; cancelled: Set<string> }
  const scope = globalThis as typeof globalThis & { __lycheeNativeWebMcp?: State }
  const context = (document as Document & { modelContext?: NativeContext }).modelContext
  const fail = (status: WireResult['status'], message: string): WireResult => ({ status, message })
  if (window !== window.top) return fail('unavailable', 'Only the top-level page is supported.')
  if (!isSecureContext || !context || typeof context.getTools !== 'function' || typeof context.executeTool !== 'function') {
    return fail('unsupported', 'Native WebMCP discovery and execution are unavailable in this browser or page. WebMCP is experimental and requires a supporting browser and site.')
  }
  // The Chrome origin-trial builds before 155 accepted JSON-string inputs.
  // Never probe by executing twice: a failing callback may already mutate.
  const chromeMajor = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1]
  if (chromeMajor && Number(chromeMajor) < 155) return fail('unsupported', 'Lychee’s current native WebMCP adapter requires Chrome 155 or newer. This browser has an older experimental API.')
  let state = scope.__lycheeNativeWebMcp
  if (!state || state.context !== context) {
    state = { context, revision: 0, calls: new Map(), cancelled: new Set() }
    scope.__lycheeNativeWebMcp = state
    const captured = state
    context.addEventListener('toolchange', () => { captured.revision++ })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        captured.revision++
        for (const controller of captured.calls.values()) controller.abort()
      }
    })
    window.addEventListener('pagehide', () => {
      captured.revision++
      for (const controller of captured.calls.values()) controller.abort()
    }, { once: true })
  }
  if (request.action === 'cancel') {
    if (request.callId) {
      state.cancelled.add(request.callId)
      state.calls.get(request.callId)?.abort()
      // Bound abandoned cancellation tokens while retaining recent requests.
      if (state.cancelled.size > 200) state.cancelled.delete(state.cancelled.values().next().value!)
    }
    return { status: 'ready', message: 'Cancellation requested.' }
  }
  if (request.callId && state.cancelled.has(request.callId)) return fail('unavailable', 'Execution cancelled.')
  if (request.action === 'execute' && (location.origin !== request.origin || location.href !== request.url || state.revision !== request.revision)) {
    return fail('unavailable', 'The page or its tools changed. Refresh site actions and ask again.')
  }
  // Metadata is data, never code/HTML. Bound all page-controlled text/schema
  // before crossing the extension boundary. Reject unsafe object keys and
  // remote references rather than resolving anything supplied by the page.
  const normalize = (tool: NativeTool): SiteTool | null => {
    if (tool.window !== window || tool.origin !== location.origin || tool.annotations?.debugging) return null
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) return null
    if (typeof tool.description !== 'string' || tool.description.length > 4000) return null
    const schema = tool.inputSchema ?? { type: 'object', properties: {} }
    let budget = 1000
    const safe = (value: unknown, depth: number): boolean => {
      if (--budget < 0 || depth > 20) return false
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true
      if (Array.isArray(value)) return value.every((v) => safe(v, depth + 1))
      if (typeof value !== 'object') return false
      return Object.entries(value).every(([key, v]) => !['__proto__', 'constructor', 'prototype'].includes(key) && !(key === '$ref' && typeof v === 'string' && !v.startsWith('#')) && safe(v, depth + 1))
    }
    if (!schema || Array.isArray(schema) || typeof schema !== 'object' || !safe(schema, 0)) return null
    if (schema.type !== undefined && schema.type !== 'object') return null
    const encoded = JSON.stringify(schema)
    if (encoded.length > 16_000) return null
    return { name: tool.name, description: tool.description, inputSchema: JSON.parse(encoded) }
  }
  try {
    const before = state.revision
    let discoveryTimer: ReturnType<typeof setTimeout> | undefined
    const listed = await Promise.race([
      context.getTools({ fromOrigins: [] }),
      new Promise<never>((_, reject) => { discoveryTimer = setTimeout(() => reject(new Error('WebMCP discovery timed out.')), 5000) }),
    ]).finally(() => clearTimeout(discoveryTimer))
    if (!Array.isArray(listed)) return fail('error', 'The native WebMCP catalog was invalid.')
    if (before !== state.revision) return fail('unavailable', 'Site actions changed during discovery. Refresh to try again.')
    const entries = listed.slice(0, 200).flatMap((native) => {
      const tool = normalize(native)
      return tool ? [{ native, tool }] : []
    }).slice(0, 50)
    if (request.action === 'discover') {
      return { status: 'ready', message: '', tools: entries.map((e) => e.tool), origin: location.origin, url: location.href, revision: state.revision }
    }
    if (location.origin !== request.origin || location.href !== request.url || state.revision !== request.revision) {
      return fail('unavailable', 'The page or its tools changed. Refresh site actions and ask again.')
    }
    const entry = entries.find(({ tool }) => tool.name === request.tool?.name)
    if (!entry || JSON.stringify(entry.tool) !== JSON.stringify(request.tool)) {
      return fail('unavailable', 'This action was removed or changed after it was shown. Refresh site actions and ask again.')
    }
    if (!request.callId) return fail('error', 'Missing execution identifier.')
    if (state.cancelled.has(request.callId)) return fail('unavailable', 'Execution cancelled.')
    if (document.visibilityState !== 'visible') return fail('unavailable', 'This page is no longer visible. Open its tab before running site actions.')
    const controller = new AbortController()
    state.calls.set(request.callId, controller)
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      // No retry: a rejected/timed-out execution may already have side effects.
      const result = await Promise.race([
        context.executeTool(entry.native, request.args ?? {}, { signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Execution cancelled or timed out; it may have already changed the site. Do not retry automatically.')), { once: true })),
      ])
      if (result !== null && typeof result !== 'string') return fail('error', 'The site returned an invalid WebMCP result. The action may have completed; do not retry automatically.')
      return { status: 'ready', message: '', result: result?.slice(0, 32_000) ?? null, truncated: (result?.length ?? 0) > 32_000 }
    } finally {
      clearTimeout(timer)
      state.calls.delete(request.callId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'WebMCP request failed.'
    return fail('error', request.action === 'execute' ? `${message} The action may have completed; check the site and do not retry automatically.` : message)
  }
}

export function webMcpDeadline<T>(promise: Promise<T>, ms: number, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) { onCancel?.(); reject(error) } else resolve(value as T)
    }
    const cancel = () => finish(new Error('WebMCP request cancelled.'))
    const timer = setTimeout(() => finish(new Error('WebMCP request timed out.')), ms)
    signal?.addEventListener('abort', cancel, { once: true })
    promise.then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error('WebMCP request failed.')))
    if (signal?.aborted) cancel()
  })
}

const EMPTY: SiteCatalog = { status: 'loading', message: 'Checking this page for site actions…', tools: [] }

/** One client per chat; every callable catalog is a short-lived capability. */
export class WebMcpClient {
  private catalog: SiteCatalog = EMPTY
  private generation = 0
  private serial = 0
  private listeners = new Set<() => void>()
  private pending = new Map<string, { binding: SiteBinding; cancel: () => void }>()
  private refreshInFlight?: Promise<SiteCatalog>
  constructor(private readonly boundTabId?: number) {}
  snapshot = (): SiteCatalog => this.catalog
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(catalog: SiteCatalog): SiteCatalog {
    this.catalog = catalog
    for (const listener of this.listeners) listener()
    return catalog
  }
  invalidate(message = 'The active page changed. Refreshing site actions…'): void {
    this.generation++
    this.serial++
    this.refreshInFlight = undefined
    for (const request of this.pending.values()) request.cancel()
    this.publish({ status: 'loading', message, tools: [] })
  }
  watch(): () => void {
    const refresh = () => { this.invalidate(); void this.refresh() }
    const updated = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
      if ((tabId === this.catalog.binding?.tabId || tabId === this.boundTabId) && (change.status || change.url)) refresh()
    }
    chrome.tabs.onActivated.addListener(refresh)
    chrome.tabs.onUpdated.addListener(updated)
    chrome.tabs.onRemoved.addListener(refresh)
    chrome.windows.onFocusChanged.addListener(refresh)
    // @types/chrome 0.0.280 omits Event.removeListener on this event.
    const permissionsRemoved = chrome.permissions.onRemoved as chrome.events.Event<(permissions: chrome.permissions.Permissions) => void>
    permissionsRemoved.addListener(refresh)
    const timer = setInterval(() => { void this.refresh() }, 3000)
    void this.refresh()
    return () => {
      clearInterval(timer)
      chrome.tabs.onActivated.removeListener(refresh)
      chrome.tabs.onUpdated.removeListener(updated)
      chrome.tabs.onRemoved.removeListener(refresh)
      chrome.windows.onFocusChanged.removeListener(refresh)
      permissionsRemoved.removeListener(refresh)
      this.invalidate('Site actions are paused while this chat is hidden.')
    }
  }
  async refresh(signal?: AbortSignal): Promise<SiteCatalog> {
    if (this.refreshInFlight) return webMcpDeadline(this.refreshInFlight, 6500, signal)
    const serial = ++this.serial
    const generation = this.generation
    const publish = (catalog: SiteCatalog) => serial === this.serial ? this.publish(catalog) : this.catalog
    const run = async (): Promise<SiteCatalog> => {
      try {
        const tab = await this.activeTab()
        if (!tab?.id || !tab.url || (this.boundTabId !== undefined && tab.id !== this.boundTabId)) {
          return publish({ status: 'unavailable', message: 'Open this chat’s tab to discover and use its site actions.', tools: [] })
        }
        const url = new URL(tab.url)
        if (!['https:', 'http:'].includes(url.protocol) || tab.status === 'loading') {
          return publish({ status: 'unavailable', message: 'Site actions are available only on a loaded web page.', tools: [] })
        }
        if (!await this.hasAccess(url)) return publish({ status: 'unavailable', message: 'Lychee does not have site access to this page.', tools: [] })
        const [wire] = await webMcpDeadline(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: nativeWebMcp, args: [{ action: 'discover' }] }), 6000, signal)
        const current = await this.activeTab()
        if (serial !== this.serial) return this.catalog
        if (current?.id !== tab.id || current.url !== tab.url || current.status === 'loading') return publish({ status: 'unavailable', message: 'The active page changed during discovery.', tools: [] })
        const data = wire?.result
        if (!data || wire.frameId !== 0) return publish({ status: 'error', message: 'Could not inspect this page’s native site actions.', tools: [] })
        if (data.status !== 'ready') return publish({ status: data.status, message: data.message, tools: [] })
        if (!wire.documentId || data.origin !== url.origin || data.url !== tab.url || typeof data.revision !== 'number') {
          return publish({ status: 'unavailable', message: 'The page changed during discovery. Refresh site actions.', tools: [] })
        }
        return publish({ status: 'ready', message: '', tools: data.tools ?? [], binding: { tabId: tab.id, documentId: wire.documentId, origin: url.origin, url: tab.url, revision: data.revision, generation } })
      } catch {
        return publish({ status: 'unavailable', message: 'Chrome could not inspect this page. Check site access or open a normal web page.', tools: [] })
      }
    }
    const promise = run().finally(() => { if (this.refreshInFlight === promise) this.refreshInFlight = undefined })
    this.refreshInFlight = promise
    return promise
  }
  private async activeTab(): Promise<chrome.tabs.Tab | undefined> {
    return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  }
  private hasAccess(url: URL): Promise<boolean> {
    return chrome.permissions.contains({ permissions: ['scripting'], origins: [`${url.origin}/*`] })
  }
  async assertCurrent(binding: SiteBinding): Promise<void> {
    const tab = await this.activeTab()
    if (binding.generation !== this.generation || tab?.id !== binding.tabId || tab.url !== binding.url || tab.status === 'loading' || (this.boundTabId !== undefined && this.boundTabId !== tab.id)) {
      throw new Error('The active page changed. Refresh site actions before calling this tool.')
    }
    if (!await this.hasAccess(new URL(binding.url))) throw new Error('Lychee no longer has access to this site.')
    if (binding.generation !== this.generation) throw new Error('The active page changed.')
  }
  async execute(binding: SiteBinding, tool: SiteTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<WireResult> {
    if (signal?.aborted) throw new Error('Execution cancelled.')
    await this.assertCurrent(binding)
    if (signal?.aborted) throw new Error('Execution cancelled.')
    const callId = crypto.randomUUID()
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const cancelPage = () => {
      void chrome.scripting.executeScript({ target: { tabId: binding.tabId, documentIds: [binding.documentId] }, world: 'ISOLATED', func: nativeWebMcp, args: [{ action: 'cancel', callId }] }).catch(() => {})
    }
    this.pending.set(callId, { binding, cancel })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (signal?.aborted) throw new Error('Execution cancelled.')
      const [wire] = await webMcpDeadline(chrome.scripting.executeScript({
        target: { tabId: binding.tabId, documentIds: [binding.documentId] }, world: 'ISOLATED', func: nativeWebMcp,
        args: [{ action: 'execute', callId, origin: binding.origin, url: binding.url, revision: binding.revision, tool, args }],
      }), 61_000, controller.signal, cancelPage)
      if (controller.signal.aborted || binding.generation !== this.generation) throw new Error('Execution interrupted by a page change or cancellation. It may have completed; check the site before retrying.')
      if (!wire?.result || wire.frameId !== 0 || wire.documentId !== binding.documentId) throw new Error('The original page is no longer available. The action may have completed; do not retry automatically.')
      return wire.result
    } catch (error) {
      if (error instanceof Error && /may have completed|interrupted/.test(error.message)) throw error
      throw new Error('Site execution failed or the page navigated. The action may have completed; check the site before retrying.')
    } finally {
      this.pending.delete(callId)
      signal?.removeEventListener('abort', cancel)
      // Re-read even after error: tools may disappear or navigate on execution.
      void this.refresh()
    }
  }
}
