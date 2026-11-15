# Shadow DOM action benchmark

## What changed

The indexer already traverses open shadow roots, but the original action functions only queried `document`. Click, type, select and scroll-to-element now search open roots on a light-DOM miss. Each injected function remains self-contained. Key dispatch follows the deepest focused element. Input and keyboard events cross shadow boundaries, matching native composed events; `change` stays non-composed. Closed roots remain inaccessible. Snapshot and session cleanup also remove old stamps throughout all open roots, including hidden controls and roots beyond the snapshot cap; this prevents stale IDs from targeting the wrong node. Snapshot refresh and explicit index cleanup also strip stamps throughout open roots, including hidden controls and controls outside a newly reduced indexing cap, so a stale shadow index cannot collide with a reassigned one. No permissions, action classification, approval or undo lifetime rules change.

The resolver uses a native light-DOM selector fast path and an iterative tree walker on misses. It avoids retaining a stale cross-action node cache and avoids allocating a list of every element in each root. The cost of a miss grows with page size; no claim of universal speedup is made.

## Reproduce

```sh
# On this Linux host npm ci fails on pre-existing optional-package lock entries.
# Recorded runs used this workaround without changing package-lock.json:
npm install --ignore-scripts --package-lock=false --no-audit --no-fund
npm test -- src/platform/pageActions.test.ts
# Actual browser measurement, on a host that permits Chromium subprocess sockets:
CHROMIUM_PATH=/usr/bin/chromium node scripts/benchmark-shadow.mjs
# Explicit simulation fallback, used for the recorded results in this PR:
DOM_BACKEND=jsdom node --expose-gc scripts/benchmark-shadow.mjs
```

The browser script launches a local headless Chromium fixture, compiles the original and changed **actual injection source** with esbuild, and calls each in the same page. Baseline is pinned to `ff3b750daa30534fb04507354c68be82d17a7e44`; override with `BASELINE_REF`. No model, website, network, or provider calls are made. Browser data is written to `shadow-browser-results.json`; simulation data uses a separate `shadow-jsdom-results.json` filename.

## Environment limitation

An actual Chromium launch was attempted. It exited before creating a page:

```
FATAL:chrome/browser/process_singleton_posix.cc:297
Check failed: . socket() failed: Operation not permitted (1)
```

This happened under the environment's escalated command runner, so **there are no measured Chromium results**. The recorded results are jsdom 29 on Node, with `scrollIntoView` stubbed because jsdom has no layout. They measure simulated DOM lookup and event dispatch, not browser latency, screenshots, extension IPC, Mirage inference, or end-to-end task completion. Do not use them to predict user-perceived performance. The runnable Chromium harness is included so the missing measurement can be collected on a suitable host.

## Recorded method

Each of eight deterministic fixtures receives 10 warmup calls per variant, followed by 20 batches of 20 calls per variant (400 measured actions per variant per fixture; 6,400 total). Batch order alternates before/after to reduce order bias. Times include resolver, synthetic mouse events and click dispatch; fixture construction and source compilation are outside the timed region. The target is in the first sibling shadow root, which the stack visits last; nested targets are in the deepest root. This deliberately exercises expensive successful searches. Light-DOM targets sit after the filler nodes.

Success requires the action's `ok` flag **and** the independent click event count; missing targets must return false without any click. p95 below is the p95 of batch means, not individual action tail latency. Small samples, shared host noise and JIT variation limit inference; these figures are descriptive, not statistical proof of speedup.

Hardware reported by container: AMD EPYC 9V74 80-Core Processor, 9 logical CPUs, 10,451,427,328 bytes total memory, linux 6.18.57 x64; Node v24.22.1. Run: 2026-11-15T09:54:27.180Z.

| Fixture | Clicks before / after (of 400) | Mean before ms | Mean after ms | p95 batch mean before ms | p95 batch mean after ms |
|---|---:|---:|---:|---:|---:|
| light-100 | 400 / 400 | 0.197 | 0.196 | 0.378 | 0.272 |
| light-1000 | 400 / 400 | 0.575 | 0.610 | 1.776 | 1.646 |
| light-10000 | 400 / 400 | 4.309 | 4.244 | 5.707 | 5.288 |
| shadow-10x100 | 0 / 400 | 0.052 | 1.369 | 0.068 | 1.798 |
| shadow-100x100 | 0 / 400 | 0.088 | 15.379 | 0.109 | 16.591 |
| nested-20 | 0 / 400 | 0.048 | 2.680 | 0.067 | 2.788 |
| missing-10000 | 0 / 0 | 4.395 | 5.397 | 7.907 | 6.489 |
| missing-shadow-100x100 | 0 / 0 | 0.094 | 19.052 | 0.171 | 23.060 |

The three shadow target fixtures improve from **0/1,200 to 1,200/1,200 actual click events**. All 1,200 light-DOM clicks succeed in both versions. Both missing-target fixtures produce zero clicks in all 800 attempts per variant. Baseline shadow failure times are fast because they do no useful action; they are not an equivalent-work latency comparison. A failed lookup over 100 shadow roots is more expensive after the fix, because it now genuinely searches them.

## Memory

The raw JSON records process memory before timing, after both variants and after explicit GC for each fixture (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`). Retained heap deltas range from about -18 KB to +3.03 MB across the combined two-variant runs. These include JSDOM/selector/JIT caches and both versions, so **they do not isolate implementation overhead and are not peak browser memory**. The real-browser path records Chrome `Runtime.getHeapUsage` with the same caveat. Per-variant peak renderer memory and multi-tab memory remain unmeasured.

## Regression coverage

`src/platform/pageActions.test.ts`: 12 tests pass. New cases cover nested click/scroll, native field setter and prior-value restoration, composed input propagation, select change dispatch and prior value, detached and closed-root rejection, deep focus and prevented Enter submission. Existing wrong-control and light-DOM behavior tests remain passing. Three additional domIndex regression tests cover stale shadow stamp removal on visibility changes, reduced indexing caps, and explicit cleanup. The resolver benchmark does not measure snapshot cleanup overhead. The tests execute extracted production injection bodies, so missing module closures cannot silently pass.

The benchmark addresses the shadow resolver only. It does not establish Mirage OCR accuracy, target grounding quality, post-action semantic verification, or safe autonomous task success.

Three additional `domIndex.test.ts` regressions cover hidden shadow controls whose IDs are reassigned, stale stamps beyond a reduced snapshot cap, and explicit open-root cleanup. The recorded action benchmark does not include the additional snapshot cleanup cost.
