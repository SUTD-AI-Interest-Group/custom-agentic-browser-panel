# Fine-tuning Von for `Act`

The System-1 eval (`scripts/system1-eval/README.md`, 2026-09-26) met its kill
criterion: Von's grounding was 0.685–0.741 against gemma's 0.889–0.907, and `Act`
performed **zero** actions in 21 calls, because the move question never cleared
`ACT_CONFIDENCE`. This directory is the experiment that tests whether both gaps
can be closed. It distils page-control decisions from the two local LM Studio
teachers into Von.

## What the rows are (2026-09-27: the candidate-action representation)

`Act` now runs on the candidate-action layer
(`docs/superpowers/specs/2026-09-26-candidate-action-act-design.md`): the harness
builds the finite space first and Von answers `operation` → `target_<OP>` → `value`.
The renderer (`render.mjs`) bundles the **shipped** builders from source
(`prompt-entry.ts` → `observation.ts`, `candidates.ts`, `vonPolicy.ts`'s
`renderState`/`operationQuestion`/`targetQuestion`/`valueQuestion`/`targetChunks`),
so a training row is byte-identical to the `DecideRequest` `createVonPolicy` sends.
There is no second implementation that could drift.

Heads and labels (episode labels transfer by construction — nothing was relabelled):

| episode | row | state | label |
|---|---|---|---|
| move `act` | `operation` | with the control list | the sibling target's own operation: `CLICK`, or `TYPE_TEXT`/`SELECT_OPTION` when values exist |
| move `scroll_down` / `DONE` / `BLOCKED` | `operation` | with the control list | `SCROLL_DOWN` / `DONE` / `BLOCKED` |
| target | `target_<OP>` over that operation's ranked pool (chunk + final rounds above `TARGET_CHUNK`) | without the list | the control id |
| value | `value` | without the list | the key |

`blocked_reason` has no labels and stays zero-shot. Two known train/serve gaps:
the collected elements predate domIndex's `disabled`/`readonly`/`checked`/`value`
facts, so rendered controls carry no state decoration unless a composed episode
typed into them; and `Recent actions` results are always `success` (no
`no_change`/`stale` in the data).

**Why this re-render.** The first fine-tune (below) was trained on the previous
rendering (`actState`/`moveState`/`describe()`, move label `act`). On the new
harness, zero-shot, it grounds 0.963–0.981 and clears the operation gate on every
CLICK case, but answers `CLICK` on field cases at p≈0.4 — "type into a field" as an
*operation* did not exist in its labels (`scripts/system1-eval/README.md`,
"Results — 2026-09-27").

## Pipeline

| stage | script | what it does | cost |
|---|---|---|---|
| 1 collect | `collect.mjs` | Headless Chromium over `pages.txt` (~190 seeds, +2 same-site links each). Each page is snapshotted at up to 3 scroll offsets with the **real** domIndex walker, viewport-only as `Act` sees it. Read-only: GET navigation and scrolling, never a click, type or submit. | ~1 h, no GPU |
| 2 label | `label.mjs` | Teacher labelling (below) against LM Studio. | ~45 s/page at concurrency 2 |
| 3 render | `render.mjs` | Episodes → `train.jsonl` / `val.jsonl` in Von's trainer record format (`{state, question, options:[{id,description}], label}`), via the shipped candidate-action builders: `operation` rows with the control list, `target_<OP>` rows (incl. the `TARGET_CHUNK` tournament's chunk and final rounds) and `value` rows without it. | seconds |
| 4 train | `train.py` | Continue-trains the pinned Von 1.2 (full fine-tune, CE + 0.5·Brier like Von's own trainer, `independent_options=True`). Refits the calibration temperature on val and writes an export-ready checkpoint. | see feasibility |
| 5 export | `../export-von/export.py --checkpoint data/ckpt --out data/onnx` | Same q8 parity gate as the shipped model. Writes the ship set plus its own `von-golden.json`. | minutes |
| 6 eval | `../system1-eval/run.mjs` with `EVAL_MODEL_DIR=data/onnx EVAL_GOLDEN=data/onnx/von-golden.json` | The real-browser verdict (grounding, move gate, e2e). | ~35 min |

### How the teachers label (stage 2)

The teachers are `google/gemma-4-26b-a4b` and `qwen3.8-27b-uncensored-mlx`
(`VFT_TEACHERS`). They alternate writer/verifier roles by page. They never
answer Von's questions blind; every label is either constructed or cross-checked:

- **Hindsight goals.** The writer sees a viewport's elements (the same
  `describe()` lines Von sees). It writes natural goals, each fulfilled by one
  element it names, so the target label is known by construction. For fields it
  also gives a `valueKey` and a realistic value.
- **Round-trip verification.** The *other* model gets the goals without the
  indices and must ground each back to the same element. A goal it grounds
  elsewhere is dropped (logged in `label-log.jsonl` with both picks).
- **Structural move labels.**
  - `act`: the verified target is on screen.
  - `scroll_down`: the goal was written for an element that exists only further
    down. The verifier must answer "nothing on screen serves this", and must
    also ground it on the lower viewport.
  - `DONE`: the step is in "Done so far", with a typed field showing its new value.
  - `BLOCKED`: the goal needs a value that was not provided (only when the goal
    text doesn't carry it, e.g. not a search query).
  - `WAIT` is not produced: there is no honest way to label it from snapshots.
- **Value rows.** The true key plus 0–3 plausible distractor keys, labelled
  by construction.
- **Two-field fills.** Two verified type goals on one page are composed into
  one goal: target and value rows at step 1 (with the first field done), then DONE.

JSON is requested in the prompt, not via `response_format`: a strict schema
grammar suppressed qwen3.8's reasoning, and it answered with an empty string.

### Splits and held-out data

- The split is by **site** hash (`lib.mjs splitOf`, ~10% val), so val pages never
  share a site with train pages.
- `scripts/system1-eval/fixtures/` is the untouched test set: `collect.mjs`
  refuses to collect it, and the final verdict comes only from `run.mjs` on it.
- `train.py` reports val accuracy per question kind and the coverage/accuracy the
  0.6 gate lets through, for the base model (step 0) and each eval step.

## Running it

```bash
export VFT_PLAYWRIGHT=/path/to/node_modules/playwright   # any Playwright install
node scripts/von-finetune/collect.mjs                    # → data/pages.jsonl   (resumable)
node scripts/von-finetune/label.mjs --concurrency 2      # → data/episodes.jsonl (resumable, per page)
node scripts/von-finetune/render.mjs                     # → data/train.jsonl, val.jsonl, render-stats.json
uv run scripts/von-finetune/train.py --eval-only         # base-model val numbers
uv run scripts/von-finetune/train.py --epochs 2 --grad-checkpointing
uv run scripts/export-von/export.py --checkpoint scripts/von-finetune/data/ckpt --out scripts/von-finetune/data/onnx
```

Each stage is resumable, so re-running `collect`/`label` after adding URLs only
does the new pages. Add URLs to `pages.txt` to grow the dataset (target: ≥ 1,000
pages ≈ 20k rows). Stop LM Studio's models before training: both teachers
together take ~35 GB of the same unified memory.

## Feasibility: the M4 Max is enough

Measured with `feasibility.py` (real AdamW steps on the full 395M model, Von
1.2's independent-option masks, batch 1, target-question-shaped rows; torch
2.14, MPS, M4 Max 64 GB):

| packed tokens | fp32: s/step · peak | + grad checkpointing: s/step · peak |
|---|---|---|
| 523 | 0.22 s · 8.1 GB | 0.28 s · 7.1 GB |
| 1,033 | 0.40 s · 10.1 GB | 0.52 s · 7.1 GB |
| 2,054 | 0.86 s · 19.1 GB | 1.17 s · 8.1 GB |
| 4,103 (Von's max) | 4.13 s · 47.0 GB | 3.69 s · 11.2 GB |

- Memory is not the constraint. With `--grad-checkpointing` the worst case
  (T = 4096) peaks at 11 GB. Without it, 47 GB still fits in 64 GB, but not
  alongside LM Studio.
- Throughput is ~1.7–2.6k tokens/s. Rendered rows average ~750–1,300 chars
  (≈ 200–350 tokens). Tournament and move rows are the long ones.
- Estimate: 20k rows × ~300 tokens ≈ 6M tokens/epoch → **~1 h per epoch on the
  Mac**, so 2–3 epochs overnight is comfortable. Even 100k rows is a one-night run.
- A 395M encoder is small enough that LoRA or quantised training buys nothing
  here. Full fine-tuning keeps the export path identical to the shipped model.

**RunPod is optional (for speed, not capacity).** `train.py` runs unchanged on
CUDA; use `--bf16 --tokens-per-batch 16384`. Community prices read 2026-09-26:
RTX 4090 $0.34/h, L40S $0.79/h, A100 80GB $1.19/h (stock LOW for each). An
A100 or 4090 should be roughly 5–10× the Mac's throughput, so a 20k-row, 3-epoch
run costs well under $2. That is worth it only for sweeps (lr, epochs, data
mixes), not for one run.

## Decision rule

Re-run the real eval on the fine-tuned export. The feature earns its place only if:

- grounding on `cases.json` is within ~3 points of the chat LLM (≥ ~0.86 vs gemma's
  0.889–0.907), and
- the move gate clears on most of the 54 cases, with `act` chosen, and
- e2e `forced` arm: `Act` performs real actions, with no loss of success rate.

Otherwise the kill criterion stands. Record the numbers in
`scripts/system1-eval/README.md` either way.

## Results — second fine-tune, candidate-action rows (2026-09-27)

Same 4,921 episodes, re-rendered (4,644 train rows / 115 sites, 643 val rows / 12
held-out sites; `render-stats.json`). 3 epochs = 456 optimizer steps on the M4 Max
(MPS, grad checkpointing), 62 min, best at step 200. Export `data/onnx` (q8,
manifest sha256 `33e4bc66…`) passes the parity gate (CPU max|Δp| 0.0073, fp16w
0.0005, invariance 1e-5).

**Offline val, per head** (accuracy · coverage at the 0.6 gate):

| head | rows | base Von 1.2 | step 200 (best) |
|---|---|---|---|
| all | 643 | 0.617 · 0.398 | **0.958 · 0.955** (0.977 on the covered) |
| `operation` | 321 | 0.508 · 0.003 | **0.963 · 0.978** |
| `target_<OP>` final round | 114 | 0.912 · 0.693 | 1.000 · 1.000 |
| `target_<OP>` chunk round | 114 | 0.561 · 0.903 | 0.956 · 0.921 |
| `target_<OP>` single | 73 | 0.685 · 0.794 | 0.890 · 0.849 |
| `value` | 21 | 0.762 · 0.714 | 0.905 · 0.905 |

The operation head — the one the previous fine-tune could not transfer to field
cases (it had never seen `TYPE_TEXT` as a label) — goes from unusable to 0.963
with 98% coverage. Real-browser numbers: `scripts/system1-eval/README.md`,
"Results — 2026-09-27".

## Results — first fine-tune (2026-09-26/27)

Data: 196 of 340 collected pages labelled (4,753 train rows / 115 sites, 652 val rows /
12 held-out sites). 3 epochs on the M4 Max (MPS, grad checkpointing), 47 min, best at
step 200. Export `data/onnx` (q8, manifest sha256 `63f7e93d…`) passes the parity gate
(CPU max|Δp| 0.0098; WebGPU 0.0063, 0 flips). Full numbers: `data/report-ft.json`.

**Offline val (in-distribution — same teacher pipeline):** overall top-1 0.54 → 0.94;
move-question gate coverage 0% → 95%; scroll_down still weak (0.36, n=22).

**Real-browser eval on the held-out fixtures** (same 54 cases as the baseline):

| | base Von 1.2 | fine-tuned | gemma-4-26b-a4b (baseline runs) |
|---|---|---|---|
| grounding top-1 | 37–40/54 | **54/54** (tournament 23/23) | 48–49/54 |
| move gate cleared (act) | 0/54 | **54/54** (p50 top 0.99) | — |
| confident-but-wrong @0.6 | 11 | **0** | — |
| decide p50 | 96 ms | 225 ms (move 275 ms: longer prompt from `moveState`) | 1,821 ms |

(The `llm` phase was skipped in this run — it must share a run with `grounding`; the
gemma column is from the committed baseline on identical inputs.)

**E2E, 3 tasks × 3 reps:** off 8/9, on 8/9, forced 8/9. `Act` now acts — 11 actions
over 19 calls (baseline: 0 over 21), ending `done` on every single-click task (shop,
dialog). Every non-done call was on the **multi-field form**: "unsure which element"
(p 0.28–0.60) or "unsure of the next move" mid-fill, after which gemma finished with
ControlPage. Forced-arm median wall time 91 s vs 48 s off — mostly those hand-backs.

**Read:** the kill criterion's grounding clause no longer holds (54/54 vs the LLM's
48–49/54), latency is still under 300 ms but with less margin. The remaining gap is
mid-task form state: the training data has only 2-field composed fills and no
states with several fields already done. Next data round: longer form trajectories
(3–6 fields + checkbox + submit, with "Done so far" at every step), more scroll_down,
then finish labelling the remaining 144 pages.
