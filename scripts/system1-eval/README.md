# System-1 (Von) real-browser eval

Decides whether the experimental `Act` tool is worth offering. Unit tests cannot
see WebGPU numerics, real calibration or real pages, so this drives the built
extension in a headed Chromium, per CLAUDE.md's "Browser-automation testing of
agent capabilities" (LM Studio `google/gemma-4-26b-a4b` is the only model endpoint).

## What runs where

- `run.mjs` — the driver. Phases, selected with `EVAL_PHASES` (default: all):
  - **download** — ticks Settings → General → Experimental → "Fast page control",
    waits for `Ready`, clicks "Run a test decision". The pinned Hugging Face URLs
    are 302'd to a local server over `scripts/export-von/out/`, so the real
    `downloadWeights` (manifest hash, per-file hashes, `cache.put`) runs unchanged.
  - **parity** — the exporter's golden cases (`src/system1/__fixtures__/von-golden.json`,
    fp32 reference logits) through the real `system1Worker.js` on WebGPU.
  - **kernels** — the same golden cases plus a synthetic 47-option page on a second
    worker booted with ORT's WebGPU profiler (`profile: true`, eval only): GPU time
    by kernel name, dispatch count, and two verdicts — a `FlashAttention` kernel
    present means the native EP ran fused attention, a `Memcpy` kernel present
    means a node fell back to the CPU. The unprofiled lab's `ms` is the latency.
  - **grounding** — `cases.json` on `fixtures/*.html`. `harness.ts` (bundled with
    esbuild and evaluated in an extension page) runs the real `runActLoop` for one
    step with the real `snapshotPage`, forcing only the *move* answer to `act`
    (recorded, not used) so the target question — including the `TARGET_CHUNK`
    tournament — is measured in isolation. Nothing on the page is clicked.
  - **llm** — the same state and full candidate list put to gemma, one chat
    completion per case, temperature 0.
  - **e2e** — a head-to-head on three tasks through the composer, approval cards
    auto-allowed, `EVAL_E2E_REPS` (default 3) runs per task per arm, arms interleaved
    per task. Arms (`EVAL_E2E_MODES`): `off` (the original: ControlPage only),
    `on` (toggle on, model free to choose `Act`), `forced` (toggle on + "Use the Act
    tool for the page actions." appended to the prompt — the only way to measure
    `Act` itself, since gemma never picks it unprompted). Success is read from the
    fixture page's own state, never from the model's answer. Per run: wall time
    (submit → turn stops streaming), LLM steps and tokens (from `turnTrace`), page
    actions (successful ControlPage calls + Act steps, from the saved transcript),
    Act calls and statuses, and Von decides / Von ms / engine boot ms (counted by a
    `Worker` wrapper installed with `addInitScript` — no `src/` change).
- `ep-placement.mjs` — node→execution-provider placement of the exported graph
  under onnxruntime-web's WebGPU EP (verbose ORT log), plus exact-id logits vs the
  golden fp32 reference. `node ep-placement.mjs [webgpu|wasm]`.
- `report.mjs` — the only writer of `report.json`: sections, a `runs` provenance list,
  and the verdict re-derived from data.

## Running it

The committed pin (`src/system1/weightsManifest.ts`) points at the published
act-head export, `ks-ang/von-browser-act`. To evaluate a local, not-yet-published
export, build an eval extension with the pin override (never commit a build). The
override is honoured only under `--mode system1-eval` — an ordinary build ignores
it:

```bash
VITE_SYSTEM1_PIN='{"repo":"local/von","revision":"local","manifestSha256":"<sha256 of out/manifest.json>"}' \
  npx vite build --mode system1-eval --outDir /tmp/dist-eval --emptyOutDir
EVAL_DIST=/tmp/dist-eval EVAL_PROFILE=/tmp/s1-profile \
  EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/run.mjs
EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/ep-placement.mjs webgpu
```

`EVAL_HEAD=single|lazy` (default single) must match the head the extension under
`EVAL_DIST` was built with (`VITE_SYSTEM1_HEAD`, honoured only under
`--mode system1-eval`) and the fine-tune under `EVAL_MODEL_DIR` was trained for
(`render.mjs --head`). `EVAL_PROFILE` reuses a browser profile so the 616 MB weights download once.
`EVAL_CHROMIUM` overrides the Chrome for Testing binary (branded Chrome ignores
`--load-extension`). If LM Studio is down, `llm` and `e2e` are skipped and say so.

`EVAL_PHASES=rederive` recomputes the summaries and verdict from the rows already
in `report.json`, with no browser and no model. `report.json` is written only by
`report.mjs`. Every invocation appends to its `runs` list the phases it produced, so
the file records which run each section came from.

## Results — 2026-10-02: the fast runtime (Plan A, same weights)

Spec `docs/superpowers/specs/2026-10-02-von-fast-act-design.md` §3, plan
`docs/superpowers/plans/2026-10-02-fast-act-runtime.md`. The act-head weights of
run B (`ks-ang/von-browser-act@7a0aeb2`'s `checkpoint/`), exported twice: the
published q8 graph, and the **fast graph** (`export.py --fast`: RoPE tables and
the two option masks as inputs built by `buildFastInputs`, one fused
`MultiHeadAttention` per layer, fp16 activations with fp32 islands at every
LayerNorm, the final norm and the scorer, T padded to a bucket). Apple GPU,
shader-f16 available; Chromium 151; `report.json` holds this run's download,
parity, grounding and placement — its `llm` and `e2e` sections are still run B's.

| | q8 (run B's graph) | f16 fast graph |
|---|---|---|
| download · boot | 620 MB · 1.6–1.8 s | 795 MB · 1.3 s |
| nodes on WebGPU · on CPU | 1,369 · 540 (RoPE/mask arithmetic, a sync per layer) | 1,207 · 420 (int64 shape math only, no Memcpy) |
| fused attention on WebGPU | 0 | 28 `MultiHeadAttention` |
| parity: CPU gate · WebGPU golden | 0.0098 · 0.0098 | 0.0035 (T refit 1.389→1.389) · 0.0264, 0 flips |
| decide ms, golden K = 2 / 3 / 5 / 5 (short) | 181–212 / 196–274 / 211–308 / 61–80 | **90 / 90 / 91 / 52** |
| decide ms, synthetic K = 47 (T≈1,100) | 854–1,206 | **320** |
| grounding (54 cases) | 50/54 = 0.926 | **50/54 = 0.926**, identical per case (50 right, the same 4 wrong) |
| decide p50 / p95 over the grounding run | 400 / ~584 | **98 / 205** (value head p50 56) |

(q8 ranges are its two `kernels` runs; f16 is one.) Every acceptance line of the
spec's runtime row holds: p50 ≤ 250 ms at K 15–20 (98), ≤ 450 ms at K = 47
(320), parity ≤ 0.03 on both EPs, grounding unchanged.

- **The profiler is silent on the native EP.** ORT Web 1.30's WebGPU EP (the
  asyncify bundle the worker loads) delivers nothing through
  `ort.env.webgpu.profiling.ondata`, session `enableProfiling` or the console, so
  the `kernels` phase reports latency by K and `ep-placement.mjs` (now
  shader-f16-aware) is the evidence for what runs where.
- **What is left on the CPU** is 15 int64 shape nodes per layer (Gather 5,
  Unsqueeze 4, Div 3, Concat/Add/Mul 1 each) building the reshape targets from
  `Shape` — no activation copies. A later cut could fold them into constant
  `[0, 0, 3, 16, 64]` reshape shapes.
- **Bucketing stays; graph capture was not pursued**: without per-kernel times
  there is no dispatch-overhead measurement to justify eight captured sessions,
  and the targets are met without it.
- **Not re-run:** `e2e` (needs LM Studio, ~35 min; the weights and every
  decision are unchanged, so only wall time would move).
- **Trade-off:** the download grows 616 → 792 MB (fp16 weights instead of 8-bit
  on 84 matmuls). An 8-bit-weight fast graph is untested; it would need its own
  parity gate, since 8-bit on every matmul failed it on the old graph.

## Results — 2026-09-30: the jev-ultrafast loop, and the single-pass act head

A study of [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(commit 1231850) found it scopes TypeSafe's Jev exactly as the candidate-action
`Act` scopes Von — the harness owns the action space, the model picks an
operation and a row — and that its 7 s Google Flights run comes from the loop
around the model: one request per decision, a 50–200 ms settle, no confidence
gate, the page text in the state, trusted input. Two rounds landed here
(plan: `docs/superpowers/plans/2026-09-30-jev-loop-rebuild.md`):

- **The loop** (commit 976f3f2): `settle: 'quick'` for a non-committing Act
  step (50 ms quiet / 250 ms cap; a typed combobox waits for `[role=option]`
  up to 400 ms) and the post-action snapshot reused as the next observation
  (two page reads per action, was three); `ACT_TRY_CONFIDENCE` 0.4 — a
  decision between it and 0.6 is *tentative*, executed only when
  `controlStep` finds it is not a point of no return; three consecutive
  non-WAIT `no_change` steps end the call; WAIT may repeat once; the engine
  boots on the page-control grant; `checked`/`disabled` join the stale
  check; `BLOCKED`/`MISSING_USER_DATA` names the field. Then (commit f8db84f)
  a would-be repeat excludes that (operation, target) from the space and asks
  the policy once more before ending the call.
- **The single-pass act head** (commit d2f9b27): `createVonActPolicy` asks
  ONE question over every (control, action) pair plus the global moves, state
  without the control list — one Von pass per click step (was two), value
  head for a field. `src/system1/head.ts` selects it (default) or the lazy
  policy; `render.mjs --head act` renders its training rows through the same
  functions.

### Run A — the existing fine-tune (lazy heads) on the new loop, before the exclusion retry

`EVAL_PHASES=download,e2e`, the second fine-tune's export (manifest
`33e4bc66…`, lazy-format rows), `EVAL_HEAD=lazy`, 06:31–07:04 UTC. The 27th
run (dialog/forced rep 2) was lost to the harness: the panel's `page.reload()`
hung past 30 s and run.mjs crashed before writing its report (now caught —
`reloadPanel` falls back to a fresh navigation and a thrown run becomes a
`harness-error` row). The 26 rows below are re-derived from the log; the Act
messages were recovered from the profile's IndexedDB.

| arm | success | wall median | LLM steps median | tokens median | page actions / run | Act calls → statuses → actions | Von passes / ms |
|---|---|---|---|---|---|---|---|
| off | 9/9 | 46 s | 9 | 35.1k | 3.0 | — | — |
| on | 5/9 | 36 s | 8 | 29.7k | 0.9 | 0 | — |
| forced | 5/8 | 90 s | 12 | 64.0k | 3.8 | 14 → done 4, uncertain 3, repeat 7 → 23 actions | 70 / 44.9 s (one 26 s stall; the other 65 average 290 ms) |

Per task, forced arm (success · wall · Act):

| task | rep 0 | rep 1 | rep 2 |
|---|---|---|---|
| form | ✓ 196 s · 5 calls, 10 actions | ✗ 167 s · 3 calls, 8 actions | ✓ 89 s · 2 calls, 8 actions |
| shop | ✗ 49 s · never called | ✓ 42 s · 1 `done` | ✓ 91 s · 1 `done` (the 26 s Von stall) |
| dialog | ✓ 47 s · 2 `done`, 2 actions | ✗ 122 s · never called | lost (harness) |

- **Where the model is competent, the Act penalty is gone.** Dialog rep 0:
  both clicks by `Act`, two `done` calls, 47 s against the off arm's 50 s on
  the same rep (the 27 Sep forced arm was 5–35 s slower than off on every
  task). Shop rep 1: one `done` call, 42 s vs 46/28/30 s off. Six Von passes
  for two actions.
- **Forms: Act now acts, but one field per call.** Every form call typed one
  value and then chose the *same field again* ("would repeat TYPE_TEXT on [4]
  twice in a row", 4×), re-typed a value the field already held
  (`no_change`, 2×), or said "possibly done" at p 0.51–0.59 (3×) — the lazy
  fine-tune's known mid-form weakness (its rows have no multi-field
  trajectories). Each hand-back cost a chat-model turn, which is why forced
  form runs are 89–196 s for 8–10 actions. That is what the exclusion retry
  (f8db84f) targets: the first repeat now narrows the space and asks again.
- **Every `on`/forced failure with 0 Act calls is the chat model's** (never
  opens a session, loops on "no session"): on 0/3 on the form, dialog/forced
  rep 1. Unchanged from every earlier run.
- **One 26 s Von pass** in shop/forced rep 2 (5 passes, 26.1 s) while LM
  Studio was generating; the other 65 forced-arm passes took 18.7 s. Not seen
  before; watch for it in run B.

### Run B — the act-head fine-tune, single-pass head, new loop with the retry (its rows are `report.json`'s `llm` and `e2e`)

`scripts/von-finetune/render.mjs --head act` on the same 4,921 episodes (2,743
train / 363 val rows), 3 epochs on the M4 Max (72.7 min; best at step 250, val
top-1 0.939, coverage 0.939 at the 0.6 gate with 0.971 on the covered), export
q8 (manifest `fb63645a…`, parity gate CPU max|Δp| 0.0098). `EVAL_HEAD=single`.
Parity, grounding and the LLM baseline ran 08:18–08:24 UTC; the e2e phase then
hung on the panel reload (see the note below) and was rerun 08:52–09:22 UTC
with one browser context per run. Compared with the lazy fine-tune's numbers
from 27 Sep (its harness had the old loop):

| | lazy fine-tune (27 Sep) | **act-head fine-tune, single pass** | gemma (this run) |
|---|---|---|---|
| grounding top-1 | 52/54 = 0.963 | **50/54 = 0.926** (shop 23/23 · form 15/16 · dialog 12/15) | 51/54 = 0.944 |
| operation implied | 51/54 above the gate (a separate head) | 50/54 correct in the same pass (CLICK 44, TYPE_TEXT 5, SELECT_OPTION 3; BLOCKED 2×, wrong) | |
| target above 0.6 · accuracy · confident-but-wrong | 51/54 · 0.961 · 2 | 46/54 · 0.935 · 3 (at 0.4: 52/54 · 0.923 · 4) | |
| Von passes per click step | 2 (operation ~256 ms + target ~222 ms; shop tournament 641 ms) | **1** (p50 400 ms; shop 817 ms, 47 options in one pass; value head 250 ms) | 1.7 s per completion |
| WebGPU parity · boot | 0.0073 · 1.2 s | 0.0098, 0 flips · 1.27 s | |

The four grounding misses: two "subscribe to the newsletter" goals (one
`BLOCKED` at p 0.99, one clicking Subscribe instead of typing the email),
"write the message" (clicked Send at 0.87), and one `BLOCKED` at 0.55 on the
dialog page. The single head's calibrated tops scale with the option count
(p50 0.96 overall, but 0.36–0.50 on several 47-option shop cases), which is
what the 0.4 try line is for.

| arm | success | wall median | LLM steps median | tokens median | page actions / run | Act calls → statuses → actions | Von passes / ms |
|---|---|---|---|---|---|---|---|
| off | 9/9 | 38 s | 9 | 35.8k | 3.0 | — | — |
| on | 8/9 | 31 s | 8 | 29.8k | 2.3 | 0 | — |
| forced | 6/9 | 56 s | 10 | 38.5k | 2.2 | 18 → done 9, error 6, parked 2, uncertain 1 → 11 actions | 35 / 18.2 s (520 ms avg) |

Per task, forced arm (success · wall · Act):

| task | rep 0 | rep 1 | rep 2 |
|---|---|---|---|
| form | ✓ 207 s · 7 calls: 6 `error`, 1 `done` | ✗ 145 s · never called | ✗ 116 s · `done`, `uncertain`, `done` (5 actions; a premature `done`) |
| shop | ✓ 47 s · parked, then 1 `done` | ✗ 56 s · never called | ✓ 37 s · 1 `done` |
| dialog | ✓ 45 s · 1 `done`, both clicks | ✓ 29 s · parked, then 1 `done`, both clicks | ✓ 73 s · 2 `done` |

- **One pass per step works end to end.** Dialog forced: all three runs, both
  clicks by `Act` in ONE call (2 passes, 0.7–1.4 s), `done` on its own; rep 1
  at 29 s is the fastest dialog run of the day (off 38 s median). Shop: the one
  correct click at p 1.0.
- **The six `error` calls are one bug, now fixed structurally.** All in form
  rep 0: the head chose the Topic dropdown (`6:SELECT_OPTION`, nine training
  rows) six calls running and the value head handed it a key whose text
  matched no option ("no option matching «Message»"), so `selectOption`
  failed and each refusal ended the call. Commit 9d65d5b makes a refused
  action a `failed` step that excludes that (operation, target) for the rest
  of the call (`MAX_FAILED_ACTIONS` 2), so the next decision must be another
  control. **Verified** 10:27–10:36 UTC (`EVAL_E2E_TASKS=form
  EVAL_E2E_MODES=forced`, 3 reps, same profile and weights): form/forced
  **3/3** (run B 1/3, run A 2/3), zero `error` calls; 11 / 4 / 3 `Act` calls
  performing 8 / 3 / 4 actions (36 / 16 / 12 Von passes) in 204 / 161 / 117 s.
  What remains are low-confidence terminal answers ("possibly done" 0.43,
  "possibly blocked" 0.41–0.45, "unsure of the next operation" 0.36–0.38) that
  hand back to the chat model, and one correct refusal of a committing step
  (Click "Send message" at p 0.59 — the tentative band working as designed).
  The data fix (more `SELECT_OPTION` rows, option enumeration) stands.
- **Forms still hand back or over-claim.** Rep 2's `done` after one field was
  sealed by the chat model despite the description now asking it to re-read;
  rep 1 never called `Act` (the chat model's no-session loop, also 2 of the 3
  `on`-arm failures across runs A and B).
- **Warm-on-grant is hidden but not free.** The engine now boots on the
  page-control grant, concurrently with the chat model's next generation:
  10–35 s under that GPU contention (1.27 s alone), paid in every `on`-arm run
  too. The `on` arm is nevertheless the fastest arm (31 s median), so the
  contention cost is small; a forced run's first `Act` call still waits for
  it when the grant was recent.
- **Harness note.** In three attempts on two builds the panel's
  `page.reload()` (and a fresh `goto` on the same page) hung past 30 s after a
  chat turn, while a clean profile reloads in 100 ms; a replacement page
  became the active tab and the chat bound to itself. `run.mjs` now launches
  one persistent context per e2e run (weights cached in the profile) and
  retries a run once on a hung reload; cause not found.

**Decision.** The single-pass head grounds within two cases of the lazy pair
of heads (0.926 vs 0.963; the LLM 0.944) at one pass per click step, and the
loop changes remove the `Act` wall-time penalty where the model is competent
(dialog 45 s vs 38 s off, with the fastest run of the day). Forced-arm success
is 6/9 (run A 5/8, 27 Sep 5/9); every forced failure is a form (the
`SELECT_OPTION` data gap, a premature `done`, or the chat model never calling
`Act`). Stays behind the toggle. Next: `SELECT_OPTION` and multi-field form
episodes, option enumeration for dropdowns, and page text in the state (all
need a re-collect); the chat model must re-read after `done`.

## Results — 2026-09-27: the candidate-action representation, base Von

Same fixtures, same 54 cases, same model (`von-1.2.0` q8, the pinned base weights —
not the fine-tune), same machine and Chrome for Testing 151. What changed is the
harness: `Act` now runs on the candidate-action layer
(`docs/superpowers/specs/2026-09-26-candidate-action-act-design.md`) — the finite
space is built before any question, the policy answers `operation` → `target_<OP>`
→ `value`, membership is validated, and `harness.ts` forces the operation head to
the expected element's operation so the target head is measured in isolation.
Two renderings were run back to back; the second is what ships.

### Variant 1 — control list in every head's prefix (commit 865aa8c; report at 729f070)

Doc §18 taken literally: the state block every question shares listed the
(ranked, capped at 60) controls, so a target option could "see" its siblings.

| | old format (26 Sep) | variant 1 | gemma-4-26b-a4b |
|---|---|---|---|
| grounding top-1 | 37/54 = 0.685 | **26/54 = 0.481** | 48/54 = 0.889 |
| shop / form / dialog | 13/23 · 13/16 · 11/15 | 9/23 · 8/16 · 9/15 | |
| tournament cases correct | — | 7/21 | |
| first head correct | 12/54 (`act`) | **43/54** (`CLICK` 53×, `BLOCKED` 1×; expected CLICK 44, TYPE_TEXT 7, SELECT_OPTION 3) | |
| first head above the 0.6 gate | 0/54 (max 0.55) | 8/54 (p50 0.43, max 0.70) | |
| target above the gate · accuracy on those | 36/54 · 0.694 | 11/54 · 0.636 | |
| decide ms p50 / p95 (all heads) | 96 / 488 | **1018 / 1939** | |
| target pick per case p50 / p95 | 204 / 643 | 778 / 5405 (shop median 4449) | 3168 / 15131 |
| expected control in the candidate set · shown · rank p50 | — | 54/54 · 54/54 · 1 (max 11) | |

- **Candidate generation is not the problem.** The right control was a target of
  the forced operation in all 54 cases and shown in the state block in all 54;
  the lexical ranker put it first in 47 (all 7 rank>1 are form fields whose goal
  wording does not overlap the label, e.g. "fill in the message" vs "Your message").
- **The operation head is fixed by the representation.** With the controls in
  its prefix it answers `CLICK` where the old move question answered
  `scroll_down` 40/54 times. It is still under the gate in 46/54 cases.
- **The target head got worse and ~10× slower, for one reason.** Every head's
  prefix carried the ~40-line control list: each pass cost ~10× the tokens
  (target p50 1258 ms vs 78 ms), and a target option's own line was drowned among
  copies of its siblings — Von's option marker attends to the prefix and itself,
  so 40 near-identical "Add … to cart" lines in the prefix are noise, not context.
  Both kill conditions met: p50 1018 ms > 300 ms; 0.481 clearly below 0.889.
- **e2e** (3 tasks × 3 reps × 3 arms): off 6/9 · on 5/9 · forced 6/9 (medians
  58 s / 41 s / 62 s). Forced arm: 15 `Act` calls, 14 `uncertain` + 1 error,
  **3 Act actions in total** (the first real ones — previously 0), all before an
  `uncertain` hand-back. Every success is still gemma's via ControlPage.

### Variant 2 — control list in the operation head only (commit dac560c; report at 0f50115) — **ships**

A target head's options ARE the controls, so its state carries goal, page, state
line, value keys and recent actions only; the operation head (whose options carry
no context of their own) keeps the list.

| | old format (26 Sep) | variant 1 | **variant 2** | gemma-4-26b-a4b |
|---|---|---|---|---|
| grounding top-1 | 37/54 = 0.685 | 26/54 = 0.481 | **48/54 = 0.889** | 48/54 = 0.889 |
| shop / form / dialog | 13/23 · 13/16 · 11/15 | 9/23 · 8/16 · 9/15 | **21/23 · 14/16 · 13/15** | |
| tournament cases correct | — | 7/21 | **19/21** | |
| target above the 0.6 gate · accuracy on those · confident-but-wrong | 36/54 · 0.694 · 11 | 11/54 · 0.636 · 4 | **46/54 · 0.913 · 4** | |
| first head correct · above the gate | 12/54 · 0/54 | 43/54 · 8/54 | 43/54 · 8/54 (p50 0.43, max 0.70) | |
| value key (asked only past the gate) | 8/9 | 4/5 | 5/6 | |
| decide ms p50 / p95 (all heads) | 96 / 488 | 1018 / 1939 | **222 / 586** (operation 256, target 222, value 67) | |
| target pick per case p50 / p95 | 204 / 643 | 778 / 5405 | **222 / 662** (shop median 641 = tournament) | 1787 / 11912 |
| worker boot · Settings test decision | 1.6 s · 59 ms | 2.0 s · 171 ms | 1.9 s · 57 ms | |

Threshold sweep (target head, final round):

| ACT_CONFIDENCE | coverage | accuracy on answered | confident-but-wrong |
|---|---|---|---|
| 0.4 | 0.963 | 0.904 | 5 |
| 0.5 | 0.907 | 0.918 | 4 |
| 0.6 | 0.852 | 0.913 | 4 |
| 0.7 | 0.630 | 0.941 | 2 |
| 0.8 | 0.426 | 0.957 | 1 |

- **Grounding is now level with the chat LLM, zero-shot.** 0.889 vs gemma's 0.889
  on identical candidate lists, up from 0.685 on the old rendering. The
  tournament, which lost most shop cases before, wins 19/21: the ranked order puts
  the goal's lexical matches in one chunk and Von discriminates well among them.
  The 6 misses: two green-variant confusions on the shop page (green Fjord bowl →
  green Nimbus tote), two checkbox/newsletter goals grounded to the nearby field or
  submit, and two dialog-page goals grounded to "Manage preferences" at p<0.5.
- **Latency is back under the line.** p50 222 ms across heads; the operation head
  costs ~250 ms because its prefix carries the control list, a target pass ~80 ms.
- **The operation head is the binding constraint, and it did not move between
  variants** (identical: it saw the same prefix in both). It answers `CLICK` in
  53/54 cases — right for the 44 CLICK cases (0.80 overall), wrong for every field
  case (TYPE_TEXT 7, SELECT_OPTION 3) — at p50 0.43, with the wrong answers at the
  same confidence as the right ones, so no threshold separates them. Zero-shot Von
  has no notion of "type into a field" as a *move*; the fine-tune's structural move
  labels are what target this.
- **e2e** (3 tasks × 3 reps × 3 arms): off 8/9 · on 8/9 · forced 7/9 (medians
  35 s / 36 s / 67 s). Forced arm: 13 `Act` calls, 11 `uncertain` (all on the
  operation head, 1–2 Von passes each) and 2 refused because gemma called `Act`
  before `RequestPageControl`; **1 Act action in total**. Success is gemma's via
  ControlPage in every arm.

**Decision (spec §10).** The representation wins on grounding and latency (both
kill conditions lifted: 222 ms, 0.889 = LLM) and fails on the operation gate
(8/54), so `Act` still hands back on its first head. Two follow-ups, cheapest
first: (1) fold the operation choice into the target head (one question: the
controls plus the four global moves, the operation implied by the chosen
control's kind) and re-run `grounding`; (2) re-target `scripts/von-finetune/render.mjs`
to `vonPolicy.ts`'s exported renderers (`renderState`, `operationQuestion`,
`targetQuestion`, `valueQuestion`) and retrain — the episode labels transfer by
construction (`act` → the target's own operation, `scroll_down` → `SCROLL_DOWN`,
`DONE`/`BLOCKED` unchanged), ~1 h/epoch on the Mac. The 26 Sep fine-tune was
trained on the old rendering and is measured on this harness below.

### The 26 Sep fine-tune on the new harness (old-format training, zero re-rendering)

`EVAL_MODEL_DIR` pointed at the `von-finetune` worktree's export
(`scripts/von-finetune/data/onnx`, manifest `63f7e93d…`, calibration refit to
T=1.266 with no map): Von 1.2 continue-trained for 3 epochs on 4,753 rows rendered
through the **old** builders (`actState`/`moveState`/`describe()`), val acc 0.94.
It was never shown this rendering, so this measures transfer. Parity was skipped
(the golden fixtures are the base weights'); the LLM baseline is model-independent.

| | base Von, variant 2 | **fine-tune, variant 2** | gemma-4-26b-a4b |
|---|---|---|---|
| grounding top-1 | 48/54 = 0.889 | **53/54 = 0.981** | 48/54 = 0.889 |
| shop / form / dialog | 21/23 · 14/16 · 13/15 | **22/23 · 16/16 · 15/15** | |
| tournament cases correct | 19/21 | **20/21** | |
| target above the 0.6 gate · accuracy · confident-but-wrong | 46/54 · 0.913 · 4 | **52/54 · 0.981 · 1** | |
| operation head correct · above the gate · both | 43/54 · 8/54 · 8 | **48/54 · 42/54 · 40** (p50 0.98, max 0.995) | |
| operation choices | CLICK 53, BLOCKED 1 | CLICK 50, TYPE_TEXT 3, SELECT_OPTION 1 | |
| value key (asked past the gate) | 5/6 | 9/10 | |
| decide ms p50 / p95 · target pick p50 / p95 | 222 / 586 · 222 / 662 | 220 / 583 · 220 / 657 | |

- **The old-format fine-tune transfers.** The control lines it trained on
  (`[N] button "…" → click`) are close enough to `renderControl`'s that grounding
  reaches 0.981 and the target gate passes 52/54 with one confident miss ("add
  the green mug" → the green tote; the page has no green mug, so arguably right).
- **The operation head clears the gate where it was trained to** — every CLICK
  case at p≈0.98 — **and not where it was not.** Its 6 misses are all field cases
  answered `CLICK` at p 0.38–0.67 (TYPE_TEXT ×4, SELECT_OPTION ×2): the training
  rows labelled these `act`, a move that no longer exists, so "type into a field"
  as an *operation* is out of distribution. On the form page the head's p50 is
  0.41 against 0.98 elsewhere. That is the case for re-rendering the dataset
  through `vonPolicy.ts`'s renderers and retraining (labels transfer by
  construction) — a targeted gain on field operations, not a prerequisite for
  `Act` to act at all.

### Fine-tune + the shipped loop, end to end (commit 240ac57; `report.json` is this run)

The first fine-tune e2e exposed a loop bug the base model could never reach: one
"Add to cart" click changed the cart badge (a new observation hash), the policy
never answered `DONE` (its DONE rows were all typed-field cases), and the
hash-aware repeat rule let it click the same button five times — five approval
cards, five items, `capped`, task failed. The old "same element action twice in
a row" guard is restored beside the hash rule (a different value key into the
same field is the one legitimate consecutive repeat; a stale step does not count).
This run is the fine-tune on that loop, all phases but parity, 17:27–17:58 UTC.

Grounding re-run: 52/54 = 0.963 (shop 22/23, form 16/16, dialog 14/15; the extra
miss is "subscribe to the newsletter" → "Manage preferences" at p=0.34, under the
gate), operation gate 42/54 as before, p50 219 ms. gemma 48/54 = 0.889.

| arm | success | wall median | LLM steps median | tokens median (mean) | page actions / run | Act calls → statuses → actions | Von decides / ms | cards / run |
|---|---|---|---|---|---|---|---|---|
| off: ControlPage only | 7/9 | 37 s | 9 | 36.4k (43.1k) | 2.9 | — | — | 3.1 |
| on: model's choice | 8/9 | 38 s | 9 | 36.5k (44.1k) | 2.3 | 0 | 0 | 3.2 |
| forced: "use Act" | 7/9 | 49 s | 10 | 36.5k (50.6k) | 1.7 | **12 → repeat 4, uncertain 8 → 9 actions** | 45 / 13.5 s | 2.8 |

Per task, forced arm (success · wall · LLM steps · Act):

| task | rep 0 | rep 1 | rep 2 |
|---|---|---|---|
| shop | ✓ 40 s · 7 · 1 action, `repeat` | ✓ 35 s · 5 · 1 action, `uncertain` | ✓ 44 s · 7 · 1 action, `uncertain` |
| dialog | ✓ 72 s · 10 · 2 actions, `uncertain`+`repeat` | ✓ 52 s · 7 · 2 actions | ✓ 47 s · 10 · 2 actions |
| form | ✗ 49 s · 11 · Act never called | ✗ 105 s · 19 · Act never called | ✓ 191 s · 29 · 3 calls, all `uncertain`, 0 actions |

- **`Act` now performs the decisive actions on click tasks.** Shop 3/3: the one
  correct "Add Aurora mug (blue)" click, then a clean stop. Dialog 3/3: "Reject
  non-essential" then "Add Nimbus tote (green)", then a clean stop. 9 Act
  actions across 12 calls, against 0 in 21 calls on 26 Sep and 1 in 13 with base
  Von on this harness. gemma still chose `Act` on its own in 0/9 `on` runs.
- **It does not yet make a task faster.** Forced wall medians are 5–35 s above
  the `off` arm: the engine cold-boots inside the first `Act` call of each panel
  load (1.8–6 s), each Act step still raises the same point-of-no-return card,
  and the chat model re-reads the page and verifies after every hand-back. LLM
  steps did drop on the shop task (5–7 vs 7–11).
- **Forms are the gap, exactly where grounding said.** Two forced form failures
  are gemma's (it never called `Act`, never opened a session — the known loop);
  the third call `Act` three times and got `uncertain` each time: the operation
  head answers `CLICK` at p≈0.4 on field cases because its training labels were
  `act`, so it hands back before typing. `repeat` also ends a call after each
  action, so a multi-step sub-goal costs one call per action for now.

**Decision.** Both 26 Sep kill conditions are lifted on this harness (p50 219 ms;
grounding 0.963 fine-tuned / 0.889 base vs 0.889 LLM), and `Act` acts. It stays
behind the experimental toggle: it adds wall time rather than removing it, and
it cannot fill a form. Next, in order: (1) re-render the fine-tune rows through
`vonPolicy.ts`'s renderers and retrain, so field operations and `DONE`-after-
click are in distribution (labels transfer by construction; ~1 h/epoch);
(2) keep the engine warm across a chain rather than booting inside the first
call; (3) consider a single target-or-move head to cut a step to one pass.

### The second fine-tune — trained on the candidate-action rows (its rows are `report.json`'s `llm` and `e2e`)

`scripts/von-finetune/` re-rendered the same 4,921 episodes through `vonPolicy.ts`'s
renderers (labels transfer by construction) and continue-trained base Von 1.2 for
3 epochs (62 min, best step 200, val top-1 0.958; the `operation` head alone went
0.508 → 0.963 with 98% coverage). Export q8, manifest `33e4bc66…`, parity gate
passed (CPU max|Δp| 0.0073; WebGPU 0.0073, 0 flips against its own golden). All
phases, 19:14–19:43 UTC.

| | base, new harness | old-format fine-tune | **second fine-tune** | gemma |
|---|---|---|---|---|
| grounding top-1 | 0.889 | 0.963–0.981 | **0.963** (22/23 · 15/16 · 15/15) | 0.907 (49/54) |
| tournament cases correct | 19/21 | 20/21 | 20/21 | |
| target above the 0.6 gate · accuracy · confident-but-wrong | 46/54 · 0.913 · 4 | 52/54 · 0.981 · 1 | 51/54 · 0.961 · 2 | |
| operation correct · above gate · both | 43 · 8 · 8 | 48 · 42 · 40 | **46 · 51 · 45** (p50 0.999) | |
| operation answers | CLICK 53 | CLICK 50, TYPE_TEXT 3 | **CLICK 39, TYPE_TEXT 14**, BLOCKED 1 | |
| value key (asked past the gate) | 5/6 | 9/10 | 8/10 | |
| decide p50 / p95 · target pick p50 / p95 | 222 / 586 · 222 / 662 | 220 / 583 · 220 / 657 | 220 / 584 · 221 / 659 | 2101 / 14484 |

| arm | success | wall median | LLM steps median | tokens median (mean) | Act calls → statuses → actions |
|---|---|---|---|---|---|
| off | 8/9 | 35 s | 9 | 34.2k (37.5k) | — |
| on | 9/9 | 34 s | 8 | 29.5k (39.1k) | 0 |
| forced | 5/9 | 54 s | 8 | 37.5k (47.7k) | **9 → done 7, uncertain 2 → 8 actions** |

Forced arm per task (success · wall · Act): shop ✗ 49 s · 1 action, `done` — the
**green** Aurora mug (grounding case 0's confident miss, p=0.998) and the chat model
trusted `done` · ✓ 59 s · `uncertain` · ✗ 57 s · Act never called; dialog ✓ ✓ ✓
(42 / 54 / 47 s, each 2 actions in 2 `done` calls); form ✓ 89 s · 1 action then
`uncertain` · ✗ 86 s · never called · ✗ 24 s · never called.

- **Field operations are in distribution now.** The operation head answers
  `TYPE_TEXT` where the old fine-tune said `CLICK`, and clears the gate on 51/54
  cases (was 42, base 8). Its 8 misses are the mirror image: 3 `SELECT_OPTION`
  cases answered `TYPE_TEXT` (11 training rows for that operation) and 4 form
  goals whose target is a checkbox or the submit button answered `TYPE_TEXT`
  because values were supplied. More labelled `SELECT_OPTION` and
  click-with-values-present episodes is the data fix.
- **`DONE` after a click works.** Every dialog call ended `done` on its own after
  its two clicks; no `repeat` stops were needed. The other side of that: on the
  shop task a confident wrong click (green for blue, a variant-disambiguation
  miss the old fine-tune did not make) was sealed by a `done` the chat model
  accepted without re-reading the cart. The verifier is the chat model by design;
  it should re-read after `done`, not before.
- **Three of the four forced-arm failures are gemma never calling `Act`** (0 calls,
  the "no session" loop) — the same chat-model failure every run has shown, and
  the reason the `on` arm (9/9) beats `forced`. Where `Act` was called, 7/9 calls
  ended `done` and 8 actions ran in 8.0 s of Von time across the arm.
- Latency unchanged (p50 220 ms); the engine now boots in 1.2 s.

**Decision.** The candidate-action representation plus a fine-tune rendered
through the same builders lifts every measured number except one: 0.963 grounding
vs 0.907, operation gate 51/54, `Act` completing click sub-goals with `done`.
Still experimental: the chat model must verify after `done` (a re-read of the
page is one ControlPage call), variant disambiguation needs data, and forms end in
`uncertain` after one field. Next data round: `SELECT_OPTION` and
click-with-values episodes, longer form trajectories, and colour/size-variant
goals on product grids.

## Results — 2026-09-26 (UTC 2026-09-25)

`report.json` is produced by one full run, `run.mjs` with all phases, 19:37–20:10 UTC.
It is followed by `ep-placement.mjs webgpu` and `wasm`, then a `rederive` (see its
`runs`). An earlier replicate head-to-head, 18:4x–19:35 UTC the same day, is kept in
commit `a2aeb26`'s `report.json`. Its numbers appear below as the "replicate" rows.

Setup:
- Model `von-1.2.0` q8 (`model_q8.onnx`, 616 MB, int8 MatMulNBits weights, fp32
  activations; manifest sha256 `6e2fb20c…4236d9`).
- Google Chrome for Testing 151, macOS, WebGPU adapter `apple / metal-3`,
  onnxruntime-web 1.30.0.
- LM Studio was up throughout, and nothing was skipped.

### Von vs the original (ControlPage only), end to end

Same 3 tasks, same fixtures, same model, 3 runs per task per arm. Medians, because
one forced-arm run looped for 342 s / 68 steps / 548k tokens and would dominate a mean.

| arm | success | wall median | LLM steps median | tokens median (mean) | page actions / run | Act calls → non-done → actions | Von decides / ms | approval cards / run |
|---|---|---|---|---|---|---|---|---|
| **off**: original | 6/9 | 40 s | 9 | 36.6k (41.0k) | 1.6 | — | — | 2.7 |
| on: toggle, model's choice | 8/9 | 37 s | 10 | 36.0k (48.2k) | 2.9 | 1 → 1 → 0 | 1 / 0.1 s | 3.4 |
| forced: toggle + "use Act" | 7/9 | 49 s | 9 | 37.4k (97.3k) | 1.7 | 7 → 7 → 0 | 7 / 0.8 s | 2.9 |
| *replicate* off | 8/9 | 36 s | 9 | 32.2k | 2.9 | — | — | 3.2 |
| *replicate* on | 5/9 | 37 s | 12 | 46.1k | 1.2 | 0 | 0 | 2.2 |
| *replicate* forced | 9/9 | 51 s | 11 | 44.1k | 3.0 | 13 → 13 → 0 | 14 / 1.7 s | 3.6 |
| **both sessions: off / on / forced** | **14 / 13 / 16 of 18** | **38 / 37 / 49 s** | 9 / 10 / 9 | 34.8k / 38.5k / 42.7k | 2.2 / 2.1 / 2.3 | **21 → 21 → 0** | 22 / 2.7 s | |

Per task, this run (success · median wall · median tokens):

| task | off | on | forced |
|---|---|---|---|
| form (4 fields + consent + submit) | 1/3 · 52 s · 49k | 3/3 · 69 s · 66k | 1/3 · 40 s · 35k |
| shop (1 of 36 variant buttons) | 2/3 · 28 s · 35k | 2/3 · 29 s · 34k | 3/3 · 43 s · 37k |
| dialog (cookie wall, then add) | 3/3 · 39 s · 33k | 3/3 · 35 s · 33k | 3/3 · 53 s · 43k |

- **`Act` never performed a page action.** Across both sessions it was called 21
  times and returned `uncertain` with 0 steps all 21 times. Every "unsure of the next
  move" was below `ACT_CONFIDENCE` 0.6: 0.34–0.57 in this run, and 0.32–0.60 plus
  one target-question stop at 0.57 in the replicate. Every page action in the `on`
  and `forced` arms was a ControlPage call the chat model made after `Act` handed
  back.
- Where the model used `Act`, the only effect was extra time: the forced median is
  9–15 s slower than `off` (49 vs 40 s here, 51 vs 36 s in the replicate). Von's own inference is small
  (0.1 s per decide), but its engine cold-boots inside the first `Act` call of each
  panel load: 5.3–8.6 s, with one 14.7 s outlier, while an LM Studio generation
  competed for the GPU.
- **Success rates are gemma's, not Von's.** Every failed run in every arm, in both
  sessions, is the same chat-model error: gemma called ControlPage without ever
  calling `RequestPageControl`, looped on the "no session" error, then gave up. The
  arm ranking flips between sessions (off 8/9 → 6/9, on 5/9 → 8/9), which is the
  signature of noise at n=3. `Act` cannot have raised success anywhere, because it
  never acted. In this run gemma ignored the "use Act" instruction on all 3 forced
  form runs.
- **Approval cards:** every successful run in every arm showed exactly the expected
  point-of-no-return card(s): "Click “Send message”" ×5, "Click “Add Aurora mug (blue)
  to cart”" ×7, "Click “Reject non-essential”" ×9 and "Click “Add Nimbus tote (green)
  to cart”" ×9, for 5, 7 and 9 successful runs respectively. Each came after one "Let
  the agent control …" card. `Act` added none. Failed runs show fewer cards because
  they never reached page control.

### Component-level numbers

**Execution-provider placement** (`ep-placement.mjs webgpu`):
- **84/84 MatMulNBits nodes run on WebGPU**, and ORT logged 1008 `MatMulNBits` WebGPU
  programs over 12 runs.
- The engine lists only the `webgpu` EP. Session creation **succeeded**, and ORT
  **partitioned** 540 of 1909 nodes onto its implicit CPU EP; none failed. Those 540
  are its "fallback CPU capability" choice for small int64 shape subgraphs: Gather
  201, Unsqueeze 122, Div 84, Concat 57, Add 28, Mul 28, Equal 5, Or 4, … plus 11
  MemcpyFromHost / 4 MemcpyToHost.
- The same probe on the `wasm` EP puts all 1814 nodes on CPU. It takes a 3977 ms
  median per golden case vs 176 ms on WebGPU (both with verbose logging on), so the
  latency numbers here really are GPU numbers.

**WebGPU parity** (4 golden cases vs the fp32 reference):
- Max |Δ calibrated p| is **0.0024** (per case 0.0002 / 0.00017 / 0.00098 / 0.00243),
  with **0** argmax flips. Max |Δ logit| with the exact golden ids is 0.043.
- The exporter's CPU check of the same q8 graph was 0.0236 over 9 probes. 4 cases is
  a thin sample.

**Boot and download:**
- On a fresh profile, Settings download reached "Ready · 620 MB" in 2.6 s. That was
  from localhost, so it is not a network figure, but it includes hashing 616 MB.
- Worker boot (Cache Storage → session → warm-up) takes 1.6 s in an eval page, and
  5.3–14.7 s inside the panel during e2e.
- Settings "Run a test decision" returned `Picked [2] with p=0.76 in 59 ms`.

| decide() ms | p50 | p95 |
|---|---|---|
| all calls (n=164) | 96 | 488 |
| move question | 98 | 110 |
| target question (single call) | 78 | 491 |
| whole target pick per case (incl. tournament) | 204 | 643 |
| gemma, one completion per grounding case | 1821 | 8374 |

**Grounding** (54 cases on 3 pages, same element lists for both; top-1 target):

| | Von | gemma-4-26b-a4b |
|---|---|---|
| all | **37/54 = 0.685** | **48/54 = 0.889** |
| shop (42 candidates → tournament) | 13/23 | — |
| form | 13/16 | — |
| dialog | 11/15 | — |

The replicate session scored Von 40/54 (0.741) and gemma 49/54 (0.907) on identical
inputs. Von's differences were all in tournament cases, so WebGPU results are not
bit-stable across sessions.

- **Move question:** the correct move is `act` in all 54 cases. Von chose
  `scroll_down` 40×, `act` 12×, `BLOCKED` 1× and `WAIT` 1×. Its calibrated top never
  reached `ACT_CONFIDENCE` (p50 0.37, max 0.55): **0/54 cases clear the loop's first
  gate**, which matches the e2e result.
- **Tournament:** the 42 shop candidates split 40 + 2. The chunk holding the right
  button picked it in 14/23. The final round then often preferred the header "Cart"
  link, or the degenerate 2-option chunk's winner.
- **Checkbox:** `describe()` renders an unchecked checkbox as `(currently "on")`,
  because an `<input type=checkbox>`'s `.value` is "on" regardless of `checked`. Von
  then picks "Send message" for "tick the consent box" with p=0.98.
- **Value key** (asked only when the target cleared the gate): 8/9.

**Threshold sweep** (target question, final round's calibrated top):

| ACT_CONFIDENCE | coverage | accuracy on answered | confident-but-wrong |
|---|---|---|---|
| 0.4 | 0.981 | 0.679 | 17 |
| 0.5 | 0.907 | 0.673 | 16 |
| 0.6 | 0.667 | 0.694 | 11 |
| 0.7 | 0.519 | 0.750 | 7 |
| 0.8 | 0.352 | 0.789 | 4 |

No threshold reaches LLM-level accuracy, and raising it trades coverage for a few
points. Keep 0.6. The binding constraint is the move question: lowering the gate
there would mostly make `Act` scroll instead of act.

**Kill criterion (spec §9): met.**
- Latency is fine: p50 96 ms, well under 300 ms, and genuinely on the GPU.
- But Von's grounding is clearly below the chat LLM's (0.685 vs 0.889, and 0.741 vs
  0.907 in the replicate).
- Head to head, `Act` completed zero actions in 21 calls and only added time.
- The feature stays behind the experimental toggle.
