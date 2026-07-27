# Observability

Opt-in [Langfuse](https://langfuse.com) tracing of every model-related action —
chat turns, dreaming, research, the vision probe, extraction — to **your own**
Langfuse project. Zero cost when it's off, which is the default.

Spec: [`2026-07-12-langfuse-observability-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-12-langfuse-observability-design.md).

---

## Why we hand-rolled the client

The blessed integration path (`@langfuse/otel`) **requires Node.js ≥ 20/22 and
cannot run in an MV3 browser/service-worker context.** So `src/agent/observability/`
is a hand-written batched ingestion client posting directly to
`/api/public/ingestion`.

This is a recurring theme of the project: MV3 is not Node, and roughly half the
ecosystem's "just install the SDK" advice is unavailable to us.

## Two bugs about silence

Both of these are failures to *report failure*, which is the only bug class that
can hide from you indefinitely.

### 1. HTTP 207: the response that says "OK" while rejecting everything

`e5adcaf` — *"surface ingestion failures instead of swallowing them."*

> Langfuse's `/api/public/ingestion` answers **input** errors with **207 + a
> per-event `errors` list, NOT a 4xx** — so `res.ok` is true even when every event
> in the batch was rejected.

Both `flush()` and the Settings **"Test connection"** button only checked
`res.ok`. Wrapped, for good measure, in a bare `catch {}`.

The result: a batch could be rejected in its entirety and look **identical to
success**. The Test Connection button would report a cheerful ✓ while Langfuse
discarded the event. As the commit puts it, *"a missing trace was
undiagnosable."*

Fixed by parsing the body and inspecting `payload.errors`. The same commit added a
one-time warning when the toggle is on but the keys or host are missing — because
that previously **no-opped silently**, indistinguishable from "observability is
off." Three different states — working, misconfigured, disabled — all presenting as
the same silence.

**`res.ok` means the HTTP request succeeded. It does not mean your request did.**

### 2. Every streaming turn reported zero tokens

`eb3d69d` — *"feat: token + cost tracking (and fix streaming usage being empty)."*
The parenthetical is the real story.

> `@ai-sdk/openai-compatible` only sends `stream_options: { include_usage: true }`
> when `includeUsage` is set, **and it defaults to off** — so an OpenAI-compatible
> **streaming** endpoint returned no usage block at all.

Every `streamText` turn — which is to say, every chat message, on every provider
(OpenAI, OpenRouter, Groq, LM Studio) — reported **empty usage**, and every Langfuse
generation carried no `usageDetails`.

The tell was subtle: non-streaming calls (dream, title generation, vision probe,
extraction) were *unaffected*, because they return usage in the response body
regardless. So the traces weren't empty — they were **selectively** empty, in
exactly the place you'd assume was working.

The fix is one line in `provider.ts`: `includeUsage: true`. The root cause is now
a comment there, because the next person to wonder why tokens are zero deserves
better than we got.

## Building a feature and deleting it a day later

The observability spec's YAGNI list explicitly deferred *"client-side cost
computation for custom models (Langfuse handles it)."*

We built it anyway. `eb3d69d` added a per-model USD pricing table in Settings, a
`computeCost` / `formatUsd` module, a `costUsd` field on every message, and a
running "Σ N tok" total in the composer.

**Less than a day later, `681d9db` removed all of it.** The commit message is the
whole argument:

> Cost now lives where it belongs — Langfuse prices generations from its own model
> table… Keeping the setting without an editor would just be dead config.

To make local cost estimation *mean* anything, a user would have to hand-maintain a
second pricing table that Langfuse already maintains for them — and keep it
up to date as providers change prices. We had built a feature whose upkeep cost
exceeded its value, and whose value duplicated a tool we were already integrated
with.

We kept the **token counts** (accurate, ours to report) and deleted the **pricing**
(derived, someone else's job). `usage.ts`'s header now states the final position
outright: *"Cost lives in Langfuse, not here."*

We are including this in the wiki on purpose. The spec said no, we did it anyway,
and then we un-did it — landing exactly where the design had started. **Deleting a
feature you shipped yesterday is not a failure of process; refusing to is.**
