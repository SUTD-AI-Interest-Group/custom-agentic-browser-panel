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

/**
 * A per-task grant to control one tab. Origin-fenced. There is no per-session
 * action budget: the turn's step budget (MAX_STEPS in agent.ts) bounds all
 * activity, and point-of-no-return steps still confirm individually.
 */
export interface ControlSession {
  tabId: number
  origin: string
  plan: string
  active: boolean
  /**
   * One-shot: the just-approved point-of-no-return may have triggered a
   * full-page cross-origin load that committed *after* our post-action snapshot.
   * When set, the next call's origin-drift check re-fences silently (the user
   * already approved the crossing) instead of demanding a fresh grant.
   */
  crossingAuthorized?: boolean
}

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
 * Names that commit money, identity, or destruction — the same intent as
 * COMMITTING_NAME in src/tools/browsePolicy.ts (the policy the LESS-trusted
 * headless research browser is held to). A granted foreground session must
 * not be looser than that: "Delete my account" or "Confirm order" (often
 * type!=='submit' in SPAs) still needs a fresh one-shot approval card.
 */
const COMMITTING_NAME =
  /\b(buy|purchase|checkout|pay|payment|order now|add to (cart|bag)|subscribe|unsubscribe|donate|sign\s*up|signup|register|log\s*in|login|sign\s*in|signin|delete|remove|cancel|confirm|apply now|submit application|place order|continue)\b/i

/**
 * Same vocabulary as COMMITTING_NAME, translated into languages likely to
 * appear on a non-English page (S2): German, French, Spanish, Portuguese,
 * Italian, Russian, Japanese, Chinese, Arabic. English-only coverage was the
 * finding's core bypass — "Löschen"/"Supprimer"/"Eliminar"/"Удалить"/"削除"/
 * "حذف" matched nothing here and is non-empty (so it also clears
 * isBlindClick below), slipping past both nets at once. This is a
 * representative set, not an exhaustive one — see the residual-limits note
 * near isPointOfNoReturn.
 *
 * Deliberately NOT wrapped in \b for Cyrillic/CJK/Arabic: JS's \b is defined
 * against `\w` (`[A-Za-z0-9_]` only, without a Unicode-aware flag), so
 * neither side of e.g. "削除" is ever a `\w` character — \b would never
 * match there at all, silently turning `\b削除\b` into a pattern that can
 * never match anything. Plain substring alternation is correct instead;
 * these scripts share no codepoints with the Latin words, so there is no
 * cross-alphabet false-positive risk from dropping \b.
 */
const COMMITTING_NAME_INTL =
  /\b(löschen|entfernen|kaufen|bezahlen|bestätigen|abonnieren|abbestellen|registrieren|anmelden|einloggen|kündigen|senden|bestellen|supprimer|retirer|acheter|payer|confirmer|abonner|désabonner|inscrire|connecter|envoyer|commander|annuler|eliminar|borrar|comprar|pagar|confirmar|suscribir|cancelar|enviar|registrarse|iniciar sesión|apagar|assinar|inscrever|eliminare|acquistare|pagare|confermare|annullare|inviare|iscriversi)\b|удалить|купить|оплатить|подтвердить|отправить|войти|зарегистрироваться|отменить|削除|購入|支払い|確認|送信|登録|ログイン|注文|退会|キャンセル|删除|购买|支付|确认|发送|注册|登录|下单|取消|订阅|حذف|شراء|دفع|تأكيد|إرسال|تسجيل|إلغاء|طلب/i

/**
 * A representative, not exhaustive, set of icons commonly used ALONE (no
 * text label at all) for a committing action — the other half of S2's
 * bypass (an emoji-only name is non-empty, so it clears isBlindClick too).
 * Deliberately excludes the ambiguous "X"/❌ glyph: it is at least as often
 * "close/dismiss this dialog" (the SAFE escape hatch) as it is "delete", and
 * this file already treats bare "cancel" as committing — flagging the
 * ubiquitous corner-of-every-modal dismiss button too would be a real
 * card-fatigue regression for little added safety (a genuine delete-via-X is
 * rare next to dismiss-via-X).
 */
const COMMITTING_EMOJI = /🗑️|🗑|🛒|💳|💰|💸|📤|✅|✔️|✔/

/** True when `name` reads as committing in English, a major non-English
 *  language, or a common committing icon. See the three checks above for
 *  what each closes and what each deliberately leaves out. */
const isCommittingName = (name: string): boolean =>
  COMMITTING_NAME.test(name) || COMMITTING_NAME_INTL.test(name) || COMMITTING_EMOJI.test(name)

/**
 * A click target the approval card could not describe at all: no href (so it
 * is not a link going somewhere nameable) and no accessible name (aria-label,
 * visible text, placeholder, value, title, and name attribute all empty).
 *
 * `el.type` is a native-IDL-only property: it silently reads `undefined` on a
 * `<div role="button">` or a plain onclick-driven `<span>`, so those elements
 * carry no signal at all and sail past every check above them. If we cannot
 * even describe what the element does — the card would show an empty label —
 * assume the worst rather than assume it is safe.
 */
const isBlindClick = (el: IndexedElement): boolean => !el.href && !el.name.trim()

/**
 * Known, accepted limitation (S4): every check above that reads a `name` —
 * isCommittingName, and the ancestorName check in isPointOfNoReturn below —
 * trusts the page's own self-description. A hostile page can label a
 * "Delete account" button "Cancel" and there is no DOM signal that tells them
 * apart; this is the same trust a screen-reader user extends to a page's own
 * aria-label. Not something this file can fully fix — the available
 * mitigation is structural, not textual: every check below that does NOT
 * depend on `name` (cross-origin href, `type==='submit'|'image'`, the
 * `sensitive` flag) runs UNCONDITIONALLY, so a benign-sounding name can never
 * suppress one of those. Keep it that way — do not add an "unless the name
 * looks safe" escape hatch to any structural check, or a lying label stops
 * being merely unhelped and starts being actively trusted. (The ancestorName
 * check is an incidental partial mitigation when the conflict spans two
 * levels — e.g. the clicked element says "Cancel" but its delegated
 * container's OWN aria-label says "Delete row" — but a single element lying
 * about itself, with no structural tell at all, remains undetectable.)
 */

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
    if (isCommittingName(el.name)) return true
    // Event delegation (S3): a container attaches one handler and dispatches
    // by target, so the clicked descendant (an icon, a row's plain text) can
    // carry an innocuous name while the ancestor that actually defines what
    // happens — a <form>'s own aria-label, a dialog's title, or the nearest
    // independently-clickable ancestor's own aria-label (domIndex.ts's
    // ancestorNameOf) — says otherwise. This deliberately does NOT fire for
    // merely sitting inside SOME form/dialog: only when that container's own
    // name reads as committing, the same bar as the element's own name gets
    // held to. That scoping is what keeps this from flagging every button in
    // every ordinary search/contact/login form (card fatigue).
    if (el.ancestorName && isCommittingName(el.ancestorName)) return true
    if (isBlindClick(el)) return true
  }
  return false
}

/**
 * Did the element at this index change in a way that could invalidate an
 * approval card the user already read? Compares exactly the fields the card's
 * summary and the point-of-no-return decision are built from: name, type,
 * href, sensitivity, and tag. Deliberately ignores `value`/`rect` — those
 * drift on every ordinary reflow (a live value update, a layout shift) and
 * are not evidence that a *different* element now sits at this index.
 *
 * The gap this closes: the card's summary is built from a snapshot taken
 * BEFORE the human reaction-time wait inside requestApproval. An ordinary
 * async re-render (a price/coupon recalculation relabeling the very button
 * the card described) can swap what the stamped index points to while the
 * card is still on screen — the user approves what the card said, but the
 * element that actually gets clicked may no longer match it.
 */
export function hasElementChanged(
  before: IndexedElement | undefined,
  after: IndexedElement | undefined,
): boolean {
  if (!before && !after) return false
  if (!before || !after) return true
  return (
    before.name !== after.name ||
    before.type !== after.type ||
    before.href !== after.href ||
    before.sensitive !== after.sensitive ||
    before.tag !== after.tag
  )
}

export interface ControlStepDeps {
  tabId: number
  spec: ControlSpec
  snapshot: PageSnapshot
  /** Presence hook: glide the cursor/spotlight to `index` before acting. */
  beforeAct?: (index: number | undefined) => Promise<void>
  /** Presence hook: play the click pulse after acting. */
  afterAct?: () => Promise<void>
  /**
   * Presence hook: re-establish the overlay after a navigation replaced the
   * page's DOM (which wipes the injected overlay). Called once the new document
   * has settled and been re-read, so the tint/frame/cursor return on the fresh
   * page instead of vanishing for the rest of the session.
   */
  afterNav?: () => Promise<void>
}

export interface ControlStepResult extends ActionResult {
  /** Refreshed registry text after the action. */
  registry: string
  /** Page origin after the action (empty if the re-read failed). Lets the
   *  caller re-fence the session when an action crossed origins. */
  origin: string
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
  const { tabId, spec, beforeAct, afterAct, afterNav } = deps
  const needsTarget = spec.index !== undefined && spec.action !== 'navigate'
  if (beforeAct && needsTarget) await beforeAct(spec.index)
  const result = await runRaw(tabId, spec)
  // The ripple represents a click; only play it for clicks (not type/select/
  // scroll/navigate/press/highlight).
  if (afterAct && result.ok && spec.action === 'click') await afterAct()
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
  let origin = ''
  try {
    const snap = await snapshotPage(tabId)
    registry = snap.text
    origin = snap.origin
  } catch {
    registry = '(could not re-read the page)'
  }
  // A navigation replaces the page's DOM and so destroys the injected presence
  // overlay. Re-establish it whenever this step navigated — the explicit
  // navigate action (which may reload to the same origin), or any action that
  // drifted the origin — so the tint/frame/cursor come back on the fresh page
  // now, not on the next step (or never, if this was the last step).
  if (afterNav && (spec.action === 'navigate' || (origin !== '' && origin !== deps.snapshot.origin)))
    await afterNav()
  return { ...result, registry, origin }
}
