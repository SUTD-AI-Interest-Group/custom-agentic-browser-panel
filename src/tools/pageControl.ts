// The page-control session: a per-task grant that governs the action loop.
// Also the point-of-no-return classifier and the per-action orchestration.

import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { snapshotPage } from '../platform/domIndex'
import {
  clickElement,
  navigateTab,
  pressKey,
  scrollPage,
  selectOption,
  typeIntoElement,
  waitForStable,
  type ActionResult,
} from '../platform/pageActions'

/** A per-task grant to control one tab. Origin-fenced and action-budgeted. */
export interface ControlSession {
  tabId: number
  origin: string
  plan: string
  actionsUsed: number
  maxActions: number
  active: boolean
}

export const MAX_SESSION_ACTIONS = 20

export type ControlAction =
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'highlight'
  | 'navigate'
  | 'press'
  | 'wait'

/** One action request from the model. */
export interface ControlSpec {
  action: ControlAction
  index?: number
  text?: string
  value?: string
  url?: string
  keys?: string
  direction?: 'up' | 'down' | 'toElement'
  label?: string
  sensitive?: boolean
  clear?: boolean
  /** Max ms to wait for stability (action='wait'); also caps post-action auto-wait. */
  timeoutMs?: number
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * True when an action must show an individual approval card even inside a
 * granted session: form submits, cross-origin navigation, sensitive fields,
 * or a model self-flag.
 */
export function isPointOfNoReturn(
  spec: ControlSpec,
  el: IndexedElement | undefined,
  sessionOrigin: string,
): boolean {
  if (spec.sensitive) return true
  if (el?.sensitive) return true
  if (spec.action === 'navigate') {
    return spec.url ? hostOf(spec.url) !== sessionOrigin : false
  }
  if (spec.action === 'press' && /enter/i.test(spec.keys ?? '')) return true
  if (spec.action === 'click' && el) {
    if (el.href && hostOf(el.href) !== sessionOrigin) return true
    if (el.type === 'submit' || el.type === 'image') return true
    if (/submit|sign in|log ?in|pay|checkout|place order|continue/i.test(el.name)) return true
  }
  return false
}

export interface ControlStepDeps {
  tabId: number
  spec: ControlSpec
  snapshot: PageSnapshot
  /** Presence hook: glide the cursor/spotlight to `index` before acting. */
  beforeAct?: (index: number | undefined) => Promise<void>
  /** Presence hook: play the click pulse after acting. */
  afterAct?: () => Promise<void>
}

export interface ControlStepResult extends ActionResult {
  /** Refreshed registry text after the action. */
  registry: string
}

const runRaw = (tabId: number, spec: ControlSpec): Promise<ActionResult> => {
  switch (spec.action) {
    case 'click':
    case 'highlight':
      return clickElementOrHighlight(tabId, spec)
    case 'type':
      return typeIntoElement(tabId, spec.index ?? -1, spec.text ?? '', spec.clear ?? true)
    case 'select':
      return selectOption(tabId, spec.index ?? -1, spec.value ?? '')
    case 'scroll':
      return scrollPage(tabId, { direction: spec.direction ?? 'down', index: spec.index })
    case 'press':
      return pressKey(tabId, spec.keys ?? 'Enter')
    case 'navigate':
      return navigateTab(tabId, spec.url ?? '')
    case 'wait':
      return waitForStable(tabId, {
        selector: spec.text || undefined,
        timeoutMs: spec.timeoutMs,
      }).then((r) => ({ ok: r.ok, message: `waited (${r.reason})` }))
  }
}

// 'highlight' is a read-only show-me: it uses the same scroll-into-view the
// presence layer already does, and reports success without mutating anything.
const clickElementOrHighlight = (tabId: number, spec: ControlSpec): Promise<ActionResult> => {
  if (spec.action === 'highlight') {
    return scrollPage(tabId, { direction: 'toElement', index: spec.index }).then((r) => ({
      ...r,
      message: r.ok ? `highlighted element ${spec.index}` : r.message,
    }))
  }
  return clickElement(tabId, spec.index ?? -1)
}

/** Run one action: presence glide → real action → pulse → re-snapshot. */
export async function runControlStep(deps: ControlStepDeps): Promise<ControlStepResult> {
  const { tabId, spec, beforeAct, afterAct } = deps
  const needsTarget = spec.index !== undefined && spec.action !== 'navigate'
  if (beforeAct && needsTarget) await beforeAct(spec.index)
  const result = await runRaw(tabId, spec)
  if (afterAct && result.ok) await afterAct()
  // chrome.tabs.update resolves once navigation is *initiated*, not once the
  // new document exists, so waitForStable (which injects via executeScript)
  // can otherwise race the frame transition and read the OLD document as
  // instantly "quiet". Give navigation a brief head start before polling.
  if (spec.action === 'navigate') await new Promise((r) => setTimeout(r, 300))
  // Let async pages settle before re-reading, instead of a fixed delay. Skip
  // for 'wait' (already waited) and 'highlight'/'scroll' (no state change).
  if (['click', 'type', 'select', 'navigate', 'press'].includes(spec.action)) {
    await waitForStable(tabId, { timeoutMs: spec.action === 'navigate' ? 8000 : 4000 })
  }
  let registry = '(page not re-read)'
  try {
    registry = (await snapshotPage(tabId)).text
  } catch {
    registry = '(could not re-read the page)'
  }
  return { ...result, registry }
}
