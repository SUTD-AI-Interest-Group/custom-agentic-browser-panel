# Page Control

**Goal.** Let the agent *act* on a live page — click, type, select, scroll, press,
navigate — with a human in the loop but without being tedious. One upfront
session grant with a stated plan; low-risk actions then run freely into a live
activity log; **only irreversible actions re-prompt**; Stop always available.

Built entirely on the manifest's existing `scripting`/`tabs` permissions. No
`chrome.debugger`. No new host permissions. No persistent content script.

Spec: [`2026-07-10-browser-use-page-control-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-10-browser-use-page-control-design.md).

---

## The substrate: an indexed DOM

`domIndex.ts` injects a walker that finds visible, interactive elements (tag
allowlist, ARIA roles, `contenteditable`, `cursor:pointer`), caps at 200, and
**stamps each with `data-agent-idx`**. The model addresses elements by `[index]`.

The stamp is doing something specific: `chrome.scripting` injections share **no
JS state** — each runs in a fresh isolated world. The only thing that persists
between two injections is *the DOM itself*. So the registry writes its identity
into the page, and a later injection re-finds the node by attribute. Every
injected function in this codebase is fully self-contained for the same reason.

Text-first, always. The registry is delivered as a plain text list to *every*
model; set-of-marks images are an enhancement for models that pass the vision
probe, never the primary channel ([Agent Perception](Agent-Perception)).

The walk itself is capped at 200 elements, but the cap only bounds the
*expensive* classification pass (`getComputedStyle`, `getBoundingClientRect`) —
not label discovery. `668f8c5` found that both perception registries used to
call `Array.from(root.querySelectorAll('*'))` before consulting the cap at all,
materializing every element in the document (recursing into open shadow roots)
on every single `ReadPage`. `regionIndex` was free to fuse walking with
classification and bail the instant it fills up. `domIndex` cannot: a
`<label for="x">` routinely appears *after* its `<input id="x">` in the markup
— every checkbox/radio pattern is written that way — and that label feeds
sensitive-field detection below. A single fused walk stopping at the element
cap would classify an early input before ever discovering the later label that
names it, silently losing a detection for a field that was well inside the
cap. So the label pass stays exhaustive — a tagName check plus two attribute
reads per node, no layout triggered — and only the classification pass is
bounded by the cap. Document order and shadow-splice order are unchanged
either way, since both registries depend on ancestors being visited before
descendants.

### Typing into React is not typing

From the very first line of `pageActions.ts`:

> Text entry uses the native value setter so React/Vue controlled inputs actually
> re-render.

Setting `input.value = 'x'` in a React app does approximately nothing useful:
React overrides the *instance* value setter, so your write is swallowed and the
component's state never learns about it. The fix is to reach past it to the
prototype's descriptor —
`Object.getOwnPropertyDescriptor(proto, 'value')?.set` — call *that*, then
dispatch synthetic `input`/`change` events.

We chose synthetic events over `chrome.debugger`/CDP deliberately. CDP gives you
genuinely trusted events and would sail past `isTrusted`-gated widgets — at the
cost of the `debugger` permission and Chrome's permanent **"Extension is
debugging this browser"** infobar on every page. In a consumer extension that is
hostile. Synthetic events are the right default; CDP remains a deferred escape
hatch.

## Two nested gates

**Gate one — the session.** `RequestPageControl` shows one card naming the page
and the agent's stated plan. Approving opens a `ControlSession` scoped to a tab
*and an origin*.

**Gate two — the point of no return.** Inside a granted session, individual steps
*still* stop for a one-shot confirmation when `isPointOfNoReturn()` flags them:
form submits, cross-origin navigation, Enter keypresses, password and payment
fields. **Every time.** There is no "allow this chat" button on these cards, and
no policy setting — not even `Always` — can suppress them.

This is the load-bearing distinction of the whole product. A blanket "you may
control this page" is *not* consent for the irreversible step buried inside it.

The committing/dismissal vocabulary behind the form-submit half of this check
— which names ("buy", "delete", "place order", "continue"…) read as
irreversible — used to live as two separate copies: one in `pageControl.ts`
for this human-approved gate, one in `browsePolicy.ts` for the unattended
research browser ([Autonomous Browsing](Autonomous-Browsing)). They drifted.
`pageControl.ts` had matched "place order" and "continue" since its first
commit; `browsePolicy.ts` never had either, and a test titled "flags the full
committing-name vocabulary, mirroring browsePolicy intent" passed anyway,
because it only ever exercised `pageControl`'s own copy — it asserted a parity
that did not exist in the code it named. `e402af1` extracted both regexes
into `committingVocabulary.ts` and converged on the stricter variant, on the
principle that the surface with no human in the loop must never be looser
than the one with a confirmation card. This page's gate was already the
stricter of the two, so the fix mainly closed the *other* gate — but it is now
one shared module, not two that can silently drift again.

**A card that sits open is a window of its own.** `c2edc53` found that
`ControlPage` and `AutofillForm` checked `isForeground()` once, at entry,
before showing any card — but a point-of-no-return card then sits open for
however long the human takes to react, entirely under their control.
Switching tabs and clicking Allow fired the committing action against a tab
the user was no longer watching, defeating the whole point of the foreground
check. The fix re-checks `isForeground()` a second time, immediately after
`requestApproval` resolves and right before the action runs, parking via the
same `parkFor` path the entry check already uses rather than inventing new
behavior for it.

### AutofillForm: the same session, per-field consent

`AutofillForm` is the one other tool that acts *inside* a granted session. It types
the user's saved `profile` memories — name, email, address — into the fields the
model maps by `[index]`, and it inherits both gates while adding a rule of its own:
**submit is never part of the tool**, and any *sensitive* field (password, payment)
still raises a one-shot point-of-no-return card. Its sharpest edge — carrying your
PII across an origin change mid-fill — is told as a
[Security near-miss](Security-and-the-Permission-Model#the-near-miss); the fix is the
same "re-check the origin every field" lesson as the cross-origin fence above.

`AutofillForm` fills a *list* of fields inside one `execute()` call, which made
the foreground re-check above a sharper problem for this tool than for
`ControlPage`: a single stale entry check let the whole remaining batch keep
typing into a page nobody was looking at anymore. `c2edc53`'s fix re-checks
`isForeground()` before every field, not just once at entry, and stops the
*entire* batch — not just the current field — the moment the user tabs away,
reporting back the indices already filled alongside the park so a mid-batch
stop doesn't discard what actually happened.

### Sensitive-field detection: what feeds the card

Whether a field trips the point-of-no-return card in the first place comes
down to one boolean, `sensitive`, computed in `domIndex.ts`'s injected walker
and carried on every `IndexedElement`. It used to be tested against only
`` `${name} ${id}` `` — the raw `name`/`id` attributes — which misses most
React/MUI-style forms outright, where the `id` is machine-generated
(`id="mui-42" placeholder="Card number"`) and the human-readable label lives
somewhere `accessibleName()` already knew how to find for display purposes,
but that value was never fed into the sensitivity check. `3bdd228` closed that
gap by testing every label source — `aria-label`, `placeholder`,
`aria-labelledby`, and both an associated `label[for]` and a wrapping
`<label>` — not just the element's own name/id.

The same commit also generalized the pattern itself: it required literal
whitespace between words, so `account_number`, `account-number`, `sort_code`
and `socialSecurityNumber` all read as ordinary fields, even though the regex
already had a `\bcc[-_]?(num|number|no)\b` alternative that showed the right
shape and had simply never been extended to the rest of the list. The fix
normalizes separators (`-`/`_` collapsed to a space, camelCase boundaries
split) before matching — but every source is *also* still tested raw and
un-normalized, because normalizing unconditionally would **break** the
existing `ccNum` match: splitting it to `cc Num` no longer satisfies the
`[-_]?` gap in the original pattern. Every source is OR'd together, never
AND'd or prioritized, so a hostile page's label can only ever *add* a
detection, never suppress one that a different source already found.

Widening a security regex is not free — a spurious card trains users to click
through — and `swift`/`bic` are the pattern's awkward edge: also an adjective,
a UI framework name, and a pen brand. The fix keeps them out of the general
pattern and matches them separately: a *bare* "swift" or "bic" only counts on
exact equality against each individual label source, while a compound form
like `swift-code` matches anywhere. Without that split, camelCase
normalization manufactures a token boundary that doesn't exist in the real
id — `swiftUIPreview` normalizes to `"swift UI Preview"`, where a bare
`\bswift\b` now matches text that was never actually standalone.

## The hardening pass, and what it caught

`76467a0` — *"Harden page-control gate: one-time confirms, cross-origin click
fence, accurate origin, session teardown"* — is four real bugs in one commit, and
every one of them is a hole in the gate:

- **The grant was fenced to the wrong origin.** The session's `origin` was
  computed from React state (`currentTab?.url`) inside the approval closure —
  not from the tab actually being granted. A stale value meant the fence guarded
  a page you weren't on.
- **"Allow this chat" appeared on point-of-no-return cards** — the exact bypass
  the design forbids. The fix threads a `once?: boolean` through
  `ApprovalRequest` and hides the button:
  `{!isSession && !approval.once && (<button>Allow this chat</button>)}`.
- **A cross-origin `<a>` click walked straight past the second gate.** Only
  explicit `navigate` actions and form submits were checked. A plain link to
  another site wasn't. Now: `if (el.href && hostOf(el.href) !== sessionOrigin)
  return true`.
- **Ending a session left `data-agent-idx` stamps on the old tab.** Teardown was
  factored out and is now called at the *start* of every new session request.

Then `392ca55` found the follow-up we'd missed: `domIndex` only populates `href`
for **real `<a>` tags**, so a `<div role="link">` or a JS `onclick` navigation has
no `href` and *still* slipped past the fence. The answer was to stop trying to
predict navigation from the element and instead **re-check the origin after the
action** — same-step and again on the next call.

That fix created its own annoyance — an approved cross-site navigation would then
tear the session down on the *next* call and demand a second grant. A one-shot
`crossingAuthorized` flag now carries "the user already said yes to this
crossing" across the gap.

The stamp-cleanup half of `76467a0` had its own gap, too, just on the other
registry: teardown stripped `data-agent-idx` but never `data-agent-region`
([Agent Perception](Agent-Perception)'s second registry), and `ReadPage`
mode:`'regions'` deliberately skips its own approval card while a session
already owns the tab — so a session that ever read regions left those stamps
on the user's live page indefinitely after the agent was done with it.
`clearRegions` existed in `regionIndex.ts` for exactly this and was simply
never called from `teardownSession`. `371b2a1` wired it up alongside
`clearIndex`, found incidentally while auditing dead code for an unrelated fix.

**Three passes to fence one thing.** Origin drift is genuinely hard, and each
attempt was a real improvement over the last. The pattern that finally worked was
to stop enumerating the ways a page *might* navigate and start verifying where we
*actually ended up*.

## Presence: making the agent visible

While a session is open, the page carries a translucent tint, a spotlight cutout,
a breathing frame, and a cursor that glides to each element before it acts and
pulses on click. It buys the model nothing. It exists so a human can watch.

There are two intensities of the same overlay, not two systems: **ambient**
(frame only — the agent is merely reading or navigating) and **active control**
(frame + tint + spotlight + cursor).

The bug worth telling is `e51911c`:

> The tint/glow/cursor overlay lives in the page's DOM, so any full-page
> navigation destroys it… nothing re-injected it after a navigate action, a click
> that loaded a new page, or an origin drift, so **the presence vanished while the
> agent kept acting.**

The single worst failure mode this feature could have. The whole point of the
overlay is that the user can see an agent working; a version that disappears
precisely when the agent navigates is worse than none, because it teaches the user
that "no overlay" means "not acting." Fixed by re-establishing the mount
idempotently at the top of *every* control step.

The overlay is also torn down in the continuation chain's **outer** `finally` —
not per turn — so it survives auto-continues but is always cleared on completion,
error, or Stop. Tearing down only on the success path leaves a stale tint on a
user's page after a crash, which is exactly the sort of thing that erodes trust in
an agent permanently.

## Budgets: three became one

Page control originally had its own `MAX_SESSION_ACTIONS = 20`, alongside the
turn's `MAX_STEPS = 24` and the research loop's soft prompt hint. Three
inconsistent budgets, three different exhaustion behaviours.

`e078f3c` deleted the per-session budget entirely. One 24-step budget now bounds
*all* activity — see [Long-Horizon Turns](Long-Horizon-Turns).
