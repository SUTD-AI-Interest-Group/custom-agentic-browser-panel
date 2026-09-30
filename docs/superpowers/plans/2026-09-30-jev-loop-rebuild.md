# Closing the loop gap with jev-ultrafast — plan

Status (2026-09-30): phases 1 and 2 implemented and measured — see
`scripts/system1-eval/README.md` "Results — 2026-09-30" (runs A and B) and
`scripts/von-finetune/README.md` "Results — the act-head fine-tune". Two loop
rules were added from what the runs showed: a first would-be repeat excludes
its (operation, target) and asks again; an action the page refuses does the
same instead of ending the call.

Source study: browser-use/jev-ultrafast (commit 1231850) scopes TypeSafe's Jev
exactly as our candidate-action `Act` scopes Von — the harness owns the action
space, the model picks an operation and a row. Its 7-second Google Flights run
comes from the loop around the model, not the model: one request per step, a
50–200 ms settle, no confidence gate, trusted input, page text in the state.
Measured against our 2026-09-27 numbers (fine-tuned Von grounds 0.963 at
~220 ms per head but `Act` adds 15–20 s of wall time), the gap is in five
places. This plan closes the ones that need no new training data first, then
restructures the decision into one pass and retrains.

Deferred, with the reason: page text in the state (the collected training
pages carry no text and only index/tag/name/type facts — adding it at
inference alone would be train/serve skew; needs a re-collect + re-label,
~3.5 h of teacher time); trusted CDP input via `chrome.debugger` (Chrome's
"is debugging this browser" banner makes it a separate opt-in); `<select>`
option enumeration (a candidate-space change with no training rows).

## Phase 1 — the loop (no retrain; measured by e2e with the existing fine-tune)

1. **Settle like jev.** `runControlStep` gains `settle: 'quick'|'full'`: quick
   = DOM quiet for 50 ms capped at 250 ms; a typed combobox/searchbox waits
   for `[role=option]` up to 400 ms. `controlStep` chooses quick only for an
   Act step that is NOT a point of no return; submits and navigation keep the
   full wait (400 ms quiet / 4–8 s cap).
2. **One page read fewer per action.** `runControlStep` returns its post-action
   `snapshot`; the Act loop uses it as the next observation instead of
   injecting again at the loop top (stale-check read + post-action read = 2
   per action, was 3).
3. **Banded confidence.** `ACT_CONFIDENCE` 0.6 stays the act-freely line;
   `ACT_TRY_CONFIDENCE` 0.4 executes a *tentative* action only when it is
   non-committing (not a point of no return) — the accepted worst case of the
   original design (§5): a wrong undoable click on the granted page. Terminal
   answers (DONE/BLOCKED) still need 0.6. `controlStep` refuses a tentative
   action that turns out to be a point of no return → `uncertain`.
4. **No-progress stop.** Three consecutive non-WAIT steps with `no_change`
   end the call (`repeat`), jev's rule beside the hash-repeat rule.
5. **Warm the engine on grant.** `RequestPageControl`'s grant calls
   `System1Runtime.warm()` so the 1.2–6 s cold boot leaves the first `Act`.
6. **Richer stale check.** `ElementIdentity`/`ControlFingerprint` gain
   `checked` and `disabled`: a toggle that flipped or a control that went
   disabled between observation and action is `stale`, not clicked.
7. **Missing value is a precise hand-back.** After `BLOCKED`/
   `MISSING_USER_DATA` the policy asks which field lacks a value; the result
   names it so the chat model re-calls once with the value.

## Phase 2 — one pass per step (retrain; measured by grounding + e2e)

8. **Single act head.** `createVonActPolicy`: one question whose options are
   every (control, action) pair the space allows — `[12] textbox "Email" →
   type` and `→ click` as separate options — plus the global moves
   (SCROLL_DOWN/UP, WAIT, DONE, BLOCKED). State block without the control
   list (the options are the controls). Value head lazy as before; tournament
   above `ACT_CHUNK` (120). One Von pass for a click step, two for a field.
9. **Train rows through the shipped renderer.** `render.mjs --head act`
   emits act rows (labels transfer by construction: `act` → `<id>:<op>`,
   `scroll_down` → `SCROLL_DOWN`, DONE/BLOCKED as is) + value rows; 3 epochs
   on the M4 Max; export q8; parity gate.
10. **Eval.** `harness.ts` grounds through whichever head `EVAL_HEAD` names;
    e2e reports Von passes per action and page reads per action. Run A: the
    existing fine-tune + lazy head + new loop (loop gains alone). Run B: the
    new fine-tune + single head + new loop.

## Files

Phase 1: `src/tools/pageControl.ts` (+test), `src/system1/observation.ts`
(+test), `src/system1/actLoop.ts` (+test), `src/system1/policy.ts`,
`src/system1/vonPolicy.ts` (+test), `src/system1/runtime.ts`,
`src/system1/engine.ts` (+test), `src/tools/tools.ts`.
Phase 2: `src/system1/vonPolicy.ts` (+test), `src/tools/tools.ts`,
`scripts/von-finetune/{render.mjs,prompt-entry.ts,README.md}`,
`scripts/system1-eval/{harness.ts,run.mjs,README.md}`, `CLAUDE.md`.
