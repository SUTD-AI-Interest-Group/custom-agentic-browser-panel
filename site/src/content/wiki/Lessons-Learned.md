# Lessons Learned

What we'd tell the next team building a browser agent — including the things we
got wrong twice.

---

## On agents

**The interaction between two safe systems is not automatically safe.**
Progressive disclosure was correct. The approval gate was correct. Together they
created a state where a user who denied page control could never be asked
again — because the SDK rejects an unloaded tool *before* `execute()` runs, and
`execute()` is where the card lives. Neither feature was wrong. Their composition
was. When you add a mechanism that **hides** capability, enumerate every path that
assumed capability was visible.

**Use AI for judgement under ambiguity; use code for judgement under adversarial
pressure.** Every gate that faces an attacker in this codebase — the SSRF guard,
the point-of-no-return classifier, the browse policy — is a pure, unit-tested
function with no model in it. A model asked to police itself can be argued with.

**Never use model-generated text as a join key.** We keyed research coverage by the
sub-question text the model echoed back. Models paraphrase. The join never matched,
so the loop never converged and ran its full budget every single time, silently.
Map by *position*, not by string.

**Prefer making a bug unrepresentable to handling it.** Two perception registries
address elements as `[3]` and `[r3]`. With bare integers in both, a model would
eventually aim a click at a `<figure>` and fail opaquely. The distinct sigil means
that call cannot be written.

**Absent beats denied.** A tool the model can see but not use is a tool it will
retry forever. Delete it from the ToolSet — for a `never` policy, an ungranted
permission, or a model that failed the vision probe.

**Don't implement a protocol from memory when the counterparty ships a
validator.** Our first MCP Apps handshake was written from memory of the
announcement; real apps zod-validated it and rendered the rejection *as their
UI*. The fix was reading the actual spec — and the app's validation error was
the most precise bug report we ever received.

## On the platform

**MV3 is not Node, and half the ecosystem's advice doesn't apply.** The service
worker dies after ~30s idle, so long work lives in an offscreen document — which
in turn has no `chrome.storage` or `chrome.tabs`, so every piece of state must
round-trip through the SW. Nearly all our race conditions are the tax on that one
constraint.

**A promise that resolves is not a promise that succeeded.**
`chrome.windows.create({incognito:true})` **resolves `null`** instead of rejecting
when the extension lacks incognito access. Our carefully-written `try/catch` was
never entered; execution walked straight into a null dereference. `catch` only
protects you from failures someone chose to signal as failures.

**`res.ok` means the HTTP request succeeded, not that your request did.** Langfuse
answers input errors with **207 + a per-event error list**, so a fully-rejected
batch looked exactly like success — and the "Test connection" button said ✓ while
every event was discarded.

**Check-then-act across an `await` is not a lock.** Our `chrome.storage.session`
mutex let 4 of 5 concurrent callers through. The fix is a module-scope promise
assigned **synchronously, before any `await` yields**.

**Some headers are not yours to send.** We set a `User-Agent` to get past a bot
wall. Browsers silently drop it — it's a forbidden header. Our retry logic could
never have worked, and nothing said so.

**Your dependency's code generation is your CSP violation.** MV3 bans eval with
no opt-out, and the MCP SDK's default schema validator (Ajv) compiles schemas
with `new Function` — so the first `listTools()` killed the connection. Audit
what your dependencies *generate*, not just what they request.

**Never run interactive UX on a network timeout's clock.** Our first OAuth flow
launched the login popup from inside an MCP request, whose 60-second timer kept
ticking while the user typed their password. Slow logins "timed out" even when
the user approved. Anything that waits on a human belongs outside anything that
waits on a deadline.

**A rebuilt `dist/` is not a reloaded extension.** We chased a "recurring" CSP
bug that was simply the old code still running in an un-reloaded panel — and
only bundle archaeology (grep the minified output for the fix) settled it. Bump
the version on every meaningful build; humans need to know which build they're
arguing with.

**`tsc` cannot see execution-order hazards.** A watchdog's mutex lock was
declared as a module-scope `let`, read by code that runs at import time in
`background.ts` — the service-worker entry point. A `let` sits in its temporal
dead zone until its own initializer line runs; referencing it before that
throws during module evaluation, which kills the service worker outright and
takes the extension with it. It typechecks perfectly clean: `tsc` verifies
types, not the order your module actually executes in.

## On process

**Design that cannot say no is paperwork.** A third of our commits produced no
running code. The proof that the design stage was real is `c0f77af`: a spec
written, reviewed, and *deleted* without being built.

**Deleting a feature you shipped yesterday is not a failure of process.** We built
local cost tracking against our own spec's YAGNI list, then removed it a day later
when it turned out to duplicate a table Langfuse already maintains. Refusing to
delete it would have been the failure.

**A feature with no failing test and no visible error can be 100% broken and look
100% fine.** Auto-continue never once continued. Set-of-marks images never once
reached the model. Every streaming turn reported zero tokens. None of these
errored. All of them were inert for a day or more, and each was found by a human
*looking at the actual behaviour*, not by a test.

**Deduplication is a bug-finding technique.** Unifying two component-detection code
paths onto one predicate immediately surfaced a bug that had been in the original
for its entire life: `svg.tagName` is `'svg'`, not `'SVG'` — so every inline-SVG
chart on the web had been invisible.

**A review that executes something finds real bugs; a review that reads the diff
finds none.** A jsdom re-run of the actual injected `domIndex` function — not a
description of it — found the sensitive-field regex missing every label source
but `name`/`id`. A reviewer who *built* a malicious `.xlsx` and ran it through the
real parser found a path-based worksheet guard that an unanchored parser routed
straight around. A Playwright session against real Chromium, with a local HTTP
listener as ground truth, found `RunCode` completely dead — reasoning about the
CSP from the code predicted the opposite of what Chromium actually enforced. None
of these are visible to a reviewer reading the diff and reasoning about what
"should" happen.

**Mutation testing proves a test catches the bug you knew about — not that the
harness can express the one next to it.** The research browser's SSRF fix was
mutation-verified by its own author and still shipped a TOCTOU: every mock in the
existing suite returned one static URL, so "the URL changes between the check and
the read" had no fixture able to represent it. Ask what state your fixtures
*cannot* produce, not just whether your tests catch what they can.

**A test can name a cross-file invariant while only exercising one side of it.**
`pageControl.test.ts` had a case titled "flags the full committing-name
vocabulary, mirroring browsePolicy intent," listing both files' terms, and it
passed continuously — because it only ever drove `pageControl`'s own copy.
`browsePolicy`'s copy had silently missed two of those terms for as long as the
file existed. The test was worse than no test: it made a parity that didn't exist
look verified.

**Hardening can silently disable the thing it's protecting.** At some point
`sandbox-exec.html`'s CSP was tightened without `wasm-unsafe-eval`, and QuickJS
simply stopped instantiating — every `RunCode` call failed with "engine not
initialized." The entire test suite kept passing, because Vitest runs the same
engine in Node, where no CSP exists at all — the one environment that enforces
the policy was the one nothing was exercising.

**A check performed once at the start of a loop is not a check.** `AutofillForm`
verified the page origin, then typed your name, email, and address field by field
without looking again. For a browser agent, "the page changed under you" is not an
edge case. We got a version of this wrong twice: `AutofillForm` (and `ControlPage`
alongside it) later turned out to check whether the human was still *watching* —
`isForeground` — exactly once, before the approval card was even shown, ignoring
that the card sits open for as long as the human takes to react. Tab away, then
click Allow on autopilot, and the action fires against a tab nobody is watching.
Different signal, same shape of gap: a check placed ahead of something you don't
control isn't protecting the moment that matters.

**When your bug writes to durable storage, fixing the writer is only half the fix.**
A nested `undefined` in a tool result permanently poisoned saved conversations —
they'd fail to load *forever*. The fix had to both prevent new corruption and
**repair already-persisted** data.

## The one-line version

Most of our worst bugs were not crashes. They were **silences** — a system doing
nothing, confidently, while every layer reported success. Build the thing that
makes the silence audible before you build the next feature.
