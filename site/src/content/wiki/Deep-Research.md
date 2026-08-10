# Deep Research

**Goal.** Give the agent a real research capability — search, fetch, extract,
synthesize a cited report — that runs as a background task and *survives you
closing the side panel*. Entirely client-side, no research API keys.

Specs: [`2026-07-11-auto-research-browser-use-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-11-auto-research-browser-use-design.md),
[`2026-07-12-deep-research-pipeline-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-12-deep-research-pipeline-design.md).

---

## The decision that shaped everything: where does it run?

An MV3 service worker is killed after ~30 seconds idle, with a 5-minute hard cap.
A research run is minutes of LLM calls and network I/O. **The service worker
cannot host it.**

So research runs in an **offscreen document** — a hidden page with its own event
loop that MV3 grants for exactly this class of work. That single choice cascades
through the entire subsystem, because an offscreen document has *no* access to
`chrome.storage`, `chrome.tabs`, or `chrome.scripting`. It can `fetch` and it can
`DOMParser`. That's it.

Two consequences, one lovely and one expensive:

**The lovely one — it settles the security question by construction.** The
research agent *cannot* touch your tabs, cookies, or data, because the runtime
denies it the APIs. That is why its ten tools are **ungated**: unlike the
foreground toolset, there is no approval card on `WebSearch` or `FetchUrl`. There
is no human present to click one, and — more importantly — nothing to protect.
Your single human decision happens once, at the **launch card**, and the design
spec calls this out as the reason the two halves of the product could be built
independently: research is *headless by construction*.

That decision point used to be an approval card on the model's own
`StartResearch` call — a yes/no on a question you never saw. It is now an
editable card you open yourself (by arming **◈ Deep research**, or by clicking
the chip the agent leaves when it *proposes* research — it can no longer start
any). The card shows the question research will actually run, what the
conversation already established, the sites to stay within, and a flag when you
asserted something the context contradicts. `ProposeResearch` is ungated for the
same reason the rest of this surface is: it starts nothing. **The gate moved; it
did not disappear** — and it moved to the only place that can catch the failure
that matters. Verification asks whether each claim rests on its source. It cannot
ask whether the question was right, and a real page researched under a false
premise grounds perfectly while still being wrong.

**The expensive one — all state must round-trip through the service worker** via
message passing. Every race condition below is the tax we paid for that
isolation.

## The pipeline

It began as a flat loop: search, fetch, extract, ask the model to write it up.
That produces confident, shallow reports. It is now a state machine over a
structured notebook (`src/agent/notebook.ts` — plan, sources, findings, images,
coverage):

```
Scope & Plan  →  ( Gather  ⇄  Reflect )  →  Synthesize  →  Verify
                   bounded by MAX_GATHER_ROUNDS
```

The notebook is the point. **Each gather round is a fresh agent turn seeded from
a notebook *summary*, not from a growing transcript.** A conversation that
accumulates every page it has ever read will exhaust its context on any topic
worth researching. Structured memory bounds the context; a message array does
not.

The **Verify** phase (`b857682`) does a grounding audit plus a bounded
adversarial refutation pass (`MAX_ADVERSARIAL = 3`) against the report's own
claims — a report that has not been attacked is a first draft.

Shipped in five independent phases in a single day: `3158635` (state machine +
notebook), `b857682` (verification), `5a98691` (citations), `06137b8` (tab
escalation), `f335ca0` (academic/image/table modalities).

## Bugs worth telling

### The model paraphrased its own homework

`b8a304a` — *"fix(research): map reflect coverage back to exact plan wording by
position."*

The Reflect phase assessed which sub-questions were now answered, and we keyed
the notebook's `coverage` map by the sub-question text the model echoed back.
**Models paraphrase.** The echoed text almost never matched the plan's wording
verbatim, so `openGaps` never resolved, `isFullyCovered` never fired, and the
gather loop dutifully ran all `MAX_GATHER_ROUNDS` every single time regardless of
whether the question had been fully answered ten minutes ago.

The fix is a lesson we'd generalise: **never use model-generated text as a join
key.** Map `assessments[i]` back to `focus[i]` by *position*.

### The SSRF guard we had to fix twice

`6f1cd89` shipped `isFetchableUrl()`, blocking `localhost`, `.local`, private
IPv4, `::1`. Reasonable. Then `8cf8f1b` found two bypasses:

- `http://localhost./` — a **trailing dot** is a legal FQDN and resolves fine.
- `http://[::ffff:127.0.0.1]` — an IPv4-mapped **IPv6 literal** for loopback.

We patched the trailing dot with `h.replace(/\.$/, '')`. And then `bba1499`
found that `http://localhost../` *still* got through, because stripping **one**
trailing dot is not stripping **all** of them. The regex became `/\.+$/`.

Two passes to get one hostname normalisation right. The honest lesson isn't
"write better regexes" — it's that **a security guard that is not driven by
adversarial tests is a guess.** Every bypass above arrived as a failing test
first; the tests are in `webFetch.test.ts` and they are the reason we found the
second bug at all.

### Check-then-act is not atomic (the offscreen race)

The spec originally specified a `chrome.storage.session` lock to prevent two
callers from creating the offscreen document simultaneously. Review caught it
before it shipped, and the spec's own "as built" note records the verdict:
the lock let **4 of 5** concurrent calls throw *"single offscreen document"*.
Check-then-act across an `await` is not a lock.

`4ab5c3d` replaced it with a module-scope promise gate — assign the in-flight
promise **synchronously, before any `await` yields control**, so two
near-simultaneous callers share *one* `createDocument()` instead of racing:

```ts
let creatingOffscreen: Promise<void> | null = null
```

### Three ways to clobber a cancelled task

A cancel arrives while a research run is mid-flight. The run then finishes.
Which write wins?

We got this wrong three times, in three different directions, and fixed it in
three commits:

- `1dd722c` — concurrent `saveTask`/`applyUpdate` calls interleaved a stale
  `get()` over a prior `set()`. Fixed with a serialised promise chain plus an
  atomic `applyUpdate(cur => …)` functional-updater overload.
- `ddab01f` — a late `research.done` overwrote a task the user had already
  **cancelled**. Made a no-op when `cur.status === 'cancelled'`.
- `1d3bef1` — the mirror image: a late `research.cancel` downgraded an
  already-`done` task back to `cancelled`.
- `c71d8d5` — and even after all that, a cancelled run's promise could still
  *resolve* and broadcast. Now it checks `ctrl.signal.aborted` first. The same
  commit discovered `AbortSignal` was being **accepted but never threaded** into
  the underlying `fetch` — so "cancel" wasn't cancelling the network at all.

If you take one thing from this page: **cancellation is not a feature you add,
it's an invariant you maintain at every write.**

### The `User-Agent` header that was never sent

`1eaee6e`, found *"during real research runs"* — the best kind of bug report.

DuckDuckGo was returning 202/429 bot walls. We had retry logic. It never worked.
The reason: our `fetch()` was setting a `User-Agent` header, and **`User-Agent`
is a forbidden header name** — browsers silently drop it. We were politely
identifying ourselves to nobody.

There is no header fix. The mitigation is architectural: fall back to running the
search in a **real browser tab** (`searchInTab`), which has a real user agent
because it is a real browser.

### A Chrome API that returns `null` instead of rejecting

Same commit. `BrowseSite` crashed with `Cannot read properties of null (reading
'id')`. `chrome.windows.create({incognito: true})` **does not reliably reject**
when the extension isn't allowed in incognito — on some Chrome builds it
*resolves `null`*. Our `try/catch` fallback was therefore never reached; the code
sailed past the error handler straight into a null dereference.

The fix is defensive and slightly sad: check `!win || win.id === undefined` after
*both* the incognito attempt and the fallback. **A promise that resolves is not
the same as a promise that succeeded.**

### Buffering the whole hostile response before capping it

`e8b0f8f` — `fetchReadable` did `(await res.text()).slice(0, MAX_BYTES)`. The cap
was real but useless: a 2GB response was fully buffered into memory *and then*
truncated. Replaced with `readCapped()`, a streaming reader that stops at the
cap. **A limit enforced after the damage is not a limit.**

## Decisions we defend

- **Keyless by choice.** We rejected Tavily, Exa, Serper, and Brave. Requiring a
  second API key for a product whose whole pitch is "bring your own endpoint"
  breaks the promise.
- **Sequential single agent, not a parallel multi-agent swarm.** One context, no
  tab contention, and a system we can actually reason about.
- **Fire-and-forget launch, not plan approval.** The plan is shown to you, but it
  never blocks. Gating twice for one background task is theatre.
- **Private-use Unicode (``/``) as citation sentinels**, because they
  survive `marked` **and** DOMPurify untouched — letting us inject the favicon
  `<img>` *after* sanitisation, which DOMPurify would otherwise strip.

## Where it went

Flat 3-tool loop → phased state machine over a notebook → adversarial
verification → favicon citations → tab escalation for JS/paywalled pages →
academic, image, and table modalities → a fully autonomous page-walking sub-agent
([Autonomous Browsing](Autonomous-Browsing)).
