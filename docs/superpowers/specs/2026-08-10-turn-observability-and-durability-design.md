# Turn observability & durability: usage/cost, compaction, recovery, trace, control journal

**Date:** 2026-08-10 · **Status:** Approved (durability: panel-side checkpoint+resume; compaction:
proactive with reactive backstop; cost: tokens + editable price table; trace: persisted, redacted;
control journal: redacted record, in-memory undo state)

## Summary

Five features that share one theme — **a turn should be legible, survivable, and reversible.**

| # | Feature | Core idea |
|---|---|---|
| A | Token usage & cost | `UIMessage.usage` is already populated and rendered nowhere. Surface it, and price it locally. |
| B | Context compaction | A long chat currently hard-fails on a context-length 400. Fold the old span into a summary before that happens, and recover if it happens anyway. |
| C | Turn durability | The transcript persists only *after* a turn finishes. Checkpoint mid-turn and offer a resume card. |
| D | Turn trace | The disclosure/repair/step machinery is invisible without Langfuse. Record it locally, redacted. |
| E | Page-control journal & undo | A granted session leaves no record and no way back. Record what it did; revert what is safely revertable. |

They are built **sequentially, in the order A → B → C → D → E.** A and B both add per-model metadata
to `ModelConfig`, so the settings surface is touched once. B and C both modify `runTurnChain`.
E is fully isolated.

---

## A — Token usage & cost

### Why

`toModelUsage` is carefully plumbed, `sumUsage` rolls a continuation chain's cycles into per-message
totals, and `UIMessage.usage` is assigned in `runTurnChain`. Nothing reads it. `usage.ts`'s own
header says cost "lives in Langfuse" — but observability is an off-by-default beta, so a
bring-your-own-key user has no visibility into spend at all.

### Design

**`src/agent/pricing.ts`** — new, pure, unit-tested, no Chrome/AI-SDK imports.

```ts
interface ModelPrice {
  inputPerMTok?: number
  outputPerMTok?: number
  cachedInputPerMTok?: number
}
function estimateCost(usage: ModelUsage, price: ModelPrice): number | undefined
```

The load-bearing subtlety: on providers that report both, the SDK's `inputTokens` **includes** the
cached tokens, so billing them at the full input rate double-counts. Cost is

```
(inputTokens − cachedInputTokens) × inputRate
  + cachedInputTokens × cachedRate
  + outputTokens × outputRate
```

with the uncached term clamped at zero, because a provider reporting `cached > input` must not
produce a negative charge. Returns `undefined` when no rate is configured — never a misleading
`$0.00`, which would read as "this turn was free" rather than "no price is set."

`reasoningTokens` is **not** billed separately: every provider that reports it already counts those
tokens inside `outputTokens`. Adding them would double-charge. It is displayed, not priced.

**Storage:** `price?: ModelPrice` on the existing `ModelConfig`, which is already sparse and keyed by
model id — no migration for old installs or newly added models.

**UI:**
- `UsageChip` inside `MessageToolbar`: `1.2k → 340 · $0.004`, with cached/reasoning in the tooltip.
- Conversation total as a footer line after the last message, summed from `messages[].usage`.
  Placed inside Chat's own render so App.tsx's top bar is untouched.
- Rate entry in **Settings → Providers**, per model row — not the ModelPicker popover, where a
  $/Mtok field is unusable at panel width.

---

## B — Context compaction

### Why

Nothing in `agent.ts` trims history. A long conversation eventually 400s with
`context_length_exceeded`, and `classifyError` correctly files a 400 as **permanent** — so the turn
dies with no retry and no path forward. The user's only recourse is starting a new chat.

### Design

**`src/agent/compaction.ts`** — new, pure, unit-tested.

```ts
function planCompaction(
  history: ModelMessage[],
  opts: { keepRecentUserTurns: number },
): { fold: ModelMessage[]; keep: ModelMessage[] } | null
```

Four constraints. The first two are where naive implementations break:

1. **Tool pairing is never split.** An assistant message carrying `tool-call` parts must fold
   together with the `tool`-role messages carrying their results. A fold that orphans either half
   makes the very next request 400 — trading a context error for a protocol error.
2. **Role alternation survives.** The fold boundary always lands immediately *before* a `user`
   message — a real turn boundary, which is also the only place tool pairing is guaranteed closed.
   The replacement is injected as two messages: `user(<conversation-summary>…</conversation-summary>)`
   followed by a synthetic `assistant("Understood — continuing from that summary.")`. That pair
   guarantees clean alternation whatever the kept tail begins with; the native Anthropic adapter
   rejects consecutive user-role entries.
3. **Never compact across an open page-control session.** `[index]` addresses are meaningless
   without the recent registry output that produced them; folding that span away would leave the
   model clicking indices it can no longer justify.
4. **Never fold the last N user turns** (default 4), and never fold a `Checkpoint` hand-off that a
   continuation is about to resume from.

Only *whole messages* are ever dropped, so attachment sentinels in the kept tail round-trip through
`dehydrateHistory`/`hydrateHistory` untouched.

**Trigger (proactive):** the previous cycle's **reported** `inputTokens` — ground truth, already
plumbed through `toModelUsage` — compared against `contextLimit × 0.75`. A character heuristic is
used only when no usage has been reported yet.

`ModelConfig.contextLimit?: number`, defaulted per provider kind in `providerProfiles.ts` and
user-editable beside the price field.

**Backstop (reactive):** a new exported `isContextOverflow(err)` in `resilience.ts`. Deliberately
**not** a change to `classifyError`, whose permanent/transient contract the research retry loop
depends on — a context-length error must stay permanent *there*, or research would retry it to its
24h deadline. `runTurnChain`'s catch checks the new predicate, compacts, and retries the cycle once.

**Summarization:** one non-streaming generation on the title/dream model preference chain (a small
cheap model is the right tool). On any failure it degrades to a deterministic
truncation-with-notice — compaction must never be the reason a turn fails.

**UI:** a divider in the transcript, styled like the existing `auto-continue-divider`:
*"↯ Earlier messages summarized to fit the context window."*

---

## C — Turn durability

### Why

`Chat.tsx`'s persistence effect is documented as running "after each finished turn (not on restore
or mid-stream)". Closing the side panel 40 seconds into a multi-tool turn loses the reply **and** the
user's own message. Background research survives this only because it runs in the offscreen host.

### Why not run the turn offscreen

A headless turn would hang at the first approval card: every gated tool routes through
`requestApproval`, which renders in the panel. Research is exempt only because its tools are ungated
by design. Moving foreground turns offscreen therefore means redesigning the human-in-the-loop gate —
strictly larger than this work, and a security-model change rather than a durability fix.
**The turn still stops when the panel closes; what changes is that nothing is lost.**

### Design

**Storage:** a new `inflight` object store in the *existing* conversations DB, keyed by conversation
id.

- Not `chrome.storage.local`: 10MB quota, no `unlimitedStorage` permission.
- Not a field on the conversation record: re-serializing an entire transcript on a 1s debounce is
  too expensive for a long chat.

**Atomicity rule** (mirroring the `summaries` lesson): the inflight record is deleted **in the same
transaction** as the final `saveConversation`. A completed turn can never leave a resume card behind,
and a delete can never half-apply.

**Captured:** transcript including the partial assistant bubble, dehydrated history, the
`runTurnChain` ctx (`attachedSources`, `activeSkill`, `journalUserText`, `droppableTail`, `regen`),
`activeNames`, `autoContinues`, `episodeId`, `assistantId`.

**Deliberately dropped on resume** — the safety core of this feature:

- **The page-control session and its grant.** The tab has very likely navigated; the origin fence is
  stale. A resumed turn must re-request control through a fresh card.
- **The `imageQueue`.** Its pixels describe a page state that no longer exists.
- **Any pending approval.** Already denied by the chain's `drainAll` teardown.

**Cadence:** ~1s debounce driven off the existing `patch()` update path, plus a flush at every cycle
boundary. A `pagehide` flush is best-effort only — storage writes during unload are not reliable, so
the debounce is the real mechanism and `pagehide` is a bonus.

**UI:** a `RecoveryCard` on mount when an inflight record exists for this conversation —
*"This turn was interrupted — Resume / Discard."* Resume re-enters `runTurnChain` with the restored
state; Discard drops the record and keeps the partial transcript. Records older than 7 days are swept
on load.

---

## D — Turn trace (persisted)

### Why

The most interesting machinery in the codebase is invisible: which tools were disclosed and why,
`repairToolCall` rewriting an unloaded-tool call into `GetTool`, `imageQueue` drains, step budget
consumed, retry decisions. The only existing window is Langfuse — an optional beta that ships content
off-device. The 2026-08-10 audit's lesson stands behind this: `RunCode` shipped broken and the suite
passed throughout, because nothing local showed what actually happened at runtime.

### Design

**`src/data/traces.ts`** — a `lychee-traces` DB following the screenshots pattern exactly: full
records plus a lightweight `index` store written **in the same transaction**, pruned by size and age,
cascading on conversation delete.

```ts
interface TraceStep {
  index: number
  startedAt: number
  durationMs: number
  model?: string
  activeTools: string[]
  toolCalls: { name: string; ok: boolean; durationMs?: number }[]
  usage?: ModelUsage
  finishReason?: string
  repaired?: { from: string; to: string }
  imagesDrained?: number
}
```

**Capture:** `runAgentTurn` gains an optional `sink?: TraceSink` beside its existing `trace`.
`onStepFinish` (already unconditional, for the prompt-cache debug log) feeds steps; `prepareStep`
feeds `activeTools` and image-queue drains; `repairToolCall` feeds rewrites.

**Redaction:** every payload passes through the existing **`redactSecrets`** before it reaches the
sink. One redaction implementation, not a second one that could drift from the first — the same
reason `committingVocabulary` was converged in the 2026-08-10 audit. Every sink call is wrapped: a
trace failure must never break a turn.

**`StoreKey` gains `'traces'`**, whose exhaustiveness guard turns the omission into compile errors
across `storageReport`, `clearStore`, `RAW_CLEARERS`, and DataTab's `ROWS`/`CLEAR_EFFECT`.

**Settings:** `Settings.turnTrace?: boolean`, off by default, in Settings → General.

**UI:** a collapsible "⛓ Trace" section under an assistant message, rendered only when the setting is
on and a trace exists for that turn.

---

## E — Page-control journal & undo

### Why

`CloseTabs` stashes a closed batch for a one-level `reopen` — the only undo in the product. A
page-control session can type into a dozen fields and leaves no record and no way back. The presence
overlay lets you *watch* it work, which is excellent live and useless afterwards.

### The secret split

A journal that stores what was typed is a **new plaintext secret surface** — precisely what
`redactSecrets` exists to prevent, and the observability invariant already names `ControlPage`'s
`text`/`value` and `AutofillForm`'s `fields[].value` as carrying real secrets under generic key names.

So the record is split by lifetime:

- **The journal that renders and persists is redacted.** Values pass through `redactSecrets`; an
  entry whose element is `el.sensitive` (or whose spec sets `sensitive`) stores `'[redacted]'` and is
  marked `undoable: false`.
- **The real prior values needed for undo live only in memory**, on the live `ControlSession` object.
  The session is torn down in the chain's outer `finally`, so a real password never outlives the turn
  and never touches disk.

### Design

**Chokepoint:** `runControlStep` — every action already funnels through it, which is why the journal
goes there rather than into each per-action helper (the `HarvestImages` lesson: enumerate call sites
and you will miss one).

```ts
interface ControlJournalEntry {
  at: number
  action: ControlAction
  index?: number
  label?: string        // the element's name, for the timeline
  summary: string       // human sentence: 'typed into "Email"'
  redactedValue?: string
  undoable: boolean
  sensitive: boolean
}
```

Capturing a prior value means extending `injType`/`injSelect` to return what was there before acting.

**Undo invalidation:** undo refuses to run once the document has changed under it — origin or URL
drift since the entry was recorded, at which point the `data-agent-idx` stamps are gone anyway.
Entries invalidate visibly rather than mis-firing into a different page.

**UI:** a `ControlJournalCard` in the transcript when the session ends — the timeline of what it did,
"Undo last" / "Undo all revertable", and an explicit line naming what cannot be reverted (form
submits, committed navigations, sensitive fields). **The user clicking Undo is itself the human
gate**, so undo does not raise an approval card of its own; it is user-initiated, scoped to what the
agent just did, and strictly narrowing.

---

## Testing

Per feature: Vitest over the new pure module, then a real-Chromium pass via the `/verify-extension`
flow before the feature counts as done. The split matters — the audit found that reviews which only
read a diff found nothing, while the ones that executed something found real defects.

Two tests specifically encode invariants rather than behaviour:

1. **Compaction never emits consecutive same-role messages and never orphans a tool call**, over
   generated histories including tool-heavy and checkpoint-bearing spans.
2. **A typed password never reaches a stored trace step or a persisted journal entry**, driven
   through the real capture path rather than by calling `redactSecrets` directly — testing the
   redactor proves the redactor works, not that it is wired in.

## Risks

- **Compaction is the highest-risk item.** A bad fold turns a working long chat into a protocol
  error. Mitigated by making the planner pure and total (returns `null` rather than a risky plan),
  by the boundary-before-user-message rule, and by property-style tests over the pairing invariant.
- **C and D both add IndexedDB stores**, which raises the number of places a conversation delete
  must cascade. Both hook the existing cascade in `ConversationsList.remove` and `clearStore`.
- **E changes injected functions** (`injType`/`injSelect`), which run in the page's isolated world
  with no shared state — each must stay fully self-contained, per the standing rule.
