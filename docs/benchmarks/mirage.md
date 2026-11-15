# Mirage WASM evaluation

This report measures the real pinned Mirage model in **Node/V8 WASM on generated UI-like images**. It is not a Chromium extension, screenshot-capture, planner, action-success, or end-to-end browser benchmark. Chromium could not start in this execution environment (`socket() failed: Operation not permitted` in its process singleton initialization), including an escalated launch. No browser performance claim is made.

## Reproduce

Use the repository's installed dependencies and Python 3 with Pillow and DejaVu Sans (`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`). Obtain the optional assets only after resolving your right to use the model weights:

```sh
npm run prepare:mirage -- --acknowledge-model-license
npm run benchmark:mirage
```

`MIRAGE_ROUNDS=3` is the default; increase it for longer measurements. The script writes `docs/benchmarks/mirage-results.json`, including every raw model output, per-call timings, memory observations, runtime versions, hardware, model/engine revisions, and scoring totals. `scripts/mirage-fixtures.py` generates all inputs deterministically; no user screenshots or network services are used during inference. The assets script downloads at build time, checks SHA-256 for every artifact, and appends a deterministic ESM export to the verified runtime factory for the extension worker.

## Protocol and interpretation

Twelve 640×480 RGB fixtures cover ordinary dialog/success/error/loading screens, a denser form, dark theme, low contrast, blank content, 9px tiny text, 12px disabled text, order identifiers/currency, and rotated text. These are simple Pillow rasterizations, not a representative web benchmark. Three complete rounds rotate profile order to reduce order bias. Each profile has one initial invocation, retained in the raw data and excluded from warm summaries.

- **Default:** upstream `describe` defaults, including scene, masks, relations and generated reasoning.
- **Bounded:** the production worker's objects + text profile, score/bbox fields only, 24 objects, 48 text lines, 192 semantic tokens, detection/OCR thresholds of 0.5.
- **OCR-only:** a diagnostic profile with text/bbox/score only, 48 lines and threshold 0.5. The integration retains objects + text.

All profiles reuse one loaded instance. Initialization includes WASM instantiation and weight read/copy/load; it excludes download and JS parsing, and filesystem caches are already warm. Inference timing includes the synchronous C ABI call, not screenshot capture, PNG decode, RGB preparation, worker transfer, output normalization, Chrome scheduling, or a planner call. No other agent benchmark/test/build job was intentionally running during the final measurement; shared-host interference and CPU frequency were not controlled.

Word recall/precision use normalized **unique** OCR word sets per image (case/punctuation ignored). The raw `exactLabels` metric also ignores punctuation. The distinct `productionExactLabels` metric calls the actual bundled `normalizeMirage` and `observeExpectedText` implementation: score >= 0.5, at most 32 OCR records, 160-character output bound, complete-line comparison with case/whitespace normalization only. Production normalization/observation time is separately recorded. Three absent success phrases (`Order placed`, `Payment successful`, `Access granted`) are checked through that same production implementation for accidental exact matches; this is a small sanity check, **not** a calibrated false-confirmation rate. Repeated deterministic images increase timing samples but do not increase independent accuracy cases. Full raw output is provided so alternate scoring is possible.

`heapBytes` is WASM linear memory **capacity**, not live allocations or total browser memory. RSS is the entire Node process, sampled after each call; it includes fixtures, runtime, model, JS, and retained result records, and may miss intra-call peaks. Profiles share the allocator, so profile RSS differences do not demonstrate a memory optimization.

## Licensing and deployment

The Cactus source and prebuilt runtime are Apache-2.0 (license checksum verified by the preparation script). The pinned Hugging Face Mirage repository contains no LICENSE file or explicit license metadata; weight redistribution rights remain unresolved. Model/runtime binaries are ignored and are not part of the PR. Resolve the weights license before distributing a Mirage-enabled extension build. The normal extension build remains usable without these optional assets, and local perception fails closed when they are missing.

The actual ABI uses `unsigned long long` for the `cactus_load` archive length, requiring JavaScript `BigInt`. `cactus_describe` uses ordinary `int` for dimensions/output capacity. Actual OCR records use `string`, not `text`, with `bbox: [x1,y1,x2,y2]` normalized to 0–1000. These details were checked against real outputs and the published header, not inferred from the marketing example.

The verified runtime has no occurrences of `new Function`, `eval(`, `importScripts`, or `SharedArrayBuffer`. This is useful static CSP evidence, but is not a substitute for loading the worker under real MV3 CSP.

## Results

Run: 2026-11-15, AMD EPYC 9V74 (9 logical CPUs exposed), Linux x64 kernel 6.18.57, Node 24.22.1 / V8 13.6.233.17-node.58; 10.45 GB host memory reported. Python 3.12.14, Pillow 13.0.0, DejaVu Sans at `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`. CPU quota/frequency and co-tenant activity were not controlled. The raw result records the baseline Git commit plus SHA-256 fingerprints of the evaluated source/fixtures (working tree changes were not yet committed).

| Profile | Warm calls | p50 (ms) | p95 (ms) | Mean (ms) | Raw OCR word recall / precision | Production exact labels |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Default/full | 36 | 1877.2 | 2428.3 | 1899.2 | 96.23% / 94.44% | 90 / 99 |
| Bounded objects + text (production) | 36 | 1596.1 | 1899.5 | 1613.7 | 92.45% / 96.08% | 90 / 99 |
| OCR-only diagnostic | 36 | 1661.7 | 2154.2 | 1686.0 | 92.45% / 96.08% | 90 / 99 |

The bounded profile lowered mean inference time **15.0%** and p95 **21.8%** relative to the upstream full/default output on this corpus. This is an engine-options comparison, not a before/after Lychee task-speed measurement. Adding Mirage to the original off state adds inference latency; the original has no Mirage OCR observations. OCR-only did not improve on the production profile in this run, so no additional optimization claim is made for it.

Production normalization/expected-text checks took p50 **0.030 ms** for the bounded profile, separate from model inference. Model initialization was **187.8 ms** (warm filesystem; one observation). First inference was retained separately for each profile in the raw JSON; these initial calls are not independent model-load trials.

All profiles reached **129,695,744 bytes (123.69 MiB)** of WASM linear capacity. Observed whole-process peak RSS was **300,294,144 bytes (286.38 MiB)**. Neither number is 22 MB, and neither is a browser memory measurement. No per-profile memory reduction was established.

The 90/99 production label observations represent **30/33 annotated label occurrences across 12 distinct fixtures** repeated three times (some strings recur between fixtures). The 9px tiny fixture lost one expected line at the 0.5 confidence threshold; rotated text produced incorrect words such as `confimm` and `canicel`, and only one of its three expected labels matched. The bounded profile omitted low-confidence text that the default raw OCR emitted, reducing raw word recall while preserving the production-filtered exact-label count. All three profiles had zero exact matches to the three absent phrases in these fixtures. This limited negative check does not establish safety for action confirmation.

Do not interpret these synthetic results as general browser accuracy, calibrated confidence, a task-completion improvement, or proof that a click succeeded. Chromium MV3 loading/CSP, actual captures and worker overhead, long-session memory, real web controls, and local LM Studio planner task success remain unmeasured in this environment. See the raw JSON for every prediction and timing.
