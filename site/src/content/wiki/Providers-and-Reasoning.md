# Providers and Reasoning

The product's founding promise is that you bring your own model
([Origins and Goals](Origins-and-Goals)): OpenAI, Anthropic, OpenRouter, Groq, a
local Ollama or LM Studio, or any OpenAI-compatible URL you paste in. That promise
collides with a fact nobody advertises: **reasoning models and function tools break
in a different, provider-specific way on almost every endpoint.** This page is how
one small pure file absorbed that mess so the rest of the codebase never has to think
about it.

**This feature shipped without a design spec** — the only substantial one that did.
There is no `docs: spec for capability profiles` commit; it went straight from problem
to code across one evening on 20 July. We're noting that here rather than quietly
pretending the usual three-beat ritual ([Home](Home)) happened, because it didn't.

---

## The naive patch, then the dispatcher — 43 minutes apart

The first sign of trouble was narrow. `987e5a9` — *"let a provider pin
`reasoning_effort` for gpt-5 tool use"* — records it exactly:

> OpenAI defaults `reasoning_effort` to a non-`'none'` value server-side on
> `/v1/chat/completions` for reasoning models like gpt-5.6-luna, then rejects the
> request once function tools ride along. **Every agent turn here is tool-driven**, so
> such a model was simply unusable.

The fix was a single opt-in knob threaded into the outgoing request body — and it was
opt-in *because the same knob is poison elsewhere*: gpt-4o rejects the parameter
outright, and o1/o3 reject the value `'none'`. That should have been the warning. One
request-body field already needed three different behaviours across three OpenAI
models alone.

Forty-three minutes later, `a69886f` threw the patch away and built the thing that
scales: **per-provider capability profiles + a hybrid adapter dispatcher.** The naive
single-body approach hadn't failed loudly — it just clearly wasn't going to survive
contact with Groq, Anthropic, and OpenRouter each wanting something incompatible. The
two commits, same evening, 01:14 → 01:57, are the whole "we tried the small fix first,
then paid for the real one" arc in one `git log`.

## One profile per provider *kind*

`src/data/providerProfiles.ts` is pure — no Chrome, no network, no AI SDK imports, and
kept that way on purpose so it can be exhaustively unit-tested. It answers, for each
`kind` (`openai` / `anthropic` / `openrouter` / `groq` / `ollama` / `lmstudio` /
`custom`):

- **Which adapter to build** — `'openai'`, `'anthropic'`, or `'compatible'`.
- **Is this id a reasoning model?** — an id-pattern heuristic (`detectReasoning`),
  e.g. `/^o[134]|gpt-5|gpt-oss/i` for OpenAI.
- **What effort rungs to offer** — ordered faster→smarter, and they genuinely differ:
  `gpt-5.6` gets six (`none…max`), the o-series gets three and *no* `'none'` (it
  rejects it), Anthropic gets an honest two.
- **How to encode effort on the wire** — either a native `providerOptions` object or a
  set of request-body fields.
- **Where to fetch the model list** — the per-kind Refresh-from-endpoint URL + auth.

`createModel` (`src/agent/provider.ts`) then dispatches on `profile.adapter`:

- **`openai` → the native Responses API** (`createOpenAI({…}).responses(modelId)`).
- **`anthropic` → the native Messages API**, with the
  `anthropic-dangerous-direct-browser-access` header that lets the call leave the
  extension origin (the key still never leaves the browser).
- **everything else → the OpenAI-compatible adapter**, with reasoning injected through
  a request-body transform.

## The two constraints the whole file exists to enforce

Everything above is machinery. These two facts are the *reason* for the machinery, and
CLAUDE.md pins them as invariants (`eb9cbc4`):

1. **OpenAI reasoning + function tools coexist only on the Responses API.**
   `/v1/chat/completions` 400s that pairing — which is why `kind:'openai'` routes to
   the *native* adapter, not the compatible one. This is the constraint `987e5a9`
   discovered the hard way and `a69886f` resolved structurally: stop trying to make
   chat-completions accept reasoning+tools, and move OpenAI off chat-completions
   entirely.
2. **Groq needs `reasoning_format:'parsed'` whenever tools ride along**, or it 400s
   (its default `'raw'` + tools = rejected). The profile can only add this
   conditionally because the body transform inspects the *live outgoing request* for a
   non-empty `tools` array — a per-request decision, not a static setting.

Two more that the same layer quietly handles:

- **OpenRouter must never see a bare `reasoning_effort`** alongside its structured
  `reasoning` object — sending both 400s. The profile emits `{ reasoning: { effort } }`
  and the test suite guards *`.not.toHaveProperty('reasoning_effort')`* so a future
  edit can't reintroduce the bug.
- **Anthropic's slider is honestly off/on.** The SDK models thinking as `adaptive`
  (on, no budget/effort knob on current models) or `disabled`, so the profile offers
  exactly `['none', 'high']` rather than faking a graded dial the API can't honour.
  Graded effort waits on SDK + model support; the code says so.

One correction to a claim of the same shape, filed here rather than a new
section: CLAUDE.md used to say the OpenAI-compatible adapter "throws on any
non-image file part, 400ing the whole request." `695b504` checked that against
the installed `@ai-sdk/openai-compatible@3.0.7` (`dist/internal/index.js:107-119`)
and found it's only true for a *non-PDF* file part — an `application/pdf` part
is silently converted into OpenAI's proprietary chat-completions
`{type:'file', file:{filename, file_data}}` shape and sent anyway, rather than
rejected locally. `planAttachmentDelivery` (the delivery planner) is still the
actual guard that keeps a native PDF part off a compatible provider — that
conclusion didn't change — but the failure mode a bug in the planner would
produce does: a stray PDF fails as a remote 400/422 from a backend that
doesn't recognize OpenAI's proprietary field, one layer further from the cause
than "the adapter throws." Anyone treating the adapter itself as a backstop
would have been wrong.

Each of these lives in *three* places — a profile comment, a docblock, and a named
test (`providerProfiles.test.ts`, `provider.test.ts`) — with the same parenthetical
("raw + tools = 400"). Triplication like that is the tell of a **hard-won,
specifically-tested** constraint from real provider-API research, not a guess.

## Two ways to inject one idea

Reasoning effort reaches the model by two different roads, because the two adapter
families take configuration differently:

- **Native** (OpenAI/Anthropic) — `withReasoningOptions` wraps the model in
  `defaultSettingsMiddleware` carrying `providerOptions`. It's a genuine no-op when the
  options object is empty, so a non-reasoning model pays nothing.
- **Compatible** (everyone else) — `reasoningBodyTransform` returns a
  `transformRequestBody` closure that merges the profile's body fields in, with a
  referential-equality fast path (`provider.test.ts` asserts the body object is
  returned *unchanged* when there's nothing to add).

## Prompt caching, Anthropic only

`c549e07` added a third profile flag, `supportsPromptCaching` (`true` only for
`kind:'anthropic'`), and reused the same wrapping trick reasoning effort
already established: `createModel` chains a second middleware,
`withCacheControl`, onto whatever `withReasoningOptions` returned. Every
caller that builds one model per (provider, model) pair — a turn's up-to-24
steps, a research task's phases, the browse sub-agent's own steps — shares
the wrapped model, so all of them benefit from one place.

Nothing was cached before this — no `cache_control` anywhere in the codebase
— despite a long agentic turn re-sending an identical system prompt and tool
schemas on every one of up to 24 steps, and a research task re-sending an
identical prefix every gather round.

**Marking the block is only half the fix.** The system prompt was assembled
into one string, so it became one Anthropic block, and a marked block is a
byte-for-byte match with *no partial credit inside it* — any change anywhere
(a saved memory landing in context, an invoked skill's body, a regenerate's
retry note) missed the whole entry. Reordering volatile content to the tail
buys nothing on its own, for the same reason. Worse, a single-step "just
chat" turn would have paid the 1.25× cache-*write* premium with no read to
offset it — a net loss on the single commonest turn shape.

The fix splits the prompt in two. `runAgentTurn` now accepts an
`AgentSystemPrompt` — a plain string (unchanged behaviour: research's fixed
phase prompts, title-gen, dream) or `{stable, volatile}`. `Chat.tsx` builds
the split (`splitSystemPrompt`): `stable` is `settings.systemPrompt` plus the
disclosure/access/math notes plus the skills catalog — near-identical across
turns and even across *conversations* on the same install; `volatile` is
recalled memory context, an invoked skill's body, and a regenerate's retry
note, all recomputed every turn. `runAgentTurn` still emits **one** combined
`SystemModelMessage`, not two — tagged with a
`providerOptions.lychee.volatileSystemLength` hint (the same
namespace-no-adapter-reads trick `attachmentRefs.ts` uses for its own
sentinels). Only the Anthropic-only `withCacheControl` middleware
(`provider.ts`) reads that hint and splits the wire prompt into a marked
stable block and an unmarked volatile one; every other adapter never looks at
the `lychee` namespace, so it sees the same single concatenated string as
before this existed. Doing the split in middleware rather than at the call
site is what keeps the OpenAI-native and OpenAI-compatible wire shapes
byte-identical to before — `runAgentTurn` doesn't know which provider it's
talking to.

The marker sits on the system-message breakpoint, not Anthropic's call-level
"top-level auto-cache" convenience. That convenience places its one
breakpoint on the last cacheable block of the *whole* request — on a turn
whose message history keeps growing (every step, every research round), it
would land on the volatile tail and re-write instead of read on almost every
call. Marking the system block explicitly is the documented pattern for "a
large system prompt shared across many requests."

Tool order turns out to have the same all-or-nothing sensitivity, for a
reason specific to how the AI SDK filters `activeTools` — that mechanism
belongs to progressive disclosure, so it's covered on [The Agent Turn
Loop](The-Agent-Turn-Loop#4-tool-order-matters-and-activetools-doesnt-control-it)
rather than repeated here.

The minimum prefix length Anthropic will actually cache **isn't uniform
across the model line** — it ranges from 512 tokens on some models to 4096 on
others, and doesn't move monotonically with model age — so
`supportsPromptCaching` is a flat per-`kind` boolean rather than a
per-model-id threshold table that would need upkeep on every release. Below
the minimum the marker is a documented, silent, free no-op server-side —
never a cost, only sometimes ineffective. Instead of predicting it,
`runAgentTurn` logs actual `read`/`wrote` cache token counts per step via
`console.debug` whenever the provider reports any — the same signal that
caught the next bug.

**The bug prompt caching's own telemetry found:** `cachedInputTokens` had
been wired to Langfuse as `cache_read` since observability shipped, and had
*never once* received data. `runAgentTurn` assigned the SDK's raw
`LanguageModelUsage` — which nests cache figures under
`inputTokenDetails.cacheReadTokens` — straight into a `ModelUsage`-typed
variable. Every field on `ModelUsage` is optional, so TypeScript accepted the
mismatched shape silently and the cache figures were dropped on the floor
every single time. `toModelUsage` (`src/agent/usage.ts`) now converts
explicitly, which is what makes the caching tradeoff above measurable against
real per-install numbers instead of assumed.

## The dial the user actually turns

`src/ui/ModelPicker.tsx` replaced a plain `<select>` with a grouped-by-provider
dropdown and a **Faster ↔ Smarter snap-slider** pinned to its footer (`4fd50f3`),
shown only for reasoning models. Its rungs come straight from the profile, and the
chosen effort is stored two-deep: a per-provider default (`reasoningEffort`) and a
per-model override (`modelConfigs[id]`), resolved by `resolveReasoningEffort` where
**per-model wins**. Auto-detection is manually overridable — a "Not a reasoning model"
affordance for when the id heuristic guesses wrong, since a heuristic over
never-before-seen local model names *will* guess wrong. `71997ba` added the LM Studio
preset and a per-endpoint "Refresh models" that seeds the reasoning flag from whatever
the provider's own model list reports, catching the ids the heuristic misses.

## The warning the switch created, turned into a feature

Going native for OpenAI had an unglamorous side effect. The Responses API returns
reasoning content that chat-completions never did, so it started showing up in
persisted history — invisible in the UI, but present, and **replaying it tripped an
SDK warning** ("Non-OpenAI reasoning parts are not supported. Skipping reasoning
part") because the provider metadata is gone after a JSON round-trip.

`af0ba74` cleaned it up first: `toValidModelMessages` strips reasoning parts from the
model-replay history (and drops any assistant message left empty as a result) — the
same request the SDK was already sending, minus the warning. Then `689ef59` turned the
*same stream signal* into the visible **"Thinking" block**: `reasoning-delta` chunks
merge into a collapsible disclosure that auto-opens while streaming and folds away on
reload. The rule that keeps it coherent: **reasoning is display-only** — captured into
the UI message, stripped from what the model replays. The clean-up landed six minutes
before the feature, which is the correct order: you silence the noise, *then* you put a
speaker on the signal.

## Coda: the reasoning tax showed up first in the titles

Before any of this, `c521c73` fixed a bug that reads, in hindsight, like a warning
shot. Naming a chat was "a coin flip — roughly a third to a half of chats kept the
'New chat' fallback for good," because the one-shot title generation had a hard,
un-retried **20-second abort** — and a reasoning model spends ~2k tokens of
chain-of-thought writing four words (measured against a local qwen3.6-35b: median
16.8s, max 25.7s, *squarely astride the ceiling*). The fix raised the budget to 60s,
moved it to turn-end with retries, and added an optional non-reasoning `titleModel`.

The lesson generalised into the whole profile system a week later: **a reasoning model
is not a faster model with better answers — it is a different cost and latency shape**,
and code that assumes otherwise fails quietly, at the seams, on exactly the models
users are most excited to plug in.

## The seam nobody sees: migrating old installs

Providers saved *before* `kind` existed still had to work. `settings.ts` infers a kind
from the base URL for legacy configs (`inferKind` — `api.openai.com`→openai,
`:11434`→ollama, `:1234`→lmstudio, and so on), so the capability layer and model picker
always have a key to work from. Every real feature that adds a required field also has
to answer "what about the data already on disk," and this is that answer.
