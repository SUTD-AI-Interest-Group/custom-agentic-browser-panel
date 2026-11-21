# Decider harness: an on-device System-1 lane for page control

**Date:** 2026-11-21 · **Status:** Approved by the user 2026-11-21 · **Spike:** done the same day. Results are in
the Appendix. The throwaway code lives in the session scratchpad and may be cleared.

**Scope of this build (the user's decision):** the runtime, shadow mode (A) and lookup
form-filling (C). **Driver mode (B) is deferred.** Whether to build it is decided after shadow
mode has produced numbers on real browsing (§9, go/no-go). §7.3 stays in this doc as the
direction, not as work for this build.

## 1. Intent

Page control today spends one chat-model step on every page action. On the local test model
(LM Studio, `google/gemma-4-26b-a4b`), a step takes 3–8 s (1–36 s measured). Most steps go to
tool discovery and session plumbing, not to the page. The user wants an "ultrafast" lane for
the mechanical part of browsing. A small **decision model** picks the next action, or the value
for a field, in a fraction of a second. The chat model keeps the planning, the language, and
anything the decision model is unsure about.

The model is `StrandsAgents/strands-decider-E2B-gemma4-v2-2611` (Apache-2.0). It is a Gemma 4
E2B whose output layer was replaced by a 255-code readout. It returns a calibrated probability
for each option of a choice, yes/no, or score question about a text state. It never generates
text.

This is a **harness for the user's own experimentation**. It is experimental and off by
default, not a feature for every install. It has three parts (B is deferred; see the scope note above):

- **A. Shadow mode.** The decider answers every real page step alongside the chat model, but
  never acts. It records agreement, confidence and latency.
- **C. Lookup form-filling** (the user's idea). Saved information is a JSON object. In one pass,
  the decider picks *which key* fills each field. No text is generated.
- **B. Driver mode.** A tool lets the decider drive a short run of page steps. It hands back to
  the chat model when it is done, unsure, or blocked.

## 2. Goals, non-goals, anti-goals

**Goals**
1. The decider runs **entirely inside the extension**: WebGPU first, WASM fallback. No local
   server, no hosted endpoint, no Chrome built-in model.
2. The model files persist **in browser storage** (the extension's OPFS) after a one-time
   import, and are verified by checksum.
3. Its answers match the checkpoint's own reference answers (`golden_vectors.jsonl`) within the
   bars in §9.
4. Shadow mode gives the user agreement, calibration and latency numbers from real browsing,
   with no effect on what the agent does.
5. Lookup filling maps a whole form in one pass. Values come from profile memories plus task
   values passed by the chat model.
6. *(Deferred, phase B.)* Driver mode completes runs of simple steps (click, type, select) at decider speed, with
   every safety gate of today's page control intact.

**Non-goals (this round):** shipping to the Web Store or other users; Gemini Nano / the Prompt
API / WebLLM (explicitly skipped by the user); a local Python server or hosted GPU; image
inputs (text-only states); fine-tuning; the background-research browser and the browse
sub-agent (foreground page control only); the future information **vault** (memories stand in
for it now); replacing the chat model's planning.

**Anti-goals** (any of these is a failure, even if the rest works):
- A decider-chosen action reaches the page without going through the same checks as
  `ControlPage`: the session, the foreground check, origin fencing, `isPointOfNoReturn` → a
  one-shot approval card, and the stale-element re-check.
- Shadow records or decider logs contain page content, URLs, element names or typed values.
  This is the same exclusion-by-construction rule as `TraceStep`.
- The multi-GB model download or import starts without an explicit user action.
- With the decider off, missing, failed or slow, page control behaves differently from today.
  The decider can only add; it never blocks the chat model's path.

## 3. Approaches considered

**Where the model runs**
1. *Local `strands-decider serve` (Python, MPS/MLX).* Fastest to try, but it needs a running
   server. The user ruled it out.
2. *Chrome built-in AI (Prompt API) / WebLLM.* The Prompt API only runs Gemini Nano. WebLLM
   only runs generative models compiled by MLC, and this model is a classifier with its own
   attention pattern and output layer. Neither can run it. The user ruled out Nano as well.
3. **Chosen: a one-time Python conversion to ONNX, run with `onnxruntime-web` (WebGPU, WASM
   fallback).** The spike proved it: exact parity at full precision, 8-bit parity on WebGPU,
   and 110–230 ms per decision on real page states.

**What to build**
1. *Playground page only.* Rejected: it says nothing about real browsing.
2. **Chosen: shadow mode first, then lookup filling, then driver mode.** Shadow mode costs no
   risk, and its numbers set the confidence threshold driver mode relies on.

**Where form values come from** (the user's call): **profile memories now**; a dedicated vault
later. The decider's input is just a JSON object, so changing the source later touches only
the adapter (§6.1).

**Relation to the October System-1 attempt** (Von / the `Act` tool, removed in `a0df0e2`; the
code is readable at `a0df0e2^`). The harness has the same shape: a candidate action space, a
fast model choosing an (operation, target), and the chat model on hand-back. What changes is
the model. Von was a 395M ModernBERT fine-tuned by us. This is a general pretrained decision
model with calibrated confidence, and no training is involved. The *loop* lessons October
measured are kept rather than relearned. **Builder's call: port them from
`a0df0e2^:src/system1/actLoop.ts` into §7.3:**
- a banded gate: act at ≥ `actThreshold` (0.6); between 0.4 and the threshold, a step runs
  only if it is not a point of no return; below 0.4, hand back; `done` always needs the full
  threshold;
- a quick settle for steps that commit nothing (50 ms quiet, 250 ms cap), instead of the full
  `waitForStable`; measured to remove Act's wall-time penalty;
- repeat exclusion: a decision that would repeat the last (operation, target) excludes that
  pair and asks once more;
- give up after `MAX_FAILED_ACTIONS` (2) refused actions, or 3 no-change steps in a row;
- the fingerprint re-validation of the target before acting, if it is cheap next to
  `hasElementChanged`.

## 4. Constraints from this codebase (CLAUDE.md invariants that bind this work)

- **The approval gate.** The driver tool follows `ControlPage` exactly. It only runs inside an
  open page-control session (the `RequestPageControl` grant is the gate). Every step that
  `isPointOfNoReturn()` flags raises a one-shot `requestApproval` card. It joins
  `createAgentTools()`, so disclosure, the catalog and `repairToolCall` cover it automatically.
- **Disclosure.** `RequestPageControl` adds the control cluster to `activeNames` on grant. It
  adds the driver tool too when driver mode is on and the model is ready. Otherwise the tool is
  **absent from the ToolSet**, so the repair hook can never resurrect it.
- **Teardown.** Session and overlay teardown stay in `runTurnChain`'s outer `finally`. The
  driver loop keeps no state beyond one tool call.
- **Settings validation.** A malformed optional settings field unmounts the panel. The new
  `settings.decider` field must be optional and normalized on load. Omitted means off.
- **`legacyCleanup.ts`** deletes Cache Storage `lychee-system1` on every install and update.
  Never store anything under that name.
- **CSP.** `extension_pages` already allows `'wasm-unsafe-eval'`, which ORT's WASM needs.
- **Realms.** The decider is **panel-resident**, like `McpManager` and `PdfEngine`, and never
  runs in the service worker. Its heavy work runs in a dedicated module worker spawned by
  extension URL. That is the `pdfWorker.ts` / `pdfEngine.ts` pattern: lazy boot, a FIFO queue,
  a wedge timeout that rebuilds the worker, and idle teardown.

## 5. The runtime (`src/decider/`)

### 5.1 The model files (produced by `scripts/decider-export/`, committed)

A Python pipeline turns the Hugging Face checkpoint into the files the extension imports. It
is a rewrite of the spike's scripts (Appendix B describes them) with a README. Outputs:

| File | Content |
|---|---|
| `torso.onnx` + `torso.onnx.data` | The packed text decoder (§5.3) plus the readout. 8-bit weights (`MatMulNBits`, block 32, symmetric); the readout MatMul stays full precision. ~2.1 GB. Inputs: `inputs_embeds [1,T,1536] f32`, `per_layer_raw [1,T,35,256] f32`, `position_ids [1,T] i64`, `segment_ids [T] i64`, `gather_idx [Q] i64`. Output: `logits [Q,255]`. |
| `embed.bin`, `ple.bin` | The two token tables. Main: 262144×1536. Per-layer: 262144×8960. Each row is pre-multiplied by its embedding scale (√1536, √256, applied in fp32 as the fp32 reference does), so a lookup is a plain row read. Precision is the builder's choice against the §9 parity bar; start with int8 plus a per-row fp32 scale (~2.8 GB). |
| `tokenizer.json` | The checkpoint's Gemma 4 tokenizer. |
| `manifest.json` | Format version; model id and revision; per-file size and sha256; temperature (1.5456); soft-cap (30); the 255 codes and their token ids; control-token ids; `max_length_validated` (32768); quantization. |

### 5.2 Storage: OPFS, imported once

- **Location:** the extension's Origin Private File System, under `decider/<modelId>/`. OPFS
  rather than Cache Storage because the worker reads the token tables **by row**, through a
  `FileSystemSyncAccessHandle`: T rows per decision, never 2.8 GB in memory. It also takes
  multi-GB streaming writes.
- **Import** (Settings → Experimental → Decision model), always started by a user click. Two
  paths, both of which stream into OPFS:
  - "Import model folder…": the folder `scripts/decider-export` wrote.
  - "Download from URL…": for when the user later hosts the converted files, for example on
    their own Hugging Face repo. Publishing anything is the user's decision, outside this work.
- **After writing:** verify every file's sha256 against the manifest. Status
  (`importing | ready | failed`, model id, bytes, `importedAt`) lives in `chrome.storage.local`
  under its own key, `deciderModel`, not inside `settings`. A **Delete** button removes the
  directory.
- **Eviction:** call `navigator.storage.persist()` on import, and add the `unlimitedStorage`
  permission. The builder must confirm in `chrome://extensions` that it shows no install
  warning. If it does, drop it and rely on `persist()`.

### 5.3 The forward pass (proven in the spike; keep it exactly)

- **Packing.** One sequence `[state | q1 | q2 | …]`. Segment ids are 0 for the state and k for
  question k. Every question's position ids restart at `len(state)`. The mask is built inside
  the graph from the segment ids: key j is visible to query i iff `seg[j] == 0` or
  `seg[j] == seg[i]`. So the state reads only the state, both ways, and each question reads the
  state plus itself, both ways. This equals the checkpoint's `prefix_bidir`: verified against
  the golden vectors at full precision, max |Δp| 0.016, 0 flips.
- **Sliding windows are ignored.** Every layer sees the whole prompt. That is a property of the
  checkpoint, not an optimization.
- **KV-shared layers.** On E2B, layers 15–34 reuse the keys and values of layers 13 and 14 and
  write none. So from layer 15 on, only the `gather_idx` rows are carried (each question's last
  token). This is exact, not an approximation, and it is most of why the model is fast.
- **Readout,** done in JS: `p = softmax(tanh(z/30)·30/1.5456)` over a question's own k codes.
  Confidence formulas follow the model card: choice `(N·pmax−1)/(N−1)`; score uses the std-dev
  formula.

### 5.4 Worker and client

- **`deciderWorker.ts`** (Vite entry, module worker). Owns the ORT session (WebGPU, falling
  back to WASM), the tokenizer, and the OPFS table readers. It exposes `boot()`,
  `decide(request) → per-question probabilities`, and `dispose()`.
- **`engine.ts`** (panel side). Lazy singleton, FIFO, wedge timeout and rebuild, idle teardown.
  Idle teardown frees GPU memory; the builder picks the interval. Boot starts on the
  page-control **grant** when the decider is enabled, so its 6–18 s session creation overlaps
  the chat model's next step.
- **`prompt.ts`** (pure, tested). A TS port of the checkpoint's `strands-chat` rendering. That
  covers the state and question parts, option lines (`A. name — description`), codes
  `A…IV` (255), control tokens inserted by id, and the text of each run encoded with
  special-token matching **off**. The source is `strands_decider/core/prompt.py` in the wheel
  shipped with the checkpoint (`strands_decider-0.3.1.dev108`); the public GitHub main has
  already changed the `render()` signature, so port from the wheel.
- **Tokenizer.** The builder picks the JS implementation. It must reproduce `state_ids` and
  `question_ids` exactly for every text-only row of `golden_vectors.jsonl` (430 rows).
- **Settings:**
  ```ts
  decider?: { mode: 'off' | 'shadow' | 'assist'; actThreshold?: number }
  ```
  - `shadow` records only.
  - `assist` is shadow plus the decider-mapped `AutofillForm` path (§7.2).
  - Phase B, if built, adds `driver`.
  - `actThreshold` defaults to 0.6 (top-option probability).

### 5.5 Not in the spike, still to prove (the first plan phase gates on them)

- Tokenizer parity in JS.
- Table lookups from OPFS, and their effect on parity.
- Session creation from OPFS bytes without running out of memory in the panel's worker.
  `torso.onnx.data` is 2.1 GB.
- Latency under GPU contention while LM Studio is generating on the same machine. In October
  one Von pass took 26 s in this situation. **Measure and report it; do not block on it.**

## 6. The decision contract (shared by A, B and C)

**State** (JSON, rendered as the checkpoint renders structured content):
`{ goal, plan, url, title, previous_actions[], page_text? }`.
- `goal` is the **newest user message in effect** in the continuation chain: the message that
  opened the turn, or a steer spliced in later. A steer supersedes; it never sees a frozen
  original. `plan` is `session.plan`. **Builder's call:** `runTurnChain` passes two getters
  into `createAgentTools()`: `currentGoal()` and the chain's `steerPending()`. Today
  `steerPending` only reaches `runAgentTurn`. Neither getter persists anything.
- `previous_actions` comes from `session.journal`, which is already redacted, **windowed to
  its last 6 entries** (builder's call; it otherwise grows without bound).
- `page_text` is a bounded excerpt of the visible viewport text. Start the cap at about 1,200
  characters. The spike's shop case needed the prices from it. The builder picks the
  extraction method and must report its token cost.

**Next-action question** (one `choice`): one option per registry element, in registry order.
- Typeable fields give `type into [i]`, selects give `select in [i]`, everything else gives
  `click [i]`. The description is the element's registry line without its index.
- Then `scroll down` and `done`.
- The domIndex cap of 200 elements keeps this within the model's 255 options.

### 6.1 The lookup source (C) and the memories adapter

- **Profile JSON.** Profile memories are free-text sentences (written by `SaveMemory`, kind
  `profile`). On the first need in a panel session, the chat model turns them into flat JSON
  (`{ "full_name": "Ada Lovelace", "email": … }`) with **one** structured-output call. Reuse
  `src/agent/extract.ts` or `generateObject`.
- The result is held **in memory only**. It is keyed by a hash of the profile memories' ids
  and `updatedAt`, and recomputed when they change. No new at-rest copy of personal data.
- Keys and values come only from the memories. No invented values, and nothing sensitive:
  `SaveMemory` already forbids secrets.
- This adapter is the single seam the future vault replaces.
- **Task values.** The chat model passes the request-specific values (topic, message, dates…)
  as a flat `values` object to the tool that fills, so the lookup JSON is
  `{ profile: {…}, request: {…} }`.

## 7. The three modes

### 7.1 A — Shadow mode

- **Hook.** In `ControlPage.execute`, once `snap` is taken, `spec` is known and the session is
  valid, call `shadow.observe(...)` **fire-and-forget**. Never await it on the step's path.
  `AutofillForm` is shadowed the same way: the decider produces its own field-to-key mapping,
  and agreement means the chosen key's value equals the value the chat model typed.
- **Queue.** If a shadow decision is still pending when the next one arrives, drop the older
  one. Shadow is best-effort.
- **Record.** IndexedDB, own DB `lychee-decider`, store `shadow`. Pruned by count and age,
  following the screenshots/traces pattern. Fields:
  `{ id, conversationId, turnId, at, kind: 'next'|'fill', modelId, T, ms, cold, llm: {op, index}, top3: [{op, index, p}], agree, wouldAct: p ≥ actThreshold }`.
  **No names, values, URLs or page text.** A test must drive a password through the real
  capture path and prove it is absent, as `traceSink.test.ts` does.
- **View.** A "Decider" section in Settings → Experimental:
  - agreement rate overall and by kind;
  - a calibration table: agreement rate per confidence bucket, 0.1 wide;
  - coverage at the current threshold;
  - latency p50 and p95, with cold boots shown apart;
  - a Clear button.

### 7.2 C — Lookup form-filling

- **Entry point** (builder's call, made because driver mode is deferred). This is the existing
  **`AutofillForm`** tool. In `assist` mode with the model ready:
  - `fields` becomes optional, and a new optional `values: Record<string,string>` carries the
    request-specific values.
  - Called **without** `fields`, the decider maps the page's fields in one pass (below) and
    fills the confident ones.
  - Called **with** `fields`, the tool behaves exactly as today. In `shadow` mode it never takes
    the decider path, and its calls are only shadowed.
  - Every existing `AutofillForm` guard stays as it is: the session check, foreground parking,
    the per-field origin check, the sensitive-field card, and never submitting.
  - The result lists what was filled, by index and key name. It lists what was left: under the
    threshold, `leave_empty`, or sensitive and denied. The chat model finishes the rest with
    `ControlPage`.
- **Pass.** One decider pass over the page's form fields, all questions sharing the state
  (the spike filled a 7-field form in 0.32 s):
  - each text-like field gets a `choice` over the lookup's dotted keys plus `leave_empty`. Use
    key names as options with **no value descriptions**; the values are in the state. The
    spike showed this is half the tokens and gives the same answers.
  - a `select` gets a choice over its own options. The registry does not carry options today,
    so the snapshot or a targeted read must supply them.
  - a checkbox gets a yes/no "should it be ticked".
- **Fill.** Each field whose top probability is ≥ `actThreshold` is filled through
  `runControlStep` with the chosen key's value. Sensitive fields always take the one-shot card,
  as `AutofillForm` does today. Fields under the threshold are left for the chat model and
  reported back.
- **Prerequisite fix** (small, benefits the chat model too): the registry shows an unticked
  checkbox as `= "on"` (its value attribute). Expose checked state instead.

### 7.3 B — Driver mode (deferred: not in this build; see §9 go/no-go)

- **Tool.** A new tool in `createAgentTools()`. The name is the builder's, matching
  `^[a-zA-Z0-9_-]{1,64}$`; avoid "Act". Input:
  `{ goal: string, values?: Record<string,string>, maxSteps?: number }`. `goal` is one
  step-scoped sub-goal. `maxSteps` defaults to 12, capped at 12.
- **Loop**, per step:
  1. foreground check (park as `ControlPage` does);
  2. origin-drift check (stop and hand back);
  3. snapshot;
  4. if the page has unfilled fields the lookup can fill, run the §7.2 pass first;
  5. otherwise the next-action question;
  6. if the top probability is below the threshold, **hand back**;
  7. a `type` target gets its value from a small key question for that one field, or hands
     back if it picks `leave_empty` or falls below the threshold;
  8. `isPointOfNoReturn` → one-shot approval card, then the stale-element re-check;
  9. `runControlStep`, with the presence hooks so the user sees the cursor;
  10. stop on `done`, two no-change steps in a row, a denied card, `maxSteps`, the chain's
      Stop/abort signal, or `steerPending()`, checked between steps so a steer is never held
      behind a long run.
- **Return:**
  `{ status: 'done'|'handback'|'blocked'|'stopped', reason, actions: <redacted journal entries>, elements: <fresh registry text> }`.
  On a hand-back it adds the low-confidence question's top three options, so the chat model
  sees why.
- **Budget.** One tool call is one model step against `MAX_STEPS`; decider steps inside it are
  bounded by `maxSteps`.
- **Dense pages** (builder's call). Decision time grows with the prompt: 2.9 s at 4,920 tokens
  in the spike. If a rendered decision would exceed **2,500 tokens**, driver mode hands that
  page back to the chat model with `reason: 'dense page'` instead of deciding slowly. Shadow
  mode still decides and records `T`, so the stats view can show latency by token bucket and
  the cap can be tuned from real data.

## 8. Evaluation harness (`scripts/decider-eval/`, committed)

The spike's driver becomes a repo script, reusing the October harness pattern (`a0df0e2^`,
`scripts/system1-eval/run.mjs`):
- persistent Chrome for Testing context with the built `dist/`;
- approval cards auto-allowed;
- success read from **page state, or from the reply for retrieval tasks**, never from the
  model's claim.

**Agreement is not accuracy: score both models against an answer key.** If the chat model is
wrong, agreement with it says nothing, and the decider might be the better of the two (the
user's point). So every fixture ships an **answer key**: a pure function from the fixture's
live state to the *set* of correct next actions. Examples:
- *form:* typing into any field not yet holding its target value; ticking consent if unticked;
  Send only once everything is filled.
- *store results:* the Arc headphones link.
- *inbox:* the Acme Energy row.

Each recorded step scores the chat model's action **and** the decider's top action against
the key. The report gives the 2×2 table (both right / only chat right / only decider right /
both wrong) per task and overall, plus whole-task success.
- **Key outside the harness.** In production shadow mode (the user's real browsing) there is
  no key, and shadow records deliberately hold no page content. So production stats stay
  agreement-only, and the go/no-go uses the key.
- **Full step states in eval only.** The eval harness may store full step states, since
  fixtures hold no user data, so disagreements can be inspected. That is the
  `?eval`-only path; nothing like it exists in the shipped shadow store.

**Chat models.** Two references, run separately:
- LM Studio `google/gemma-4-26b-a4b` is the default, as CLAUDE.md requires.
- **Anthropic `claude-sonnet-5-5`** is a stronger reference (the user's choice). It is an
  **explicit opt-in** (`PROVIDER=anthropic`), the only sanctioned exception to CLAUDE.md's
  local-only rule for automated runs.
- **The key** is read from a file the user creates (`~/.config/lychee-eval/key`, mode 0600),
  never printed. It is seeded only into a throwaway profile that is deleted after the run.
- **Spend cap.** The harness aborts the run once the estimated spend passes a cap of **$10 per
  run** (the user's limit), computed from each step's usage at $2 / $10 per M input/output, $0.10 cache read,
  1.25× for cache writes.
- **Measured** (one form run): 10 steps, 40 s, 108k input (38k cached), 1.5k output,
  ≈ $0.16–0.19, against Gemma's 18 steps and 184 s on the same task.

**Task set.** Grow from 4 tasks to about 15–20, roughly 150+ scored steps, each with an
answer key. Variants of store search (cheapest under a price, a specific colour, add two
items), forms (different field sets, a select-heavy form, an optional field to leave blank),
navigation (two to three levels deep), inbox retrieval (amounts, dates, a sender among
look-alikes), and one page dense enough to cross the 2,500-token cap. Optional, builder's
call: an offline set of real-site steps with gold labels, built with the October Mind2Web
conversion code (`a0df0e2^:scripts/von-finetune/mind2web*.mjs`).

**Arms.** `shadow` (the chat model's behaviour equals `off`, plus decider scoring) and
`assist`. Add `driver` if B is built. `off` runs only as a sanity check that shadow does not
change the chat model's results.

**Report per task:** success, wall time, chat-model steps and tokens/cost, decider steps and
milliseconds, coverage at the threshold, the 2×2 accuracy table, agreement, and hand-back
reasons.

**Bugs the benchmark runs surfaced** (fix, or at least confirm, during the build):
- the unticked checkbox shows as `= "on"`; Sonnet spent a screenshot to check it;
- Sonnet reported the set-of-marks screenshot boxes **misaligned** with the form fields.
  Confirm whether this is the harness (the panel as a tab, viewport, DPR) or Lychee;
- the anthropic profile maps reasoning `none` to `thinking: {type: 'disabled'}`, which
  `claude-sonnet-5-5` rejects with a 400 (it accepts `{type: 'between_tools'}` instead). This
  is out of scope here; note it for a separate fix.

## 9. Acceptance

- **Parity.** In the browser on WebGPU, with the real JS tokenizer and OPFS tables, over the
  text-only golden rows up to 3,000 tokens: max |Δp| ≤ 0.05 and **0 top-1 flips**. The spike
  had ≤ 0.03 and 0 flips with Python-made embeddings. Tokenizer: exact id parity on all 430
  text-only rows.
- **Latency** (WebGPU, warm, M4 Max): next-action ≤ 300 ms p50 at ≤ 600 tokens and ≤ 800 ms at
  ~1,400 tokens (spike: 276 / 688 ms); the 7-field lookup form ≤ 400 ms (spike: 319 ms).
- **Safety.**
  - Tests prove the decider path of `AutofillForm`:
    - never runs outside `assist` mode or without a ready model;
    - never fills a field below the threshold;
    - fills only values present in the lookup JSON;
    - still raises the one-shot card on every sensitive field;
    - never submits;
    - stops on origin drift as the existing path does.
  - A password-through-capture test proves shadow records carry no user data.
  - If driver mode is built later, it adds its own §7.3 safety tests: no action without a
    session, a card on every point-of-no-return step, a stop on origin drift, and absence from
    the ToolSet outside `driver` mode.
- **Off is off.** With `decider` omitted, no worker boots, no OPFS access happens, and the
  existing page-control tests pass unchanged.
- **Eval.** The harness runs the `shadow` and `assist` arms on the expanded task set, with both
  chat models, and writes a report. These are **numbers to read, not pass/fail bars**: the
  point of the harness is to find out.
- **Go/no-go for driver mode** (proposed bar; the user decides with the numbers in hand).
  Over at least 150 answer-keyed steps:
  - the decider's **accuracy against the key** is ≥ 85% on steps where its top probability is
    ≥ 0.6;
  - its accuracy is within 5 points of the Sonnet reference's on the same steps;
  - and its accuracy rises with confidence (calibration).
  
  If any fails, rethink before building B. Production shadow agreement is reported alongside
  but does not decide.

## 9a. Build order

1. **Runtime and storage.** The export pipeline, OPFS import and verify, the worker and engine,
   and the prompt port and tokenizer. Gated on the §9 parity bars and the §5.5 items.
2. **Shadow mode.** The hook, records, stats view, and the checkbox-state fix in `domIndex`.
3. **Lookup filling.** The memories adapter, the one-pass field mapping, the `AutofillForm`
   decider path, and shadowing of `AutofillForm`.
4. **Eval harness:** answer-keyed fixtures (about 15–20 tasks), the `shadow` and `assist` arms,
   Gemma by default and Sonnet 5.5 opt-in under a spend cap, and a report. Then the user's
   go/no-go on B.

## 10. Left to the builder

- The JS tokenizer library, and table precision (bound by §9 parity).
- Speed-ups beyond the spike: fused attention, fp16 activations, input-length bucketing
  (bound by §9 latency).
- The `page_text` extraction method and cap.
- Getting select options into the decision.
- The idle-teardown interval.
- The tool's name and description wording.
- The stats view's layout.

## Appendix A — Spike results (2026-11-21, M4 Max 64 GB, Chrome for Testing, ORT-web 1.31.1)

**Parity against the golden vectors**

| Variant | Size | max \|Δp\| | Flips |
|---|---|---|---|
| fp32, ORT CPU | 7.5 GB | 0.016 | 0/36 |
| 4-bit symmetric, ORT CPU | 1.18 GB | 0.34 | 4/180 |
| 8-bit, WebGPU | 2.11 GB | ≤ 0.03 (golden), ≤ 0.015 (vs fp32) | 0 |

The 2/180 flips seen for 8-bit on the CPU come from ORT CPU `accuracy_level=4`, which
quantizes activations to int8. WebGPU does not.

**WebGPU latency, 8-bit, warm median**

| Tokens | Elements | Time |
|---|---|---|
| 275–329 | — | 90–165 ms |
| 563 | 10 | 276 ms |
| 1,375 | 47 | 688 ms |
| 2,619 | 100 | 1.31 s |
| 4,920 | 200 | 2.87 s |

4-bit runs at the same speed. Session creation from localhost: 6–18 s.

**WASM, 4-bit, 16 threads:** 275 tokens 1.9 s; 563 tokens 3.0 s; 1,375 tokens 6.8 s.

**Lychee baseline** (LM Studio Gemma 26B, local fixtures):

| Task | Result | Wall | Chat-model steps | Page actions |
|---|---|---|---|---|
| inbox | ✓ | 93 s | 10 | 1 |
| shop-search | ✗ | 88 s | 11 | 0 |
| form | ✓ | 184 s | 18 | 6 |
| navigate | ✓ | 64 s | 9 | 2 |

The shop failure: the chat model called `ControlPage` without `RequestPageControl` and looped
on `ToolSearch`.

**Shadow replay:** 12/12 agreement with the chat model's actions, at 110–229 ms each, with
confidence 0.30–0.98. That is 10 recorded steps plus 2 hand-built shop states, which needed the
prices from the page text.

**Lookup form:** 7/7 correct in one pass, including the decoys (work email, first and last
names). With value descriptions in the options: 1,544 tokens, 662 ms. Keys only: 1,180 tokens,
319 ms, the same answers. The textarea → `request.message` pick was right but had p ≈ 0.28.

## Appendix B — What the spike's export did (to rebuild it)

- **Load:** `Gemma4ForConditionalGeneration.from_pretrained` with
  `config.audio_config = config.vision_config = None`, in fp32. The text model is
  `model.model.language_model`.
- **Attention:** register a custom attention function: plain `softmax(qkᵀ·scaling + bias)·v`.
  Broadcast the single K/V head rather than repeating it, and ignore the sliding window. Set it
  with `set_attn_implementation({"text_config": name})`.
- **Wrapper:**
  1. `ple = project_per_layer_inputs(inputs_embeds, per_layer_raw)`.
  2. Build the bias from the segment ids (0, or the dtype's minimum).
  3. Rotary embeddings per layer type.
  4. Loop the layers with a `KVSharingDict`. At `first_kv_shared_layer_idx`, index the hidden
     states, `ple`, the cos/sin values and the bias rows by `gather_idx`.
  5. Final norm, then `h @ readoutᵀ`.
- **Export:** `torch.onnx.export(..., dynamo=True)` with dynamic T (4–32768) and Q (1–64);
  `optimize=True`; external data. 20 s.
- **Quantization:** `MatMulNBitsQuantizer(bits=8, block_size=32, is_symmetric=True,
  accuracy_level=4)`, excluding the readout MatMul (the initializer whose last dim is 255).
- **Torch versions:** torch 2.15, transformers 5.24.0.
