// Real DOM mutations, dispatched by injecting self-contained functions that
// re-find the target via its data-agent-idx stamp. Text entry uses the native
// value setter so React/Vue controlled inputs actually re-render.

const ATTR = 'data-agent-idx'

/** Outcome of one page action, fed back to the model. */
export interface ActionResult {
  ok: boolean
  message: string
  urlChanged?: boolean
}

function injClick(attr: string, index: number) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.click()
  return { ok: true, message: `clicked element ${index}` }
}

function injType(attr: string, index: number, text: string, clear: boolean) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  ;(el as HTMLElement).focus()
  if ((el as HTMLElement).isContentEditable) {
    el.textContent = clear ? text : (el.textContent ?? '') + text
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return { ok: true, message: `typed into element ${index}` }
  }
  const input = el as HTMLInputElement
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const next = clear ? text : (input.value ?? '') + text
  if (setter) setter.call(input, next)
  else input.value = next
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, message: `typed into element ${index}` }
}

function injSelect(attr: string, index: number, value: string) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLSelectElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  const opt = Array.from(el.options).find(
    (o) => o.value === value || o.text.trim() === value.trim(),
  )
  if (!opt) return { ok: false, message: `no option matching "${value}" in element ${index}` }
  el.value = opt.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, message: `selected "${opt.text.trim()}" in element ${index}` }
}

function injScroll(attr: string, direction: string, index: number) {
  if (direction === 'toElement') {
    const el = document.querySelector(`[${attr}="${index}"]`)
    if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return { ok: true, message: `scrolled to element ${index}` }
  }
  window.scrollBy({ top: (direction === 'up' ? -1 : 1) * window.innerHeight * 0.8, behavior: 'smooth' })
  return { ok: true, message: `scrolled ${direction}` }
}

function injPress(keys: string) {
  const el = (document.activeElement as HTMLElement) ?? document.body
  const fire = (type: string) =>
    el.dispatchEvent(
      new KeyboardEvent(type, { key: keys, bubbles: true, cancelable: true }),
    )
  fire('keydown')
  fire('keyup')
  return { ok: true, message: `pressed ${keys}` }
}

// Resolves once the page settles: either `selector` appears, or the DOM stops
// mutating for `quietMs`. Bounded by `timeoutMs` so a never-quiet page (ads,
// polling) proceeds instead of hanging. Runs in the page's isolated world.
function injWaitStable(selector: string, quietMs: number, timeoutMs: number) {
  if (selector && document.querySelector(selector)) {
    return Promise.resolve({ ok: true, reason: 'selector-present' })
  }
  return new Promise<{ ok: boolean; reason: string }>((resolve) => {
    let quiet: number
    let hard: number
    const finish = (reason: string) => {
      try { obs.disconnect() } catch {}
      clearTimeout(quiet)
      clearTimeout(hard)
      resolve({ ok: true, reason })
    }
    const obs = new MutationObserver(() => {
      if (selector && document.querySelector(selector)) return finish('selector-appeared')
      clearTimeout(quiet)
      quiet = setTimeout(() => finish('quiet'), quietMs) as unknown as number
    })
    obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    })
    quiet = setTimeout(() => finish('quiet'), quietMs) as unknown as number
    hard = setTimeout(() => finish('timeout'), timeoutMs) as unknown as number
  })
}

async function inject<T>(tabId: number, func: (...a: any[]) => T, args: any[]): Promise<T> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return res?.result as T
}

const guarded = async (tabId: number, fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, message: `cannot act on this page (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** Click the element at `index`. */
export function clickElement(tabId: number, index: number): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injClick, [ATTR, index]))
}

/** Type `text` into the element at `index`; `clear` replaces existing text. */
export function typeIntoElement(
  tabId: number,
  index: number,
  text: string,
  clear: boolean,
): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injType, [ATTR, index, text, clear]))
}

/** Choose an option (by value or visible text) in the <select> at `index`. */
export function selectOption(tabId: number, index: number, value: string): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injSelect, [ATTR, index, value]))
}

/** Scroll the page up/down, or bring element `index` into view. */
export function scrollPage(
  tabId: number,
  opts: { direction: 'up' | 'down' | 'toElement'; index?: number },
): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injScroll, [ATTR, opts.direction, opts.index ?? -1]))
}

/** Dispatch a key (Enter | Tab | Escape) to the focused element. */
export function pressKey(tabId: number, keys: string): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injPress, [keys]))
}

/**
 * Wait for the page to settle after an action: the DOM goes quiet for
 * `quietMs`, or `selector` appears, whichever first, bounded by `timeoutMs`.
 * executeScript awaits the injected promise. Never throws.
 */
export async function waitForStable(
  tabId: number,
  opts: { selector?: string; quietMs?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason: string }> {
  const { selector = '', quietMs = 400, timeoutMs = 6000 } = opts
  try {
    return await inject(tabId, injWaitStable, [selector, quietMs, timeoutMs])
  } catch (err) {
    return { ok: false, reason: `wait failed (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** Navigate the tab to `url`. Returns urlChanged so the caller can re-fence origin. */
export async function navigateTab(tabId: number, url: string): Promise<ActionResult> {
  try {
    await chrome.tabs.update(tabId, { url })
    return { ok: true, message: `navigating to ${url}`, urlChanged: true }
  } catch (err) {
    return { ok: false, message: `could not navigate (${err instanceof Error ? err.message : String(err)})` }
  }
}
