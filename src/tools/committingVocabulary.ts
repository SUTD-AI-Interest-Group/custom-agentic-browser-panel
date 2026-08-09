// The committing/dismissal vocabulary shared by the two point-of-no-return
// gates in this codebase: the human-approved foreground page-control session
// (isPointOfNoReturn, pageControl.ts) and the unattended background research
// browser (isSafeResearchAction, browsePolicy.ts). Single-sourced on purpose
// — these two gates protect very different trust boundaries (a human reads
// pageControl.ts's approval card; nobody is watching browsePolicy.ts's
// headless browser), so a committing verb added to one file's copy and not
// the other used to be able to silently open a gap in whichever gate got
// missed, with no failing test to catch it (each file's suite only exercised
// its own copy). See committingVocabulary.test.ts for the cross-gate parity
// check that now guards against exactly that.
//
// The only exported surface is the four predicate functions below — neither
// pageControl.ts nor browsePolicy.ts ever needed the raw regexes themselves,
// only what they classify.

import type { IndexedElement } from '../platform/domIndex'

/**
 * Names that commit money, identity, or destruction. Denied/gated however
 * the control is wired up — a POST form, a GET link, or an onclick handler.
 * "place order" and "continue" matter here as much as "buy"/"delete": this
 * list used to read `...submit application)` in browsePolicy.ts, silently
 * missing both — a gap in the LESS-trusted, unattended gate that no test
 * caught since neither file's suite exercised either term.
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
 * near isPointOfNoReturn in pageControl.ts.
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
 * this codebase already treats bare "cancel" as committing — flagging the
 * ubiquitous corner-of-every-modal dismiss button too would be a real
 * card-fatigue regression for little added safety (a genuine delete-via-X is
 * rare next to dismiss-via-X). (N1 pulled the checkmark glyphs OUT of this
 * set for the same reason — see AMBIGUOUS_COMMITTING_EMOJI below.)
 */
const COMMITTING_EMOJI = /🗑️|🗑|🛒|💳|💰|💸|📤/

/**
 * Checkmark glyphs (N1): at least as often "mark complete" / "acknowledge" —
 * a to-do app's done-checkbox, a toast's dismiss-check — as a destructive
 * confirm. A bare check mark is core, everyday UI; treating it as committing
 * by itself would be exactly the card-fatigue regression the reasoning about
 * ❌ above already rejects for a comparably ambiguous glyph. It only counts
 * as committing when the surrounding container ALSO reads as committing — a
 * dialog titled "Confirm delete", a form named "Complete purchase" — via the
 * ancestorName signal each gate computes for itself. See
 * isCommittingCheckmark below, the only place this is used.
 */
const AMBIGUOUS_COMMITTING_EMOJI = /✅|✔️|✔/

/** True when `name` reads as committing in English, a major non-English
 *  language, or an unambiguous committing icon. Deliberately excludes the
 *  ambiguous checkmark glyphs (isCommittingCheckmark below needs ancestor
 *  context too) and, for an exact bare-word match, the dismissal vocabulary
 *  (isDismissalName below). */
export const isCommittingName = (name: string): boolean =>
  COMMITTING_NAME.test(name) || COMMITTING_NAME_INTL.test(name) || COMMITTING_EMOJI.test(name)

/**
 * N1: a checkmark glyph commits only when its own ancestor context also
 * reads as committing — never from the bare glyph alone. See
 * AMBIGUOUS_COMMITTING_EMOJI above for the full reasoning.
 */
export const isCommittingCheckmark = (el: IndexedElement): boolean =>
  AMBIGUOUS_COMMITTING_EMOJI.test(el.name) && !!el.ancestorName && isCommittingName(el.ancestorName)

/**
 * N2: the universal "back out of this flow without committing" label —
 * Cancel/Close/Back/Dismiss/No/Not now and translated equivalents — matched
 * ONLY as the WHOLE (trimmed) accessible name, never a substring. Exact
 * match is what keeps this safe: "cancel" (and several of its translations —
 * annuler, cancelar, キャンセル, 取消, إلغاء) is ALSO already in
 * COMMITTING_NAME/_INTL, because "Cancel subscription" / "Annuler
 * l'abonnement" genuinely commits (it stops/destroys a live thing) — but the
 * bare word alone, with nothing else in the name, is overwhelmingly the
 * ordinary dismiss-button convention instead. "Cancel subscription" does not
 * match this regex (it has an object after the verb), so it stays flagged;
 * only the standalone label is exempted. A representative, not exhaustive,
 * set, same convention and language coverage as COMMITTING_NAME_INTL above.
 */
const DISMISSAL_NAME =
  /^(cancel|close|back|dismiss|no|not now|skip|abbrechen|schließen|zurück|nein|annuler|fermer|retour|non|cancelar|cerrar|fechar|atrás|voltar|não|annulla|chiudi|indietro|отмена|закрыть|назад|нет|キャンセル|閉じる|戻る|いいえ|取消|关闭|返回|否|إلغاء|إغلاق|رجوع|لا)$/i

/** True when `name`, taken as a WHOLE (not a substring), is an explicit
 *  dismissal control. See DISMISSAL_NAME above and its use in each gate's
 *  own point-of-no-return check for what this does and does not suppress. */
export const isDismissalName = (name: string): boolean => DISMISSAL_NAME.test(name.trim())

/**
 * A click target the approval card (or, in browsePolicy.ts, the denial
 * message) could not describe at all: no href (so it is not a link going
 * somewhere nameable) and no accessible name (aria-label, visible text,
 * placeholder, value, title, and name attribute all empty).
 *
 * `el.type` is a native-IDL-only property: it silently reads `undefined` on a
 * `<div role="button">` or a plain onclick-driven `<span>`, so those elements
 * carry no signal at all and sail past every other check. If we cannot even
 * describe what the element does, assume the worst rather than assume it is
 * safe — in pageControl.ts that means always raising a card, in
 * browsePolicy.ts (no human to show a card to) it means always denying.
 */
export const isBlindClick = (el: IndexedElement): boolean => !el.href && !el.name.trim()

/**
 * Known, accepted limitation (S4): every check above that reads a `name`
 * trusts the page's own self-description. A hostile page can label a
 * "Delete account" button "Cancel" and there is no DOM signal that tells
 * them apart; this is the same trust a screen-reader user extends to a
 * page's own aria-label. Not something this module can fully fix — the
 * available mitigation is structural, not textual: every check in each
 * gate's own file that does NOT depend on `name` (cross-origin href,
 * `type==='submit'|'image'`, the `sensitive` flag, `formMethod==='post'`)
 * runs UNCONDITIONALLY there, so a benign-sounding name can never suppress
 * one of those. Keep it that way in both callers — do not add an "unless the
 * name looks safe" escape hatch to any structural check, or a lying label
 * stops being merely unhelped and starts being actively trusted.
 *
 * N2 narrows the ancestorName mitigation on purpose: an element whose OWN
 * name is an EXACT dismissal word (isDismissalName — bare "Cancel"/"Close"/
 * "Back"/etc.) is no longer flagged by either the own-name or the
 * ancestor-derived check, even when the ancestor's own name reads as
 * committing. That gives up the previous incidental catch of "the clicked
 * element says 'Cancel' but its delegated container's OWN aria-label says
 * 'Delete row'" for the FAR more common legitimate shape — literally every
 * purchase/delete confirmation dialog's own Cancel button, which has exactly
 * this shape (dialog named after the committing flow, containing a plain
 * "Cancel" control). A page that mislabels its real commit control "Cancel"
 * while leaving an honestly-committing ancestor label in place is a narrow,
 * self-contradictory attack shape next to the ubiquitous safe pattern it
 * would otherwise put a card/denial on every single time; treat it as folded
 * into the same accepted-undetectable class as the rest of this paragraph,
 * one level less mitigated than before. The exemption is exact-match only,
 * so it never touches a compound name ("Cancel subscription" keeps
 * flagging) or any of the structural checks above.
 */
