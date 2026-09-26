# Candidate-action `Act` — the harness owns the action space, Von only chooses

Status: design approved in chat 2026-09-26 (approach A of three); implementation
started the same day on branch `candidate-action-act`. Supersedes §4 of
`2026-09-26-system1-act-design.md` (the `Act` step); everything else in that
spec (weights, engine, worker, settings, safety analysis) stands.

## Why

The first `Act` eval (`scripts/system1-eval/README.md`, 2026-09-26) met its kill
criterion: Von grounded 0.685–0.741 against gemma's 0.889–0.907, and `Act`
performed zero actions in 21 calls because the move question never cleared
`ACT_CONFIDENCE`. The fine-tune experiment (`scripts/von-finetune/`, branch
`von-finetune`) attacks that with weights and one input fix (`moveState`).

This spec restructures the harness side around the **candidate-action
representation**: the browser harness inspects the page, constructs a finite set
of valid operations and valid targets, and the decision model may only select
from that set. The model is a policy over available controls, never the
executor. Concretely, for base Von 1.2 and zero-shot, it changes five things the
eval measured as the failure:

1. **The controls are in the prefix.** Von scores each option against the
   prefix alone; options never see each other. The move question's prefix used
   to carry goal, title, progress and value keys — nothing that separates
   "act" from "scroll down". `moveState` fixed this for one question; here the
   full control list is the state every question shares, so a target option
   also sees its siblings (the 36 other "Add … to cart" buttons) through the
   prefix — context the option-marker head cannot get any other way.
2. **Per-operation target heads.** The target pool used to mix clickables and
   fields with a `→ click`/`→ type` suffix. Asking `target_CLICK` over click
   targets only (and `target_TYPE_TEXT` over fields only) shrinks pools and
   removes a whole axis of confusion.
3. **Impossible actions are never candidates.** A disabled button has no
   `CLICK`, a read-only field no `TYPE_TEXT`, `SCROLL_DOWN` only exists when the
   page can scroll, `TYPE_TEXT` only when there are values to type.
4. **Revalidation before execution.** Between Von's snapshot and `controlStep`'s
   own fresh snapshot, an index can be re-pointed by an async re-render.
   `hasElementChanged` already guards the approval card; it now guards every
   `Act` step.
5. **Results in history and loop detection.** "Done so far" recorded actions but
   not outcomes. Each entry now carries `success`/`no_change`/`stale`, and a
   repeated (observation hash, operation, target) stops the loop.

It also creates the boundary the research needs: `BrowserPolicy` over a
`CandidateActionSpace`, so Von, an LLM and later Jev are compared on the same
page, task, observation, candidates, executor and verifier.

## Non-goals

- No navigation operations (`GO_BACK`, `RELOAD`, URLs) — the closed-set safety
  design forbids Von from choosing a navigation.
- No visual candidates, iframes, shadow DOM, drag-and-drop, file uploads, or
  multi-tab (the doc's Phase 4).
- No `SELECT_OPTION` option enumeration: `domIndex` does not record `<option>`s;
  selecting still means "put this supplied value in that dropdown". Follow-up.
- No content scripts and no service-worker orchestration: the doc's §42 split
  assumes a different extension architecture. Here the agent runs in the panel
  and touches the page through `chrome.scripting.executeScript`.
- No persisted transitions in-product: a transition carries page text, and
  `TraceStep` may carry none. Transitions are returned in memory for the eval.
- No change to the fine-tune renderer in this pass. The renderers are exported
  with the same intent (a training row is rendered by the inference code); the
  re-render + retrain is the follow-up if this representation wins.
- No Jev adapter: the interface exists; the adapter does not.
- No new gate semantics. Every action still runs through `controlStep`.

## Train/serve consequence (decided)

The fine-tune running on 2026-09-26 (val acc 0.94, coverage 0.95 at the 0.6
gate, on `actState`/`moveState`/`describe()` text) is **not** compatible with
what Von sees after this change. Decision: render the new representation for
**base** Von now and measure; the finishing checkpoint stays evaluable on the
old builders (main before this merge, or the `von-finetune` worktree). If the new
representation wins zero-shot or structurally, `render.mjs` is re-targeted to
the exported renderers here and retrained (~1 h/epoch on the M4 Max).

## 1. Observation — `src/system1/observation.ts` (pure)

```ts
export type ElementAction = 'click' | 'type_text' | 'select_option'
export interface ControlFingerprint { tag: string; type?: string; name: string; href?: string; sensitive: boolean }
export interface BrowserControl {
  id: number                     // domIndex index, rendered "[N]" — the same address ControlPage uses
  role: string                   // page ARIA role, else derived from tag/type
  name: string
  value?: string                 // never for checkbox/radio (see checked) and never for a sensitive control
  checked?: boolean
  group?: string                 // IndexedElement.ancestorName
  sensitive: boolean
  states: { enabled: boolean; editable: boolean; focused: boolean }
  actions: ElementAction[]       // capabilities independent of values; [] when sensitive or disabled
  fingerprint: ControlFingerprint // exactly hasElementChanged's field set
}
export interface BrowserObservation {
  page: { url: string; origin: string; title: string }
  state: { canScrollUp: boolean; canScrollDown: boolean; focusedId?: number; truncated: boolean }
  controls: BrowserControl[]
  hash: string                   // see Observation hash
}
export function buildObservation(snap: PageSnapshot): BrowserObservation
export function opFor(el): 'click' | 'type' | 'select'   // moves here from actLoop.ts
```

Rules:
- Every indexed element becomes a control, **including sensitive ones**, which
  are listed with no actions and no value so Von can recognise a login wall
  and answer `BLOCKED`. They can never be a target (§2) — the CLAUDE.md
  invariant "sensitive elements are never candidates" is kept by the candidate
  builder, and tested by mutation.
- `actions`: `opFor` decides `click` / `type_text` / `select_option`; a
  disabled element has none; a read-only field loses `type_text`. A field also
  gets `click` (focusing a combobox is a real move).
- `states.enabled = !disabled`, `editable = !readonly && opFor ∈ {type,select}`,
  `focused = index === snap.focusedIndex`.
- `canScrollDown = scroll.y < scroll.max - 1`, `canScrollUp = scroll.y > 0`;
  when the snapshot has no `scroll` (older callers), both are `true`.

**`domIndex.ts` additions** (raw DOM facts, one injection, same walker):
`IndexedElement.disabled?: true` (`el.matches(':disabled')` — covers a disabled
`<fieldset>` ancestor — or `aria-disabled="true"`), `IndexedElement.readonly?:
true` (`readOnly` or `aria-readonly="true"`), `PageSnapshot.scroll?: {y, max}`
(`scrollY`, `scrollHeight − innerHeight`, clamped ≥ 0), `PageSnapshot.focusedIndex?:
number` (the indexed element that is `document.activeElement`, resolved across
shadow roots the same way the walker already descends). All optional; no other
consumer changes. `serializeRegistry` renders `(disabled)` / `(read-only)` so the
chat model sees the same facts.

**Observation hash** (doc §41, no raw DOM): FNV-1a 32-bit over
`url` + per control, in id order, `role \t name \t value \t checked`, rendered
as 8 hex chars. Scroll position is deliberately not hashed: a scroll that
reveals no new control is `no_change`, and the space then drops `SCROLL_DOWN`
because the page reports it cannot scroll further.

## 2. Candidate space — `src/system1/candidates.ts` (pure)

```ts
export type ElementOperation = 'CLICK' | 'TYPE_TEXT' | 'SELECT_OPTION'
export type BrowserOperation = ElementOperation | 'SCROLL_DOWN' | 'SCROLL_UP' | 'WAIT' | 'DONE' | 'BLOCKED'
export interface CandidateActionSpace {
  operations: BrowserOperation[]
  targets: Record<ElementOperation, number[]>   // ranked control ids; [] when none
  shown: number[]                                // ids the state block lists (ranked, ≤ SHOWN_CONTROLS)
  valueKeys: string[]
  stats: { controls: number; eligible: number; shown: number; hidden: number }
}
export const SHOWN_CONTROLS = 60
export function buildCandidateSpace(obs: BrowserObservation, values: Record<string,string>, history: ActStep[]): CandidateActionSpace
export function rankControls(goal: string, controls: BrowserControl[], valueKeys: string[], history: ActStep[]): BrowserControl[]
```

Rules (doc §11, §24):
- `targets.CLICK` = controls whose `actions` include `click`.
- `targets.TYPE_TEXT` = controls with `type_text`, **only when `valueKeys` is non-empty**; likewise `SELECT_OPTION`.
- `operations`: an element operation is present iff its target list is non-empty; `SCROLL_DOWN`/`SCROLL_UP` iff the state allows; `WAIT`, `DONE`, `BLOCKED` always.
- A sensitive control is in no target list (its `actions` are empty by §1; the builder additionally refuses `sensitive` outright so the two guards are independent).

**Ranking** (doc §25 — a documented, deterministic placeholder, ties broken by
document order; never removes eligibility, only orders and picks `shown`):
`score = 0.6·overlap + 0.2·fieldFit − 0.2·done + 0.1·focused` where `overlap`
is the fraction of goal words (≥ 3 chars, lowercased, punctuation stripped)
found in `name` + `group`; `fieldFit` is 1 for a field when values exist;
`done` is 1 when a successful history step already acted on this id;
`focused` from state. The state block shows the top `SHOWN_CONTROLS` and says
how many more exist. **Every eligible control stays choosable** in its target
head, regardless of whether it is shown: the target option carries its own
description, so a hidden control is still selectable — nothing is silently
removed (doc §26). The `TARGET_CHUNK` tournament (unchanged, 40) runs over the
ranked order.

## 3. Policy boundary — `src/system1/policy.ts`

```ts
export interface DecisionContext {
  goal: string
  observation: BrowserObservation
  space: CandidateActionSpace
  values: Record<string, string>
  steps: ActStep[]                  // recent history, rendered by the adapter
}
export type BlockedReason = 'AUTH_REQUIRED' | 'CAPTCHA' | 'MISSING_USER_DATA' | 'UNSUPPORTED_UI' | 'NO_VALID_ACTION'
export interface BrowserDecision {
  operation: BrowserOperation
  targetId?: number
  valueKey?: string
  blockedReason?: BlockedReason
  confidence: { operation: number; target?: number; value?: number }   // calibrated top-p per head
  ranked?: { id: number; p: number }[]                                  // target head's ranking, for `uncertain`
  ms: number
}
export interface BrowserPolicy { decide(ctx: DecisionContext): Promise<BrowserDecision> }
export class PolicyInputError extends Error {}  // the context cannot be rendered within the model's budget
```

A policy may return a decision outside the space — validation (§5) catches
that, so the boundary never trusts the adapter. Confidence gating is the
loop's job, not the adapter's: the adapter reports, the loop decides.

## 4. Von adapter — `src/system1/vonPolicy.ts`

`createVonPolicy(decide: (req: DecideRequest) => Promise<DecideResult>): BrowserPolicy`.

**Shared state block** (`renderState(ctx, shownIds)`, exported), the doc's §18
in Von's line format — every question in one step shares it:

```
Goal: <goal ≤ 300>
Page: <title ≤ 150> (<origin>)
State: scroll down: yes; scroll up: no; focused: [2]
Controls (60 of 73 shown):
[1] button "Round trip" → click
[2] combobox "Where from?" (currently "Singapore") → click, type
[3] password field "Password" (sensitive)
[9] button "Search" (disabled)
[12] textbox "First name" in "Passenger details" → click, type
Provided values: origin, destination
Recent actions:
1. TYPE_TEXT [2] "Where from?" ← origin → success
2. CLICK [3] "Where to?" → no change
```

**Control line** (`renderControl(c)`, exported; also the option text in target
heads, byte-identical): `[id] <role> "<name ≤ 60>"[ in "<group ≤ 40>"][ (currently
"<value ≤ 30>") | (checked) | (unchecked)][ (disabled) | (read-only) | (sensitive)]
[ → <click|type|select, comma-joined>]`. Every page-authored string passes
`neutralize` (the `[MASK]`-family special-token defusal) after clipping, as
today. "Recent actions" is the last 8 steps with absolute numbering; the value
is shown as its **key**, never its text.

**Questions**, asked lazily, each one forward pass over the same state:
- `operation` over `space.operations` — `CLICK` "Click one of the listed
  controls."; `TYPE_TEXT` "Type one of the provided values into a listed
  field."; `SELECT_OPTION` "Choose one of the provided values in a listed
  dropdown."; `SCROLL_DOWN` "Scroll down: what is needed next is below the
  visible area."; `SCROLL_UP` "Scroll up: what is needed next is above the
  visible area."; `WAIT` "The page is still loading or changing; wait for it to
  settle."; `DONE` "The goal is already achieved on this page."; `BLOCKED` "The
  goal cannot be progressed here."
- `target_CLICK` / `target_TYPE_TEXT` / `target_SELECT_OPTION` over that
  operation's targets only, option text = the control line. Pools over
  `TARGET_CHUNK` run the tournament; the final round's confidence is the head's.
- `value` over `valueKeys` (`key: <value ≤ 40>`), only for a field operation.
- `blocked_reason` over the five `BlockedReason` codes, only after `BLOCKED`.

Lazy rather than parallel heads: one pass ≈ 100 ms; a step costs 1–3 passes
instead of always 3, and the fine-tune labels heads by construction, so the
dataset gains nothing from unasked heads.

**Budget**: on `VonInputError('too-long')` re-render once with `shown` halved
(min 10); if still too long, throw `PolicyInputError` — the loop returns
`uncertain` with a stated reason. The list is truncated explicitly with a count,
never the tokens silently.

**Eval LLM policy** (`scripts/system1-eval/llmPolicy.mjs`, not shipped): the
same `renderState` plus "Answer with the operation and, if any, the [N] of the
target" to LM Studio at temperature 0. This is what makes the Von-vs-LLM
comparison fair (doc §46–48).

## 5. Validation and execution

**`src/system1/validate.ts`** (pure): `validateDecision(d, space, obs, values)`
→ `{ok: true, action}` or `{ok: false, reason}`. Membership: `operation ∈
space.operations`; `targetId ∈ space.targets[operation]` for an element
operation; `valueKey ∈ values` for a field operation. Mapping to `ControlSpec`:
`CLICK → {action:'click', index}`; `TYPE_TEXT → {action:'type', index, text:
values[key], clear:true}`; `SELECT_OPTION → {action:'select', index, value:
values[key]}`; `SCROLL_DOWN/UP → {action:'scroll', direction}`; `WAIT →
{action:'wait', timeoutMs: 3000}`. `DONE`/`BLOCKED` end the loop before
validation. The `ValidatedAction` carries `expect: {id, fingerprint}` for an
element operation.

**Execution.** `ActDeps.execute(action: ValidatedAction)`; in `tools.ts` the
`Act` wiring calls the shared `controlStep(spec, { expect })`. `controlStep`
compares `expect` to its own fresh snapshot's element at that index with
`hasElementChanged` (widened to accept a `ControlFingerprint`) and returns
`{ stale: true }` before the point-of-no-return check when they differ — so
revalidation sits in the one body every action passes through and costs no
extra injection. `ControlPage` passes no `expect` (unchanged). Everything after
that point — the card, the post-approval re-check, park, drift, `runControlStep`
— is untouched.

**History.** `ActStep` gains `operation`, `valueKey?`, `result:
'success'|'no_change'|'stale'`. A stale step is pushed (Von should see that the
page shifted) and the loop re-observes; two consecutive stale steps → `error`.
`no_change` is set retroactively on the previous step when the new observation's
hash equals the hash before that step. Steps count against the cap as today.

**Loop detection** (doc §40): `${hash}|${operation}|${targetId ?? ''}` counted
before execution; the second occurrence returns `repeat` without acting. This
subsumes the old "same action on the same index twice in a row" rule and stops
flagging legitimate repeats (typing two values into one field changes the hash).

**Terminal answers.** `DONE` → `done` (the chat model verifies, as before).
`BLOCKED` → `blocked` with `blockedReason` in the result.

## 6. Transitions and the tool result

```ts
export interface ActTransition {
  seq: number
  observation: { url: string; title: string; hash: string; controls: number; canScrollDown: boolean; canScrollUp: boolean }
  space: { operations: BrowserOperation[]; targets: Record<ElementOperation, number[]>; shown: number[]; stats: CandidateActionSpace['stats'] }
  decision: BrowserDecision
  action?: { operation: BrowserOperation; targetId?: number; targetName?: string; valueKey?: string }
  result?: ActStep['result'] | 'denied' | 'parked' | 'drifted' | 'error' | 'rejected'
  ms: { observe: number; policy: number; execute: number }
}
```

`runActLoop` returns `{ ...ActResult, transitions }`. The `Act` tool strips
`transitions` before `scrubActValues` and the model; the eval harness calls
`runActLoop` directly and reads them. `targets` are id lists (not counts) so the
eval can answer doc §52's question — was the correct target in the candidate
set, and at what rank — and attribute a miss to candidate generation rather than
the policy. The doc's §50 dataset row is a pure function of a transition and
lives with the scripts.

## 7. Safety

Unchanged: closed set, no free text, no URL, no navigation; typed content is a
supplied value verbatim; every action through `controlStep`; the
point-of-no-return card, park, drift and the session fence. New and strictly
narrowing: a decision must be a member of the candidate space or nothing runs;
a stale target cannot execute; a disabled or read-only control is not a
candidate. Sensitive controls appear in the state block by role and name only
(never a value), with no actions — listed so Von can say `BLOCKED`, unactionable
so nothing changes. `SCROLL_UP` is new and non-committing. `Act`'s `values` are
still force-redacted in observability and scrubbed from the result.

## 8. Error handling

- Engine failure → `error` (unchanged; engine marked unhealthy for the chain).
- `PolicyInputError` (page too dense even at 10 shown) → `uncertain`, message
  names the reason, `elements` carries the registry for the chat model.
- Validation failure (a choice outside the space) → `error` "returned an action
  outside the candidate space".
- Stale target → recorded, re-observe; second consecutive → `error`.
- Snapshot failure → `error` (unchanged).

## 9. Testing

- `observation.test.ts`: control derivation per tag/type/role; disabled → no
  actions; read-only → no `type_text`; sensitive → listed, no actions, no value;
  checkbox → `checked`, no value; hash stable under control reorder-free
  re-observation and changed by a value change; scroll state.
- `candidates.test.ts`: every filtering rule; no values → no field operations;
  scroll operations follow state; ranking determinism and tie order; `shown`
  cap and stats; **a sensitive control never reaches a target list** (checked by
  mutating the builder's guard in review).
- `vonPolicy.test.ts`: `renderState` golden text; lazy question sequence and
  keys; confidence propagation; tournament over ranked order; too-long → halve
  → `PolicyInputError`.
- `validate.test.ts`: membership rejections; every mapping; `expect` carried.
- `actLoop.test.ts`: every stop reason including `stale`, `repeat` by hash,
  `no_change` marking, `blockedReason`, abort between steps, the cap.
- `domIndex.test.ts`: the new facts via the existing extracted-source pattern.
- `harness.ts`: the grounding phase forces `operation` to the expected element's
  operation (derived from the observation) and records the real answer, so the
  target head is measured in isolation as before.

## 10. Measurement and decision rule

Run `scripts/system1-eval/run.mjs` (phases grounding, llm, e2e) on **base**
Von with the eval build, after the fine-tune has released the GPU. Record in the
eval README a new results section against the 2026-09-26 baselines: grounding
0.685 (gemma 0.889), move gate cleared 0/54, `Act` actions 0/21 calls. The
representation wins if grounding improves materially and the operation gate
clears on most cases with an element operation chosen; then re-target
`render.mjs` and retrain. Otherwise the harness changes stand on their own (they
do not depend on the format) and the old-format fine-tune remains the candidate.

## Files

New: `src/system1/{observation,candidates,policy,vonPolicy,validate}.ts` + tests,
`scripts/system1-eval/llmPolicy.mjs`.
Touched: `src/system1/actLoop.ts` (+test), `src/platform/domIndex.ts` (+test),
`src/tools/pageControl.ts` (`hasElementChanged` type), `src/tools/tools.ts`
(`controlStep` expect, `Act` wiring), `src/ui/Chat.tsx` if the Act card reads
changed fields, `scripts/system1-eval/{harness.ts,run.mjs,README.md}`, `CLAUDE.md`.
