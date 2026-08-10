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
import { normalizeHost } from '../agent/researchFraming'
import type { IndexedElement } from '../platform/domIndex'
import {
  isBlindClick,
  isCommittingCheckmark,
  isCommittingName,
  isDismissalName,
} from './committingVocabulary'

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

/**
 * The committing/dismissal vocabulary and its predicates (isCommittingName,
 * isCommittingCheckmark, isDismissalName, isBlindClick) live in
 * ./committingVocabulary — shared verbatim with pageControl.ts's
 * isPointOfNoReturn, the gate a human approves. This file is the ONLY gate
 * on the unattended, headless research browser, so it must never be looser
 * than that one; see the shared module for the full vocabulary rationale.
 */

/** Field types that are never a site-search box, whatever they are labelled. */
const CREDENTIAL_TYPE = /^(password|email|tel|number|date|file|checkbox|radio)$/i

/** How a site-search / filter box names itself. */
const SEARCH_NAME = /\b(search|query|filter|find|lookup)\b/i

/**
 * Known, accepted limitation (S4): isCommittingName and the ancestorName
 * check below both trust the page's own self-description — a hostile page
 * can label a "Delete account" control "Cancel" and there is no DOM signal
 * that tells them apart. Not fixable from the DOM alone; see
 * committingVocabulary.ts's comment for the full rationale, which applies
 * here unchanged — including why every check that does NOT depend on `name`
 * (sensitive, the href/SSRF guard, formMethod==='post') stays unconditional
 * so a benign name can never suppress one of those.
 *
 * N2 narrows the ancestorName mitigation the same way as pageControl.ts: an
 * element whose OWN name is an EXACT dismissal word (isDismissalName) is no
 * longer denied by either the own-name or the ancestor-derived check, even
 * with a committing ancestor — see committingVocabulary.ts's comment for the
 * full trade-off (a "Cancel" button in a legitimate confirm dialog vs. the
 * narrower, self-contradictory attack shape this gives up). Exact-match
 * only, and never touches the structural checks (sensitive,
 * formMethod==='post', the href/SSRF guard) below.
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

/**
 * True when `url`'s host is within `scope`. An empty scope allows everything,
 * which is the unrestricted default and today's behavior.
 *
 * Matching is registrable-host based: a scope of `aftershockpc.com` admits
 * `www.` and `sg.` subdomains but NOT `aftershockpc.com.evil.net` — the dot in
 * the suffix check is what makes that collision fail rather than pass.
 */
export function scopeAllows(url: string, scope: string[]): boolean {
  if (scope.length === 0) return true
  // A document the user attached is always in scope: they handed it over
  // deliberately, which makes it the most explicitly-scoped source there is, and
  // refusing it because they ALSO pinned a website would be perverse. It has no
  // host to match anyway. This cannot widen browsing — `attachment:` is not a
  // fetchable scheme, so isFetchableUrl refuses it regardless of what this says.
  if (url.startsWith('attachment:')) return true
  const host = normalizeHost(url)
  if (!host) return false
  return scope.some((entry) => {
    const s = normalizeHost(entry)
    return s !== null && (host === s || host.endsWith(`.${s}`))
  })
}
