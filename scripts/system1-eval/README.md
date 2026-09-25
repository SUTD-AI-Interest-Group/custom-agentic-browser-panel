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
- `report.json` — the numbers below (partial runs carry earlier sections over).

## Running it

The model is not published yet, so build an eval extension with the pin override
(never commit a build):

```bash
VITE_SYSTEM1_PIN='{"repo":"local/von","revision":"local","manifestSha256":"<sha256 of out/manifest.json>"}' \
  npx vite build --outDir /tmp/dist-eval --emptyOutDir
EVAL_DIST=/tmp/dist-eval EVAL_PROFILE=/tmp/s1-profile \
  EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/run.mjs
EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/ep-placement.mjs webgpu
```

`EVAL_PROFILE` reuses a browser profile so the 616 MB weights download once.
`EVAL_CHROMIUM` overrides the Chrome for Testing binary (branded Chrome ignores
`--load-extension`). If LM Studio is down, `llm` and `e2e` are skipped and say so.

## Results — 2026-09-26

Model `von-1.2.0` q8 (`model_q8.onnx`, 616 MB, int8 MatMulNBits weights, fp32
activations; manifest sha256 `6e2fb20c…4236d9`). Chrome for Testing (Playwright
chromium-1234), macOS, WebGPU adapter `apple / metal-3`, onnxruntime-web 1.30.0.
LM Studio up throughout; nothing skipped.

### Von vs the original (ControlPage only) — end to end

Same 3 tasks, same fixtures, same model, 3 runs per task per arm (27 runs).

| arm | success | wall median (mean) | LLM steps | tokens in+out | page actions | Act calls (non-done) | Von decides / ms | approval cards |
|---|---|---|---|---|---|---|---|---|
| **off** — original | **8/9** | **36 s** (37 s) | 10.2 | 40.9k (39.4k + 1.5k) | 2.9 | — | — | 3.2 |
| on — toggle, model's choice | 5/9 | 37 s (39 s) | 11.1 | 42.8k (40.6k + 2.2k) | 1.2 | 0 | 0 | 2.2 |
| forced — toggle + "use Act" | 9/9 | 51 s (56 s) | 11.6 | 55.7k (53.5k + 2.3k) | 3.0 | 13 (13 `uncertain`) | 14 / 1.7 s | 3.6 |

Per task (success · median wall · mean tokens):

| task | off | on | forced |
|---|---|---|---|
| form (4 fields + consent + submit) | 3/3 · 50 s · 57k | 1/3 · 52 s · 49k | 3/3 · 76 s · 77k |
| shop (1 of 36 variant buttons) | 3/3 · 25 s · 29k | 3/3 · 27 s · 35k | 3/3 · 48 s · 49k |
| dialog (cookie wall, then add) | 2/3 · 36 s · 36k | 1/3 · 37 s · 44k | 3/3 · 36 s · 41k |

- **`Act` never performed a page action.** 13 calls in the forced arm, 13 `uncertain`,
  0 steps: 12 at the move question (p 0.32–0.60, all below `ACT_CONFIDENCE` 0.6),
  1 at the target question (p 0.57). Every page action in the forced arm was a
  ControlPage call the chat model made after `Act` handed back. The forced arm's
  extra ~15 s and ~15k tokens are the cost of those detours; Von's own share is
  1.7 s of inference plus a 4.4–5.6 s cold engine boot inside the first `Act` call
  of each panel load.
- **In the `on` arm gemma never chose `Act`** (0 calls in 9 runs though it was in
  `activeTools` after the page-control grant), so that arm measures the original path
  with a larger tool catalog. Its 4 failures, and the `off` arm's 1, share one
  pattern: gemma called ControlPage without ever calling `RequestPageControl`, looped
  on the "no session" error and gave up. That is chat-model variance; with n=3 it
  can't be attributed to the toggle. The forced arm's 9/9 is probably the extra
  instruction steering gemma to the page-control cluster, not `Act`, which did nothing.
- **Approval cards:** in successful runs the point-of-no-return cards were the same in
  every arm ("Click “Send message”", "Click “Add Aurora mug (blue) to cart”", "Click
  “Reject non-essential”", "Click “Add Nimbus tote (green) to cart”"), each after one
  "Let the agent control 127.0.0.1…" card. `Act` added no cards of its own. The other
  differences are the model's own reads, e.g. a "View the tab you are currently on"
  (screenshot) card in some form runs of both `off` and `forced`. Failed runs show
  fewer cards because they never reached page control.

### Component-level numbers

**Execution-provider placement** (`ep-placement.mjs`): **all 84 MatMulNBits nodes run
on WebGPU** (84 × 12 runs = 1008 `MatMulNBits` WebGPU programs launched). 1369 nodes
go to `WebGpuExecutionProvider` and 540 to `CPUExecutionProvider`. The CPU nodes are
ORT's own "fallback CPU capability" choice for small int64 shape subgraphs (Gather
201, Unsqueeze 122, Div 84, Concat 57, Add 28, Mul 28, …), plus 11 MemcpyFromHost / 4
MemcpyToHost. Same probe with the `wasm` EP: 3.9–4.4 s per golden case vs 0.17–0.21 s
on WebGPU, so the latency numbers here really are GPU numbers.

**WebGPU parity** (4 golden cases vs fp32 reference): max |Δ calibrated p| **0.0024**,
argmax flips **0**; max |Δ logit| 0.043 with the exact golden ids. The exporter's CPU
check of the same q8 graph was 0.0236 over 9 probes. 4 cases is a thin sample.

**Boot and download:** Settings download → "Ready · 620 MB" in 2.1 s (localhost, so
not a network figure; this includes hashing 616 MB). Worker boot (Cache Storage →
session → warm-up): 1.3 s in an eval page, 4.4–5.6 s inside the panel during e2e (with
an LM Studio generation competing). Settings "Run a test decision": `Picked [2] with
p=0.76 in 57 ms`.

| decide() ms | p50 | p95 |
|---|---|---|
| all calls (n=164) | 105 | 486 |
| move question | 112 | 133 |
| target question (single call) | 93 | 496 |
| whole target pick per case (incl. tournament) | 203 | 657 |
| gemma, one completion per grounding case | 1711 | 13730 |

**Grounding** (54 cases on 3 pages, same element lists for both; top-1 target):

| | Von | gemma-4-26b-a4b |
|---|---|---|
| all | **40/54 = 0.741** | **49/54 = 0.907** |
| shop (43 candidates → tournament) | 16/23 | — |
| form | 13/16 | — |
| dialog | 11/15 | — |

Run-to-run: a first identical grounding run scored 37/54 (0.685). All the differences
were in tournament cases, so WebGPU results are not bit-stable across sessions.

- **Move question:** the correct move is `act` in all 54 cases. Von chose
  `scroll_down` 40×, `act` 13×, `WAIT` 1×, and its calibrated top never reached
  `ACT_CONFIDENCE` (p50 0.38, max 0.56) — **0/54 cases clear the loop's first gate**,
  matching the e2e result above.
- **Tournament:** the 42 shop candidates split 40 + 2. The chunk holding the right
  button picked it in 17/23; the final round then often preferred the header "Cart"
  link or the degenerate 2-option chunk's winner (7 of 7 tournament errors).
- **Checkbox:** `describe()` renders an unchecked checkbox as `(currently "on")`
  (an `<input type=checkbox>`'s `.value` is "on" regardless of `checked`). Von then
  picks "Send message" for "tick the consent box" with p=0.99.
- **Value key** (asked only when the target cleared the gate): 8/9.

**Threshold sweep** (target question, final round's calibrated top):

| ACT_CONFIDENCE | coverage | accuracy on answered | confident-but-wrong |
|---|---|---|---|
| 0.4 | 0.981 | 0.736 | 14 |
| 0.5 | 0.907 | 0.735 | 13 |
| 0.6 | 0.667 | 0.750 | 9 |
| 0.7 | 0.519 | 0.786 | 6 |
| 0.8 | 0.352 | 0.789 | 4 |

No threshold reaches LLM-level accuracy; raising it trades coverage for a few points.
Keep 0.6. The binding constraint is the move question, where lowering the gate would
mostly make `Act` scroll instead of act.

**Kill criterion (spec §9): met.** Latency is fine (p50 105 ms, well under 300 ms, and
genuinely on the GPU). But Von's grounding is clearly below the chat LLM's (0.741 vs
0.907), and head to head the `Act` arm is slower (51 s vs 36 s median), uses more
tokens (55.7k vs 40.9k) and completes zero actions itself. The feature stays behind
the experimental toggle.
