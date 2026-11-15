# Mirage decision classifier: measured negative result

The fixed visual classifier did **not** establish a useful routing or context-size improvement in this evaluation. All production policy decisions abstained, while classification added about **1.24 seconds** per image and increased the complete visual-result JSON envelope **52.6%** through decision/packing metadata. Keep this experiment off by default. These measurements do not justify relaxing the thresholds or enabling automatic tool selection.

## What is implemented and verified

The existing approved screenshot is sent through a separate image-form request:

```json
{"form":{"screen_type":{"enum":["dialog","form","document","other"]}}}
```

The actual pinned runtime returns:

```json
{"form":{"screen_type":{"value":null,"probabilities":{"dialog":0.13208986402295297,"form":0.01072976975706353,"document":0.039258381460107086,"other":0.00036095830635950036,"-":0.817561026453517}}}}
```

That example is a real blank-image diagnostic, separate from the final corpus run. `value: null` represents abstention, whose candidate is `-` in the probability map. Enum probabilities depend on the exact alternatives and their wording; they are not calibrated correctness probabilities. This implementation fixes one field and four candidate labels, caps input preprocessing/output size and uses the existing 30-second worker deadline. No general maximum enum size is claimed.

[Upstream describes forms as a separate request mode and states that its OCR reader does not run on the form path](https://cactuscompute.com/blog/structured-perception). Therefore the classifier does not replace perception: production runs perception first, classification second, on the same already approved image. It receives no chat history, task instructions, tools, tool arguments or OCR strings. It does not summarize or decide which conversation messages to discard.

`classifyMirage` shares the single-flight worker, model, timeout and idle lifecycle with `describeMirage`. A change to either consent setting terminates pending inference. The worker accepts only a boolean decision request, selecting the fixed form internally; callers cannot supply arbitrary enum labels or prompts.

The application validates the returned probability map and uses its existing conservative policy: supported class, probability at least 0.8 and margin at least 0.2 over every other candidate, including abstention. At most it emits a **read-only advisory** (`ReadPage` elements/text). The planner still chooses its next tool and arguments through the original gates. Reversible tuple packing preserves every retained visual field and is permitted only when a supported advisory exists and that record becomes smaller. It does not change chat compaction, summaries, screenshot retention, OCR contents, tool pairs, or instructions.

## Reproduce

```sh
npm run prepare:mirage
npm run benchmark:mirage:decisions
```

Requires the repository's Node dependencies plus Python/Pillow and DejaVu Sans. `MIRAGE_ROUNDS=3` is the default. All weights, runtime and model-card bytes are checksum verified. The model preparation now uses the publisher's Apache-2.0 model-card revision with **identical weight bytes** to the original experiment; see [license provenance](../mirage-license-provenance.md).

Inputs come from `scripts/mirage-decision-fixtures.py`: twelve deterministic 640×480 RGB rasterizations representing dialogs, forms, documents, dark variants, small/rotated content, a chart, a landscape, blank/noise controls, and a misleading-text control. They are generated images, **not browser screenshots**. No user screenshots or provider endpoints were used.

`docs/benchmarks/mirage-decision-results.json` contains all raw predictions, probabilities, per-call timing/memory, generated-image hashes, annotations, source hashes, runtime/model pins, versions and the initial call. Nine distinct fixtures have class annotations; three controls are annotated for abstention. These are deliberately small layout tests, not user-intent or tool-selection ground truth. In particular, “document” versus “form” is the requested exclusive taxonomy, not a claim that an image cannot contain both.

One bounded perception baseline is measured for each fixture. Then each fixture receives the production label order and its reverse in three complete rounds (72 measured classifier calls), alternating order each round. One initial classifier call is retained separately and excluded from warm summaries. Repetition increases timing samples, not independent accuracy examples.

The context-size comparison replays **real inference outputs through the actual `perceiveApprovedScreenshot` implementation**, with only its engine and settings mocked: decision mode off versus assist. This records the full visual-result envelope, including the classifier, timing, heap and packing metadata. It is a simulation of serialization, not an actual model conversation or browser run. Worker `totalMs` is represented by the measured C ABI duration in this replay; capture, decode, worker-transfer and planner latency are not measured. Bytes are UTF-8 JSON, not tokens, and no LLM cost reduction is inferred.

## Results

Run 2026-11-15 on Intel Xeon Platinum 8573C, 9 logical CPUs exposed, Linux x64 6.18.57, Node 24.22.1 / V8 13.6.233.17-node.58, about 10.45 GB host RAM reported. Python/Pillow/font versions and paths are recorded in raw metadata. No other agent tests/builds were intentionally running during timing; co-tenant load and CPU frequency remain uncontrolled. This host differs from the prior perception benchmark's AMD host: do not compare their absolute runtimes as an optimization result.

| Measurement | Production enum order | Reversed enum order |
| --- | ---: | ---: |
| Warm classification calls | 36 | 36 |
| p50 C ABI latency | 1232.7 ms | 1238.7 ms |
| p95 C ABI latency | 1307.0 ms | 1319.0 ms |
| Mean C ABI latency | 1236.9 ms | 1248.4 ms |
| Raw rubric matches (includes abstention controls) | 12/36 | 12/36 |
| Accepted production advisories | 0/36 | 0/36 |
| Supported fixture occurrences receiving advisory | 0/21 | 0/21 |
| Tuple packing applied | 0/36 | 0/36 |
| Baseline visual envelope bytes, total | 33,594 | 33,594 |
| Classifier-enabled envelope bytes, total | 51,271 | 51,293 |

Across the **nine distinct class-annotated images**, only the two document images matched their expected raw class (2/9); two forms were labeled document, and five images returned null. The blank and noise controls abstained; the text-label control returned document. Consequently the overall raw rubric match count is 4/12 distinct fixtures, repeated three times. The production policy rejected every result, including correct document predictions whose scores were approximately 0.757 and 0.715. The incorrect form→document predictions scored approximately 0.643 and 0.563. Thresholds were not tuned after observing the results.

Reversing the enum order changed the returned raw class in **0/36 paired observations**. Stability under this limited reorder test does not establish accuracy or invariance to label wording. Zero incorrect **accepted** hints were emitted because zero hints were accepted; conditional advisory accuracy/false-positive rate is undefined, not proven safe or 100% correct.

Model initialization was **348.0 ms** (single observation, excludes download and uses warm filesystem). WASM linear capacity reached **108,068,864 bytes (103.06 MiB)**. Sampled whole-process RSS peaked at **287,137,792 bytes (273.84 MiB)** across both profiles. These are neither exclusive model allocations nor browser-memory measurements, and the sequential profiles share one allocator.

Relative to no classifier, there is no additional raw observation retention benefit: every normalized visual record was retained unchanged. Production mode's aggregate envelope increased by **17,677 bytes (+52.6%)**, roughly 491 extra bytes per result. With no packing applied, this is overhead rather than compaction. The per-fixture perception baseline and classifier costs are separate in the raw data; paired requests incur both, plus unmeasured browser overhead.

## Limitations and recommendation

This fixed-form model appears insufficient for the proposed broad UI taxonomy on these fixtures. Do not treat it as a text-conversation classifier, general tool router, or context summarizer. Keep the implementation explicitly experimental and opt-in; retain abstention and original observations. Evaluate better task-specific visual labels on an independently annotated held-out set before revisiting routing. Any future deterministic visual packing experiment should be measured independently so representation savings are not misattributed to this classifier.

Actual MV3 worker loading/CSP, Chrome screenshot overhead, real website distributions, user intent, planner success, token counts and long-session memory remain unmeasured here. A fresh Chromium launch was attempted for this follow-up and again failed before page creation: `process_singleton_posix.cc:297`, `socket() failed: Operation not permitted`. No real browser pass is claimed. The benchmark uses the real WASM model and exact application policy, but it does not call or authorize any browser action.

## Regression validation

Compared with the prior PR head `807eea6`, the unchanged baseline produced 2,264 passes / 13 failures (2,277 tests); the final experiment produced **2,310 passes / the identical 13 failures** (2,323 tests). **46 additional tests pass**, covering malformed output/abstention, read-only hints, reversible packing, both-mode privacy, revocation, classifier failure, capture approvals and worker lifecycle. The full production build and typecheck passed. [Exact failure names and commands](decision-validation.json).

Both runs used the same installed dependencies in this refreshed environment. The existing lockfile workaround is documented in the benchmark overview; the lockfile is unchanged. The 13 agent-loop failures predate this experiment. Passing mocked/unit tests does not establish real MV3 execution or planner task performance.
