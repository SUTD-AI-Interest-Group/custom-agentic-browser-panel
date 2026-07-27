# The Agent Turn Loop

**Goal.** Run one turn of an agent — model, tools, multi-step — where *every*
tool that touches a page, the network, or your data stops for human permission
first.

The mechanism is almost embarrassingly simple, and it has survived every
rewrite since the first commit:

```ts
// the tool's execute() suspends on a promise only a human click resolves
await requestApproval({ … })
```

Because the approval is just an unresolved promise inside `execute()`, the AI
SDK's multi-step loop needs **no special handling at all**. It thinks the tool is
slow. The user thinks they're being asked. Both are right.

This is the extension's security model, not a feature on top of it. It is
[CLAUDE.md invariant #1](Security-and-the-Permission-Model), and exactly two
categories of tool are exempt — `Checkpoint`, and the disclosure meta-tools
`ToolSearch`/`GetTool` — because they touch no page, no network, and no data. The
boundary was drawn precisely, and we've held it.

---

## Three bugs that taught us how the SDK actually behaves

Each of these is the kind of bug you cannot design your way out of. You have to
run the thing.

### 1. A single `undefined` corrupted entire saved conversations

`a320217` — *"Fix history corruption from undefined tool-result values."*

`ControlPage` returns `urlChanged?: boolean`. On a non-navigation action it's
simply `undefined`. Harmless — except:

> The AI SDK stores that object inside a tool result's `{type:'json', value}`
> output but only strips **top-level** undefined — a nested `undefined` survives.
> On the NEXT turn the SDK re-validates the whole history and rejects the entire
> prompt with *"The messages must be a `ModelMessage[]`"*.

So the failure didn't appear when the bug happened. It appeared on the *next*
message, as a total refusal to talk, in a conversation that was now **permanently
poisoned on disk**.

The fix — `toValidModelMessages()`, a JSON round-trip — is chosen deliberately to
do two jobs: it prevents new corruption *and* **repairs conversations already
persisted with the bad shape**. When your bug writes to durable storage, fixing
the writer is only half the fix.

### 2. `finishReason` doesn't say what the docs imply

`876a9cb`. We had shipped long-horizon auto-continue. It didn't auto-continue.

> The AI SDK reports `finishReason: 'other'` (not `'tool-calls'`) when `stopWhen`
> halts the loop, so a turn cut off at the step ceiling was mislabelled
> `'completed'` — which made `runTurnChain` break out of the continuation chain
> instead of auto-continuing.

We were testing `finishReason === 'tool-calls'` to detect a cut-off. That test
never once matched. Every truncated turn was cheerfully reported as *finished*,
and the chain stopped dead.

The fix inverts the question, and the code comment now states the rule that
actually holds: **a turn the model ended by itself reports `'stop'`; anything
else at the ceiling is a cut-off.** Don't enumerate the failure modes of someone
else's state machine — enumerate the *one* success mode and treat the rest as
failure.

### 3. The dead-end that progressive disclosure created

`5d6853e` — the marquee bug of this codebase, and our favourite, because the
system's two best ideas broke each other.

Progressive disclosure means most tools aren't loaded. The AI SDK rejects a call
to an unloaded tool with `NoSuchToolError` — **before `execute()` runs**. And
`execute()` is where the approval card lives.

Put those together: a user denies page control. The model wants to ask again. It
calls `RequestPageControl`… which is no longer loaded… so the SDK rejects it
before `execute()`… so **the approval card never appears**… so the model can
never re-ask. As the commit says: *"after denying page control it could never
re-ask."*

A denial became permanent. Silently. For the rest of the turn.

The fix is a self-heal in `repairToolCall`: a call naming a **real but unloaded**
tool is rewritten into `GetTool({names:[…]})`, loading it so the model's *next*
call reaches `execute()` and its permission card. Three properties we had to get
exactly right, all now locked down by tests in `agent.test.ts`:

- A tool removed by **policy** (`never`), permission, or tab-access is *absent
  from the ToolSet* — so it can never be resurrected this way.
- A genuinely **hallucinated** tool name must still surface as an error, not be
  silently "fixed."
- We use `Object.hasOwn`, **not `in`** — otherwise a model calling
  `"constructor"` or `"toString"` would look like a loadable tool name.

That last one is the kind of detail that only shows up when you write the
adversarial test.

---

## Decisions we'd defend

- **`repairToolCall` returns `null` on failure, never throws.** A thrown repair
  escalates to a `ToolCallRepairError` that aborts the entire turn. We chose
  benign self-correction over strict failure: a confused model should get a
  second chance, not kill the conversation.
- **Point-of-no-return actions ignore every auto-approve path — including an
  explicit `Always` policy.** No setting can weaken that backstop. If a user could
  configure away the confirmation on an irreversible action, the confirmation was
  never a safety property, just a default.
- **We declined the AI SDK v7's own human-in-the-loop primitives**
  (`toolApproval` / `needsApproval`) and its `ToolLoopAgent`. Our hand-rolled gate
  already encoded behaviour theirs didn't: Never/Ask/Always policies, "allow this
  chat," and one-shot point-of-no-return cards. Adopting the native primitive
  mid-flight would have been a rewrite of the security model to gain nothing.

## The v5 → v7 migration

`cd5ee79` upgraded the Vercel AI SDK across two major versions in one commit:
`system`→`instructions`, `stepCountIs`→`isStepCount`,
`experimental_repairToolCall`→`repairToolCall`, `fullStream`→`result.stream`,
and the image part shape `{type:'image'}` → `{type:'file', mediaType:'image'}`.

The dangerous change was none of those. It was a **silent semantic** one:
`prepareStep`'s `messages` override in v7 *carries forward as the base for all
later steps*, where v6 applied it to one step only. For us, that meant an injected
screenshot would persist into every subsequent step — and a set-of-marks image is
only valid for the step that acts on the element list it matches. A stale one
sends `[index]` marks that now point at the wrong elements.

The fix rebuilds the base from `initialMessages + responseMessages` every step.
**Renames announce themselves at compile time. Semantic changes don't.**
