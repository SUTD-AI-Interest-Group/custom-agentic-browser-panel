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

**A check performed once at the start of a loop is not a check.** `AutofillForm`
verified the page origin, then typed your name, email, and address field by field
without looking again. For a browser agent, "the page changed under you" is not an
edge case.

**When your bug writes to durable storage, fixing the writer is only half the fix.**
A nested `undefined` in a tool result permanently poisoned saved conversations —
they'd fail to load *forever*. The fix had to both prevent new corruption and
**repair already-persisted** data.

## The one-line version

Most of our worst bugs were not crashes. They were **silences** — a system doing
nothing, confidently, while every layer reported success. Build the thing that
makes the silence audible before you build the next feature.
