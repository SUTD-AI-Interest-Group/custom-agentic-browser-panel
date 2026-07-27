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

### AutofillForm: the same session, per-field consent

`AutofillForm` is the one other tool that acts *inside* a granted session. It types
the user's saved `profile` memories — name, email, address — into the fields the
model maps by `[index]`, and it inherits both gates while adding a rule of its own:
**submit is never part of the tool**, and any *sensitive* field (password, payment)
still raises a one-shot point-of-no-return card. Its sharpest edge — carrying your
PII across an origin change mid-fill — is told as a
[Security near-miss](Security-and-the-Permission-Model#the-near-miss); the fix is the
same "re-check the origin every field" lesson as the cross-origin fence above.

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
