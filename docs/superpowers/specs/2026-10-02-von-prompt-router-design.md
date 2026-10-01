# Von Prompt Router — design

**Status:** design, awaiting review · **Date:** 2026-10-02 · **Area:** `src/router/` (new), `src/ui/Chat.tsx`, `src/data/settings.ts`, `scripts/router-eval/` (new)

## 1. Intent

Before a composer message reaches the chat model, ask Von — once — whether the message is a quick action the harness can do itself. v1 recognises two:

- **`search`** — "search for rust lifetimes", "look up X" → open a web search in a new tab.
- **`switch-tab`** — "go to my gmail tab" → focus an already-open tab.

Everything else is **`chat`**: the message goes to the chat model exactly as today.

Goals, in order:

1. **Experiment.** Find out whether Von can route user messages at all, zero-shot, on the already-pinned act-head weights. This is the cheapest measurable precursor to a broader router (tool pre-selection, memory prefetch) and its numbers decide whether that is worth building.
2. **Speed.** When it can, a quick command lands in ~hundreds of milliseconds instead of a chat-model round trip.

Non-goals (v1): `open-site` (needs history/bookmarks as a candidate source — gated, privacy-sensitive; v2), tool pre-selection for the chat model, passing a routing hint to the chat model on fall-through, prompt rewriting of any kind.

## 2. Constraints carried in from the codebase

- **Von never produces text.** It scores options in a closed set the harness built (the `Act` invariant). The search query is therefore cut from the user's words by the harness, never generated.
- **Every action routes through the human gate.** The router is a new actor, so it uses the same `ApprovalQueue` the tools use; its policy is a first-class entry in the tool policy list.
- **User messages are frozen claims.** The user's message is kept verbatim; nothing the router decides rewrites it.
- **Failure must look like absence.** The router is an optimisation. Every failure falls through to the chat model and must never strand the user's bubble.

## 3. Architecture

### 3.1 Where it runs

In `startFreshTurn` (`src/ui/Chat.tsx`), after the user bubble is pushed and before `buildUserTurn`. It runs **only** for a fresh turn with:

- no attachments,
- no leading `/skill`,
- no `@memory`,
- no open page-control session,
- policy ≠ `never` and `resolveSystem1(settings)` defined.

Steers, regenerate, continue and resume never touch the router.

### 3.2 Units

| File | Kind | Responsibility |
|---|---|---|
| `src/router/candidates.ts` | pure, tested | Build the closed route set from `(message, tabs, currentTabId)`. `chat` always; `search` always (with its stripped query); one `switch-tab:<id>` per open tab other than the current one, rendered as title (clipped) + host only. |
| `src/router/query.ts` | pure, tested | Deterministic search-query extraction: strip a leading command phrase (`search for`, `search`, `look up`, `google`, `find me`, …) and trailing punctuation. Empty result ⇒ `search` is not offered. |
| `src/router/policy.ts` | interface | `RoutePolicy.decide(message, candidates) → { route, top, decideMs }`. |
| `src/router/vonPolicy.ts` | adapter | One `DecideRequest`: state `Message: <neutralized, clipped 300>`; one question `route` whose options are the candidate lines (`search: open a web search for "<query>"`, `switch-tab: switch to the open tab "<title>" (<host>)`, `chat: answer, explain, or do anything else with the assistant`). Reuses `neutralize`/`clip` from `vonPolicy.ts`. |
| `src/router/heuristicPolicy.ts` | adapter | The regex baseline (`top` ∈ {0, 1}). **Eval-only in v1** — never wired into the product. |
| `src/router/validate.ts` | pure, tested | The chosen key must be a member of the candidate set; otherwise `chat`. |
| `src/router/plan.ts` | pure, tested | `planRoute({decision, policy, searchPermitted}) → 'run' \| 'card' \| 'chat'` — the whole band × policy table (§4) in one function. |
| `src/router/run.ts` | shell | Resolve candidates → decide (with the 300 ms budget) → validate → plan → card / execute → report `{handled, message?}` back to `startFreshTurn`. |

### 3.3 Data flow

```
submit → startFreshTurn → push user bubble
       → routerEligible? ── no ──────────────────────────────┐
       → candidates → Von.decide (≤300 ms, warm engine only)  │
       → validate → planRoute                                 │
            run ─────────► execute ─► ok ─► Von bubble, done  │
            card ─► Allow ─► execute ─► ok ─► Von bubble      │
                    Ask Lychee instead / failure ─────────────┤
            chat ─────────────────────────────────────────────┤
                                                              ▼
                                        buildUserTurn → runTurnChain (unchanged)
```

### 3.4 Latency budget

Decide must return within **300 ms** (the `Act` kill-criterion figure) or the router falls through. A **cold** engine falls through immediately rather than paying the 1.2–6 s boot; composer focus calls `System1Runtime.warm()` so the second message onward is warm.

## 4. Permissions and confidence bands

**One policy:** a `TOOL_CATALOG` entry `PromptRouter` — label "Prompt Router (beta)", group `navigation`, default `ask`, flagged so Settings shows it (with a *Beta* badge) only when System-1 is available.

| Von's top choice | `never` | `ask` | `always` |
|---|---|---|---|
| any | router does not run | | |
| `chat`, any confidence | | chat | chat |
| non-chat, `top ≥ ROUTE_CONFIDENCE` | | **card** | **run, no card** |
| non-chat, `ROUTE_TRY_CONFIDENCE ≤ top < ROUTE_CONFIDENCE` | | card | card |
| non-chat, `top < ROUTE_TRY_CONFIDENCE` | | chat | chat |

- **No session grant.** The card is always one-shot (`once: true`): under `ask` every router action shows a card, "Allow this chat" never appears, and `sessionAllowed` is not consulted. Only the Settings-level `always` ("allow for all chats") lets Von act without a card.
- **Thresholds are not borrowed.** `top`'s calibration was fit on the act head, not routing. Constants start at `ROUTE_CONFIDENCE = 0.85`, `ROUTE_TRY_CONFIDENCE = 0.5` and are set by the eval (§7).
- **`search` needs an optional permission.** `chrome.search.query({text, disposition: 'NEW_TAB'})` uses the user's own default engine and needs the `search` permission, added to `optional_permissions` (Chrome warns on it — same reasoning as `tabGroups`). Until granted, a `search` decision is always carded, even under `always`; the card's Allow requests it via `needsPermissions`, ahead of every `await` in `settleApproval` (the existing gesture rule).
- **The card states exactly what will happen:** *Search the web for "rust lifetimes"* / *Switch to "Inbox – Gmail" (mail.google.com)*. Buttons: **[Search]** / **[Switch]** and **[Ask Lychee instead]**. Declining is not an error — the message falls through to chat.
- **Stop** while a router card is up drains it (existing `drainAll`) and the message is *not* sent to chat.

## 5. Failure handling

All of these fall through to chat silently (logged to the turn trace when enabled, no user-visible error):

engine cold / unhealthy / failed; decide > 300 ms; `too-long`; validation reject; the chosen tab closed between decide and execute (re-checked by id immediately before `chrome.tabs.update`); `chrome.search.query` rejects; the permission request declined.

Invariant: a router path either produces a Von bubble **or** returns `handled: false` before `buildUserTurn` — never neither.

## 6. UI and history

**The Von bubble.** An assistant message with `handledBy: 'von'` and `vonTiming: {decideMs, actMs, top}`:

- **Shiny on arrival:** a single gradient sweep across the bubble border and its `⚡ Von` badge, built from `--accent` / `--lychee-*` tokens (correct in light and dark). Plays **once**, on arrival; a reloaded transcript renders the static accent edge. `prefers-reduced-motion: reduce` → no sweep.
- **Text:** *Searched the web for "rust lifetimes"* / *Switched to "Inbox – Gmail"*.
- **Duration:** `⚡ Von · 142 ms` = decide + execute, submit to action landed, **excluding** time a card waited on the user. Hover: `decide 96 ms · act 46 ms · confidence 0.93`.

**History.** The user message and a past-tense assistant line — `[Quick action by Lychee: searched the web for "rust lifetimes"]` — are pushed to `historyRef` and persisted, so a later turn can refer to it and the chat model never sees an unanswered user message. The line states what was done, never live state, so replay stays true.

**Not persisted:** the probability vector or the option list (option lines carry other tabs' titles; the bubble keeps only the chosen one).

## 7. Evaluation (the kill criterion)

### 7.1 Labelled set

`scripts/router-eval/messages.jsonl` — ~300 messages, each `{text, tabs, label}` where `label ∈ {search:<query>, switch-tab:<tabKey>, chat}` against a small fixed tab fixture. Drafted by hand plus gemma via LM Studio, then hand-reviewed. Deliberately rich in **hard negatives**, because a wrong action is the expensive error:

- questions that look like searches ("what are rust lifetimes", "who won yesterday") → `chat`
- in-page intent ("search this page for pricing", "find the refund section") → `chat`
- tab talk that is not a switch ("summarize my gmail tab", "close the youtube tab") → `chat`
- switch to a tab that is not open → `chat`

Split 50/50 dev/test by message, stratified by label. Thresholds are fit on dev, reported on test.

### 7.2 Runs

- **Heuristic** — pure Node, `heuristicPolicy` over the set.
- **Von** — WebGPU numerics only exist in a browser, so this reuses the `scripts/system1-eval/` pattern: built extension, headed Chromium, a bundled harness evaluating `vonRoutePolicy` in an extension page. No chat model is needed for the decision itself.
- **e2e smoke** — a handful of messages through the real composer (per CLAUDE.md's LM Studio harness) to confirm bubbles, cards, fall-through and timing render.

### 7.3 Metrics

- **Wrong-action rate** — a non-chat route chosen at a band that would act or card, when the label differs. Reported separately for the `run` band (no human check) and the `card` band.
- **Coverage** — share of `search`/`switch-tab` messages routed correctly at the chosen threshold.
- **Decide latency** — p50/p95 warm.
- **Calibration** — reliability table of `top` on routing.

`ROUTE_CONFIDENCE` = the lowest dev threshold with run-band wrong-action ≤ 1 %; `ROUTE_TRY_CONFIDENCE` = the lowest with card-band wrong-action ≤ 10 %.

### 7.4 Kill criterion

Von routing ships (as beta, default `ask`) only if, on test:

1. at its chosen `ROUTE_CONFIDENCE`, coverage **exceeds the heuristic's** at an equal or lower wrong-action rate, **and**
2. warm decide p50 ≤ 300 ms.

Otherwise the feature stays unshipped and the result motivates approach B (a dedicated route head trained in `scripts/von-finetune/`), with the measured gap as its target. Numbers go in `scripts/router-eval/README.md`.

## 8. Testing

- Unit (Vitest): `query.ts` (strip rules, empty ⇒ no search), `candidates.ts` (current tab excluded, titles clipped, no content), `validate.ts` (non-member ⇒ chat), `plan.ts` (every cell of §4's table, incl. search-unpermitted ⇒ card under `always`), `heuristicPolicy.ts`.
- `run.ts` with a fake `RoutePolicy`: every §5 failure returns `handled: false`; timeout path; card-decline path.
- Settings: `PromptRouter` hidden without System-1; `never` skips the engine call entirely (asserted on a spy).
- Real browser: §7.2's e2e smoke.

## 9. Docs

On implementation, add a CLAUDE.md invariant: the router chooses from a closed set, routes through `ApprovalQueue` under its own one-shot policy (`always` is the only card-less path), never rewrites the user's message, and fails to absence.
