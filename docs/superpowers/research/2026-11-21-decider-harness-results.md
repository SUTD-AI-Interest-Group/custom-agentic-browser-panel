# Decider harness: results

**Date:** 2026-11-22 · **Branch:** `worktree-decider-harness` at `3b8f3fd` · **Spec:**
`docs/superpowers/specs/2026-11-21-decider-harness-design.md` (§9 is the bar used here) ·
**Machine:** M4 Max 64 GB, Chrome for Testing (Playwright build), onnxruntime-web WebGPU.

Every number below comes from a run made for this report (commands in §1) or from a cited file
(§13).
- **Decider:** `strands-decider-E2B-gemma4-v2-2611`, 8-bit, on WebGPU in the panel's worker.
- **Chat model:** the agent's own model. Either LM Studio `google/gemma-4-26b-a4b` (Gemma) or
  Anthropic `claude-sonnet-5-5` (Sonnet).

> **Update (Task 17): driver mode, measured end to end, is in §14.** It is accurate: 0 wrong
> actions in 37 executed steps. But it is not faster across the suite: with Gemma the median is
> +0.7 s per task. The one exception is the local model on multi-step store flows: −6 s per task,
> −2.5 chat steps, −13k tokens. §14.7 gives the causes and the fixes.

## Summary

**The decider meets all four parts of the spec's go/no-go bar for driver mode**, on 173
answer-keyed steps from three runs:

| Criterion (spec §9) | Bar | Measured | Verdict |
|---|---|---|---|
| Answer-keyed steps | ≥ 150 | **173** (Gemma 37 + Sonnet 43 + Gemma extra 93) | **PASS** |
| Decider accuracy at p ≥ 0.6 | ≥ 85% | **97.2%** (137/141), 95% CI 93–99 | **PASS** |
| Within 5 points of Sonnet on the same steps | \|Δ\| ≤ 5 | Sonnet run, p ≥ 0.6: decider **96.9%** vs Sonnet **96.9%** (31/32 each), Δ 0. All 43 Sonnet-run steps: 93.0% vs 90.7%, +2.3 | **PASS** |
| Accuracy rises with confidence | monotone | **71% → 83% → 93% → 98%** over p < 0.4 / 0.4–0.6 / 0.6–0.8 / ≥ 0.8 (n 14 / 18 / 29 / 112); AUROC 0.84 | **PASS** |

The harness's own scores, before the two corrections in §5.1, give the same four verdicts:
181 steps, 94.6% at p ≥ 0.6, a 36/40 tie with Sonnet, and a rising curve
71 / 83 / 87 / 97%.

**Three findings matter most:**

1. **On the same steps, the decider is as accurate as the chat models, in about 0.2 s.** Overall
   it scored 93.6% against the chat models' 94.2%. In the Sonnet run it scored 93.0% against
   Sonnet's 90.7%. Warm latency is 168 ms p50 under 600 tokens, and LM Studio generating on the
   same GPU barely moves it. The two err in **different places and never on the same step**:
   - On the store the decider wins, 98.5% vs 84.6%. The chat models were misled by a stale
     "Cart (0)" header, clicked the wrong link, or used `navigate` shortcuts.
   - On forms the chat models win, 100% vs 87.5%.
2. **All 4 of the decider's confident errors are one blind spot: unticking a pre-ticked box.**
   The newsletter form has "Deals" ticked and the goal says "Audio only". The decider never
   proposes clicking the ticked box: it ticks "Kitchen" or submits instead, at p 0.63–0.91. The
   lookup-fill pass has the same gap, since it ticks but never unticks. Pre-ticked marketing
   boxes are common on real forms, so fix this **before** building driver mode. The likely fix
   is to name the outcome in the option (`untick [7]`) instead of the mechanism (`click [7]`);
   it can be measured offline (§6.1).
3. **The harness itself had scoring and fixture defects, now identified.** None of them changes a
   verdict, but each one distorted specific scores.
   - Keys were computed on a pre-fill registry after `AutofillForm` (11 steps).
   - Parallel tool calls raced on the page (8 Sonnet calls).
   - The store's "Cart (0)" header never updates after an add.
   - The **set-of-marks misalignment is a harness artifact.** Playwright's viewport emulation
     reports a device-pixel ratio of 1 while the capture is 2×. In a normal browser the boxes
     align (§11).

Assist (lookup filling) worked whenever it was used. Gemma took the path in 2 of 4 form tasks
and all 12 fields were right. Sonnet never took it: it always passed its own `fields`.
Separately, `AutofillForm` with `fields` failed on every `<select>` (3/3), a pre-existing bug.
The screenshot variant (Task 14) is **not integrated**: it gave no accuracy gain, did measurable
harm, and cost 2.9× the latency.

**Read with care:**
- The 173 steps come from 16 small synthetic fixtures. Many form states recur across runs, so
  the steps are not independent and the confidence intervals are optimistic.
- Real pages are larger than these fixtures. They will push states into the 600–2,500-token
  range, where the fixtures gave few samples.
- The bar is met; whether to build driver mode is the user's decision (spec §9).

## 1. What was run

| Run | Command | Output |
|---|---|---|
| Repo checks | `npm run typecheck && npm test && npm run build`; `node --test scripts/decider-eval/` | all green (§2) |
| Gemma | `node scripts/decider-eval/run.mjs --arms shadow,assist --reps 1` | `scripts/decider-eval/out/2026-11-21T18-16-01-372Z/` (35 min) |
| Sonnet | `node scripts/decider-eval/run.mjs --arms shadow,assist --reps 1 --provider anthropic --cap 10` | `scripts/decider-eval/out/2026-11-21T18-51-49-590Z/` (15 min) |
| Gemma extra | `node scripts/decider-eval/run.mjs --arms shadow --reps 2` | `scripts/decider-eval/out/2026-11-21T19-13-50-460Z/` (50 min) |
| Self-test, synthetic latency, set-of-marks check | scratchpad `t13/latency_marks.mjs` (fresh profile, model imported over a local server) | scratchpad `t13/latency_marks.json`, `t13/marks-*.png` |

**Gemma extra** was not in the task brief. One pass of both providers gave 80 scored steps,
short of the spec's 150, and a local pass costs nothing.

Every run made its own fresh Chrome profile and imported the model into OPFS through Settings →
Experimental → Import from URL. Each run deleted its profile afterwards. The Sonnet run first
scrubbed the API key from the profile; the log shows "settings scrubbed".

The scores in §5 to §8 are recomputed from the runs' `results.json` by two scratchpad scripts,
`t13/rekey.mjs` and `t13/analyze.py`. They correct two scoring defects in the harness that this
report found (§5.1). The harness's own uncorrected numbers are given beside them.

## 2. Repo checks

- `npm run typecheck`: clean.
- `npm test`: **193 files, 2503 tests passed, 1 skipped.**
- `npm run build`: clean.
- `node --test scripts/decider-eval/` (answer keys and scoring): 42/42 passed.

## 3. Runtime: parity, import, latency

### 3.1 Parity (spec §9: max |Δp| ≤ 0.05 and 0 top-1 flips)

| Check | Result | Source |
|---|---|---|
| JS tokenizer vs the checkpoint's ids, every text-only golden row | 0 mismatches / 430 rows | Task 2 report |
| Exported files vs golden vectors (numpy + ORT, the same int8 tables) | 60 rows, 180 questions, max \|Δp\| 0.0245, 0 flips | Task 1 report |
| In the browser: Settings → Run self-test (WebGPU, OPFS tables, JS tokenizer) | **Pass · 5 rows · max \|Δp\| 0.0136 · 0 flips · webgpu**, median 94–98 ms | this report (twice); Task 6 got the same 0.0136 on 8 runs |

**PASS.**
- The in-browser self-test covers only the 5 golden rows in `selftest.json`.
- The 60-row check ran the same tables through ORT on the CPU, not on WebGPU.

### 3.2 Import

The model is 4.6 GB on disk: torso 2.11 GB, PLE table 2.39 GB, embed table 0.41 GB and
tokenizer 32 MB. An import into a fresh profile from a local server, SHA-256 verified, took
**12, 15, 18 and 35 s** in this report's four fresh profiles. Task 6 measured 9.1–10.1 s. The
spread is machine load: the 35 s import overlapped LM Studio loading its model. Over a real
network the import will be bound by download speed.

Loading the model from OPFS into the worker (session creation) took 1.6 s here, and 1.5–2.0 s in
Task 6.

### 3.3 Latency

**Real page states.** These are shadow records from all three runs, 187 next-action decisions
and 13 lookups. `ms` excludes the model load. "Cold" is a panel's first decision after boot.

| Kind | Tokens | n | Warm p50 | Warm p95 | Cold |
|---|---|---|---|---|---|
| next action | < 600 (316–597) | 157 | **168 ms** | 433 ms | 53 cold, median 260 ms (127–935) |
| next action | 600–1400 (604–700) | 26 | **225 ms** | 336 ms | 1 cold, 674 ms |
| next action | > 2500 (dense catalog, ≈ 3,540) | 4 | — | — | all cold: 1494, 2245, 2716, 2996 ms |
| form lookup (7–8 fields) | 948–1281 | 13 | 438 ms | 803 ms | 430, 539, 539, 699 ms |

No real state fell between 1,400 and 2,500 tokens: the fixtures are small, and only
`dense-catalog` is big.

**Synthetic states fill that gap.** A next-action request was built by the extension's own
`state.ts` at k = 10, 47 and 100 elements, with the spike's flight-search labels and 1,200
characters of page text. Each ran 8 times through the self-test path, in a fresh profile, with
the GPU otherwise idle. Token counts come from the extension's tokenizer.

| k elements | Tokens | Median of 8 (two runs) | Spike (Appendix A) |
|---|---|---|---|
| 10 | 662 | **186 ms**, 186 ms | 276 ms at 563 tokens |
| 47 | 1,363 | **413 ms**, 433 ms | 688 ms at 1,375 |
| 100 | 2,417 | **837 ms**, 832 ms | 1.31 s at 2,619 |

At the same size, the shipped runtime is about 35–40% faster than the spike.

**Against the spec's bars** (WebGPU, warm):

| Bar | Measured | Verdict |
|---|---|---|
| Next action ≤ 300 ms p50 at ≤ 600 tokens | 168 ms (real); 186 ms at 662 tokens (synthetic) | PASS |
| Next action ≤ 800 ms at ~1,400 tokens | 413–433 ms at 1,363 tokens (synthetic) | PASS |
| 7-field lookup form ≤ 400 ms | form-contact (7 fields, 1,119 tokens): 397 and 405 ms with the GPU free; p50 648 ms with LM Studio generating | at the bar with the GPU free; FAIL under contention |

**GPU contention (spec §5.5).** In the Gemma runs, LM Studio generates on the same GPU; in the
Sonnet run nothing else uses it.
- **Small states barely move.** Under 600 tokens the warm p50 is 183 and 165 ms in the two Gemma
  runs, against 170 ms with Sonnet. A shadow decision fires as the tool executes, before
  LM Studio has a tool result to start on.
- **Long passes slow down.** The lookup pass goes from a warm p50 of 397 ms to 648 ms. The
  dense-catalog decision takes 1.5 s with the GPU free and 2.2–3.0 s under contention.
- Nothing like October's 26 s Von pass was seen.

**Dense pages.** Driver mode's 2,500-token cap (§7.3) would have handed the dense catalog
(≈ 3,540 tokens) back to the chat model.

## 4. End-to-end tasks

There are 16 tasks. The `assist` arm runs only on the 4 form tasks.

| Provider | Arm | Runs | Success | Wall p50 (mean) | Chat steps (per task) | Step p50 | Tokens in (cached) / out | Cost (est.) |
|---|---|---|---|---|---|---|---|---|
| Gemma | shadow | 16 | 10/16 | 72 s (84 s) | 168 (10.5) | 7.1 s | 886k (0) / 41k | $0 |
| Gemma | assist | 4 | 3/4 | 123 s (132 s) | 42 (10.5) | 9.7 s | 241k (0) / 14k | $0 |
| Gemma extra | shadow ×2 | 32 | 27/32 | 74 s (81 s) | 363 (11.3) | 6.4 s | 2,046k (0) / 82k | $0 |
| Sonnet | shadow | 16 | **16/16** | **30 s** (34 s) | 150 (9.4) | 2.5 s | 1,537k (787k) / 16k | $1.74–2.12 |
| Sonnet | assist | 4 | 4/4 | 32 s (34 s) | 36 (9.0) | 2.8 s | 393k (198k) / 5k | $0.46–0.56 |

**Sonnet spend: $2.68** (upper estimate; $2.20 lower) of the $10 cap. The cap was not reached.
Across all three passes, Gemma's shadow success was 37/48 (77%).

The same four form tasks under both arms:

| Provider | Arm | Success | Wall p50 | Chat steps | ControlPage calls |
|---|---|---|---|---|---|
| Gemma | shadow | 3/4 | 100 s | 51 | 21 |
| Gemma | assist | 3/4 | 123 s | 42 | 18 |
| Sonnet | shadow | 4/4 | 32 s | 36 | 12 |
| Sonnet | assist | 4/4 | 32 s | 36 | 12 |

Sonnet's two arms are identical because Sonnet never took the assist path (§7).

**Why Gemma fails.** None of these failures is the decider's doing: shadow mode never acts.
- **Page control without a session.** The model calls `ControlPage` without `RequestPageControl`,
  gets "No page-control session is open", and loops on `ToolSearch`. This is the spike's shop
  failure again (spec Appendix A).
  - The first Gemma run had 24 such calls across 7 rows. Three of those rows recovered.
  - Four tasks failed outright this way: shop-mug, form-contact, inbox-order and
    form-shipping/assist.
- **Narrating instead of acting.** In shop-qty it asked "…Is that okay?". In nav-warranty it
  repeated "I'll click on 'Product warranty'" without ever calling a tool.
- **The store's stale header.** After an add, the product page still says "Cart (0)". In
  shop-cheapest Gemma clicked "Add to cart" again, and the task failed; the decider's top pick
  there was `done`.
- **Wrong link, then a false claim.** In the extra run's shop-mug (both reps), Gemma clicked
  "Cart (0)", element [3], on the search results instead of [4] "Aurora mug (blue)". The decider
  picked [4] at p 0.97. In rep 2 Gemma then replied "I have added the blue Aurora mug to your
  cart" from the empty cart page.

## 5. Accuracy against the answer keys

### 5.1 Two scoring corrections

Reading the per-step records turned up two defects in how the harness scores steps. Both affect
specific steps that can be checked, so the tables below are corrected. Both are harness-only;
neither touches `src/`.

1. **A stale registry after `AutofillForm`.** The key for a step is computed from the latest
   earlier tool output that carries `elements`. `AutofillForm`'s result carries none. So a step
   after a fill was keyed against the **pre-fill** form, and the key asked for every field to be
   typed again.
   - Example: in Gemma form-contact/assist the decider filled six fields, then both models
     clicked Send. The harness scored both wrong because the key wanted "type Full name".
   - **Fix:** `rekey.mjs` applies each `AutofillForm`'s reported fills to the registry and
     recomputes the key with the harness's own `keys.mjs`. It does this only when the fill ran
     in an **earlier** model step; the AI SDK finishes a step's tools before the next step starts.
   - This re-keyed **11 steps**: 4 Gemma, 7 Sonnet, and none in the extra run.
2. **Parallel tool calls.** Sonnet often issues `AutofillForm` and one or two `ControlPage` calls
   **in the same model step**. The SDK runs them concurrently on the same page, so the decider's
   snapshot is taken mid-race.
   - In all 8 such calls the decider saw the empty form with no history. It picked the first
     empty field at p 0.80–0.98: correct for the page it saw, unrelated to the batch in flight.
   - "The state before this action" has no single value here.
   - **Fix:** these **8 calls** are excluded from the scores and listed in §5.6.

The verdicts in §8 are the same with or without the corrections.

### 5.2 Decider vs chat model on the same steps (2×2)

This covers every keyed `ControlPage` step that has a decider decision: 173 steps. "Chat" is
whichever chat model drove that run.

| Run | Family | n | Both right | Chat only | Decider only | Both wrong | Chat acc | Decider acc |
|---|---|---|---|---|---|---|---|---|
| Gemma | all | 37 | 32 | 3 | 2 | 0 | 94.6% | 91.9% |
| Sonnet | all | 43 | 36 | 3 | 4 | 0 | 90.7% | **93.0%** |
| Gemma extra | all | 93 | 84 | 5 | 4 | 0 | 95.7% | 94.6% |
| **Pooled** | **all** | **173** | **152** | **11** | **10** | **0** | **94.2%** | **93.6%** |
| Pooled | store | 65 | 54 | 1 | 10 | 0 | 84.6% | **98.5%** |
| Pooled | form | 80 | 70 | 10 | 0 | 0 | **100%** | 87.5% |
| Pooled | nav | 13 | 13 | 0 | 0 | 0 | 100% | 100% |
| Pooled | inbox | 15 | 15 | 0 | 0 | 0 | 100% | 100% |

At p ≥ 0.6 (141 of the 173 steps), the decider scored **97.2%** and the chat models scored
95.7% on the same steps.

The raw harness numbers (uncorrected, 181 steps): chat 91.2%, decider 91.7%, and at p ≥ 0.6 the
decider scored 94.6% (141/149).

Overall the two are equally accurate, but they **fail in different places and never on the same
step**: after correction there is no "both wrong". The decider wins on the store; the chat
models win on forms. §6 explains why.

### 5.3 Calibration

Decider top-1 accuracy by its own confidence, over the same 173 steps:

| p bucket | < 0.4 | 0.4–0.6 | 0.6–0.8 | ≥ 0.8 |
|---|---|---|---|---|
| Gemma | 4/5 | 1/2 | 7/8 | 22/22 |
| Sonnet | 3/4 | 6/7 | 5/5 | 26/27 |
| Gemma extra | 3/5 | 8/9 | 15/16 | 62/63 |
| **Pooled** | **71.4%** (10/14) | **83.3%** (15/18) | **93.1%** (27/29) | **98.2%** (110/112) |
| Raw harness, pooled | 71.4% (10/14) | 83.3% (15/18) | 86.7% (26/30) | 96.6% (115/119) |

At 0.1 width (pooled):

| p | 0.2–0.3 | 0.3–0.4 | 0.4–0.5 | 0.5–0.6 | 0.6–0.7 | 0.7–0.8 | 0.8–0.9 | 0.9–1.0 |
|---|---|---|---|---|---|---|---|---|
| right / n | 2/2 | 8/12 | 4/5 | 11/13 | 11/13 | 16/16 | 42/43 | 68/69 |

- Mean top-1 p is 0.81 when the decider is right and 0.54 when it is wrong.
- As a right/wrong separator, top-1 p has an **AUROC of 0.84**: 0.88 and 0.89 in the Gemma runs,
  0.76 in the Sonnet run.

Accuracy rises steadily with confidence. Above 0.8 the decider is wrong 2 times in 112.

### 5.4 Coverage at p ≥ 0.6

Coverage is the share of all next-action decisions, keyed or not, whose top p is at least 0.6:
the steps driver mode would have taken itself.

| Run | Shadow | Assist |
|---|---|---|
| Gemma | 80% (24/30) | 88% (7/8) |
| Sonnet | 77% (30/39) | 83% (10/12) |
| Gemma extra | 85% (83/98) | — |
| **Pooled** | **82%** (154/187) | |

### 5.5 Agreement (the production metric)

Agreement with the chat model's own action, over every judged next-action record:
- Gemma run: **88.9%** (32/36).
- Sonnet run: **68.6%** (35/51).

Sonnet's figure is low because of the 8 parallel calls (§5.6) and 4 cart checks (§6.2). Yet in
that same run the decider was the *more* accurate of the two: 93.0% vs 90.7%. That is the case
the spec warned about: going by agreement alone, the decider would have looked worse.

### 5.6 The excluded parallel calls

| Task / arm | Chat call | Pre-step key | Decider top-1 (p) |
|---|---|---|---|
| form-contact / shadow | select [6] | type 3, 4, 7; select 6; click 8 | type [3] (0.98) |
| form-contact / shadow | click [8] | type 4, 7 | type [3] (0.98) |
| form-contact / assist | click [8] | type 3, 4, 7; select 6; click 8 | type [3] (0.98) |
| form-sales / assist | select [6] | type 3, 4, 7; select 6 | type [3] (0.96) |
| form-shipping / assist | select [6] | type 2–5; select 6; click 8, 11 | type [2] (0.80) |
| form-newsletter / shadow | click [5] | type 2–4; click 5, 7 | type [2] (0.95) |
| form-newsletter / shadow | click [7] | type 3, 4 | type [2] (0.95) |
| form-newsletter / assist | click [5] | type 2–4; click 5, 7 | type [2] (0.94) |

Where two calls were batched with the fill, their records are 1 ms apart with identical token
counts and probabilities. Both snapshots were taken before the concurrent fill wrote anything.

Driver mode would not have this problem, since it acts one step at a time. Production shadow
stats, though, will under-count agreement whenever the chat model batches.

## 6. Where each model goes wrong, and why

### 6.1 The decider's wrong picks (11 of 173)

| Pattern | Count | p | Example |
|---|---|---|---|
| **Does not untick a pre-ticked box** | 5 | **0.60, 0.63, 0.70, 0.81, 0.91** | form-newsletter: ticks [6] "Kitchen" (unchecked) or clicks Subscribe; the key is click [7] "Deals" (checked) |
| Torn between Send and re-typing the filled message | 3 | 0.32, 0.33, 0.35 | form-sales: type [7] "How can we help?" `= "Do you offer volume discounts?"`; the key is click [10] Send |
| Fills the optional phone before continuing | 2 | 0.31, 0.55 | form-shipping: type [9] "Phone (optional)"; the key is the terms box, then Continue |
| Search not yet submitted | 1 | 0.43 | shop-cheapest: scroll; the key is click [2] Search |

At p ≥ 0.6 the decider made **4 errors in 141 steps, and all 4 are the untick case.**

**Unticking a pre-ticked box.**
- **What happens.** The newsletter goal is "interested in Audio only", and "Deals" starts
  ticked. The decider never proposes clicking the ticked box: `click [7]` never reaches its top
  two, and where it shows in the top three its p is 0.04. It picks the next *unticked* box
  ("Kitchen") or goes straight to Subscribe.
- **Seen before.** The diag's 37 states had the same single confident error
  (form-newsletter4, p 0.92), and adding the screenshot did not fix it (Task 14).
- **Why.** The option reads `click [7] — <input> checkbox "Deals" (checked)`. Two inferences are
  needed: that clicking a *checked* box removes a choice, and that "only" requires removing it.
  The model does not make them.
- **Why it matters.** Pre-ticked marketing boxes are common on real forms. This is the one
  failure that matters for driver mode, and it is confident, so the gate would not catch it.
- **Fix.** Name the outcome, not the mechanism: `untick [7]` / `tick [7]` for checkboxes. That
  is the lesson of the 1/6 → 6/6 diagnosis (§10). It is a pure `state.ts` framing change and can
  be scored offline on the diag states plus these newsletter states before anything is built.
  - A safe interim rule for driver mode: a click on a *checked* box always hands back.

**The other three patterns are all below 0.6**, so driver mode would hand those steps back, which
is the safe outcome.
- **form-sales Send.** The form leaves two things open on purpose: an unrequested "I agree to be
  contacted" box and an optional phone. The decider cannot tell whether it is finished. The
  diag's form-sales4 had the same near-tie (p 0.28).
- **Optional phone.** "Fill in the shipping form with my details" arguably does include the
  phone; Sonnet filled it too. The key never keys optional fields, so this is partly the key
  being strict.

### 6.2 The chat models' wrong picks (10 of 173)

| Pattern | Count | Chat did | Key | Decider (p) |
|---|---|---|---|---|
| Stale "Cart (0)" after an add | 5 | Sonnet ×4 opened the cart to check; Gemma ×1 added again (task failed) | done | done ✓ (0.26–0.68) |
| Wrong link: clicked [3] "Cart (0)" next to [4] "Aurora mug (blue)" | 2 | Gemma extra, shop-mug on the search page, both reps | click [4] | ✓ (0.97, 0.97) |
| `navigate` to the product URL | 3 | Gemma: a shortcut the key never accepts | click Add to cart / the product link | ✓ (0.83–0.96) |

- **Five of the ten come from one fixture defect.** The store header shows "Cart (0)" after an
  add because it is rendered once at page load and never updated.
- **Sonnet's check is harmless**, arguably prudent. Gemma's double add failed the task.
- **The decider said `done` every time, at low confidence (0.26–0.68).** That fits a state that
  looks contradictory.
- **Without this defect** the store family would likely be close to a tie.
- **On forms the chat models made no keyed errors.**

## 7. Assist: lookup form-filling

**Did the chat model take the assist path** (`AutofillForm` with no `fields`, so the decider
maps the form)?
- **Gemma: 2 of 4** form tasks (form-contact and form-sales). Both calls came in the step right
  after `RequestPageControl` returned the grant note (Ruling 15). Both tasks succeeded, with
  every field correct.
  - In form-shipping Gemma never opened a session.
  - In form-newsletter it filled step by step with `ControlPage`.
- **Sonnet: 0 of 4.** It called `AutofillForm` **with** its own `fields` every time, even with
  the grant note in front of it. So Sonnet never exercised the decider path; its fills were
  shadowed instead.

**Field accuracy of the decider's mapping.** The mapping is deterministic for a given form, so the
per-form result is the same in every run.

| Form | Mapped right / fields with a target | Notes |
|---|---|---|
| form-contact, assist path (with `values`) | **6/6** | also filled the optional phone (p 1.00), which was not requested |
| form-sales, assist path | **6/6** | left the phone empty, as "Don't include my phone number" asks (p 0.97) |
| form-contact / form-sales, shadowed (no `values`, because the chat passed `fields`) | 5/6 | the message has no source without request values, so it was left (p 0.27–0.29), not misfilled |
| form-shipping, shadowed | 6/7 | the Express radio is not in the fill pass (radios are not asked); the optional phone was filled |
| form-newsletter, shadowed | 5/6 | picked the personal email over the work email ✓; **left Deals ticked**: the pass ticks, never unticks |

- **No wrong-value fills.** No field received another field's value at p ≥ 0.6.
- **Where the chat model filled a field itself, the decider's choice matched its value 34 times
  out of 34** (8 Gemma, 26 Sonnet).
- The untick gap from §6.1 shows up here as a gap in what a fill can do.

**Cost.**
- One lookup pass is 948–1,281 tokens. It takes 308–505 ms warm with the GPU free, 648–803 ms with
  LM Studio busy, and 430–699 ms cold.
- On LM Studio, the first use in a panel also makes a structured-output `profileLookup` call to
  the chat model. The model steps that issued the assist `AutofillForm` took 38 s and 54 s.
- That is why Gemma's assist wall time is longer despite fewer steps. On form-sales: 151 s and 8
  steps with assist, 85 s and 12 steps without.

**A pre-existing bug, not the decider's.** `AutofillForm` **with fields** failed on the `<select>`
in **3 of 3** calls that included one (Country, and Topic twice), returning `left: failed`. The
chat model then had to use `ControlPage select`. The decider path filled the same selects
correctly, as `option.N`.

## 8. Go / no-go for driver mode (spec §9)

| Criterion | Bar | Corrected (primary) | Raw harness | Verdict |
|---|---|---|---|---|
| Answer-keyed steps | ≥ 150 | 173 | 181 | **PASS** |
| Decider accuracy at p ≥ 0.6 | ≥ 85% | 97.2% (137/141), CI 93–99 | 94.6% (141/149), CI 90–97 | **PASS** |
| Within 5 points of Sonnet on the same steps | \|Δ\| ≤ 5 | Sonnet-run steps at p ≥ 0.6: 96.9% vs 96.9% (31/32 each), Δ 0. All Sonnet-run steps: 93.0% vs 90.7%, +2.3 | 90.0% vs 90.0% (36/40 each), Δ 0 | **PASS** |
| Accuracy rises with confidence | monotone | 71 → 83 → 93 → 98%; AUROC 0.84 | 71 → 83 → 87 → 97% | **PASS** |

How the steps were counted:
- A step counts when it was answer-keyed, the decider decided it, and it was not a parallel call
  (§5.1).
- "Same steps" means the Sonnet run's steps, the only run that has Sonnet's choices. That sample
  is small: 32 steps at p ≥ 0.6, 43 overall.
- Steps where the decider was never asked are outside every count: 37 answer-keyed Gemma calls
  made without a session, which return before the hook by design.

**What this does and does not say.** The proposed bar is met on these fixtures. The bar does not
weigh *what kind* of error the decider makes, and its four confident errors are all one failure
mode that real forms will hit (§6.1). Before the user decides on driver mode:
1. Fix the untick framing and re-score it offline.
2. Keep §7.3's banded gate, and hand back on any click of a checked box until the fix is proven.
3. Get a sample of real pages. These fixtures stop at 700 tokens apart from the dense catalog.

## 9. Screenshot input (Task 14): not integrated

Source: scratchpad `shot/RESULTS.md`; Ruling 16.

The test added the viewport screenshot to each decision on 37 diag states, run on the reference
engine with its vision tower.
- **Accuracy.** It never fixed a wrong pick and broke 2.
  - Text alone: 36/37 top-1, with 30 right / 1 wrong at p ≥ 0.6. With the screenshot: 34/37, and
    27 / 1.
  - Mean p(gold) moved **−0.033** (95% CI −0.073 to +0.008), which rules out any gain above
    about +0.01.
- **The harm comes from the content.** A blank image moved p(gold) by only −0.002. The real
  screenshot pulls probability toward fields and boxes that *look* empty or unticked, whether
  the goal wants them or not. The v2 checkpoint was trained on text only.
- **It also did not fix the untick error:** form-newsletter4 stays at p 0.90–0.92.
- **Cost on WebGPU.** About +360 ms per decision at a typical 540 tokens (2.9×): 265 ms for the
  q4f16 vision encoder plus 258 extra torso tokens. It also adds 99 MB of download and
  1.0–1.7 GB of peak memory.

**Verdict: not integrated.** Revisit only with a checkpoint trained on screenshots.

## 10. How agreement went from 1/6 to 6/6 (diagnosis)

Source: scratchpad `diag/REPORT.md`, `diag/tables.md`.

The first real-browser shadow run (Task 10) agreed with the chat model on **1 of 6** form steps.
The decider picked `type into [3]` (Full name) at every step, even after it was filled. The
diagnosis rebuilt the extension's exact requests byte for byte and ran ablations on the fp32
reference.

- **Root cause: `previous_actions` had no values.** The journal summary says only
  `typed into "Full name"`. The decider treats a field as done only when the goal's value
  appears in its history. Without the value, the option `type into [3] … = "Ada Lovelace"`
  matches the goal best at every step.
  - Removing `previous_actions` entirely gives the same 1/6, so the summaries told it nothing.
  - An empty value slot (`typed "[redacted]"`) still gives 1/6.
  - With the real value it gives 6/6.
- **Second defect: page text joined with spaces.** Text such as "Arc wireless headphones — $64
  Nimbus wireless headphones — $95" made the decider pick Nimbus at p 0.96. Joining text blocks
  with ` | ` fixed it.
- **Third: a 6-action window** dropped early fields on 8-step forms. A window of 10 fixed it.

On 37 states, confident right/wrong went from 10/7 as shipped to **30/1** with all three fixes
plus `ticked`/`unticked` lines for checkbox clicks. That landed as `3b8f3fd` (Task 10b), and its
browser re-check agreed 6/6 at a p50 of 194 ms.

The runs in this report are the first full benchmark of that fixed state, and the same lesson
explains §6.1. The decider reads the *history* and the *option text* to judge what is done and
what an action will do. It needs the **outcome** spelled out ("typed X", "ticked", and next,
"untick"), not the mechanism ("typed into", "click").

## 11. Spec §8 bug list

| Item | Status |
|---|---|
| Unticked checkbox shown as `= "on"` | **Fixed** (Task 7). Registries in these runs show `(checked)`/`(unchecked)`. |
| Set-of-marks boxes misaligned (Sonnet's report) | **Confirmed as a harness artifact**, checked in the browser (below). |
| The Anthropic profile's `thinking: disabled` rejected by claude-sonnet-5-5 | Out of scope. Not hit: the Sonnet run finished 20/20 tasks with no 400. |

**The set-of-marks check.** I captured form.html with `captureVisibleTab` and drew the boxes
with `marks.ts`'s exact formula (`rect × devicePixelRatio × downscale`):

| Setup | Page | `devicePixelRatio` | Capture | Real scale | Boxes |
|---|---|---|---|---|---|
| The eval harness: Playwright `viewport: 1280×900` | 1280×900 | **1** (emulated) | 2560×1800 | 2.0 | drawn at **half size, in the top-left quarter** |
| No emulation (`viewport: null`), like a user's browser | 1200×1159 | 2 | 2400×2318 | 2.0 | on the right elements |

- **Why.** Playwright's viewport emulation reports a device-pixel ratio of 1, but
  `captureVisibleTab` still returns the real 2× Retina surface. So in the harness every
  set-of-marks image is off by a factor of 2. In a real browser the boxes align.
- **It cost Sonnet a step in this run.** Its `ReadPage` reason in form-contact/assist was
  "Verify field indexes before filling, since the screenshot overlay looks misaligned".
- **Harness fix:** launch with `viewport: null`, or with a `deviceScaleFactor` that matches the
  screen.
- **Hardening for later (a `src/` change):** scale by `image.width / innerWidth` instead of
  trusting `devicePixelRatio`. It is robust to emulation and costs nothing.
- Images: scratchpad `t13/marks-harness-1280x900.png` and `t13/marks-no-emulation.png`.

## 12. What failed, and harness defects found

**Model behaviour (not decider faults):**
- Gemma failed 11/48 shadow tasks and 1/4 assist tasks (§4). The causes:
  - page control without a session (44 calls across both Gemma runs hit this error);
  - narrating instead of acting;
  - the stale cart header;
  - a wrong link followed by a false "added" claim.
- Sonnet never adopted the assist path (§7).

**Lychee bugs found** (outside this task's scope; `src/` untouched):
- `AutofillForm` with `fields` cannot fill a `<select>`: 3 of 3 failed (§7).
- `marks.ts` trusts `devicePixelRatio` (§11). That is correct in real browsers but fragile under
  emulation.

**Harness defects** (`scripts/decider-eval/`):
1. **Stale registry after `AutofillForm`.** Keys were computed on the pre-fill form (11 steps).
   - Fix option: have `AutofillForm` return `elements`, as `ControlPage` does. That is a `src/`
     change, and it would also help the chat model.
   - Alternative: compute the key from the page's live state instead of from tool outputs.
2. **Parallel tool calls.** Calls in one model step race on the page, so the "before" state is
   undefined. Flag them by trace step (8 calls here).
3. **The store fixture's "Cart (0)" header** never updates after an add. It misled both chat
   models in 5 keyed steps and failed one Gemma task (shop-cheapest). Fix: re-render the header
   on add.
4. **Viewport emulation** misaligns set-of-marks images (§11).
5. **Sample size.**
   - One pass per provider gives about 40 scored steps; nav and inbox give 1–2 each.
   - Real-site states would test the 600–2,500-token range, which the fixtures barely reach.
   - The answer keys are strict about harmless detours (checking the cart, filling an optional
     field, `navigate` to a known URL). Those count as "errors" for both models.

No run had a harness error, an unpaired record, a "no shadow records" row or a skipped decision.
All 200 recorded decisions (187 next-action, 13 lookup) ran on WebGPU.

## 13. Sources

- **This report's runs** (git-ignored; each `results.json` holds every step's registry, URL, key
  and both models' choices):
  - `scripts/decider-eval/out/2026-11-21T18-16-01-372Z/`
  - `scripts/decider-eval/out/2026-11-21T18-51-49-590Z/`
  - `scripts/decider-eval/out/2026-11-21T19-13-50-460Z/`
- **Corrections and analysis** (session scratchpad, may be cleared):
  - `t13/rekey.mjs`, `t13/analyze.py`
  - `t13/all_analysis.md` (corrected), `t13/raw_analysis.md` (uncorrected)
  - `t13/latency_marks.mjs`, `t13/latency_marks.json`, `t13/synth_rows.json`, `t13/marks-*.png`
- **Earlier evidence** (scratchpad): `spike/RESULTS.md`, `diag/REPORT.md`, `diag/tables.md`,
  `shot/RESULTS.md`.
- **Task reports:** `.superpowers/sdd/2026-11-21-decider-harness/task-{1,2,6,10,11,12}-report.md`.

## 14. Driver mode — end-to-end (Task 17)

**Question:** does driver mode make the agent faster end to end? In driver mode the chat model
can call `FastSteps`, and the on-device decider then takes up to 12 page steps itself.

**Short answer: not on this benchmark as a whole.** It is a modest gain on multi-step store flows
with the local chat model, and no gain with Sonnet.

| Scope | Pairs | Wall time, driver − off (median, paired) | Chat-model steps | Input tokens |
|---|---|---|---|---|
| Gemma, all 16 tasks | 16 | **+0.7 s** (mean −2.7 s) | −1 | +0.6k (mean −13k) |
| Gemma, store family | 16 | **−6 s** (driver faster in 11/16) | −2.5 | −13k |
| Gemma, store runs where FastSteps ran | 8 | **−6 s** (faster in 5/8) | **−5** | **−34k** |
| Sonnet, store family (final build) | 8 | **0 s** (faster in 5/8) | 0 | +5k |
| Sonnet, store runs where FastSteps ran | 5 | +3 s (faster in 2/5) | +1 | +19k |

**Where FastSteps runs, it is accurate and it cuts the chat model's work.**
- 37 executed steps, **0 wrong** against the answer keys.
- With Gemma it halves the chat-model steps and tokens.
- Gemma's store success rose from 12/16 to 13/16. That includes shop-cheapest going from 0/4 to
  3/4, though only one of those three wins was FastSteps choosing the product itself.

**But it saves little wall time, for three reasons:**
1. **Few tasks have the right shape.** FastSteps ran in only **2/16 (Gemma) and 3/16 (Sonnet)**
   of the whole suite. Only 3 of the 16 tasks are multi-step page flows. Forms go to assist, and
   help-site and inbox tasks take a single click.
2. **Gemma's first typed value waits for the profile.** In every Gemma FastSteps call that started
   with a `type`, that step waited **13–26 s** (median 19 s, 7 calls) for a chat-model
   profile-structuring call, although each value came from `values`.
3. **The gate hands back at Search.** In the 0.4–0.6 band, the Search submit is a point of no
   return, so it is handed back: **8 of the 15** "click Search after typing" decisions. The decider
   was right on all 15.

Sonnet's own steps are fast (about 2.5 s), so a FastSteps call that hands back after one step is
pure overhead.

### 14.1 What was run

| Run | Build | Command (`node scripts/decider-eval/run.mjs …`) | Output (`scripts/decider-eval/out/…`) | Sonnet spend |
|---|---|---|---|---|
| **A** Gemma, all tasks | `1e967d2` | `--arms off,driver --reps 1` | `2026-11-21T21-38-11-474Z` (36 min) | $0 |
| **B** Sonnet, all tasks | `ba598bd` | `--arms driver --reps 1 --provider anthropic --cap 10` | `2026-11-21T22-14-44-584Z` (12 min) | **$2.28** |
| **C** Gemma, store family | `fdfafdf` | `--arms off,driver --tasks shop-cheapest,shop-qty,shop-mug,dense-catalog --reps 3` | `2026-11-21T22-27-26-302Z` (37 min) | $0 |
| **D** Sonnet, store family | `fdfafdf` | `--arms off,driver --tasks shop-cheapest,shop-qty,shop-mug,dense-catalog --reps 2 --provider anthropic --cap 10` | `2026-11-21T23-04-19-225Z` (12 min) | **$2.42** |

**Notes on the runs:**
- **The cap was never reached.** Sonnet spent $4.69 in total, across two runs each capped at $10.
  The estimate excludes the profile-structuring calls described in the README.
- **Every run used a fresh profile and a fresh model import** (10–12 s). All decisions ran on
  WebGPU. No run had a harness error, a cancelled request or a skipped decision.

**Builds.**
- **Run A used `1e967d2`,** which predates the final-review fixes. The fixes that touch driver
  mode:
  - FastSteps no longer echoes typed values;
  - FastSteps and assist appear only once the model is ready (in the eval it always is);
  - ControlPage and AutofillForm refuse to run during a FastSteps run;
  - a box that flipped since the decision hands back;
  - the gates are NaN-safe.

  None of these changes a decision on these fixtures.
- **Run B used `ba598bd`, and runs C and D used `fdfafdf`.** `fdfafdf` changes only the erase-all
  path in `src/data/storage.ts`.

**Why runs C and D were added (not in the brief):**
- Runs A and B showed that FastSteps is only ever used on the multi-step store tasks.
- Run B's only Sonnet baseline was the Task 13 shadow run. That run predates the Task 15b
  cart-header fix. In it, Sonnet ended 4 of the 5 store tasks by opening the cart to check a
  stale "Cart (0)", which cost 2 steps each, so a comparison against it is confounded.
- Run D is the clean Sonnet comparison, at $2.42 under its own $10 cap. Run C adds repetitions on
  Gemma where FastSteps applies, at no cost.

**How wrong actions were scored** (harness, `report.mjs` `driverCalls`):
- A FastSteps result lists its executed steps as `{op, index?, p, ms, ok}` and carries no page
  content.
- In driver rows the harness copies every `decider.next` request into the results, from a passive
  listener in the panel page. Each request carries the masked page snapshot (URL and elements) that
  the service worker sent the panel.
- Each `drive` record is paired with the request it answered: they share a timestamp to the
  millisecond.
- Each executed step is matched, in order, to the decision whose top-1 is that step's `(op, index)`
  at the same rounded p.
- The step is keyed against that decision's registry, rendered by a port of `serializeRegistry`.
- **A fallback replays** from the registry the chat model last saw. It applies typed values, from
  the step's `key` or the older `actions[].value`, and box flips. It marks every step after a
  navigating click `unscoreable`.
- **All 37 executed steps were scored by capture.** None needed the fallback.

### 14.2 Gemma: off vs driver, all 16 tasks (run A)

| Family | Success off → driver | Wall p50 (s) | Chat steps p50 (total) | Tokens in p50 (total) |
|---|---|---|---|---|
| Store | 4/5 → 4/5 | 42 → 45 | 9 → 8 (42 → 39) | 40k → 41k |
| Form | 4/4 → 3/4 | 63 → 67 | 10.5 → 8 (43 → 33) | 59k → 44k |
| Nav | 3/3 → 3/3 | 66 → 70 | 11 → 11 (37 → 33) | 59k → 56k |
| Inbox | 4/4 → 3/4 | 41 → 45 | 9 → 9.5 (49 → 37) | 42k → 42k |
| **All** | **15/16 → 13/16** | **50 → 53** | **9.5 → 9 (171 → 142)** | **53k → 44k** (971k → 765k) |

**FastSteps ran in 2 tasks:**
- **shop-mug: done in one call.** It clicked Kitchen, then the blue mug, then Add to cart (card).
  The decider took 0.7 s in total. Against off: 38 → 27 s, 9 → 5 chat steps, 40k → 20k tokens.
- **shop-cheapest: typed and searched, then handed back.** The hand-back was `done` at p 0.36 on
  the results page, which was wrong but gated. Gemma finished with ControlPage. The off run had
  failed.

**Why nothing else used it:**
- **Forms:** the grant note routes them to `AutofillForm` assist. Gemma took assist in
  form-shipping and form-newsletter. Assist filled the whole newsletter form, including the
  untick, in one call.
- **Nav, inbox, shop-price, dense-catalog:** each needs one or two clicks, so the chat model
  clicked directly.

**Gemma's 3 driver failures are not driver failures.** They are shop-qty, form-contact and
inbox-library.
- Each is Gemma's known pre-grant failure (§4): it calls `ControlPage` without a session and loops
  on `ToolSearch`.
- No driver code ran in any of them.
- The off arm hit the same pattern in 4 tasks and failed 1.

**Where the time differences come from.**
- **Big wins.** The two largest (nav-warranty −47 s, inbox-order −99 s) are the off arm wandering
  through 16 and 24 steps on tasks where FastSteps never ran: chat-model variance.
- **The one large loss.** form-newsletter took +48 s. Of that:
  - an outlier first chat step took 29 s, before any page control;
  - the assist call took 34 s, including Gemma's profile structuring.

### 14.3 The store family, where FastSteps applies

**Gemma, runs A and C pooled** (16 paired runs):

| Arm | n | Success | Wall p50 | Chat steps p50 | Tokens in p50 | FastSteps used | Executed (wrong) |
|---|---|---|---|---|---|---|---|
| off | 16 | 12/16 | 47 s | 10 | 53k | — | — |
| driver | 16 | **13/16** | 47 s | **7** | **45k** | 8/16 | 23 (0) |
| driver, FastSteps ran | 8 | **8/8** | 68 s | 7 | 31k | | |
| driver, FastSteps did not run | 8 | 5/8 | 44 s | 7 | 54k | | |

| Task (Gemma) | off: success · wall p50 · steps · tokens | driver: success · wall p50 · steps · tokens · FastSteps ran |
|---|---|---|
| shop-cheapest | 0/4 · 34 s · 9.5 · 38k | **3/4** · 84 s · 9.5 · 45k · 3/4 |
| shop-qty | 4/4 · 140 s · 17.5 · 99k | 2/4 · **52 s** · 11 · 45k · 2/4 |
| shop-mug | 4/4 · 59 s · 10.5 · 65k | 4/4 · **47 s** · **5** · **20k** · 3/4 |
| dense-catalog | 4/4 · 42 s · 6 · 53k | 4/4 · 44 s · 6.5 · 60k · 0/4 |

**Sonnet, run D** (final build, 8 paired runs):

| Arm | n | Success | Wall p50 | Chat steps p50 | Tokens in p50 | Cost (upper) | FastSteps used | Executed (wrong) |
|---|---|---|---|---|---|---|---|---|
| off | 8 | 8/8 | 35 s | 9.5 | 112k | $1.21 | — | — |
| driver | 8 | 8/8 | 36 s | 10.5 | 113k | $1.20 | 5/8 | 8 (0) |

| Task (Sonnet) | off: wall p50 · steps · tokens | driver: wall p50 · steps · tokens · FastSteps ran |
|---|---|---|
| shop-cheapest | 44 s · 12 · 126k | 46 s · 11 · 120k · 1/2 |
| shop-qty | 38 s · 11 · 105k | 39 s · 11 · 121k · 2/2 |
| shop-mug | 34 s · 9 · 79k | 35 s · 10.5 · 102k · 2/2 |
| dense-catalog | 27 s · 7.5 · 119k | 22 s · 7 · 104k · 0/2 |

**Why the store results differ between the two chat models:**
- **Gemma: some of the success gain is FastSteps, some is noise.**
  - Gemma failed shop-cheapest all 4 times in off:
    - twice it never opened a session, and ended by asking permission;
    - once it narrated its plan without acting;
    - once it ended with the wrong cart while replying that it had added the Arc.
  - Driver mode won 3 of 4:
    - once FastSteps itself opened the $64 Arc from the results (p 0.77);
    - twice FastSteps typed and searched, and Gemma then chose the product.
    - The fourth driver run failed before it had a session.
  - Sonnet's FastSteps calls also opened the Arc from the results (p 0.83 and 0.87).
  - With 4 runs per arm, the shop-cheapest swing is suggestive, not proof.
  - In shop-qty and shop-mug, off runs sometimes wandered: 302 s and 35 steps, 127 s and 16 steps.
    The three FastSteps calls that reached `done` finished their tasks in 27–54 s and 5 chat
    steps.
- **Gemma: the wall-time gain is smaller than the step saving.**
  - Each FastSteps call that types first waits for the profile lookup, 13–26 s.
  - That eats most of what the saved Gemma steps would buy: 5 steps at about 6 s each, including
    tool time.
- **Gemma: one driver run took 221 s.** FastSteps typed the query and handed back at Search
  (p 0.57). Gemma then wandered through 25 ControlPage and navigate steps on its own, the same
  pattern as off's 302 s run.
- **Sonnet: FastSteps mostly stops after one step.**
  - 4 of its 5 calls typed the query and handed back at the Search click, at p 0.39–0.50. The
    decider's top-1 was right every time.
  - So a FastSteps call replaced one `type` step and added the FastSteps step itself: zero or one
    extra step.
  - Sonnet's own steps take about 2.5 s, so there is little to save anyway.
  - The one call that ran the whole flow did 4 actions in 14 s. The decider's share of that was
    1.1 s; the rest was 2 approval cards and full settles after 3 navigations.
- **Sonnet: input tokens rose a little** (+5k median). The likely cause is the longer driver grant
  note and the FastSteps schema, which ride on every step after the grant; this was not measured
  separately.

**Run B (Sonnet, all 16, `ba598bd`) against the Task 13 Sonnet shadow run.** Shadow never acts, so
for the chat model it behaves like off.

| Family | Success shadow → driver | Wall p50 | Chat steps p50 | Tokens in p50 |
|---|---|---|---|---|
| Store | 5/5 → 5/5 | 49 → 37 s | 14 → 10 | 155k → 109k |
| Form | 4/4 → 4/4 | 34 → 31 s | 9 → 8 | 97k → 89k |
| Nav | 3/3 → 3/3 | 29 → 36 s | 8 → 9 | 55k → 84k |
| Inbox | 4/4 → 4/4 | 24 → 28 s | 6.5 → 9 | 56k → 95k |
| **All** | **16/16 → 16/16** | **31 → 31 s** | **9 → 9** | **92k → 95k** |

Spend: $2.12 → $2.28 (upper estimates).

**Do not read the store row as a driver gain.** 4 of the 5 store runs in the shadow column (all but
shop-price) ended with `click "Cart (0)"` and a re-read. The fixture's header never updated, which Task 15b fixed, and
that accounts for about 2 of the 4 saved steps. Run D, on the fixed fixture, shows no gain.

**Nav and inbox did not use FastSteps.** Their changes are Sonnet adding `HighlightContent` steps
this time (+2–3 steps), which is behavioural variance.

### 14.4 FastSteps usage, statuses and hand-back reasons

**How often it ran:**

| | A Gemma | B Sonnet | C Gemma | D Sonnet |
|---|---|---|---|---|
| Driver tasks where FastSteps reached its loop | 2/16 | 3/16 | 6/12 | 5/8 |
| …on a multi-step store task with a session open | 2/2 | 3/3 | 6/7 | 5/6 |
| Share of page actions taken by the decider (executed ÷ executed + chat ControlPage) | 24% | 17% | 36% | 25% |

When the chat model held a session on a multi-step store task, it chose FastSteps **16 times out
of 18**. It never called FastSteps on dense-catalog, shop-price, a form, or a help-site or inbox
task. Every FastSteps call carried `values: {query: …}`.

**How the 17 calls ended:**

| How the call ended | Calls | Decider's top-1 at the hand-back |
|---|---|---|
| `done` (p ≥ 0.6) | 3 | — |
| `handback / unsure`: risky step in the 0.4–0.6 band (always the Search submit) | 7 | right 7/7 |
| `handback / unsure`: `done` below 0.6 | 3 | right 1/3 (0.56 ✓; 0.48, 0.36 ✗) |
| `handback / unsure`: top p < 0.4 | 3 | right 2/3 (Search at 0.39 ✓, a product at 0.39 ✓; "Cart (1)" at 0.35 ✗) |
| `handback / max steps` (Sonnet passed `maxSteps: 4`) | 1 | — |
| `blocked`, `dense page`, `repeat`, `failed actions`, `page changed`, `decider error` | 0 | |

- **10 of the 13 hand-backs were on a right top-1.** Counting the 3 `done` stops as well, 13 of 16
  keyed stop decisions were right. The gate is conservative. It never let a wrong action through,
  and most of the time it handed back a step the decider would have got right.
- **Most hand-backs come from one decision.** "Click Search" right after typing the query came up
  15 times:
  - p was 0.95, 0.94, 0.91, 0.89, 0.80, 0.75, 0.64 (acted on, 7);
  - and 0.57, 0.50, 0.49, 0.45, 0.45, 0.43, 0.39 (handed back, 8).
  - The decider was right all 15 times.
- **No "dense page" hand-back occurred.** Neither chat model called FastSteps on the dense
  catalog.

**Scope overshoot.**
- In 4 of the 17 calls the sub-goal stopped at the search results, but the decider kept going.
  Example sub-goals: "Search for wireless headphones and open the search results page", or
  "search for 'blue Aurora mug'". It opened the product, and in 3 of the 4 clicked Add to cart.
- Each Add to cart went through its one-shot card, and each matched what the user had asked for,
  so the key scores them right.
- But FastSteps does not stop at the boundary of its sub-goal. The decider's request carries both
  the sub-goal and the session plan, and it follows the plan.
- After one such overshoot (run B, shop-cheapest), Sonnet spent 2 more steps re-running the
  search to verify. The shadow decider said `done` (p 0.63 and 0.48) on both of those steps.

### 14.5 Decider accuracy in driver mode

| | A | B | C | D | **All** |
|---|---|---|---|---|---|
| Executed steps (wrong) | 5 (0) | 6 (0) | 18 (0) | 8 (0) | **37 (0)** |
| All keyed decisions, top-1 right | 6/7 | 8/8 | 24/25 | 12/13 | **50/53 (94%)** |

- **The 3 wrong decisions were never acted on.** All were stop decisions under the threshold:
  - `done` at 0.36 on the results page;
  - `done` at 0.48 on the product page before the add;
  - `click "Cart (1)"` at 0.35 after the add.
- **Wrong-action rate: 0 of 37 executed steps** (95% CI 0–9.5%). The executed steps were:
  - 15 `type`s of the search query;
  - 7 Search clicks;
  - 8 product or category clicks;
  - 6 Add to cart clicks, each with a card;
  - 1 `select` of quantity 2, with the value chosen by the single-field option question at
    p 0.96.
- **The shadow decider on the chat model's own ControlPage calls,** across these runs, agrees with
  §5: 89–100% at p ≥ 0.6.

### 14.6 Latency: the decider is not the bottleneck

- **The decider itself is fast.** Over all 53 driver decisions:
  - **p50 154 ms, p90 349 ms, p95 548 ms, max 633 ms**;
  - the first decision of each panel (cold) took 220–633 ms;
  - its total time per FastSteps call was 0.1–1.2 s. That is 2–8% of a multi-step call (0.7 of
    30.8 s; 1.1 of 14.1 s), and up to about 15% of a one-step call (0.47 of 3.0 s).
- **The rest of a FastSteps call's time goes to:**
  - **The first `type`'s profile lookup.**
    - With Gemma: 13, 13, 14, 19, 22, 22 and 26 s (median 19 s) in the seven calls that began
      with a `type`. The Task 16 grant-time pre-warm starts the lookup, but Gemma's structuring
      call takes about 16–20 s with reasoning, while the chat model's next step takes about
      3–5 s.
    - With Sonnet: 0.8–2.3 s.
    - Every one of these values came from `values` (`request.0`), not from the profile.
  - **Carded steps.** The Search submit and Add to cart each raise a one-shot card, then wait for
    a full settle. Each took 4–5 s from its decision to the next one; the harness clicks a card
    within about 0.5–1 s, and a person would take longer, in both arms.
  - **Link clicks.** A plain link click (the product or a category) took about 1 s, with a full
    settle. Non-navigating steps settle quickly, at 50/250 ms.
- **The chat model's own page-action steps** (median, ControlPage-only model steps): Gemma
  3.5–3.7 s, Sonnet 2.4–2.5 s.
- **So a FastSteps action is not faster than a chat-model action:** about 1 s for a link click, and
  4–5 s for a carded step. The saving comes from fewer model steps and less context, not from
  faster actions.

### 14.7 Is driver mode faster end to end?

**No, not across this benchmark.**
- **Whole suite:** with Gemma the median paired change is **+0.7 s per task** (16 pairs). The
  steps and tokens are flat or slightly down.
- **Sonnet, the family where FastSteps applies** (final build): **0 s** (8 pairs).

**It is faster only on multi-step store flows driven by the local model:**
- **About −6 s per task** (median of 16 pairs; driver faster in 11). That is roughly −13% of a
  47 s task.
- **−2.5 chat-model steps and −13k input tokens** per task.
- **Where FastSteps actually ran:** −5 steps and −34k tokens, about half.
- **Higher success:** 12/16 → 13/16, which includes shop-cheapest going from 0/4 to 3/4. This is
  partly chat-model noise (§14.3).

Accuracy is not the limit: 0 wrong actions in 37. What limits the gain, in order:

1. **The first typed value waits for a chat-model profile lookup** (13–26 s with Gemma), even
   when the value is in `values`.
   - Fix: answer a `type` from the request values first, and structure the profile only when they
     cannot fill the field.
   - With Gemma this would take about 19 s (median) off every FastSteps call that types.
2. **The Search submit counts as a point of no return,** so it hands back between 0.4 and 0.6:
   8 of 15 Search decisions, all of them right.
   - Fix: treat a GET search form (`input[type=search]`, `role=search`) as non-committing in the
     driver gate, or let its card cover the tentative band.
   - This is the main reason Sonnet's FastSteps calls stop after one step.
3. **The suite has few driver-shaped tasks:** 3 of 16.
   - A benchmark for driver mode needs longer flows: pagination, filters, multi-item carts,
     multi-page forms.
4. **The sub-goal boundary is not kept** (overshoot in 4 of 17 calls). This is a behaviour
   question rather than a speed one. The cards still gate every Add to cart.

### 14.8 Integration checks

At `fdfafdf`, on the Task 17 harness changes:
- `npm test`: **196 files, 2,688 passed, 1 skipped.** At `ba598bd`: 2,687 passed, 1 skipped.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `node --test scripts/decider-eval/`: **62/62.** That is 49 before, plus 13 new driver-scoring
  tests in `driver.test.mjs`; the summary-line expectation in `report.test.mjs` was also updated.
  The new scoring tests were mutation-checked: removing the call windows, the step↔decision match,
  the replay, or the "a refused call owns no decisions" guard each fails a test.
- **End to end in a real browser, on the final build** (runs B–D, 36 driver tasks):
  - fresh profiles, with the model imported from a URL;
  - the readiness-gated FastSteps and the grant note: every granted session named FastSteps;
  - the `decider.next` round trip from the service worker to the panel: 46 decisions in runs B–D
    (53 with run A), all on WebGPU, with no timeouts or cancels;
  - one-shot cards inside FastSteps;
  - the single-field select question;
  - assist still working in driver mode (Gemma);
  - FastSteps never raced a ControlPage call. The 6 raced calls in the Sonnet runs were
    AutofillForm + ControlPage and two ControlPage calls batched by Sonnet itself.

**Harness changes** (`scripts/decider-eval/`):
- `run.mjs`: the `decider.next` capture, the `selectOptions` capture, and a per-task driver log
  line with warnings.
- `report.mjs`: `registryOf`, `pairDriveRequests`, `driverCalls`, `driverScore`, `valueOfStep`,
  `replayStep`. It also adds FastSteps to the page-mutating calls (race detection), the driver and
  off-vs-driver report sections, and medians in the aggregate.
- New `rescore.mjs`: re-scores a run, and merges re-runs into it.
- New `driver.test.mjs`.
- `README.md`.

**Analysis scripts** (session scratchpad `t17/`, may be cleared):
- `analyze.mjs` — family tables and paired deltas;
- `pooled.mjs` — the pooled store family;
- `tally.mjs` — the calls, hand-back kinds, latency, the Search decisions and overshoot;
- `fstimeline.py` and `rawpairs.py` — per-call timelines;
- `integ.py` — backend, cancels, sessions.
