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

The model is not published yet, so build an eval extension with the pin override
(never commit a build). The override is honoured only under `--mode system1-eval`
— an ordinary build ignores it, and hides the Experimental toggle while the
committed pin is empty:

```bash
VITE_SYSTEM1_PIN='{"repo":"local/von","revision":"local","manifestSha256":"<sha256 of out/manifest.json>"}' \
  npx vite build --mode system1-eval --outDir /tmp/dist-eval --emptyOutDir
EVAL_DIST=/tmp/dist-eval EVAL_PROFILE=/tmp/s1-profile \
  EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/run.mjs
EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/ep-placement.mjs webgpu
```

`EVAL_PROFILE` reuses a browser profile so the 616 MB weights download once.
`EVAL_CHROMIUM` overrides the Chrome for Testing binary (branded Chrome ignores
`--load-extension`). If LM Studio is down, `llm` and `e2e` are skipped and say so.

`EVAL_PHASES=rederive` recomputes the summaries and verdict from the rows already
in `report.json`, with no browser and no model. `report.json` is written only by
`report.mjs`. Every invocation appends to its `runs` list the phases it produced, so
the file records which run each section came from.

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
