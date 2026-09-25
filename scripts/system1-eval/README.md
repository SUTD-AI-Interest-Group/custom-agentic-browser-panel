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
  - **e2e** — three tasks driven through the composer (approval cards auto-allowed),
    with `EVAL_E2E_MODES` of `on`, `off` and `forced` (toggle on + "Use the Act tool"
    in the prompt, since the chat model may never choose `Act` on its own).
- `report.json` — the last run's numbers (partial runs carry earlier sections over).

Not exercised: `engine.ts`'s FIFO/timeout wrapper (the harness talks to the worker
directly; the e2e runs do go through it).

## Running it

The model is not published yet, so build an eval extension with the pin override
(never commit a build):

```bash
VITE_SYSTEM1_PIN='{"repo":"local/von","revision":"local","manifestSha256":"<sha256 of out/manifest.json>"}' \
  npx vite build --outDir /tmp/dist-eval --emptyOutDir
EVAL_DIST=/tmp/dist-eval EVAL_PROFILE=/tmp/s1-profile \
  EVAL_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/system1-eval/run.mjs
```

`EVAL_PROFILE` reuses a browser profile so the 616 MB weights download once.
`EVAL_CHROMIUM` overrides the Chrome for Testing binary (branded Chrome ignores
`--load-extension`). If LM Studio is down, `llm` and `e2e` are skipped and say so.

## Results — 2026-09-26

Model `von-1.2.0` q8 (`model_q8.onnx`, 616 MB, fp32 activations, manifest sha256
`6e2fb20c…4236d9`). Chrome for Testing (Playwright chromium-1234), macOS, WebGPU
adapter `apple / metal-3`. LM Studio up.

**WebGPU parity** (4 golden cases vs fp32 reference): max |Δ calibrated p| **0.0024**,
argmax flips **0**. (The exporter's CPU check of the same q8 graph was 0.0236 over
9 probes; WebGPU is closer to fp32 on these 4, but 4 cases is a thin sample.)

**Latency** — worker boot (cache → session → warm-up) 1.3 s; download "Ready" and
the Settings test decision ("Picked [2] with p=0.76 in 57 ms") both work.

| decide() ms | p50 | p95 |
|---|---|---|
| all calls (n=164) | 105 | 486 |
| move question | 112 | 133 |
| target question (single call) | 93 | 496 |
| whole target pick per case (incl. tournament) | 203 | 657 |
| gemma, one completion per case | 1711 | 13730 |

**Grounding** (54 cases on 3 pages; top-1 target):

| | Von | gemma-4-26b-a4b |
|---|---|---|
| all | **40/54 = 0.741** | **49/54 = 0.907** |
| shop (43 candidates → tournament) | 16/23 | — |
| form | 13/16 | — |
| dialog | 11/15 | — |

Run-to-run: a first identical grounding run scored 37/54 (0.685) — the differences
were all tournament cases, so WebGPU results are not bit-stable across sessions.

- **Move question:** the correct move is `act` in all 54 cases. Von chose
  `scroll_down` 40×, `act` 13×, `WAIT` 1×, and its calibrated top never reached
  `ACT_CONFIDENCE` (p50 0.38, max 0.56) — **0/54 cases clear the loop's first gate.**
- **Tournament:** the 42 shop candidates split 40 + 2. The chunk holding the right
  button picked it in 17/23; the final round then often preferred the header "Cart" link
  or the degenerate 2-option chunk's winner (7 of 7 tournament errors).
- **Checkbox:** `describe()` renders an unchecked checkbox as `(currently "on")`
  (an `<input type=checkbox>`'s `.value` is "on" regardless of `checked`); Von then
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

No threshold buys LLM-level accuracy; raising it trades coverage for a few points.

**End-to-end** (all 9 runs succeeded; wall time includes approval-card round trips):

| task | toggle | s | steps | Act calls | ControlPage calls |
|---|---|---|---|---|---|
| form | on | 86 | 18 | 0 | 10 |
| shop | on | 35 | 10 | 0 | 3 |
| dialog | on | 35 | 10 | 0 | 4 |
| form | off | 42 | 12 | 0 | 7 |
| shop | off | 31 | 6 | 0 | 1 |
| dialog | off | 26 | 9 | 0 | 3 |
| form | forced | 78 | 15 | 2 | 6 |
| shop | forced | 41 | 8 | 1 | 2 |
| dialog | forced | 53 | 12 | 2 | 3 |

With the toggle on, `Act` was offered every time and gemma never called it. Forced,
every `Act` call that reached the loop (4 of 5; the other was made before
`RequestPageControl`) returned `uncertain` at the first move with **0 steps**
(p = 0.54, 0.37, 0.37, 0.45); gemma then finished with ControlPage. The toggle only
added time.

**Kill criterion (spec §9): met.** Latency is fine (p50 105 ms ≪ 300 ms), but Von's
grounding is clearly below the chat LLM's (0.741 vs 0.907), and the shipped loop never
gets past its move question on these pages, so `Act` performs no actions end to end.
The feature stays behind the experimental toggle.
