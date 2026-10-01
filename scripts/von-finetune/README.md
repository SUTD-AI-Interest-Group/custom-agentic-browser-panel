# Fine-tuning Von for `Act`

The System-1 eval (`scripts/system1-eval/README.md`, 2026-09-26) met its kill
criterion: Von's grounding was 0.685–0.741 against gemma's 0.889–0.907, and `Act`
performed **zero** actions in 21 calls, because the move question never cleared
`ACT_CONFIDENCE`. This directory is the experiment that tests whether both gaps
can be closed. It distils page-control decisions from the two local LM Studio
teachers into Von.

## What the rows are (2026-09-30: the single-pass act head)

`render.mjs --head act` (the default) renders the rows for `createVonActPolicy`
(`src/system1/vonPolicy.ts`): ONE `act` question per decision whose options are
every (control, action) pair the candidate space allows — `[12] textbox "Email"
→ type` and `[12] textbox "Email" → click` as separate options, in the space's
ranked order — plus the global moves, with the state block WITHOUT the control
list. Labels transfer by construction: a `target` episode → `<id>:<op>` (the op
from `operationFor`, as before), a `scroll_down`/`DONE`/`BLOCKED` move → the
move; a move `act` renders nothing (its sibling target episode is the identical
row). Above `ACT_CHUNK` element options a chunk row (element options only, only
when the label is an element) and a final row (the target or the other chunks'
most goal-like control, plus the moves) mirror the policy's tournament. `value`
rows are unchanged. `--head lazy` renders the previous format below.

Rendered 2026-09-30 from the same 4,921 episodes: 2,743 train rows / 115 sites
(CLICK 1,138 · TYPE_TEXT 126 · SELECT_OPTION 9 · SCROLL_DOWN 105 · DONE 851 ·
BLOCKED 37 single-round; 129 chunk + 213 final tournament rows; 135 value),
363 val rows / 12 held-out sites; mean 2,379 chars per row (every row carries
the whole option list). Base Von 1.2 on the val rows: act 0.208 top-1 (the
format is new to it), value 0.762.

## What the rows were (2026-09-27: the candidate-action representation, `--head lazy`)

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
node scripts/von-finetune/render.mjs [--head act|lazy]   # → data/train.jsonl, val.jsonl, render-stats.json
uv run scripts/von-finetune/train.py --eval-only         # base-model val numbers
uv run scripts/von-finetune/train.py --epochs 2 --grad-checkpointing
uv run scripts/export-von/export.py --checkpoint scripts/von-finetune/data/ckpt --out scripts/von-finetune/data/onnx
```

Each stage is resumable, so re-running `collect`/`label` after adding URLs only
does the new pages. Add URLs to `pages.txt` to grow the dataset (target: ≥ 1,000
pages ≈ 20k rows). Stop LM Studio's models before training: both teachers
together take ~35 GB of the same unified memory.

## The Mind2Web corpus (2026-09-30)

The act-head fine-tune's failures were data gaps (`SELECT_OPTION` had 9 rows,
no multi-field form states, no real scroll decisions, 115 sites). Round 2
(`docs/superpowers/specs/2026-09-30-von-data-round-2-design.md`, plan
`docs/superpowers/plans/2026-09-30-mind2web-conversion.md`) converts
osunlp/Multimodal-Mind2Web — 14,193 human-demonstrated CLICK/TYPE/SELECT steps
on 137 real sites, CC-BY-4.0 / OpenRAIL — into this pipeline's shape and merges
it at render time. Two more stages, in front of stage 3:

| stage | script | what it does | cost |
|---|---|---|---|
| M1 fetch | `mind2web-fetch.py` | Streams the four splits' text columns over HTTP range requests (huggingface_hub `HfFileSystem` + pyarrow column projection): the 13 GB of parquet is mostly screenshots, and a 100-row row group's 13 text columns come down in ~4 s. Sorted by task into `data/mind2web/raw/<split>.jsonl.gz` (400 MB). | 8 min, no HF cache |
| M2 convert | `mind2web.mjs` (rules in `mind2web-lib.mjs`, tested) | One page per step with one or two 1280×720 windows so the target is visible in one; episodes in two goal kinds; every skip counted. | 12 min |
| 3 render | `render.mjs --corpus mind2web` | Merges with the teacher corpus, enforces the site-level split across both, renders the act head and the typed heads below. | 1 min |

**What a Mind2Web page is.** `cleaned_html` (jsdom) plus the step's candidates
become the registry `domIndex.ts` would record on that page: the same
accessible-name order (aria-label → own text → placeholder → value → title →
name; never alt), the DOM's own `type` defaults (a typeless `<button>` submits),
the selected option as a `<select>`'s value, `input_checked` as `checked`, the
three sensitivity regexes copied verbatim (a parity test reads them back out of
`domIndex.ts`), `ancestorName` by the same climb. What cleaning strips — `href`,
`disabled`, `readonly`, `formMethod` — stays absent rather than guessed.
Negatives are what `isInteractive` would accept from the surviving attributes
(tag, ARIA role, Mind2Web's `is_clickable`) plus the target's same-tag siblings
and same-class peers, so a div/li/span target (21% of clicks) is never the only
element of its kind. Frames are flattened into the dump, so `<iframe>` and
`<template>` tags are renamed before parsing (the HTML parser reads their
children as text: 537 targets vanished before the rename, 150 remain inside
other raw-text elements). No URL exists: the origin is `https://www.{website}.com`
(`originPlaceholder: true`; never a synthetic TLD, which the model could learn as
a corpus marker since the origin heads every state prefix), the viewport
1280×720 (Playwright's default; the `<html>` rect confirms 1280;
`viewportInferred: true`). Window 0 is the page top; a below-fold target gets a
second window a third of a screen above it; ≤ 200 elements per window in
document order, like a real snapshot. One production quirk is mirrored on
purpose: a `<select>`'s name is its options' text (innerText), not its label.

**Episodes.** Every converted step yields both goal kinds: a templated per-step
goal from Mind2Web's own element description ("Select Pickup from the
Reservation type dropdown"; no history, unambiguous, like the teacher rows) and
the task's `confirmed_task` with the trajectory so far as `Recent actions`, each
prior step carrying its own page's index, name and value key — the multi-field
form state the act head had never seen. Field goals hide their value half the
time and then carry a BLOCKED twin without it; a below-fold target yields
`scroll_down` from window 0 unless a same-name control sits on top. Labels are
the human's: `op` on a target episode overrides `operationFor` in the renderer.

Full run 2026-09-30: 14,193 steps → 11,598 pages / 56,998 episodes (23,196
target · 2,596 value · 31,206 move; 910 SELECT_OPTION, 3,004 TYPE_TEXT, 7,002
scroll_down, 1,008 BLOCKED), 136 sites. Skipped: 1,450 unnamed targets (icon
clicks with no name in the repr or the registry), 775 with no visible positive
candidate, 150 unregistered, 146 op/tag mismatches (TYPE on a label or div,
SELECT on a custom list), 39 past the 200 cap, 35 ENTER; 64 SELECT values not
among the options are kept and flagged (`mind2web-stats.json`). Splits:
Mind2Web `train`/`test_task`/`test_domain` → train, `test_website` (10 sites
unseen in every other split) → val; `resolveSplits` (`lib.mjs`) moves any val
page whose site is a train site in the other corpus to train (127 pages).

**Merged render** (`render.mjs --corpus mind2web`): 47,763 train rows / 240
sites (mind2web 43,241 · teacher 4,522; act rows CLICK 20,074 · TYPE_TEXT 2,966
· SELECT_OPTION 813 · SCROLL_DOWN 6,620 · DONE 1,272 · BLOCKED 970; value 2,537;
t1 1,088 yes / 2,184 no; t2 1,249; t4 1,447; t5 2,853 committing / 3,690
reversible), 3,520 val rows / 20 sites; mean 2,064 chars per row. Every val row
packs under Von's 4,096 tokens (`train.py --eval-only`: 0 dropped). Base Von 1.2
on this val (MPS, 278 s): all 0.268; act single 0.12, final 0.33; value 0.65;
t1 0.68, t2 0.28, t4 0.08, t5 0.57 — the heads are new to it, and these are the
numbers the next fine-tune is measured against. Teacher-only output (no `--corpus`, `--typed none`) is
byte-identical to the previous act-head render.

### Typed-instruction heads (spec §3, first batch)

Rendered from the same states through the shipped builders; `train.py` reports
each head as its own `kind` and each corpus as `corpus:<name>`.

| head | question | options | label | train rows |
|---|---|---|---|---|
| `t5_commit` | Is taking this action reversible, or does it commit to something…? + `Action: <renderControlAction line>` | reversible / committing | `isPointOfNoReturn()` verbatim over the raw element; ≤ 2 committing + ≤ 2 reversible per page; anchors excluded (a link's reversibility is a cross-origin fact the state never shows) | 6,543 |
| `t4_submit` | Which of these controls submits the form? | the form's button-role controls | the single `type ∈ {submit, image}` one (a typeless `<button>` is one) | 1,447 |
| `t2_field` | Which of these fields still needs a value to complete the task? | the page's editable fields | the target of a Mind2Web task-goal field step, when ≥ 2 fields and one is already valued or history is non-empty | 1,249 |
| `t1_done` | Is the task complete on this page, with no further action needed? | yes / no with explicit descriptions (Von's own noul packing) | yes = a teacher DONE episode; no = a target state, ≤ 2× yes | 3,272 |

No `uncertain` option on t5: an option with no labels is dead weight exactly
like `WAIT`; the confidence gate expresses uncertainty. `--typed-cap` (default
`t1=0.1,t5=0.2`, fractions of the split's act-head rows) keeps any one head from
dominating an epoch and gives val train's composition. T3 (login walls, needs a
Claude labeller) and T6–T8 are deferred; AgentTrek — the only scroll and
"declare done" source — waits on a written licence from xlang-ai.

```bash
uv run scripts/von-finetune/mind2web-fetch.py                                  # → data/mind2web/raw/*.jsonl.gz (resumable per split)
node --max-old-space-size=8192 scripts/von-finetune/mind2web.mjs               # → data/mind2web/{pages,episodes}.jsonl + mind2web-stats.json
node --max-old-space-size=8192 scripts/von-finetune/render.mjs --corpus mind2web [--typed t1,t2,t4,t5] [--typed-cap t1=0.1,t5=0.2]
npx vitest run scripts/von-finetune                                              # the conversion rules and the split rule
```

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

## Results — the act-head fine-tune (2026-09-30)

`render.mjs --head act` rows (2,743 train / 363 val, 12 held-out sites), 3
epochs = 396 optimizer steps on the M4 Max (MPS, grad checkpointing), 72.7 min,
best at step 250. Export `data/act-head/onnx` in the main checkout (gitignored;
q8, manifest sha256 `fb63645a…`) passes the parity gate (CPU max|Δp| 0.0098,
fp16w 0.0007, invariance 1e-5); the checkpoint, rows and logs sit beside it in
`data/act-head/`.

**Offline val**, one `act` head instead of `operation` + `target_<OP>`:

| step | val top-1 | coverage at the 0.6 gate | accuracy on the covered | calibration T |
|---|---|---|---|---|
| 0 (base Von 1.2) | 0.240 (act 0.208, value 0.762) | 0.785 | 0.256 | — |
| 250 (saved) | **0.939** | 0.939 | 0.971 | 1.389 |
| 396 | 0.939 | 0.953 | 0.962 | 1.464 |

Real-browser numbers: `scripts/system1-eval/README.md`, "Results — 2026-09-30",
run B (grounding 0.926 at one pass per click step). A CPU pass over public
System-One benchmarks the same day found no forgetting from either fine-tune
(jabr v2 0.724 → 0.718–0.721 with ECE 0.145 → ~0.06; a 492-row DecisionBench
subsample 0.490 → 0.520; one small-n regression on JevBench's "original"
choice items, 0.72 → 0.50, n=36, identical for both fine-tunes).

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
