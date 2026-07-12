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

/** Field types that are never a site-search box, whatever they are labelled. */
const CREDENTIAL_TYPE = /^(password|email|tel|number|date|file|checkbox|radio)$/i

/** How a site-search / filter box names itself. */
const SEARCH_NAME = /\b(search|query|filter|find|lookup)\b/i

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
      if (COMMITTING_NAME.test(el.name)) {
        return deny(`refused to click "${el.name}" — it looks like it commits an action (purchase/auth/destructive)`)
      }
      // A <button> with no explicit type reports type="submit" from the DOM, so
      // this catches the default-submit case too. GET submits are search-shaped
      // and idempotent; POST submits create state.
      if (el.type === 'submit' && el.formMethod === 'post') {
        return deny('refused to submit a POST form')
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
