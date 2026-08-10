# Turn Observability & Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This run:** the user chose **sequential inline execution, no subagents**. Use
> `superpowers:executing-plans`.

**Goal:** Make a turn legible (token/cost + trace), survivable (compaction + crash recovery), and
reversible (page-control journal + undo).

**Architecture:** Five features, built strictly in order A → B → C → D → E. Each puts its decision
logic in a **pure, Chrome-free, unit-tested module** and keeps the Chrome/React code a thin shell
over it — the convention already used by `toolDiscovery.ts`, `browsePolicy.ts`, `planStitch`,
`approvalQueue.ts`. A and B both extend `ModelConfig`, so the settings surface is edited once. B and
C both modify `runTurnChain`, which is why they are sequential rather than parallel.

**Tech Stack:** TypeScript (strict), React 18, Vercel AI SDK v5/v7 surface, IndexedDB, Vitest,
`fake-indexeddb` (already a devDependency).

## Global Constraints

- **No semicolons** (ASI style); **single quotes**; **2-space indentation**.
- Prefer `interface` for object/record shapes; `type` only for unions and aliases.
- Document exported types/functions with `/** ... */`; explain non-obvious *why* in block comments.
- No linter/formatter is configured — match style by hand.
- `npm run typecheck` (never `npx tsc` — npx fetches an unrelated package).
- Every new pure module gets a sibling `*.test.ts`.
- This plan adds **no new agent tools**, so the `requestApproval` invariant is untouched — verify it
  stays that way.
- Secrets never reach storage outside `loadSettings`/`saveSettings`/`mcp/auth.ts`. Features D and E
  both touch data that can contain typed secrets; both must route through `redactSecrets`.
- Injected functions (`inj*`) run in the page's isolated world with no shared JS state: fully
  self-contained, no closures over outer scope, no imports, everything passed via `args`.

> **All implementation code blocks below are unverified sketches** — they establish shape, naming
> and intent, not final text. Test bodies are meant to be committed roughly as written. Run
> everything; do not trust a sketch that has never executed.

---

## Feature A — Token usage & cost

### Task A1: Pure pricing module

**Files:**
- Create: `src/agent/pricing.ts`
- Test: `src/agent/pricing.test.ts`

**Interfaces:**
- Consumes: `ModelUsage` from `src/agent/observability/types.ts`.
- Produces: `ModelPrice`, `estimateCost(usage, price): number | undefined`,
  `formatTokens(n): string`, `formatCost(n): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { estimateCost, formatCost, formatTokens, type ModelPrice } from './pricing'

const PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }

describe('estimateCost', () => {
  it('bills input, output and cached input at their own rates', () => {
    const cost = estimateCost({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500 }, PRICE)
    expect(cost).toBeCloseTo((800 * 3 + 200 * 0.3 + 500 * 15) / 1_000_000, 12)
  })

  it('does not double-count cached tokens already inside inputTokens', () => {
    const withCache = estimateCost({ inputTokens: 1000, cachedInputTokens: 1000 }, PRICE)
    expect(withCache).toBeCloseTo((1000 * 0.3) / 1_000_000, 12)
  })

  it('clamps a provider reporting more cached than input rather than going negative', () => {
    expect(estimateCost({ inputTokens: 100, cachedInputTokens: 500 }, PRICE)).toBeGreaterThanOrEqual(0)
  })

  it('never bills reasoning tokens separately — they are already inside outputTokens', () => {
    const a = estimateCost({ outputTokens: 500 }, PRICE)
    const b = estimateCost({ outputTokens: 500, reasoningTokens: 400 }, PRICE)
    expect(b).toBe(a)
  })

  it('returns undefined when no rate is configured, rather than a misleading zero', () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500 }, {})).toBeUndefined()
  })

  it('prices the half it knows when only one rate is set', () => {
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500 }, { outputPerMTok: 15 })
    expect(cost).toBeCloseTo((500 * 15) / 1_000_000, 12)
  })

  it('returns undefined for an empty usage', () => {
    expect(estimateCost({}, PRICE)).toBeUndefined()
  })
})

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(1240)).toBe('1.2k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })
})

describe('formatCost', () => {
  it('keeps small costs legible instead of rounding them to zero', () => {
    expect(formatCost(0.0000043)).toBe('<$0.01')
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(12.5)).toBe('$12.50')
  })
})
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/agent/pricing.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement (sketch)**

```ts
/** Per-model rates in dollars per million tokens. Every field optional: a user
 *  who fills in only the output rate still gets a partial figure. */
export interface ModelPrice {
  inputPerMTok?: number
  outputPerMTok?: number
  cachedInputPerMTok?: number
}

export function estimateCost(usage: ModelUsage, price: ModelPrice): number | undefined {
  // uncached = max(0, inputTokens - cachedInputTokens); sum the three terms;
  // undefined when no term contributed (no rate set, or no tokens).
}
```

Document in the module header **why** cached tokens are subtracted from `inputTokens`, and why
`reasoningTokens` is displayed but never billed.

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Typecheck** — `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(usage): pure per-model pricing`

---

### Task A2: Per-model rates in settings

**Files:**
- Modify: `src/data/settings.ts` (`price?: ModelPrice` on `ModelConfig`)
- Modify: `src/ui/settings/ProvidersTab.tsx`
- Test: extend `src/data/settings.test.ts`

**Interfaces:**
- Consumes: `ModelPrice` (A1). Produces: `providers[i].modelConfigs[modelId].price`.

- [ ] **Step 1: Write the failing test** — a settings round-trip preserving `price` through
  `saveSettings`/`loadSettings`; and a model with no `modelConfigs` entry stays unaffected
  (sparse by design, no migration).
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Add the field** — one optional property plus a doc comment noting rates are per
  **million** tokens and user-supplied, because a model-agnostic client cannot ship prices that
  stay true.
- [ ] **Step 4: Add the UI** — under each model row, three small number inputs
  (`in $/Mtok`, `out $/Mtok`, `cached $/Mtok`). Blank **clears** the field rather than storing `0`:
  `0` is a real price and must not mean "unset".
- [ ] **Step 5: Run tests + typecheck.**
- [ ] **Step 6: Commit** — `feat(usage): per-model token rates in Settings → Providers`

---

### Task A3: Usage chip and conversation total

**Files:**
- Create: `src/ui/usageDisplay.ts`, `src/ui/usageDisplay.test.ts`
- Modify: `src/ui/Chat.tsx` (`MessageToolbar` ~4354; message-list footer ~3280), `src/ui/styles.css`

**Interfaces:**
- Consumes: A1's formatters, A2's stored `price`, `UIMessage.usage`.
- Produces: `conversationUsage(messages): ModelUsage | undefined`,
  `usageLabel(usage, price): { tokens: string; cost?: string; detail: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('sums usage across assistant messages and ignores user messages', () => { /* ... */ })
it('returns undefined when no message reported usage', () => { /* ... */ })
it('names cached and reasoning tokens in the detail string only when present', () => { /* ... */ })
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement `usageDisplay.ts`** — pure, no React import.
- [ ] **Step 4: Render** — `UsageChip` in `MessageToolbar`, right-aligned, `1.2k → 340 · $0.004`,
  `title` carrying the detail string. Conversation total as a footer line after the last message,
  rendered only when a total exists. Resolve the active model's `price` from `settings`.
- [ ] **Step 5: Run tests + typecheck.**
- [ ] **Step 6: Browser pass** (`/verify-extension`) — send a turn, confirm real numbers; set a rate
  in Settings and confirm a cost appears.
- [ ] **Step 7: Commit** — `feat(usage): show per-reply tokens and conversation cost`

---

## Feature B — Context compaction

### Task B1: Pure compaction planner

**Files:**
- Create: `src/agent/compaction.ts`, `src/agent/compaction.test.ts`

**Interfaces:**
```ts
interface CompactionPlan { fold: ModelMessage[]; keep: ModelMessage[]; foldIndex: number }
function planCompaction(history: ModelMessage[], opts?: { keepRecentUserTurns?: number }): CompactionPlan | null
function applyCompaction(plan: CompactionPlan, summary: string): ModelMessage[]
function estimateHistoryTokens(history: ModelMessage[]): number
```

Highest-risk module in the plan. Its tests encode invariants, not examples.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { applyCompaction, planCompaction } from './compaction'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text })
const toolCall = (id: string, name: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: {} }],
})
const toolResult = (id: string, name: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'json', value: {} } }],
})

/** Every assistant tool-call id must have its tool-result in the same array. */
function hasOrphanedToolCall(messages: ModelMessage[]): boolean {
  const called = new Set<string>()
  const resolved = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content as { type: string; toolCallId?: string }[]) {
      if (p.type === 'tool-call' && p.toolCallId) called.add(p.toolCallId)
      if (p.type === 'tool-result' && p.toolCallId) resolved.add(p.toolCallId)
    }
  }
  return [...called].some((id) => !resolved.has(id)) || [...resolved].some((id) => !called.has(id))
}

function hasConsecutiveSameRole(messages: ModelMessage[]): boolean {
  return messages.some((m, i) => i > 0 && m.role === messages[i - 1].role && m.role !== 'tool')
}

describe('planCompaction', () => {
  it('returns null when there is nothing old enough to fold', () => {
    expect(planCompaction([user('a'), assistant('b'), user('c'), assistant('d')], { keepRecentUserTurns: 4 })).toBeNull()
  })

  it('never splits a tool call from its result', () => {
    const history = [
      user('q1'), toolCall('t1', 'ReadPage'), toolResult('t1', 'ReadPage'), assistant('a1'),
      user('q2'), toolCall('t2', 'ReadPage'), toolResult('t2', 'ReadPage'), assistant('a2'),
      user('q3'), assistant('a3'), user('q4'), assistant('a4'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })
    expect(plan).not.toBeNull()
    expect(hasOrphanedToolCall(plan!.fold)).toBe(false)
    expect(hasOrphanedToolCall(plan!.keep)).toBe(false)
  })

  it('always cuts immediately before a user message', () => {
    const history = [
      user('q1'), assistant('a1'), user('q2'), assistant('a2'),
      user('q3'), assistant('a3'), user('q4'), assistant('a4'),
    ]
    expect(planCompaction(history, { keepRecentUserTurns: 2 })!.keep[0].role).toBe('user')
  })

  it('keeps at least the requested number of recent user turns', () => {
    const history = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`)))
    expect(planCompaction(history, { keepRecentUserTurns: 3 })!.keep.filter((m) => m.role === 'user')).toHaveLength(3)
  })
})

describe('applyCompaction', () => {
  it('produces a history with no orphaned tool calls and no consecutive same-role turns', () => {
    const history = [
      user('q1'), toolCall('t1', 'ReadPage'), toolResult('t1', 'ReadPage'), assistant('a1'),
      user('q2'), assistant('a2'), user('q3'), assistant('a3'), user('q4'), assistant('a4'),
    ]
    const next = applyCompaction(planCompaction(history, { keepRecentUserTurns: 2 })!, 'Earlier: X, established Y.')
    expect(hasOrphanedToolCall(next)).toBe(false)
    expect(hasConsecutiveSameRole(next)).toBe(false)
  })

  it('opens with the summary as a user message followed by an assistant acknowledgement', () => {
    const history = [
      user('q1'), assistant('a1'), user('q2'), assistant('a2'),
      user('q3'), assistant('a3'), user('q4'), assistant('a4'),
    ]
    const next = applyCompaction(planCompaction(history, { keepRecentUserTurns: 2 })!, 'SUMMARY')
    expect(next[0].role).toBe('user')
    expect(JSON.stringify(next[0].content)).toContain('SUMMARY')
    expect(next[1].role).toBe('assistant')
  })

  it('leaves the kept tail byte-identical, so attachment sentinels survive', () => {
    const history = [
      user('q1'), assistant('a1'), user('q2'), assistant('a2'),
      user('q3'), assistant('a3'), user('q4'), assistant('a4'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })!
    expect(applyCompaction(plan, 'SUMMARY').slice(2)).toEqual(plan.keep)
  })
})
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement (sketch).** Walk backwards collecting user-message indices; the candidate
  boundary is the index of the Nth-from-last user message. Then validate pairing: if any `tool-call`
  id in `fold` lacks its result in `fold` (or vice versa), move the boundary **later** until pairing
  closes. Return `null` when no valid boundary leaves anything worth folding.

```ts
export function applyCompaction(plan: CompactionPlan, summary: string): ModelMessage[] {
  return [
    { role: 'user', content: `<conversation-summary>\n${summary}\n</conversation-summary>` },
    { role: 'assistant', content: 'Understood — continuing from that summary.' },
    ...plan.keep,
  ]
}
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Mutation-check the pairing test.** Deliberately break the boundary walk (cut one
  message earlier) and confirm the orphan test fails. Revert. A test that cannot fail is not a test.
- [ ] **Step 6: Typecheck + commit** — `feat(compaction): pure history fold planner`

---

### Task B2: Context limits per model

**Files:**
- Modify: `src/data/settings.ts` (`contextLimit?: number`), `src/data/providerProfiles.ts`
  (`defaultContextLimit` per kind), `src/ui/settings/ProvidersTab.tsx`
- Test: extend `src/data/providerProfiles.test.ts`

- [ ] **Step 1: Write the failing test** — every `ProviderKind` resolves a positive
  `defaultContextLimit`, and a per-model `contextLimit` overrides it via
  `resolveContextLimit(settings, providerId, modelId)`, mirroring `resolveReasoningEffort`.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Conservative defaults — a too-low limit compacts early and harmlessly;
  a too-high one hits the 400 that Task B3's backstop catches.
- [ ] **Step 4: UI** — a "context limit" number input beside A2's rate inputs.
- [ ] **Step 5: Run tests + typecheck.**
- [ ] **Step 6: Commit** — `feat(compaction): per-model context limits`

---

### Task B3: Context-overflow detection

**Files:**
- Modify: `src/agent/resilience.ts`; Test: extend `src/agent/resilience.test.ts`

**Interfaces:** Produces `isContextOverflow(err: unknown): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
it('recognises the common context-length rejections across providers', () => {
  for (const msg of [
    "This model's maximum context length is 128000 tokens",
    'context_length_exceeded',
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Requested token count exceeds the model context window',
  ]) {
    expect(isContextOverflow(Object.assign(new Error(msg), { status: 400 }))).toBe(true)
  }
})

it('does not fire on an unrelated 400', () => {
  expect(isContextOverflow(Object.assign(new Error('invalid tool schema'), { status: 400 }))).toBe(false)
})

it('leaves classifyError untouched — a context 400 stays permanent for research', () => {
  const err = Object.assign(new Error('context_length_exceeded'), { status: 400 })
  expect(classifyError(err).kind).toBe('permanent')
})
```

The third test is the point: research's retry loop must keep treating this as permanent, or it
retries to its 24h deadline. The new predicate is purely additive.

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — message-pattern predicate reusing the file's existing `messageOf`.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `feat(compaction): detect context-overflow rejections`

---

### Task B4: Wire compaction into the turn chain

**Files:**
- Create: `src/agent/summarizeSpan.ts`
- Modify: `src/ui/Chat.tsx` (`runTurnChain`, ~2718–2900), `src/ui/styles.css`

- [ ] **Step 1: Implement `summarizeSpan.ts`** — one non-streaming `generateText` on the
  title/dream provider chain, prompted to preserve decisions, constants, identifiers, file paths,
  user preferences and unfinished threads. On **any** throw, return a deterministic fallback
  (first + last lines of the span plus an explicit "(summary unavailable)" notice). Compaction must
  never be the reason a turn fails.
- [ ] **Step 2: Proactive trigger.** At the top of each cycle: if the last cycle reported
  `inputTokens > contextLimit * 0.75` **and** no page-control session is active, plan → summarize →
  apply to `historyRef.current`, and push a divider marker into `messages`.
- [ ] **Step 3: Reactive backstop.** In `runTurnChain`'s catch, before existing handling: if
  `isContextOverflow(err)` and this chain has not already compacted-and-retried, compact and
  `continue` once. Guard with a boolean so it can never loop.
- [ ] **Step 4: Divider UI** — reuse the `auto-continue-divider` pattern:
  `↯ Earlier messages summarized to fit the context window`.
- [ ] **Step 5: Full test run + typecheck.**
- [ ] **Step 6: Browser pass** — temporarily set a tiny `contextLimit` and confirm compaction fires,
  the divider renders, and the next turn succeeds. **That is the only practical way to exercise this
  by hand — do it.**
- [ ] **Step 7: Commit** — `feat(compaction): fold old turns before the context window fills`

---

## Feature C — Turn durability

### Task C1: The inflight store

**Files:**
- Modify: `src/data/conversations.ts` (DB_VERSION 2 → 3, new `inflight` store)
- Test: extend `src/data/conversations.test.ts`

**Interfaces:**
```ts
interface InFlightTurn {
  conversationId: string
  startedAt: number
  updatedAt: number
  messages: UIMessage[]
  history: ModelMessage[]
  ctx: { attachedSources: MessageSource[]; activeSkill: { name: string; body: string } | null
         journalUserText: string; droppableTail: boolean; regen: RegenTarget | null }
  activeNames: string[]
  autoContinues: number
  episodeId: string
  assistantId: string
}
function saveInFlight(record: InFlightTurn): Promise<void>
function getInFlight(conversationId: string): Promise<InFlightTurn | undefined>
function clearInFlight(conversationId: string): Promise<void>
function sweepInFlight(olderThanMs: number): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips an in-flight record', async () => { /* ... */ })

it('deletes the in-flight record in the same transaction as the final save', async () => {
  await saveInFlight(record)
  await saveConversation(conversation)
  expect(await getInFlight(conversation.id)).toBeUndefined()
})

it('sweeps records older than the cutoff and keeps fresh ones', async () => { /* ... */ })

it('takes the in-flight record with the conversation on delete', async () => {
  await saveInFlight(record)
  await deleteConversation(record.conversationId)
  expect(await getInFlight(record.conversationId)).toBeUndefined()
})
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Bump `DB_VERSION` to 3, create `inflight` in `onupgradeneeded` (nothing
  to backfill — no in-flight turns is the correct empty state). Extend `mutate()`'s transaction to
  span `[STORE, SUMMARY_STORE, INFLIGHT_STORE]` and delete the conversation's inflight row inside
  it; same for `deleteConversation`/`clearConversations`. **This is the spec's atomicity rule — a
  finished turn must never leave a resume card.**
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `feat(recovery): in-flight turn store, cleared with the final save`

---

### Task C2: Pure snapshot/restore logic

**Files:** Create `src/ui/turnRecovery.ts`, `src/ui/turnRecovery.test.ts`

**Interfaces:** `isResumable(record, now): boolean`, `restoreCtx(record)`, `INFLIGHT_MAX_AGE_MS`.

- [ ] **Step 1: Write the failing tests**

```ts
it('treats a record older than the max age as unresumable', () => { /* ... */ })
it('restores activeNames as a Set', () => { /* ... */ })
it('never restores a page-control grant', () => {
  // restoreCtx's output shape must have no session/grant key, so a future edit
  // that adds one fails here.
  expect(Object.keys(restoreCtx(record))).toEqual(['ctx', 'activeNames'])
})
```

- [ ] **Step 2: Run, confirm fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Commit** — `feat(recovery): pure resume-eligibility logic`

---

### Task C3: Checkpointing and the recovery card

**Files:** Modify `src/ui/Chat.tsx` (`runTurnChain`, mount effect, render), `src/ui/styles.css`

- [ ] **Step 1: Debounced checkpoint writes** — ~1s debounced `saveInFlight` off the existing
  `patch()` path plus a flush at every cycle boundary. Reuse `drafts.ts`'s debounce shape (one timer
  per conversation id, module-level map).
- [ ] **Step 2: `pagehide` flush** — best-effort, explicitly commented as such.
- [ ] **Step 3: Recovery card** — on mount, `getInFlight(conversationId)`; if present and
  `isResumable`, render a `RecoveryCard` above the composer: *"This turn was interrupted —
  Resume / Discard."* Resume re-enters `runTurnChain` with restored ctx/history and **no**
  page-control grant and **no** imageQueue carry-over; Discard calls `clearInFlight`.
- [ ] **Step 4: Sweep** — `sweepInFlight(INFLIGHT_MAX_AGE_MS)` once on panel mount.
- [ ] **Step 5: Full test run + typecheck.**
- [ ] **Step 6: Browser pass** — start a multi-tool turn, close the panel mid-stream, reopen: the
  card must appear and Resume must continue. Then let a turn finish normally and confirm **no** card
  appears (the same-transaction delete).
- [ ] **Step 7: Commit** — `feat(recovery): survive a panel close mid-turn`

---

## Feature D — Turn trace

### Task D1: The traces store

**Files:** Create `src/data/traces.ts`, `src/data/traces.test.ts`

**Interfaces:** `TraceStep`, `StoredTrace`, `saveTrace`, `getTrace(turnId)`,
`deleteTracesForConversation(id)`, `tracesUsage()`, `clearTraces()`.

- [ ] **Step 1: Write the failing tests** — round-trip; the `index` store is written in the same
  transaction as the record; pruning evicts oldest-first past the byte cap; delete-by-conversation
  cascades. Model the file on `src/data/screenshots.ts` and its test.
- [ ] **Step 2: Run, confirm fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Commit** — `feat(trace): local trace store`

---

### Task D2: Capture from the turn loop

**Files:** Modify `src/agent/agent.ts` (options; `onStepFinish` ~451; `prepareStep` ~617;
`repairToolCall` ~520); Test `src/agent/traceSink.test.ts`

**Interfaces:** `interface TraceSink { step(s: TraceStep): void }`, `sink?: TraceSink` on
`runAgentTurn`'s options.

- [ ] **Step 1: Write the failing test — the one that matters**

```ts
it('never lets a typed secret reach the sink', async () => {
  const steps: TraceStep[] = []
  // Drive a step whose tool call carries { text: 'hunter2', sensitive: true }
  // through the REAL capture path — not by calling redactSecrets directly.
  // Testing the redactor proves the redactor works; this proves it is wired in.
  expect(JSON.stringify(steps)).not.toContain('hunter2')
})
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement.** Feed `onStepFinish` (already unconditional), `prepareStep`
  (`activeTools`, images drained) and `repairToolCall` (the rewrite) into the sink. Every payload
  through `redactSecrets` first; every sink call inside try/catch, matching the Langfuse code's
  best-effort discipline.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `feat(trace): capture steps, disclosure and repairs`

---

### Task D3: Setting, storage plumbing, and the drawer

**Files:** Modify `src/data/settings.ts` (`turnTrace?: boolean`), `src/data/usage.ts` (`StoreKey`),
`src/data/storage.ts`, `src/ui/settings/DataTab.tsx`, `src/ui/settings/GeneralTab.tsx`,
`src/ui/Chat.tsx`, `src/ui/styles.css`; Create `src/ui/TraceDrawer.tsx`

- [ ] **Step 1: Add `'traces'` to `StoreKey`, then run `npm run typecheck` FIRST** and let the
  exhaustiveness guard enumerate every site that must be updated — `storageReport`, `clearStore`,
  `RAW_CLEARERS`, DataTab's `ROWS`/`CLEAR_EFFECT`. Follow the compiler.
- [ ] **Step 2: Settings toggle** in General, off by default, with a one-line note that the trace is
  stored locally and redacted.
- [ ] **Step 3: `TraceDrawer`** — collapsible "⛓ Trace" under an assistant message; step timeline
  with duration, active tools, tool calls, tokens, finish reason, and any repair. Rendered only when
  the setting is on and a trace exists.
- [ ] **Step 4: Full test run + typecheck.**
- [ ] **Step 5: Browser pass** — enable the toggle, run a multi-tool turn, confirm the drawer shows
  the disclosure sequence; confirm Settings → Data reports and clears the store.
- [ ] **Step 6: Commit** — `feat(trace): local turn-trace drawer`

---

## Feature E — Page-control journal & undo

### Task E1: Pure journal entry logic

**Files:** Create `src/tools/pageControlJournal.ts`, `src/tools/pageControlJournal.test.ts`

**Interfaces:** `ControlJournalEntry`, `buildEntry(spec, el, priorValue, at)`,
`isUndoable(entry, currentOrigin, currentUrl): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
it('redacts the value of a sensitive field and marks it not undoable', () => { /* ... */ })
it('marks a form submit not undoable', () => { /* ... */ })
it('marks scroll, select and non-sensitive type undoable', () => { /* ... */ })
it('invalidates undo once the document url has changed', () => { /* ... */ })
it('never stores a raw value that redactSecrets would strip', () => { /* ... */ })
```

- [ ] **Step 2: Run, confirm fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Commit** — `feat(control): pure page-control journal logic`

---

### Task E2: Capture prior values and record entries

**Files:** Modify `src/platform/pageActions.ts` (`injType`, `injSelect`), `src/tools/pageControl.ts`
(`runControlStep`, `ControlSession.journal`); Test: extend `src/tools/pageControl.test.ts`

- [ ] **Step 1: Extend the injected functions** — `injType`/`injSelect` return
  `{ ok, message, prior }`. **Self-contained**: no closures, no imports, everything via `args`.
- [ ] **Step 2: Record in `runControlStep`** — the single chokepoint. Redacted entry onto
  `session.journal`; the **raw** prior value onto an in-memory-only `session.undoState`, never
  persisted, torn down with the session.
- [ ] **Step 3: Write the test proving the split** — a `type` into a sensitive field leaves
  `'[redacted]'` on `journal` and nothing recoverable after `endSession`.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `feat(control): record a redacted action journal`

---

### Task E3: The journal card and undo

**Files:** Create `src/ui/ControlJournalCard.tsx`; Modify `src/ui/Chat.tsx`, `src/ui/styles.css`,
`src/platform/pageActions.ts` (a `restoreValue` action)

- [ ] **Step 1: Render the timeline** on session end — what it did, in order, with non-revertable
  items called out explicitly (submits, committed navigations, sensitive fields).
- [ ] **Step 2: Undo dispatch** — "Undo last" / "Undo all revertable", newest-first. Each undo
  re-checks `isUndoable` against the tab's **current** origin/url before acting. **User-initiated
  undo is the human gate — it raises no approval card of its own**; document that in a comment.
- [ ] **Step 3: Full test run + typecheck.**
- [ ] **Step 4: Browser pass** — grant control, have the agent fill a form, undo it, confirm fields
  revert; confirm a submitted form reports itself not revertable.
- [ ] **Step 5: Commit** — `feat(control): undo what a page-control session changed`

---

## Final verification

- [ ] `npm test` — full suite green (baseline before this work: **126 files / 1657 tests**).
- [ ] `npm run build` — typecheck + both Vite builds.
- [ ] One combined `/verify-extension` pass exercising all five features in a single session.
- [ ] Update `README.md` (feature tour) and `CHANGELOG.md` (a dated milestone entry).
- [ ] Update `CLAUDE.md`'s architecture invariants with: the compaction pairing/alternation rule,
      the inflight same-transaction delete, the trace redaction path, and the control-journal
      memory/disk split.

## Self-review notes

- **Spec coverage:** A→A1–A3, B→B1–B4, C→C1–C3, D→D1–D3, E→E1–E3. The spec's two named invariant
  tests are Task B1 Step 5 (mutation-checked pairing) and Task D2 Step 1 (secret never reaches the
  sink); the journal half of the latter is Task E2 Step 3.
- **Naming consistency:** `estimateCost`/`formatTokens`/`formatCost` (A1) → A3;
  `planCompaction`/`applyCompaction` (B1) → B4; `resolveContextLimit` (B2) → B4;
  `isContextOverflow` (B3) → B4; `saveInFlight`/`getInFlight`/`clearInFlight`/`sweepInFlight` (C1)
  → C3; `isResumable`/`restoreCtx` (C2) → C3; `TraceSink` (D2) → D3; `buildEntry`/`isUndoable`
  (E1) → E2/E3.
- **Known risk:** Task C1 changes `mutate()`'s transaction scope, which every conversation write
  goes through. If its tests are anything short of green, stop — a broken `mutate()` breaks saving.
