// What a page-control session actually did, and which of it can be taken back.
//
// `CloseTabs` stashes a closed batch for a one-level `reopen` — until now the
// only undo in the product. A granted control session could type into a dozen
// fields and left no record and no way back: the presence overlay lets you
// WATCH it work, which is excellent live and useless five minutes later.
//
// Pure and Chrome-free so the classification below — which is the whole
// security-relevant part — is unit-tested without a browser, matching
// browsePolicy.ts's shape for the same reason.
//
// ── The lifetime split, which is the point of this module ────────────────────
// A journal that stores what was typed is a NEW plaintext secret surface, and
// the observability invariant already names `ControlPage`'s `text`/`value` as
// carrying real secrets under deliberately generic key names. So the record is
// split by LIFETIME rather than by trust:
//
//   * The journal built here — rendered, and living as long as the session's
//     card — never holds a raw value. A sensitive field's value is replaced
//     outright, and every other value is passed through `redactSecrets`.
//   * The RAW prior value needed to actually restore a field lives only in
//     memory on the live `ControlSession` (see pageControl.ts), which the turn
//     chain's outer `finally` tears down. It is never persisted and never
//     rendered.
//
// So a password can be typed, and undone within the session, without ever being
// written anywhere it could outlive the turn.

import { redactSecrets } from '../agent/observability/redact'
import type { IndexedElement } from '../platform/domIndex'
import type { ControlAction, ControlSpec } from './pageControl'

/** One recorded action. Safe to render and to persist — see the module header. */
export interface ControlJournalEntry {
  at: number
  action: ControlAction
  /** `[index]` the action targeted, when it had one. */
  index?: number
  /** The element's accessible name, for the timeline ("typed into \"Email\""). */
  label?: string
  /** Human sentence describing what happened. */
  summary: string
  /**
   * The value involved, redacted. `undefined` when the action carried none
   * (a click, a scroll). Never a raw secret — see the module header.
   */
  redactedValue?: string
  /** Whether this action can be taken back at all (see `classifyUndoable`). */
  undoable: boolean
  /** True when the target was a password/payment-like field. */
  sensitive: boolean
  /** Origin the page was on when this ran; undo refuses across a change. */
  origin: string
  /** URL the page was on when this ran; undo refuses across a change. */
  url: string
}

/** Actions whose effect is a field value this module knows how to restore. */
const RESTORABLE_ACTIONS: ReadonlySet<ControlAction> = new Set<ControlAction>(['type', 'select'])

/**
 * Can this action be reverted?
 *
 * Deliberately narrow. Only a field edit is restorable, because only a field
 * edit has a prior value we captured and can put back. Everything else is
 * either irreversible in principle (a form submit, a purchase — the very
 * point-of-no-return actions the approval gate already stops on), or reversible
 * only in appearance: re-navigating "back" after a navigation re-runs whatever
 * the destination does, and a click's effect is entirely the page's business.
 *
 * A **sensitive** field is never undoable, and that is a lifetime decision
 * rather than a capability one: restoring it would mean holding its prior value
 * long enough for the user to click a button, and a card can sit on screen
 * indefinitely. The narrower promise is the honest one.
 */
export function classifyUndoable(
  spec: ControlSpec,
  el: IndexedElement | undefined,
  priorValue: string | undefined,
): boolean {
  if (spec.sensitive || el?.sensitive) return false
  if (!RESTORABLE_ACTIONS.has(spec.action)) return false
  // Nothing to restore TO. An empty string is a legitimate prior value (the
  // field started blank), so this checks for absence, not falsiness.
  return priorValue !== undefined
}

/** A short human sentence for the timeline. */
function describe(spec: ControlSpec, el: IndexedElement | undefined): string {
  const target = el?.name ? `“${el.name}”` : spec.index !== undefined ? `element ${spec.index}` : 'the page'
  switch (spec.action) {
    case 'type':
      return `typed into ${target}`
    case 'select':
      return `chose an option in ${target}`
    case 'click':
      return `clicked ${target}`
    case 'press':
      return `pressed ${spec.keys ?? 'a key'}`
    case 'scroll':
      return `scrolled ${spec.direction ?? 'down'}`
    case 'navigate':
      return `navigated to ${spec.url ?? 'a new page'}`
    case 'highlight':
      return `highlighted ${target}`
    case 'wait':
      return 'waited for the page to settle'
  }
}

/**
 * The recordable form of a typed/selected value.
 *
 * A **sensitive** field is replaced outright rather than run through the
 * redactor — a password has no diagnostic worth that would justify betting on
 * the heuristics being complete, the same reasoning `instrumentTools.ts`
 * applies to a denied call's arguments. Everything else still goes through
 * `redactSecrets` under the `ControlPage` tool name, so its shape-based net
 * (Luhn-valid numbers, high-entropy strings) catches a card number typed into a
 * field the page never labelled as one.
 */
function safeValue(raw: string | undefined, sensitive: boolean): string | undefined {
  if (raw === undefined) return undefined
  if (sensitive) return '[redacted]'
  const swept = redactSecrets({ value: raw }, 'ControlPage') as { value?: unknown }
  return typeof swept.value === 'string' ? swept.value : '[redacted]'
}

/**
 * Build the renderable record of one action.
 *
 * `priorValue` is accepted only to decide undoability — it is never copied into
 * the returned entry. The raw value stays with the caller, in memory.
 */
export function buildEntry(
  spec: ControlSpec,
  el: IndexedElement | undefined,
  priorValue: string | undefined,
  at: number,
  page: { origin: string; url: string },
): ControlJournalEntry {
  const sensitive = spec.sensitive === true || el?.sensitive === true
  const raw = spec.action === 'select' ? spec.value : spec.text

  return {
    at,
    action: spec.action,
    index: spec.index,
    label: el?.name || undefined,
    summary: describe(spec, el),
    redactedValue: safeValue(raw, sensitive),
    undoable: classifyUndoable(spec, el, priorValue),
    sensitive,
    origin: page.origin,
    url: page.url,
  }
}

/**
 * Is this entry still safe to undo *now*?
 *
 * Undo restores a field by `[index]`, and those indices are stamped onto the
 * DOM of one particular document (`data-agent-idx`). A navigation replaces that
 * document: the stamps are gone, and index 4 on the new page is some unrelated
 * element. So an entry recorded on a different URL is refused rather than
 * applied — an undo that silently types into the wrong field on the wrong page
 * is far worse than an undo that declines.
 */
export function isUndoable(
  entry: ControlJournalEntry,
  current: { origin: string; url: string },
): boolean {
  if (!entry.undoable) return false
  return entry.origin === current.origin && entry.url === current.url
}

/** Entries that can still be reverted, newest first — the order undo applies. */
export function revertableEntries(
  entries: ControlJournalEntry[],
  current: { origin: string; url: string },
): ControlJournalEntry[] {
  return entries.filter((e) => isUndoable(e, current)).reverse()
}
