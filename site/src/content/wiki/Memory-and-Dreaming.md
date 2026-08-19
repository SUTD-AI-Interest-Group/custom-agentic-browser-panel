# Memory and Dreaming

**Goal.** An assistant that "wakes up already knowing the user" — without an
embeddings backend, without a server, entirely in IndexedDB.

---

## Two tiers

- **Episodes** — a raw journal of every conversation, appended turn by turn.
  **Never shown to the model during normal chat.** It is the write-ahead log, not
  the memory.
- **Memories** — small, durable, distilled facts, typed as `fact` / `preference` /
  `project` / `summary` (and later `profile`, added for form autofill). The most
  relevant are injected into the system prompt each turn.

The separation is the whole design. Feeding a growing transcript back to the model
is how you run out of context; distilling it is how you don't.

## Dreaming

Episodes become memories while you're away. The model re-reads unconsolidated
episodes alongside its current memories and emits operations — **add**, **update**
(merge duplicates), **delete** (forget stale entries) — plus a compact day summary.

For a long time it was fully automatic with no user-facing trigger — two hardcoded
numbers, shipped in the very first commit:

```ts
MIN_INTERVAL_MS = 20h   // don't dream more than ~once a day
MIN_IDLE_MS     = 30m   // and never mid-conversation
```

**The honest footnote used to end there:** those numbers were never empirically
derived — they encoded a design intent ("looser than daily; never while the user is
around") rather than a measurement, and we said so in as many words. On 20 July
`f0f96c4` finally acted on it and made the interval a **setting** (`dreamIntervalMs`,
30 min–24 h, default 24 h). The background alarm period now adapts to
`min(interval, 60min)` and reschedules whenever settings change, so a 30-minute
choice is genuinely honoured rather than quietly rounded up to the old daily cadence.
The **idle guard stayed fixed at 30 min** — "never mid-conversation" is a safety
property, not a preference, so it isn't yours to loosen.

The same commit added the controls the footnote implied were missing: a **"Dream
now"** button that runs a cycle on demand (bypassing both gates), a **"Reset
memory"** that wipes memories, episodes, and dream state through one shared path, and
a separate **dreaming model** pick (`dreamModel`, falling back to the chat model) — a
small, cheap model is the right fit for an unwatched background cycle, mirroring the
`titleModel` split.

The dream output is parsed defensively, because *"the model's JSON discipline
varies"* — with hard caps (`MAX_ADDS_PER_DREAM = 12`, `MAX_MEMORY_CHARS = 600`,
`MAX_TRANSCRIPT_CHARS = 24_000`). A memory system that lets a bad night's JSON
write unbounded garbage into durable storage is a memory system that eventually
poisons every future conversation.

### Where the dream actually runs

For most of the project the whole cycle ran in the MV3 service worker, which is
the one context Chrome is free to kill whenever it likes. A dream is a single long
model call — precisely the shape of work a worker that can be terminated
mid-flight should not be doing. `2e438f9` moved the generation into the offscreen
document: the alarm still fires in the worker, because that is where alarms live,
but the model call is dispatched over a typed message channel to a context that
can see it through. The storage-backed reentrancy lock is unchanged and still does
the job it was built for — the worker and the panel's "Dream now" are two JS
realms that share no memory, and the worker can be restarted mid-dream, so the
lock never could have been an in-memory flag.

The bookkeeping either side of that call was quietly expensive. Marking episodes
consolidated and pruning the aged-out ones each ran a sequential loop of one
IndexedDB round trip per id — up to roughly a thousand of them per cycle against a
lock whose 60-second TTL is written on the assumption that this step is fast local
work. `668f8c5` batched both into single transactions. Not parallel ones:
IndexedDB serializes overlapping readwrite transactions against the same store
anyway, so N parallel transactions queue at the engine while each pays its own
open and commit. One transaction is also atomic, where the old loop could leave
half the episodes marked if it threw partway.

## No embeddings — on purpose

`searchMemories()` is keyword matching plus a recency boost with a ~30-day
half-life. That's it.

The justification is written into the source: the store is small (tens of
memories), it stays local, and the model can always re-query. Adding a vector
index would mean either shipping an embedding model into the extension or
requiring an embeddings endpoint that a local Llama server may not expose —
breaking the model-agnostic promise ([Origins and Goals](Origins-and-Goals)) to
solve a problem we don't have at this scale.

**Consistency with product constraints beat sophistication.** If the memory store
ever grows to thousands of entries, this decision should be revisited — and until
then, it shouldn't.

## The one real bug: PII following a navigation

For a long time memory had no bug story of its own — every commit to `memory.ts`
and `dream.ts` was additive. That stopped being true in August, though both
exceptions are about *where and how* the work runs rather than what it stores (the
offscreen move and the batched bookkeeping, above). The store itself has still
never had a correctness fix. Its most sensitive *consumer* is another matter.

`07edf4d` — *"fix: re-fence session origin in AutofillForm (block cross-origin PII
drift)."*

`AutofillForm` fills a form from your saved `profile` memories: name, email,
address. It filled fields in a loop, and it did **not** re-check the page's origin
between them. If the tab navigated mid-fill, it would carry on typing your real
name, email, and address **into a different origin's form**.

That is the worst class of bug this product could ship — not a crash, not a wrong
answer, but a tool designed to handle your PII quietly handing it to somebody
else. The fix re-snapshots and compares `snap.origin !== session.origin` before
**every single field**, and ends the session the moment it drifts.

The generalisable lesson is the one that also produced the origin re-fencing in
[Page Control](Page-Control): **a check performed once at the start of a loop is
not a check.** Anything that can change under you must be re-verified at the point
of use — and "the page navigated" is the single most likely thing to change under
a browser agent.

We learned it again in the same function a month later. `c2edc53` found that
`AutofillForm` checked whether its tab was still frontmost exactly once, at entry,
and then filled an entire batch of fields — so a user who switched tabs partway
had the rest typed into a page they were no longer watching. Same tool, same
shape, a different variable: the first time it was the origin that could change
under the loop, the second time it was whether anyone was looking. The origin
re-fence had been added per-field precisely because of `07edf4d`, and the
foreground check sitting three lines away was still hoisted out of the loop.

Worth being blunt about why that happened, because it is the part that
generalises: fixing one instance of a class does not fix the class. The
`07edf4d` fix was written against *origin drift*, so it re-checked the origin.
Nobody went back and asked which other preconditions that loop had also
established once and then assumed forever. If you find a
check-hoisted-out-of-a-loop bug, the useful next move is not to fix it — it is to
enumerate every other precondition in that same loop and check them all.
