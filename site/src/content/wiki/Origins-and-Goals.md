# Origins and Goals

## What we set out to build

An AI agent that lives where the work already is — in the browser, beside the
page — instead of in a separate tab you paste things into. It should be able to
*read* what you're looking at, *act* on it when you allow it, and *go away and
research* something properly while you get on with your day.

The whole application was scaffolded in a single commit — `217a8e2`, *"Agent chat
side panel: onboarding, memory dreaming, screenshots, @mentions"* — on
10 July 2026. Everything in this wiki is what happened over the next three days.

## Two constraints that decided everything else

Almost every interesting decision downstream traces to one of these.

### 1. There is no backend

The panel calls whatever OpenAI-compatible endpoint you configure, directly, from
the browser. There is no server of ours in the path — no proxy, no key escrow, no
telemetry funnel.

This is a privacy position first: **your API key lives in
`chrome.storage.local` and is sent to exactly one place — the endpoint you
chose.** But it is also a hard engineering constraint, and it bit immediately:

- Direct calls to arbitrary API hosts are a CORS violation for any normal web
  page. What makes them legal here is the extension manifest's
  `host_permissions` — that single line is the entire reason no proxy server is
  needed.
- No backend means **no server-side secrets, no `.env`, no build-time keys.**
  Everything is entered at runtime through the UI.
- No backend also means no server to do the long-running work. Which leads
  directly to the offscreen document in [Deep Research](Deep-Research), and to
  every race condition it caused.

### 2. Model-agnostic, including the weak ones

The panel must work against *any* OpenAI-compatible endpoint — OpenAI,
Anthropic's compat layer, OpenRouter, Groq, a local Ollama or LM Studio. That is
a product promise, and it repeatedly overruled the more elegant technical option:

- **Tool discovery uses substring matching, not embeddings.** A vector-search
  retriever over the tool catalog would be lovely. It also assumes an embeddings
  endpoint that a local Llama server may not expose. Rejected — for ~14 tools,
  substring is enough.
- **No pre-turn classifier LLM call** to decide which tools to load, for the same
  reason: it doubles latency and assumes a competence the weakest supported model
  may not have.
- **Perception is text-first.** The indexed-DOM registry is delivered as a plain
  text list to *every* model. Screenshots are an *enhancement* for models that
  pass the vision probe — never the primary channel. A design that requires
  vision silently excludes half the endpoints we promised to support.

The general shape of the rule: **the floor is the weakest endpoint we support,
and features degrade toward it rather than assuming it away.**

## The onboarding consequence

Both constraints converge on the first screen a user ever sees. If we hold the
key and pick the model, onboarding is trivial. Because we do neither, the wizard
has to earn the user's trust in three steps: configure an endpoint, **test it
live**, and choose how much of your browsing the agent may see.

The live test is the part we'd defend hardest. `testModel()` fires one tiny
completion and **you cannot proceed until it comes back `ok`.** A typo'd base URL
or a dead key becomes a clear error on step two, instead of a mystifying broken
chat five minutes later. It has never needed a bug fix — no commit has touched
`Onboarding.tsx` since the day it was written, other than a directory move.

The visibility choice made in that same wizard isn't cosmetic either. Choosing
*"only my current tab"* doesn't hide a button — it **deletes `ReadTabs` from the
toolset entirely**, so the model never learns the capability exists. That
distinction, *removed vs. hidden*, becomes the backbone of the whole permission
model: see [Security and the Permission Model](Security-and-the-Permission-Model).

## How we worked

Spec, then plan, then build — 33 of the 180 commits are design documents that
shipped no code. The full reasoning is in
[The Design-AI Methodology](Design-AI-Methodology), including the spec we wrote,
reviewed, and then deleted without building.
