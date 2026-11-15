# Mirage integration: validation and performance scope

> License update: the initial licensing observation below is historical. The preparation script now pins an Apache-2.0-labeled revision with the identical weight hash and packages notices. See [verified provenance](../mirage-license-provenance.md).

Baseline: `ff3b750daa30534fb04507354c68be82d17a7e44`. The results separate a DOM executor correctness fix from model inference. Neither is an end-to-end browser-agent success benchmark.

## Measurements

- [Shadow-root action comparison](shadow.md): 6,400 jsdom simulated actions, pinned original/changed production functions, eight DOM sizes/topologies, alternating batches, latency distributions and memory snapshots. Raw [JSON](shadow-jsdom-results.json).
- [Mirage inference](mirage.md): the pinned production WASM model is evaluated on synthetic UI rasters in Node; [raw results](mirage-results.json) retain predictions and timings. These are not Chrome-extension timings.

Chromium could not launch: its process-singleton `socket()` syscall returned `Operation not permitted` even through the escalated runner. No page, extension, screenshot or browser measurement was created by that attempt. The Chromium shadow benchmark remains runnable on an unrestricted development host.

## Dependency and test reproducibility

On this Linux host `npm ci --ignore-scripts` fails because the existing lockfile omits platform-specific optional esbuild/Rollup package entries. The recorded installation used:

```sh
npm install --ignore-scripts --package-lock=false --no-audit --no-fund
npm run typecheck
npm run build
npm test -- --maxWorkers=2
```

The lockfile is unchanged. This workaround is not a fully frozen install; compare original and changed code with the **same installed dependencies**, as done here. Node is v24.22.1; Vitest resolved to 4.1.12 and Vite to 6.4.6. The raw benchmark files record platform/CPU and runtime details.

The unchanged baseline full suite produced **13 failures / 2,216 passes**, in three files: `src/agent/agent.test.ts` (9), `src/agent/browseAgent.test.ts` (3), and `src/agent/traceSink.test.ts` (1). The final changed-code run reproduced the same 13 failing tests and passed **2,264 tests**, including **48 new passing tests** across shadow actions, perception gates/normalization and worker lifecycle. The total was 2,277 tests in 185 files. Both baseline and changed builds passed typechecking and bundling. [Validation details and exact failure names](validation.json). These are baseline failures under this dependency environment, not a clean full-suite pass. Focused new tests use mocked inference only to verify gates, settings, lifecycle and normalization; they do not establish accuracy.

## Release criteria still outstanding

1. Load the model-inclusive unpacked MV3 build in actual Chrome; verify worker import, CSP, screenshot capture, denial, consent revocation and post-action observation end to end.
2. Run the Chromium resolver harness and model worker on real screenshots across low/mid/high-end devices; measure cold load, steady-state p50/p95, peak renderer RSS, teardown, full-page/crop behavior, and the cost of each capture/IPC step.
3. Evaluate a labeled browser task corpus against DOM-only and DOM+Mirage: target-selection correctness, task completion, false confirmation, inconclusive rate and repeated-action safety. This PR's exact OCR match is intentionally only an observation.
4. Run live agent testing only against the repository-prescribed local LM Studio model. No hosted model benchmarks or provider spending were performed.
5. Retain runtime/model Apache-2.0 notices when distributing the optional assets. The original metadata gap is resolved by the newer, hash-matched licensed model revision; see the provenance update above.

The implementation remains opt-in and should stay experimental until these checks pass. The included data cannot support a claim that Mirage improves real-world browser task success or user-perceived latency.

## Bundle footprint

Measured on the two actual Vite production build directories, same installed dependencies:

| Build | Uncompressed bytes |
|---|---:|
| Original | 17,562,520 |
| Changed, excluding optional model assets | 17,570,763 |
| Changed, including prepared model/runtime/license assets | 40,558,359 |
| Optional assets alone | 22,987,596 |

The integration adds 8,243 bytes of compiled code with assets excluded. Counts include all files in each `dist/`; they are not compressed CRX/network transfer size or process memory. Mirage assets are absent from the PR and normal clean builds. Both builds reported existing chunks over Vite's 500 kB advisory limit.

## Decision experiment follow-up

The [image-only decision benchmark](mirage-decisions.md) separately evaluates fixed visual classes, abstention, label-order sensitivity, read-tool hints and reversible visual-record encoding. It does not measure semantic chat routing, generated tool arguments, or conversation summarization.
