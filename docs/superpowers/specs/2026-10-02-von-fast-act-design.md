# Von fast Act — fp16 runtime, geometric context, multi-exit heads, a conformal gate

Status: design approved in conversation 2026-10-02 (approach 1 of three; see
§9); not yet implemented. Evidence: the four research reports in
`docs/superpowers/research/2026-09-30-*.md` (facts tagged measured [M] vs
inferred [I] there). Builds on the candidate-action layer
(`docs/superpowers/specs/2026-09-26-candidate-action-act-design.md`) and the
round-2 corpus (`docs/superpowers/specs/2026-09-30-von-data-round-2-design.md`,
merged 2026-10-02: 45,624 train / 3,374 val rows).

## 1. Why

`Act` runs Von 1.2 (ModernBERT-large, 395M, option-marker head) on WebGPU. The
act-head fine-tune (eval README, run B, 2026-09-30) grounds 0.926 against the
chat model's 0.944 and decides in p50 400 ms per pass, 817 ms on a 47-option
page — against a 300 ms kill line. The research found the cost is not the
architecture: the same weights run ~8× faster per token on CUDA [M]; our graph
is all fp32, attention is unfused over two T×T masks, and 540 of 1,909 nodes
(RoPE, mask and shape math) run on ORT's CPU fallback with a GPU↔CPU sync inside
every layer [M, eval README]. The fitted cost is ≈ 80 ms fixed + 0.65 ms per
token with T ≈ 150 + 20·K [I]. Accuracy-side, the largest measured lever for an
encoder element ranker is neighbour/label text chosen by geometry (+11.9 R@1,
Dual-VCR) [M]; Von's shipped calibration map clamps to its floor at K ≥ 12 [I
from the shipped coefficients], which is why gate coverage collapses on dense
pages; and the independent-option mask means the 18 local layers let an option
see only the last 64 prefix tokens — where today the *recent actions* sit, not
the goal [M, source].

## 2. Goals and non-goals

Goals: (a) p50 ≤ 250 ms per decision at K≈15–20 and ≤ 450 ms at K=47 with the
current weights (runtime only); (b) after the fine-tune, p50 ≤ 200 ms at K≈50
with a truncated exit, else ≤ 300 ms at full depth; (c) grounding on the
54-case eval ≥ 0.926 (paired McNemar vs run B), the SELECT_OPTION form case
completing; (d) gate coverage restored on dense pages with a stated error bound
among executed steps; (e) no general-benchmark regression > 1 point.

Non-goals (this round): a smaller student backbone (approach 3, fallback); an
in-graph cascade (approach 2, optional later); a page-text excerpt in the state;
packing the value/blocked heads into the act pass (the value question depends
on the chosen control; after §3 the second pass costs ~100 ms); AgentTrek; T3.

## 3. Runtime — the fp16 graph with the math taken out (no retraining)

**Export (`scripts/export-von/export.py`).** A third variant `f16` beside `q8`
and `fp16w`:

- Activations fp16 with fp32 islands: RoPE application, LayerNorm, softmax, the
  scorer head (ORT's op block list / explicit Casts). Weights stored fp16 as
  today; `requiresShaderF16: true` in the manifest, which the worker already
  honours (`requestGpuDevice`).
- RoPE angles leave the graph: `cos`, `sin` tables `[T, 64]` (fp32) become
  inputs the worker computes once per T from `position_ids` and the two RoPE
  bases (global 160k, local 10k — two table pairs). This is what the earlier
  fp16 attempt tripped on (`pos·inv_freq` computed in fp16) and what most of
  the CPU-partitioned `Div`/`Gather` nodes are.
- Masks leave the graph: the worker builds two additive biases `(1,1,T,T)`
  (0 / −30000) from `option_ids` and `position_ids` — the same rule
  `VonExport.forward` encodes — and passes them as inputs; `option_ids` and
  `position_ids` stop being inputs. A pad token carries `option_id = −2`,
  masked everywhere, so T can be bucketed.
- Attention emitted as `com.microsoft.MultiHeadAttention` (Q, K, V split from
  Wqkv by Slice; `attention_bias` = the layer's bias) so the native WebGPU
  FlashAttention kernel runs. Which execution provider the `onnxruntime-web/
  webgpu` bundle actually uses is **measured first** with
  `ort.env.webgpu.profiling = {mode:'default'}`: if no `FlashAttention` kernel
  appears, the plan switches the bundle before anything else.
- Bucketed T ∈ {256, 512, 768, 1024, 1536, 2048, 3072, 4096} so pipelines are
  reused. Graph capture only if the profile shows dispatch overhead *and* one
  or two buckets cover the eval; eight captured sessions would be eight weight
  copies on the GPU.

**Worker (`src/system1/worker.ts`, `von.ts`).** `planSequence` already yields
option/position ids; a pure, tested `buildAttentionInputs(plan, T, window)`
returns the two biases and the cos/sin tables, and the request is padded to the
bucket. Nothing changes above the worker: `DecideRequest`/`DecideResult` are
untouched.

**Gate.** Parity max|Δp| ≤ 0.03 on the calibration set *after* a scalar
temperature refit (fp16 noise mostly rescales logits; the probability gate is a
calibration gate, tighter than any accuracy gate); the WebGPU golden file in the
eval; grounding unchanged (same weights). Accept at the latency targets in §2(a).

## 4. Representation — the goal where the local layers can see it, context where the ranker needs it

All changes are in the shipped renderers (`src/system1/vonPolicy.ts`,
`observation.ts`), so training rows (`render.mjs`) and inference requests stay
byte-identical by construction.

- **Prefix order** (`renderState`): `Page · State · Controls? · Recent actions ·
  Provided values · Goal`. The goal (≤ 300 chars) and the value keys end the
  prefix and therefore sit inside every option's 64-token local window; the
  global layers still see everything.
- **Control line** (`renderControlLine`): `[12] textbox "Email" near "Billing"
  in "Checkout" (=jane@…) → type`. New `near`: the nearest text node above or to
  the left of the control (≤ 200 px by bbox distance, ≤ 48 chars, not inside
  another indexed element, not equal to the name), rendered only when present.
  Name clip 60 → 48, value clip 30 → 20, `(currently "x")` → `(=x)`. Token
  count per option stays roughly flat; `neutralize` applies to `near` as to
  every page-controlled string.
- **Perception** (`src/platform/domIndex.ts`): the walker collects `near` for
  every indexed element from the viewport's visible text nodes (one pass, text
  nodes with a non-empty rect inside the viewport, capped at 400), as a raw DOM
  fact on `IndexedElement.near?: string`; `buildControl` copies it to
  `BrowserControl.near`. The fingerprint and the hash do not include it (layout
  text drifts on reflow). `collect.mjs`'s snapshot entry picks it up for free.
- **Mind2Web** (`mind2web-lib.mjs`): the same rule over the dump's rects and
  `<text>` nodes. The teacher corpus cannot be re-collected without breaking its
  labels, so its rows render without `near` (~10% of rows); the effect of `near`
  is ablated on Mind2Web val (render with/without, same training run cadence).

## 5. Training — exits, calibration, export per exit

`scripts/von-finetune/train.py`, continue-training from the published act-head
checkpoint (`ks-ang/von-browser-act`, `checkpoint/`), on RunPod (bf16, token
budget 16k), 2–3 epochs over the re-rendered merged corpus.

- **Multi-exit heads** at layers 8, 16, 22, 28: a copy of the scorer head per
  exit, applied to that layer's marker hidden states (the encoder is run with
  `output_hidden_states`). Loss = Σ_l w_l · (CE + 0.5·Brier) + β · KL(p_l ‖
  p_28.detach()), w = {0.1, 0.3, 0.3, 1.0}, β = 1 (MoSE/LEAP recipe: train the
  exits for the exit, distil the final head into them). The 28-layer head keeps
  today's objective exactly.
- **Calibration per exit**: k-fold refit on val of Von's own K-aware map
  (`T = clamp(bias + w_H·H/ln K + w_len·log10(tokens)/4 + w_K·K/8, lo, hi)`) vs
  a scalar T, chosen by held-out NLL, stored per exit in `marker_calibration.json`
  and `von.json`.
- **Export per exit** (`export.py --exit L`): the graph keeps layers 1..L and
  head L; parity against the truncated PyTorch reference; the manifest records
  `layers: L`. The exit that ships is chosen by the eval (§7), not by val alone.
- **Report** (`train.py`): per exit × per head kind × per corpus; the
  eval's `EVAL_MODEL_DIR` points at one exit's export at a time.
- Forgetting: re-run jabr / JevBench / DecisionBench as on 2026-09-30 for the
  shipped exit and the full depth.

## 6. Gate — a margin with a bound, not a constant

`actLoop.ts` gates on `confidence.*` = calibrated top probability against
`ACT_CONFIDENCE` 0.6 / `ACT_TRY_CONFIDENCE` 0.4. This round:

- `DecideAnswer` gains `margin` = calibrated p_top − p_second (the worker
  computes it beside `top`).
- Thresholds are **fitted**, not chosen: on the fine-tuned model's val
  predictions per head kind (act element, act move, value), τ_free is the
  smallest margin such that the error rate *among accepted rows* is ≤ 5% with a
  finite-sample (Clopper–Pearson) upper bound, τ_tentative the same at 15%
  (selection-conditioned risk, the LEC correction to naive conformal cut-offs).
  DONE/BLOCKED keep τ_free. A pure, tested `fitGate(rows)` script writes
  `gate: {act: {free, tentative}, value: {…}}` into `von.json`.
- `actLoop.ts` reads the gate from the config when present and falls back to
  today's constants otherwise; the banded semantics (free / tentative-only-if-
  not-committing / hand back) are unchanged — only the statistic and the
  numbers change. The eval's 54 cases and the e2e forced arm report coverage
  and accuracy at the fitted thresholds as they do today at 0.6/0.4.

## 7. Acceptance, measurement, kill lines

| stage | accept when | measured by |
|---|---|---|
| runtime (§3) | FlashAttention + fp16 kernels in the profile; parity ≤ 0.03 after refit; p50 ≤ 250 ms (K 15–20), ≤ 450 ms (K 47); grounding identical | `ort.env.webgpu.profiling`; `export.py` gate + WebGPU golden; `scripts/system1-eval/run.mjs` |
| representation + training (§4–5) | per-head val top-1 ≥ run B's on comparable rows; grounding ≥ 0.926 by paired McNemar vs run B; form SELECT case completes; `near` ablation ≥ 0 on Mind2Web val | `train.py` report; eval grounding + e2e |
| exit choice (§5) | ship L=16 only if val top-1 within 1 pt of L=28 **and** no grounding loss on the 54 cases; else L=22 on the same rule; else L=28 | eval per export |
| gate (§6) | at the fitted thresholds, error among executed steps ≤ the bound on the eval, coverage ≥ run B's | eval + e2e |
| forgetting | jabr / JevBench / DecisionBench within 1 pt of run B | the 2026-09-30 benchmark scripts |
| overall | p50 ≤ 200 ms at K≈50 (L=16 + f16) or ≤ 300 ms (L=28 + f16) | eval |

If the runtime stage misses its latency target, the plan stops there and the
cause is profiled before any training starts: training cannot fix a kernel.

## 8. Risks

- fp16 parity: the head's low temperature amplifies logit noise ×3; mitigated by
  fp32 islands and the post-refit gate; fallback is the q8 graph with the
  mask/RoPE inputs alone (still removes the CPU nodes).
- `near` costs a text-node pass in the walker: capped at 400 viewport text
  nodes; measured on the eval fixtures before shipping.
- Exit heads can hurt the final head's accuracy (LEAP's finding): the final head
  keeps weight 1.0 and its loss is unchanged; if L=28 val drops > 0.5 pt vs a
  no-exit control run, exits are trained with the backbone frozen instead.
- The gate fit assumes val's margin distribution matches real pages; the eval's
  54 cases are the check, and the defaults remain the current constants.
- RunPod cost is small (README: a 20k-row 3-epoch run well under $2; this is
  ~2.5× the rows and ~2× the tokens).

## 9. The alternatives considered

(2) Approach 1 plus an in-graph cascade (layer-8 head shortlists 16 options,
upper layers run on prefix + 16): exact when recall@16 holds, 1.6–1.9× more,
2–3 days of two-session runtime work — optional after the exits exist. (3)
Distil into ModernBERT-base / Ettin-150M: 2.5–3× and a 150 MB download, but
loses Von's decision pretraining; the efficiency report puts P(≤ 1 pt loss) at
~0.45 — the fallback if the exits do not hold. Von's authors' own direction
(Von 2, decoder native-logit readout) is far more accurate on general decisions
but cannot meet in-browser latency at 4B [M].

## 10. Implementation plans

Two plans, in order: **Plan A** (§3, runtime; no training; ~2 days) and **Plan
B** (§4–6, the data re-render, the RunPod run, exports per exit, the gate fit,
the eval). B's exporter changes extend A's.
