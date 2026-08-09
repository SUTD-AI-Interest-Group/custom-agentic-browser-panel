# Deep research as an explicit mode: a launch gate, a one-slot lifecycle, and a browsing window that says what it is

**Date:** 2026-08-10 · **Status:** Approved (placement: labelled composer pill; launch: agent-framed editable card with premise check + source scope; self-launch: propose-only chip; arrival: collapsed row in the live card's own slot; window: labelled page + narrated in-card)

## Summary

Background research today has exactly one entry point — the model calling `StartResearch`
(`src/tools/research.ts:421`) — and it launches on a **bare question string** the user never sees
(`research.ensureAndStart` carries only `{taskId, question, conversationId}`,
`src/data/researchTasks.ts:154`). The finished report is appended to the transcript as a fully
expanded card at whatever the current bottom of the chat happens to be
(`src/ui/Chat.tsx:932`), which reads as a reply to the user's most recent message even when it
answers something asked twenty minutes earlier.

This spec makes the mode explicit and the question inspectable:

- A labelled **`◈ Deep research`** pill in the composer arms the mode; arming re-tints the composer
  and swaps the placeholder, so the button and the box agree about what Send will do.
- Sending while armed runs one cheap framing call (the `title.ts` shape — no tool loop) that
  produces an **editable launch card**: the question, a brief of what the conversation already
  established, seed sub-questions, an optional **premise flag**, and an editable **source scope**.
  Nothing runs until Start.
- The model loses the ability to launch. `StartResearch` becomes **`ProposeResearch`**, which
  renders a dismissible chip that opens the same launch card.
- The launch card, the live progress card and the finished report are **one message in one slot** —
  created where the user asked, mutated in place through `proposed → running → done`.
- The research browsing window parks on a page that names itself, and the live card says it exists.

## The incident this comes from

A user asked for a comparison of "the 5 setups" on a vendor site. The foreground turn established
there were only **4** and said so. The model separately launched background research with the
original phrasing; ~22 minutes later a long report landed at the bottom of the chat listing **5**
machines, the fifth invented from an unrelated search result. Nothing in the UI distinguished it
from a live reply, and the user had no point at which the question "compare the 5 setups" was ever
shown to them.

Three separate defects, all addressed here: the question was never visible, the research had no
access to what the foreground turn had already learned, and the report's arrival was
indistinguishable from a reply.

## Why a launch gate, and not more verification

Established by product survey and the 2026 literature (2026-08-10):

| Product | Entry point | Pre-launch gate | Typical duration |
|---|---|---|---|
| ChatGPT deep research | composer mode | **editable plan** + clarifying questions + trusted-site restriction | 5–30 min |
| Gemini Deep Research | composer mode | **editable plan** (`Edit plan` → `Start research`) | 5–10 min |
| Perplexity Deep Research | search-box mode selector | none | 3–5 min |
| Lychee (today) | model-only tool call | approval card on an unseen question | up to 24 h |

The correlation is the argument: **the two products with the longest runs both gate on an editable
plan, and the one without a gate is the one that finishes in three minutes.** Lychee's runs are the
longest of the four and its gate is the weakest.

The PING taxonomy ([arXiv 2601.22984](https://arxiv.org/abs/2601.22984)) separates deep-research
failures by where they originate: **grounding** (source-level — a claim its citation doesn't
support), **intent** (query-level — "deviated actions: misinterpreting query intent"), and
**propagation** (trajectory-level — later work built on an earlier bad premise). In proprietary
systems over 57% of source errors occur early and cascade.

This matters because `verifyReport` (`src/agent/research.ts:615`) is already a strong *grounding*
defense — it audits whether each cited claim rests on its source's recorded quote, then
adversarially red-teams up to 3 load-bearing claims — and citation quality is precisely the axis
commercial systems score worst on (78% citation accuracy for OpenAI deep research; DRACO's best
system at 65% citation quality). **It still could not have caught the invented fifth machine.**
That machine is a real product with a real page; every claim about it would ground cleanly. The
failure was intent-level, introduced before the first search ran, and then propagated for twenty
minutes.

No amount of downstream verification catches an upstream premise error. **The launch card is the
only component in this design positioned at the right end of the pipeline**, which is why it —
not the pill — is the load-bearing part.

## UX

### The armed pill

A labelled pill leading the right-hand cluster of `.composer-btns`:

```
[+]  gpt-5-mini  ──────────  [◈ Deep research]  [tools]  [cam]  [↑]
```

Arming changes three things simultaneously, because a button that lights up alone is too easy to
miss mid-task:

1. the pill fills with `--accent`,
2. the composer border tints to the accent gradient,
3. the placeholder becomes *"Research anything — this runs in the background…"*.

**Arming is one-shot.** It disarms the moment a launch card is created. Sticky arming is how a user
fires a second 20-minute task by accident.

**Narrow-width collapse order.** `.composer-btns` already collapses `tools` into the `…` menu below
a breakpoint (`src/ui/styles.css:2703`). The camera joins `…` at that same breakpoint so the pill
keeps its label; only below a second, narrower breakpoint does the pill degrade to the bare `◈`
glyph. The pill is the control no existing user knows, so it is the last to go silent — the exact
inverse of the natural "newest control collapses first" instinct.

### The launch card

Rendered in the transcript at the point the user asked. Nothing has run yet.

```
┌─ Ready to research ─────────────────────────────┐
│ ⚠ You said 5 setups — this page lists 4.        │  ← premise flag (only when raised)
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ Compare the specs of the 4 Aftershock        │ │  ← editable, autosized
│ │ prebuilt configs and who each one suits      │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ Sites  [aftershockpc.com ×]  [+ add]             │  ← editable scope
│ ▸ What it already knows                          │  ← collapsed brief
│                                                  │
│ usually 10–20 min · keeps running if you close   │
│ the panel                  [Cancel]  [Start]     │
└──────────────────────────────────────────────────┘
```

The duration line is **static copy, not an estimate.** Run length here is governed by
`MAX_GATHER_ROUNDS`, page latency and how many sub-questions reach coverage, and no cheap predictor
of it exists; a fabricated per-task number would be worse than an honest typical range. The same
string is used on the `ProposeResearch` chip so the two never disagree.

- **Premise flag** — shown only when the framing call raises one. Not a blocker; it explains what
  the question was changed *to* and why. This is the surface where the reported bug dies visibly
  rather than being silently corrected and hoped about.
- **Clarifications** — at most two, rendered as short answerable prompts, and only when the framing
  call is genuinely unsure. Unanswered clarifications never block Start.
- **Sites** — see [Source scoping](#source-scoping). Prefilled from the tabs and page in context;
  empty means unrestricted, which is today's behavior.
- **Cancel** — restores the user's original text to the composer, **re-arms** the pill, and removes
  the card, leaving the user exactly where they were before Send so they can reword and try again.
  No task is ever created.
- **Start** — creates the task and transitions this same card to `running`.

A launch card **persists with the conversation** and remains actionable after a panel reload — a
proposal you did not start is a draft worth keeping. It carries the timestamp it was drafted at, so
a stale brief is visibly stale. Like the existing report card, it is **display-only and never enters
model history**.

### Live state

The same card, in place:

```
┌─ Researching · 8m elapsed ─────────────────┐
│ "Compare the specs of the 4 Aftershock…"   │
│ ████████████████░░░░░░░░░                  │
│ ✓ CPU / GPU per config                     │
│ ✓ RAM & storage                            │
│ ▸ Price & warranty — reading aftershockpc.com
│   ↳ in a private window                    │
│ ○ Who each config suits                    │
│ 11 sources                          [Stop] │
└────────────────────────────────────────────┘
```

Phase, elapsed time and per-sub-question coverage all come from data the notebook already carries
(`ResearchTask.notebook.coverage`, already rendered by `ResearchSheet`). The bottom sheet is
unchanged and remains the full step log, reachable by tapping the card.

### Arrival

The same card again, collapsed:

```
┌────────────────────────────────────────────┐
│ ✓ Research finished · started 22 min ago   │
│   "Compare the specs of the 4 Aftershock…" │
│   14 sources · verified              [ ⌄ ] │
└────────────────────────────────────────────┘
```

Because the card never moved, a finished report is anchored where it was asked for and **cannot be
read as a reply to the user's latest message**. Expanding renders the existing
`ResearchReportMessage` body inline. This matches Gemini, whose completed report also does not push
itself into the conversation — a notification appears beside the thread and the user opens it.

`error`, `cancelled` and `partial` are the same collapsed row with their own icon and a one-line
reason.

### The dock, demoted

`ResearchDock` (`src/ui/Chat.tsx:4672`) renders **only while this conversation's live card is
outside the viewport**, via an `IntersectionObserver` on the card element. Tapping it scrolls to the
card rather than opening the sheet. When the card is on screen the dock is absent — nothing is ever
simultaneously duplicated and invisible.

## Data model & message protocol

### Proposals are panel-side; tasks are persistent

A proposal deliberately does **not** create a `ResearchTask`. `researchTasks` storage stays free of
rows that were never started, so the watchdog, `resumableTasks` and `isActiveStatus` need no new
status and no new exclusions.

The transcript message is minted at propose time with the id that the task will later use:

```ts
/** A launch card awaiting Start. Lives in the transcript message, not in researchTasks. */
interface ResearchProposal {
  taskId: string            // pre-minted; becomes ResearchTask.id on Start
  question: string          // editable
  brief?: string            // what the conversation already established
  subQuestions: string[]    // seed coverage
  sites: string[]           // source scope; [] = unrestricted
  premise?: { asserted: string; corrected: string }
  clarifications?: string[] // ≤ 2
  draftedAt: number
}
```

`UIMessage` gains `proposal?: ResearchProposal` beside its existing `research?` field. The card
renders from `proposal` until a `ResearchTask` with the same id appears, then from the task.

### The injection effect becomes an upsert

`src/ui/Chat.tsx:932` currently filters to `done`/`error` and **appends**. It changes to:

- include every status, not just terminal ones;
- **upsert** by `research-<id>` — refresh the payload of an existing message in place rather than
  skipping it.

Because `researchTasks` is already reactive to `chrome.storage` changes (`Chat.tsx:1136`), the live
card animates for free with no new subscription. The `restored` gate stays exactly as-is.

### `research.ensureAndStart` gains the launch payload

```ts
| { type: 'research.ensureAndStart'
    taskId: string
    question: string
    conversationId: string
    brief?: string          // NEW — prepended to the Scope & Plan phase
    subQuestions?: string[] // NEW — seeds notebook coverage
    sites?: string[]        // NEW — source scope, [] or absent = unrestricted
  }
```

`research.start` forwards all three to `runResearch`. `ResearchTask` gains the same three optional
fields so a resumed task keeps its scope. All are optional; legacy tasks are unaffected.

## The framing call — `src/agent/researchFraming.ts`

One `generateText` call with a structured output schema. **Not** a `runAgentTurn` — no tool loop, no
step budget, no chance of it wandering into the browser. Same architectural shape as `title.ts` and
`chatNaming.ts`, and it lives beside them for the same reason.

**Input:** the last few turns of the conversation, the armed message, and any `@page`/`@tabs`
context already attached to it.

**Output:** the `ResearchProposal` fields above, minus `taskId`/`draftedAt`.

**The premise rule, stated explicitly in the prompt:** if the user's message asserts a fact that the
conversation context contradicts, correct it in `question` *and* report both halves in `premise`.
Silent correction is what today's flow effectively attempts; the whole point is that the correction
becomes visible.

`parseFraming` is a pure exported function mirroring `sanitizeTitle` and defensive in the same ways:
inline `<think>` blocks, a conversational preamble ahead of the JSON, a question returned wrapped in
quotes, `sites` entries arriving as full URLs rather than hosts (normalized to registrable hosts),
more than two clarifications (truncated). A framing call that yields nothing usable falls back to
the user's raw message as the question with no premise flag and no scope — degraded, never blocked.

## `ProposeResearch` replaces `StartResearch`

`createStartResearchTool` becomes `createProposeResearchTool`. Its `execute()` no longer calls
`postResearchMsg`; it returns `{proposed: true, question}` and its result renders as a chip beneath
the reply:

```
◈ Research this properly · usually 10–20 min
```

Clicking the chip opens the launch card prefilled from the tool's `question`, routed through the
same framing call so it gets the same brief, scope and premise check.

**It stops needing an approval gate.** Proposing touches no page, no network and no data — the same
category as `ToolSearch`/`GetTool`, which are ungated for exactly this reason. This *strengthens*
the architecture invariant rather than eroding it: today's card is a yes/no on a question the user
cannot see, and the launch card shows the question, permits editing it, and scopes its sources.
The human gate moves later and gets sharper. `CLAUDE.md`'s approval-gate invariant gains
`ProposeResearch` to its short list of deliberately-ungated tools, with this justification.

**Migration.** `DEFAULT_TOOL_POLICIES` is derived from the tool catalog (`src/data/settings.ts:111`),
so the catalog entry is renamed in place. `loadSettings` migrates a persisted
`toolPolicies.StartResearch` to `toolPolicies.ProposeResearch` and deletes the old key, so a user
who set `never` keeps meaning it. The `TOOL_DISCLOSURE_NOTE` capability list in `Chat.tsx:123` is
updated to name `ProposeResearch` and to state that it proposes rather than starts.

## Source scoping

An empty scope is unrestricted — today's behavior, and the default whenever the framing call has no
basis for suggesting hosts.

A **non-empty** scope is enforced, not merely suggested, because a suggestion is what the model
already ignores:

- **`WebSearch`** appends `site:` operators for up to 3 scoped hosts and filters returned results to
  in-scope hosts beyond that. Off-scope results never reach the model as snippets — a snippet alone
  is enough to hallucinate from.
- **`FetchUrl` / `BrowseSite`** refuse an off-scope host with a stated reason that appears in the
  step log, so a blocked read is visible rather than silent.

Enforcement lives in **`src/tools/browsePolicy.ts`**, which is already the pure, exhaustively tested
policy layer deciding what the research agent may touch, and already the documented security model
for this surface. It gains one parameter and one exported predicate:

```ts
/** True when `url`'s host is within `scope`. An empty scope allows everything. */
export function scopeAllows(url: string, scope: string[]): boolean
```

Host matching is registrable-domain based: a scope of `aftershockpc.com` admits
`www.aftershockpc.com` and `sg.aftershockpc.com` but not `aftershockpc.com.example.net`. This is the
amendment that makes the reported bug structurally impossible rather than merely unlikely — with the
scope set, no path exists by which an unrelated vendor's page enters the report.

## The research window

`researchTab.ts:107` opens a **minimized incognito window**, and line 161 briefly restores it to
`normal` because `captureVisibleTab` cannot screenshot a minimized window. That restore is what the
user sees as blank incognito windows appearing and vanishing. The window is load-bearing — it is how
research reads JS-rendered pages that plain `fetch()` returns nothing for — so it is labelled rather
than removed:

- A bundled **`public/research-tab.html`**, `<title>Lychee is researching…</title>`, that the leased
  tab parks on at lease time and between navigations. It names the question and states that the
  window is safe to close and will be reopened if needed.
- The live card names it once per task: *"↳ in a private window"*, with the reason one tap away.

No change to the lease, mutex, idle-teardown or orphan-sweep logic.

## Testing

Pure, Chrome-independent, unit-tested beside their modules:

| Unit | Covers |
|---|---|
| `parseFraming` (`researchFraming.test.ts`) | think-block stripping, preamble, quoted question, URL→host normalization, >2 clarifications truncated, unusable output → raw-message fallback |
| `researchCardState` (`researchCard.test.ts`) | proposal-or-task → one of `proposed`/`running`/`done`/`error`/`cancelled`; task wins over proposal at the same id |
| `scopeAllows` (`browsePolicy.test.ts`) | empty scope allows all; subdomain admitted; suffix-collision host rejected; scheme and port ignored |
| settings migration (`settings.test.ts`) | `StartResearch` policy carried to `ProposeResearch`, old key deleted, absent key is a no-op |
| tool name (`toolNames.test.ts`) | `ProposeResearch` matches `^[a-zA-Z0-9_-]{1,64}$` |

Chrome-coupled and verified via `/verify-extension`: arming and disarming, the collapse order at
both breakpoints, upsert-in-place across a real task lifecycle, the `IntersectionObserver` dock,
proposal survival across a panel reload, and the parked window's title.

## Out of scope (explicit)

- **Mid-run steering.** ChatGPT added "interrupt to refine with follow-up prompts or new sources",
  and Lychee's `steerPending` machinery (`src/agent/agent.ts`) plus research's per-gather-round
  `runAgentTurn` calls put it within reach — a steer could drain at a round boundary. Deferred to
  its own spec; after Start this design stays fire-and-forget.
- **Contradiction detection** between a finished report and the conversation it landed in.
- **Changes to the research pipeline itself.** `brief`, `subQuestions` and `sites` feed the existing
  Scope & Plan phase and the existing browse policy; no phase is added, removed or reordered.
- **Changes to `verifyReport`.** It is a grounding defense and remains correctly scoped as one; this
  spec addresses the intent-level failure it structurally cannot see.
- **Source scoping for the foreground agent.** Scope is a property of a research launch only.
