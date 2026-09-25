# System-1 page control (`Act`) — experimental, in-browser, WebGPU

Status: design approved in chat 2026-09-26; spec awaiting review.

## Why

Every `ControlPage` action is one full LLM round trip: the model re-reads the
element list, picks an `[index]`, emits a tool call, waits for the result. On a
hosted reasoning model that is seconds per click; a ten-field form is a minute.
"System One" decision models (TypeSafe's proprietary Jev, and open replicas)
answer a *choice* question over supplied options in a single forward pass with
calibrated probabilities and no text generation. Used as the inner loop of page
control, one could execute several low-stakes steps locally between LLM calls.

This is an **experiment**: off by default, behind an explicit toggle that
triggers a large model download, with a stated kill criterion (§9).

## Model choice

**Von 1.2** (`wfzyx/von`, Apache-2.0): ModernBERT-large (395M) encoder plus an
Option-Marker head, 8192-token context. Chosen over NanoJev-Web and Kev because:

- **Encoder, single pass.** The premise and every option are packed into one
  sequence; each option gets a `[MASK]` marker whose final hidden state the head
  scores. Cost is one encoder pass regardless of option count — scoring 150
  on-screen elements costs the same pass as scoring 5. Prefill-only work with no
  KV cache is exactly what WebGPU does well.
- **Order-invariant by construction (1.2).** Each option attends only to the
  premise and to itself, with position ids restarting at the premise's end. DOM
  order is arbitrary, so this matters.
- **Calibrated probabilities** (`marker_calibration.json`: an
  input-conditioned temperature map), which is what makes a confidence-based
  hand-back to the LLM meaningful.

NanoJev-Web (Qwen3-0.6B, frozen, browser-trained head) was rejected: it encodes
each candidate separately (N passes/decision, 768-token cap) and its training
contract deliberately hides page content from the model, so it cannot ground
"the blue variant's Add to cart". Its *contract* ideas are borrowed (host-owned
values; re-observe before acting; `DONE`/`WAIT`/`BLOCKED` as choices). Kev-0.6B
is the A/B fallback if Von's export fails (§4 risk).

## Non-goals

- No WASM/CPU fallback. A 395M encoder on CPU is slower than the round trip it
  replaces; without a WebGPU adapter the tool simply does not exist.
- No research-pipeline use (research has its own browse sub-agent and no user).
- No new permission gate semantics; `Act` rides the existing page-control grant.
- No fine-tuning in this iteration — zero-shot Von on our element format.

## 1. Settings & UI

- `Settings.experimental?: { system1?: boolean }` — sparse; absent → off.
  `normalizeSettings` drops a malformed value rather than letting it unmount the
  tree (see CLAUDE.md's `observability` trap).
- New **Settings → General → Experimental** section with one row,
  *"Fast page control (System-1, experimental)"*, whose status line is one of:
  `Off` · `WebGPU unavailable` · `Downloading 132 / 410 MB` (progress bar +
  Cancel) · `Verifying…` · `Ready · 410 MB` · `Failed: <reason>` (Retry).
- Toggling **on** checks WebGPU (`navigator.gpu?.requestAdapter()`), then starts
  the download. Toggling **off** keeps the files and offers
  *"Delete model (410 MB)"*.
- Manifest gains `unlimitedStorage` (no install warning) so Chrome does not
  evict the weights under storage pressure.

## 2. Weights: export, hosting, download

**Exporter** — `scripts/export-von/` (Python, run by a maintainer, not the build):

1. Load `wfzyx/von` at a pinned revision (safetensors + `option_marker.pt`).
2. Wrap backbone + head in a module taking
   `input_ids[1,T]`, `position_ids[1,T]`, `attention_bias[1,1,T,T]` (additive
   float mask, 0 / -inf), `marker_positions[K]`, returning `logits[K]`.
   ModernBERT alternates global and 128-token sliding-window layers; the wrapper
   must combine our block mask with each layer's own window mask — this is the
   highest-risk step.
3. `torch.onnx.export` (opset ≥ 17), then quantize (q4 via ORT's
   MatMulNBits, int8 fallback) keeping an fp16 variant for parity.
4. **Parity check:** for a fixed suite of inputs, max |ΔlogP| between PyTorch
   fp32 and each ONNX variant, printed and asserted under a threshold.
5. **Order-invariance check:** permuting options permutes logits (exactly, up
   to fp tolerance).
6. **Refit calibration** on the quantized variant (quantization shifts logits;
   the shipped `marker_calibration.json` was fit on fp32).
7. Emit `manifest.json`: `{version, variants:{q4:{files:[{path,bytes,sha256}]}},
   calibration, tokenizer}`.

The maintainer pushes the output to a Hugging Face repo they control (working
name `ks-ang/von-onnx-web`). The extension pins **one revision hash** in code
(`src/system1/weightsManifest.ts`), never `main`.

**Download** — `src/system1/weights.ts` (panel-resident):

- Fetch the pinned `manifest.json`, then each file via a streaming `fetch`
  (`https://huggingface.co/<repo>/resolve/<rev>/<path>`; `<all_urls>` covers
  CORS), reporting progress; cancellable via `AbortController`.
- SHA-256 each file (`crypto.subtle.digest`) **before** `cache.put` into Cache
  Storage `lychee-system1`. A mismatch discards the file and fails the download.
- Readiness in `chrome.storage.local` (`system1State: {rev, variant, bytes,
  readyAt}`) is written **only after** every file verified; a partial download
  is never "ready". Readiness is re-validated at boot (all cache entries present).
- Delete = `caches.delete('lychee-system1')` + clear state.

## 3. Runtime

`src/system1/` is a new concern directory (add to CLAUDE.md's source layout).

- **`engine.ts`** — the `pdfEngine.ts` analog: owns one module `Worker`
  (`system1Worker`, a Vite entry spawned by extension URL), boots lazily, FIFO
  `queue` so a call's timeout starts when it begins, rebuilds the worker if a
  round trip wedges. API:
  `decide(req: DecideRequest): Promise<DecideResult>` where a request is
  `{premise, questions: {[key]: {instructions, options: {[id]: text}}}}` and a
  result is `{[key]: {choice, probabilities, confidence}}` plus `ms`.
- **`worker.ts`** — `onnxruntime-web` with `executionProviders: ['webgpu']`;
  loads model bytes from Cache Storage (same origin), tokenizes, packs, runs,
  calibrates. ORT's `.wasm`/`.mjs` assets are **bundled** (MV3 forbids remote
  code; the existing CSP already allows `'wasm-unsafe-eval'`). Direct ORT, not
  transformers.js pipelines — pipelines cannot pass a custom 4D mask. Tokenizer:
  the ModernBERT `tokenizer.json` via a JS tokenizer library (transformers.js's
  tokenizer or equivalent; chosen in the plan after measuring bundle size).
- **`von.ts`** — pure, tested: `packInput` (premise ids + per-option
  `[MASK] + option ids`, per-option position ids restarting at premise end,
  marker positions), `buildAttentionBias` (premise↔premise, option→premise,
  option↔self; option↔other-option masked), `calibrate` (temperature from
  entropy/length/count per `calibration_map`), `softmax`. Rejects over-length
  inputs with a typed error (never truncates silently).
- One question = one forward pass; a step's up-to-three questions run
  sequentially in the worker (the queue already serializes).

## 4. The `Act` tool

Defined in `createAgentTools()` (so disclosure, repair and the catalog work
unchanged), present **only when** `experimental.system1` is on **and**
`system1State` is ready **and** a WebGPU adapter exists. Disclosed into
`activeNames` alongside `ControlPage` when `RequestPageControl` is granted.

```ts
Act({ goal: string, values?: Record<string, string>, maxSteps?: number })
```

- `goal` — one short sub-goal ("add the blue variant to the cart").
- `values` — named literals the LLM authorizes for typing/selecting. Von chooses
  *which key*; the typed text is always that value verbatim. Von never
  generates text and never chooses a URL (`navigate` is not an Act move).
- `maxSteps` — default 6, clamped to 8.

**Gate.** Requires an open, active page-control session (same check as
`ControlPage`); the session grant is the gate. No card of its own.

**Per step:**

1. **Shared pre-step guard** — extracted from `ControlPage.execute` into one
   helper both tools call: session active, tab still bound, foreground (else
   park), `mountPresence`/`setTint`, origin-drift handling (card or re-fence).
2. `snapshotPage()` → candidates = viewport interactive elements **minus
   sensitive ones** (domIndex's `sensitive` flag: password/payment). Sensitive
   fields are the LLM's, via `ControlPage`/`AutofillForm`.
3. Premise = goal + origin + title + the steps already taken this call
   (action, label — never values) + busy/dialog flags.
4. `decide` with:
   - `move`: `act` · `scroll_down` · `WAIT` · `DONE` · `BLOCKED`
   - `target` (only if `move=act`): one option per candidate —
     `"[17] button 'Add to cart' → click"`, `"[5] textbox 'Email' (empty) → type"`,
     `"[9] select 'Size' (M) → select"`.
   - `value` (only if the target is a type/select): one option per `values` key.
     No `values` → type/select targets are excluded up front.
5. **Confidence gate:** any answered question with calibrated top-p < τ
   (`ACT_CONFIDENCE`, 0.6) → stop `uncertain`, returning the top 3 candidates.
6. **Point-of-no-return:** `isPointOfNoReturn()` exactly as ControlPage calls it
   → one-shot `requestApproval` card. Denied → stop `denied`.
7. `runControlStep` — journal, undo state, presence, settle, re-snapshot:
   unchanged.
8. Stop on: `DONE`, `BLOCKED`, `uncertain`, `denied`, origin `drifted`,
   `repeat` (same action on same index twice in a row), `aborted` (the tool's
   `abortSignal`, checked between steps — Stop must not wait out the loop),
   `capped`, `error` (engine failure — also marks the engine unhealthy for the
   rest of the chain so the model falls back to ControlPage).

**Returns** `{status, steps:[{action, index, label, p}], candidates?, elements}`
— values redacted as the journal redacts them; `elements` is the fresh registry
so the LLM can continue with `ControlPage` without another read. The `ms` per
decision rides along for the experiment's measurements.

The step loop itself is a pure planner (`src/system1/actLoop.ts`) over injected
`decide`/`snapshot`/`execute`/`approve` functions, so every stop rule is unit
tested without Chrome.

## 5. Safety analysis

Page text is untrusted and now flows into a classifier that selects actions, so
a prompt injection can bias the choice. The design bounds what a biased choice
can do:

- Moves are drawn from a closed set; no free text, no URL, no `navigate`.
- Typed/selected content is only ever an LLM-supplied value, verbatim.
- Sensitive fields are not candidates at all.
- Every committing action (submit, Enter, cross-origin nav, flagged fields)
  still raises the one-shot point-of-no-return card via the same classifier.
- The session is still origin-fenced; drift still cards.

Worst case: a wrong non-committing click or a supplied value typed into the
wrong non-sensitive field on the granted page — both already reachable by the
LLM through `ControlPage`, and both undoable through the journal.

**Invariant amendment (CLAUDE.md, long-horizon bullet):** "there is no separate
per-session action budget" becomes: one `Act` call is one of the 24 steps but
may perform up to 8 actions; the chain's worst case is therefore bounded by
`MAX_STEPS × ACT_MAX_STEPS`, and every point-of-no-return still confirms
individually. `TraceStep` is unchanged (tool names only).

## 6. Prompting

`TOOL_DISCLOSURE_NOTE`-style guidance (always-appended, not the user's system
prompt), only when `Act` exists: use `Act` for routine multi-step sub-goals on
the controlled page with explicit `values`; use `ControlPage` for single precise
actions, sensitive fields, navigation, and after an `uncertain`/`blocked`
result; always check `Act`'s returned status rather than assuming success.

## 7. Error handling

- Engine boot/inference failure → `Act` returns `error` with a one-line reason;
  engine flagged unhealthy for the chain; settings row shows the error.
- Over-length premise (huge page) → candidates trimmed to the viewport (they
  already are) then, if still over, `uncertain` with a note — never truncate
  tokens silently.
- Cache entry missing at boot (user cleared site data) → state reset to
  not-ready, tool absent next turn, settings row offers re-download.

## 8. Testing

- **Pure units:** `von.ts` (packing, position ids, bias matrix, the
  permutation property, calibration, over-length rejection); `actLoop.ts` (each
  stop reason, sensitive exclusion, value-key-only typing, no values ⇒ no
  type targets, PONR routes to approve, abort between steps); `weights.ts`
  hashing/readiness logic with a fake cache; `normalizeSettings` for the new
  field.
- **Exporter:** parity + order-invariance assertions inside the script.
- **Real browser (Playwright, unpacked build, LM Studio
  `google/gemma-4-26b-a4b` as planner per CLAUDE.md):** fixture pages (a form,
  a product list with variants, a dialog). Measure p50/p95 `decide` ms, a
  ~50-case labelled grounding set (goal + page → correct `[index]`) scored for
  Von vs the LLM, and end-to-end task success/time for Act vs ControlPage-only.

## 9. Kill criterion

Report, keep behind the toggle, and do not promote if either holds on the
reference Mac: p50 `decide` > ~300 ms, or grounding accuracy clearly below the
LLM's on the labelled set. The export risk (§2 step 2) is checked first; if
the combined mask cannot be exported faithfully, stop and evaluate Kev-0.6B.

## Files

New: `src/system1/{engine,worker,von,von.test,actLoop,actLoop.test,weights,weights.test,weightsManifest}.ts`,
`src/ui/settings/ExperimentalSection.tsx`, `scripts/export-von/*`.
Touched: `src/data/settings.ts`, `src/ui/settings/{GeneralTab,normalizeSettings}.tsx|ts`,
`src/tools/tools.ts` (Act + shared pre-step guard), `src/agent/…` disclosure note,
`vite.config.ts` (worker entry, ORT assets), `public/manifest.json`
(`unlimitedStorage`), `package.json` (`onnxruntime-web`, tokenizer), `CLAUDE.md`.
