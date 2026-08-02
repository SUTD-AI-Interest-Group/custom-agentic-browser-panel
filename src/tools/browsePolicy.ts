// The action policy for the BACKGROUND research browser. Pure and Chrome-free so
// it can be exercised exhaustively in vitest — this is the piece that decides what
// the agent may do in a tab where NO HUMAN IS AT THE GATE.
//
// The foreground page-control agent has a human behind every point-of-no-return
// step (see isPointOfNoReturn in pageControl.ts). The research browser does not:
// it runs headless in the offscreen host, in an isolated incognito window, with
// the user very possibly asleep. So instead of "ask a human", the rule here is
// "only do things that cannot commit anything" — read, navigate, and site-search.
//
// The window is logged-out (incognito, no cookie jar), so nothing behind an auth
// wall is reachable in the first place; this policy is the second layer, stopping
// the agent from *creating* state (submitting, buying, registering) on the open web.

import { isFetchableUrl } from '../platform/webFetch'
import type { IndexedElement } from '../platform/domIndex'

/** One thing the research browser can attempt to do to the page. */
export type BrowseAction =
  | { kind: 'click'; index: number }
  | { kind: 'type'; index: number; text: string }
  | { kind: 'press'; keys: string; index: number }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'toElement'; index?: number }
  | { kind: 'back' }
  | { kind: 'navigate'; url: string }

/** Allowed, or refused with a reason the model sees (so it can try another way). */
export type PolicyVerdict = { ok: true } | { ok: false; reason: string }

const ALLOW: PolicyVerdict = { ok: true }
const deny = (reason: string): PolicyVerdict => ({ ok: false, reason })

/** Controls that commit money, identity, or destruction. Denied however they are
 *  wired up — a POST form, a GET link, or an onclick handler. */
const COMMITTING_NAME =
  /\b(buy|purchase|checkout|pay|payment|order now|add to (cart|bag)|subscribe|unsubscribe|donate|sign\s*up|signup|register|log\s*in|login|sign\s*in|signin|delete|remove|cancel|confirm|apply now|submit application)\b/i

/**
 * Same vocabulary as COMMITTING_NAME, translated into languages likely to
 * appear on a non-English page (S2): German, French, Spanish, Portuguese,
 * Italian, Russian, Japanese, Chinese, Arabic. English-only coverage was the
 * finding's core bypass — on THIS policy, the only gate on the unattended,
 * headless research browser — see the identical constant + comment in
 * src/tools/pageControl.ts for the full rationale (including why non-Latin
 * scripts are deliberately not \b-wrapped). Representative, not exhaustive.
 */
const COMMITTING_NAME_INTL =
  /\b(löschen|entfernen|kaufen|bezahlen|bestätigen|abonnieren|abbestellen|registrieren|anmelden|einloggen|kündigen|senden|bestellen|supprimer|retirer|acheter|payer|confirmer|abonner|désabonner|inscrire|connecter|envoyer|commander|annuler|eliminar|borrar|comprar|pagar|confirmar|suscribir|cancelar|enviar|registrarse|iniciar sesión|apagar|assinar|inscrever|eliminare|acquistare|pagare|confermare|annullare|inviare|iscriversi)\b|удалить|купить|оплатить|подтвердить|отправить|войти|зарегистрироваться|отменить|削除|購入|支払い|確認|送信|登録|ログイン|注文|退会|キャンセル|删除|购买|支付|确认|发送|注册|登录|下单|取消|订阅|حذف|شراء|دفع|تأكيد|إرسال|تسجيل|إلغاء|طلب/i

/**
 * A representative, not exhaustive, set of icons commonly used ALONE (no
 * text label at all) for a committing action (S2's other half — an
 * emoji-only name is non-empty, so it also clears isBlindClick below).
 * Deliberately excludes ❌/"X" — see pageControl.ts's identical constant for
 * why (it reads at least as often as "dismiss" as "delete"). (N1 pulled the
 * checkmark glyphs OUT of this set too — see AMBIGUOUS_COMMITTING_EMOJI.)
 */
const COMMITTING_EMOJI = /🗑️|🗑|🛒|💳|💰|💸|📤/

/**
 * Checkmark glyphs (N1) — see pageControl.ts's identical constant for the
 * full rationale: a bare check mark is at least as often "mark complete" /
 * "acknowledge" as a destructive confirm, so it only counts as committing
 * when the ancestor context also reads as committing (isCommittingCheckmark
 * below), never from the bare glyph alone.
 */
const AMBIGUOUS_COMMITTING_EMOJI = /✅|✔️|✔/

/** True when `name` reads as committing in English, a major non-English
 *  language, or an unambiguous committing icon. Deliberately excludes the
 *  ambiguous checkmark glyphs (isCommittingCheckmark) and, for an exact
 *  bare-word match, the dismissal vocabulary (isDismissalName). */
const isCommittingName = (name: string): boolean =>
  COMMITTING_NAME.test(name) || COMMITTING_NAME_INTL.test(name) || COMMITTING_EMOJI.test(name)

/**
 * N1: a checkmark glyph denies only when its own ancestor context also
 * reads as committing — never from the bare glyph alone. See
 * pageControl.ts's identical function for the full rationale.
 */
const isCommittingCheckmark = (el: IndexedElement): boolean =>
  AMBIGUOUS_COMMITTING_EMOJI.test(el.name) && !!el.ancestorName && isCommittingName(el.ancestorName)

/**
 * N2: the universal "back out of this flow without committing" label —
 * Cancel/Close/Back/Dismiss/No/Not now and translated equivalents — matched
 * ONLY as the WHOLE (trimmed) accessible name, never a substring. Identical
 * vocabulary and exact-match reasoning as pageControl.ts's DISMISSAL_NAME:
 * "cancel" (and several translations — annuler, cancelar, キャンセル, 取消,
 * إلغاء) is ALSO already in COMMITTING_NAME/_INTL for phrases like "Cancel
 * subscription" that genuinely commit; the bare word alone is instead the
 * ordinary dismiss-button convention. Exact match keeps the compound phrase
 * denied — only the standalone label is exempted.
 */
const DISMISSAL_NAME =
  /^(cancel|close|back|dismiss|no|not now|skip|abbrechen|schließen|zurück|nein|annuler|fermer|retour|non|cancelar|cerrar|fechar|atrás|voltar|não|annulla|chiudi|indietro|отмена|закрыть|назад|нет|キャンセル|閉じる|戻る|いいえ|取消|关闭|返回|否|إلغاء|إغلاق|رجوع|لا)$/i

/** True when `name`, taken as a WHOLE (not a substring), is an explicit
 *  dismissal control. See DISMISSAL_NAME above. */
const isDismissalName = (name: string): boolean => DISMISSAL_NAME.test(name.trim())

/** Field types that are never a site-search box, whatever they are labelled. */
const CREDENTIAL_TYPE = /^(password|email|tel|number|date|file|checkbox|radio)$/i

/** How a site-search / filter box names itself. */
const SEARCH_NAME = /\b(search|query|filter|find|lookup)\b/i

/**
 * Same "cannot describe it, so do not trust it" rule as pageControl.ts's
 * isBlindClick — see that file for the full rationale (el.type reads
 * undefined on anything that is not a native form control, so a
 * `<div role="button">` or onclick-driven `<span>` carries no signal at all
 * and would otherwise sail past every check below). No human is watching this
 * browser, so "cannot classify" must resolve to deny, not allow.
 */
const isBlindClick = (el: IndexedElement): boolean => !el.href && !el.name.trim()

/**
 * Known, accepted limitation (S4): isCommittingName and the ancestorName
 * check below both trust the page's own self-description — a hostile page
 * can label a "Delete account" control "Cancel" and there is no DOM signal
 * that tells them apart. Not fixable from the DOM alone; see pageControl.ts's
 * identical comment for the full rationale, which applies here unchanged —
 * including why every check that does NOT depend on `name` (sensitive, the
 * href/SSRF guard, formMethod==='post') stays unconditional so a benign name
 * can never suppress one of those.
 *
 * N2 narrows the ancestorName mitigation the same way as pageControl.ts: an
 * element whose OWN name is an EXACT dismissal word (isDismissalName) is no
 * longer denied by either the own-name or the ancestor-derived check, even
 * with a committing ancestor — see pageControl.ts's comment above
 * isPointOfNoReturn for the full trade-off (a "Cancel" button in a
 * legitimate confirm dialog vs. the narrower, self-contradictory attack
 * shape this gives up). Exact-match only, and never touches the structural
 * checks (sensitive, formMethod==='post', the href/SSRF guard) below.
 */

/**
 * Is this element a site-search / filter box — the one input the research browser
 * is allowed to type into? Deliberately narrow: a search-shaped *name* never
 * promotes a credential-shaped *type* (a password field labelled "search" stays
 * off-limits).
 */
export function isSearchInput(el: IndexedElement): boolean {
  if (el.sensitive) return false
  if (el.type && CREDENTIAL_TYPE.test(el.type)) return false
  if (el.role === 'searchbox') return true
  if (el.tag !== 'input') return false
  if (el.type === 'search') return true
  // A plain text input only counts if it *says* it is a search box.
  if (el.type && el.type !== 'text') return false
  return SEARCH_NAME.test(el.name)
}

/**
 * The gate every research-browser action passes through. Returns a reason on
 * refusal rather than throwing, so the refusal reaches the model as a normal tool
 * result and it can pick a different route instead of dead-ending.
 *
 * `el` is the target's registry entry from the latest snapshot; it is required for
 * click/type/press (we refuse to act on an element we cannot see).
 */
export function isSafeResearchAction(action: BrowseAction, el?: IndexedElement): PolicyVerdict {
  switch (action.kind) {
    // Pure reads — always fine.
    case 'scroll':
    case 'back':
      return ALLOW

    // Cross-origin is allowed (surfing is the point); the SSRF guard is what
    // keeps the tab off file://, chrome://, localhost, and the link-local
    // metadata endpoints.
    case 'navigate': {
      const guard = isFetchableUrl(action.url)
      return guard.ok ? ALLOW : deny(`refused to navigate (${guard.reason})`)
    }

    case 'click': {
      if (!el) return deny(`element ${action.index} is not on the page`)
      if (el.sensitive) return deny('refused to click a password/payment field')
      // N2: an explicit dismissal name (bare "Cancel"/"Close"/"Back"/etc.,
      // see isDismissalName) is the standard "back out without committing"
      // control. Checked once and used to gate every remaining name-based
      // check below — both this element's own name (bare "cancel" and
      // several of its translations are otherwise committing, for "Cancel
      // subscription"-style phrases) and its ancestor's (S3). Never gates
      // the structural checks further down (formMethod==='post', the
      // href/SSRF guard) — those stay unconditional.
      const dismissal = isDismissalName(el.name)
      if (!dismissal) {
        if (isCommittingName(el.name)) {
          return deny(`refused to click "${el.name}" — it looks like it commits an action (purchase/auth/destructive)`)
        }
        // N1: a checkmark alone is too ambiguous (to-do "done", toast
        // acknowledge) to deny; it only counts with a committing ancestor.
        if (isCommittingCheckmark(el)) {
          return deny(`refused to click "${el.name}" — it looks like it commits an action (purchase/auth/destructive)`)
        }
        // Event delegation (S3): a container attaches one handler and
        // dispatches by target, so the clicked descendant can carry an
        // innocuous name while its delegated container's own name (a <form>'s
        // aria-label, a dialog's title, or the nearest independently-clickable
        // ancestor's aria-label — domIndex.ts's ancestorNameOf) says otherwise.
        // Scoped to containers that self-describe as committing, not "inside
        // any form/dialog" — that's what keeps an ordinary search/filter form
        // from denying every click inside it.
        if (el.ancestorName && isCommittingName(el.ancestorName)) {
          return deny(
            `refused to click inside "${el.ancestorName}" — its container looks like it commits an action (purchase/auth/destructive)`,
          )
        }
      }
      // A <button> with no explicit type reports type="submit" from the DOM, so
      // this catches the default-submit case too. GET submits are search-shaped
      // and idempotent; POST submits create state.
      if (el.type === 'submit' && el.formMethod === 'post') {
        return deny('refused to submit a POST form')
      }
      // An <a> click navigates the leased research tab just like the explicit
      // `navigate` action does, so it must pass the same SSRF guard — otherwise
      // a page could smuggle a click straight at a blocked target (e.g. the
      // metadata endpoint) around the guard on `navigate`.
      if (el.href) {
        const guard = isFetchableUrl(el.href)
        if (!guard.ok) return deny(`refused to click a link to a blocked target (${guard.reason})`)
      } else if (isBlindClick(el)) {
        return deny(
          `refused to click "${el.tag}" — it has no href and no accessible name, so its effect cannot be verified as safe`,
        )
      }
      return ALLOW
    }

    case 'type': {
      if (!el) return deny(`element ${action.index} is not on the page`)
      if (!isSearchInput(el)) {
        return deny(
          `refused to type into "${el.name || el.tag}" — the research browser may only type into a search/filter box, never a general form field`,
        )
      }
      return ALLOW
    }

    case 'press': {
      if (action.keys !== 'Enter') return deny(`refused to press "${action.keys}" — only Enter is allowed`)
      if (!el) return deny(`element ${action.index} is not on the page`)
      // Enter anywhere else submits whatever form the caret happens to be in.
      if (!isSearchInput(el)) return deny('refused to press Enter outside a search box')
      return ALLOW
    }
  }
}
