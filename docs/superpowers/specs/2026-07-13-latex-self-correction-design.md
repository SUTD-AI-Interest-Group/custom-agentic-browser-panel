# LaTeX self-correction / validation loop — design

**Date:** 2026-07-13
**Status:** Approved (design), pending implementation plan

Follow-up to [`2026-07-11-latex-rendering-design.md`](./2026-07-11-latex-rendering-design.md),
which added KaTeX rendering, the `writing-math` skill, and the always-on
`MATH_FORMATTING_NOTE`. This spec adds the layer that keeps the rendered output
clean when the model emits *malformed* LaTeX.

## Problem

The renderer (`marked` + `marked-katex-extension`, in `src/ui/Markdown.tsx`)
typesets **clean** LaTeX correctly — inline `$…$`, display `$$…$$` on their own
lines, and even `$$…$$` inline inside a list item all render fine, and
block-separated equations do not cascade-break.

The failure is **malformed model output**. Reproduced against the real pipeline:
when the model emits an unbalanced or stray `$` *within a paragraph*, the
`$…$` pairing desyncs — a run of KaTeX nodes collapses (measured: 4 → 1), so
valid math *after* the stray delimiter leaks out as raw source and neighbouring
prose gets swallowed as math. The reported screenshot shows exactly this: a
Gaussian-charge answer where `(x=0$)`, `$|sigma` (a typo for `$\sigma$`), and an
unclosed `$dq = \lambda(x)dx` desynced the paragraph and left the display
integrals rendering as raw `$$…$$` text.

The prompt lever is **already pulled** — `MATH_FORMATTING_NOTE` is appended to
every system prompt and a `writing-math` skill exists — yet a small local model
(`google/gemma-4-26b-a4b`) still produces broken LaTeX. So "improve the prompt"
cannot reach *always clean*. We need a correction mechanism below the model.

## Goal

Guarantee that a stray or malformed `$` **can never cascade-break other
equations**, show **structurally-invalid LaTeX as inert code** (never as garbled
half-math), and transparently repair that broken LaTeX so the user sees correct
equations — without depending on the model getting it right the first time.

**Bounded by KaTeX leniency (verified, KaTeX 0.17).** The deterministic oracle
is "does KaTeX compile it," and KaTeX throws only on *structural* errors
(unbalanced braces, undefined control sequences, dangling `^`/`_`, unclosed
`\sqrt{`). It silently renders loose text like `|sigma is bad` or `) and ` as
implicit-multiplication variables **without error**. So the layer catches the
common structural mistakes weak models make (bad `\frac`, unclosed braces,
unknown commands) but does **not** catch renderable-but-semantically-wrong spans
(a `\sigma` mistyped as `sigma`). The anti-cascade guarantee itself does not
depend on KaTeX rejecting anything — it comes from balanced-delimiter pairing
plus escaping unpaired `$`.

## Decisions (from brainstorming)

- **Two layers: deterministic baseline + model fallback.** A deterministic
  pass always runs and *guarantees* a clean render (the only thing that can
  guarantee it — a weak local model self-correcting cannot). A model re-emit
  handles what the deterministic layer can't compile.
- **Fallback is automatic + silent.** When the deterministic pass still can't
  make a span compile, the model is re-asked automatically after the turn ends
  and the corrected message is swapped in — no user action required.
- **Re-emit is surgical.** Only the broken math fragments are sent for
  correction and spliced back; the good prose is never regenerated. Cheaper,
  faster, and cannot drift into a different answer.
- **Scope: chat replies only (this cut).** The deterministic layer protects
  *everything* that renders through `Markdown.tsx` (chat **and** research
  reports) for free. The automatic model re-emit runs only for interactive chat
  turns; research reports still render guaranteed-clean but get no auto re-emit.
- **Transient state: inert inline code + tiny spinner.** While the silent fix
  is in flight, uncompilable spans show as monospace raw LaTeX with a small
  "fixing math…" indicator, then snap to rendered math when the fix lands.

## Non-goals

- Fixing semantically-wrong math (a formula that compiles but is incorrect) —
  out of scope; only malformed/uncompilable LaTeX is targeted.
- A user-facing "Fix math" button, manual retries, or a retry beyond the single
  automatic attempt.
- Auto re-emit for background research reports (deterministic protection only).
- Chemistry / `mhchem`, equation editing — still future (per prior spec).

## Architecture

Two layers. The **render layer** is a deterministic guarantee that runs on every
message; the **agent layer** is an automatic, surgical model round-trip that runs
once per final chat message that still has uncompilable math.

### Part A — Deterministic validator (`src/ui/mathValidate.ts`, new, pure)

The chosen approach is a **pre-parse validator** (over a custom marked extension
or post-render DOM repair): it fits the existing `normalizeMathDelimiters`
idiom, is a pure Node-testable transform, and naturally produces the
invalid-span list the fallback needs.

```ts
export interface MathSpan {
  raw: string      // the full delimited source, e.g. "$$Q = \\int ...$$"
  start: number    // index into the ORIGINAL text
  end: number
  display: boolean // $$…$$ vs $…$
}

export interface MathValidation {
  cleaned: string       // safe to hand to marked-katex; never desyncs
  invalid: MathSpan[]    // spans that would not compile / had no partner
}

export function validateMath(text: string): MathValidation
```

Behaviour:

1. Scan the text **outside code regions**, reusing the code-vs-math scanning
   discipline already in `mathDelimiters.ts` (fenced ``` / ~~~ blocks, inline
   backtick spans — closed and mid-stream-unterminated — are skipped so a `$`
   inside code is never touched).
2. Extract math-delimiter candidates in order: `$$…$$` (non-greedy) first, then
   `$…$`. A leftover unpaired `$` is a candidate failure.
3. Trial-compile each candidate with `katex.renderToString(raw, { throwOnError:
   true, displayMode })` inside try/catch. A throw ⇒ that span is invalid.
4. Build `cleaned`: valid spans pass through unchanged; each **invalid delimited
   span is wrapped in an inline-code span** — its raw source becomes
   `` `$$Q = \int…$$` `` (backticks escaped if the source itself contains a
   backtick run). marked-katex skips code spans, so it (a) can never desync on
   the bad `$`, and (b) the span renders as monospace inert code, which is
   exactly the transient state Part D wants. A **truly lone stray `$`** (not part
   of any candidate pair) is instead escaped as `\$` so it shows as a literal
   dollar sign.
5. Record every invalid span (with original-text offsets into the **unmodified**
   input) in `invalid`. Offsets index the original text — `cleaned` is a
   separate, render-only string; splicing (Part C) operates on the original
   message text using these offsets.

Because `cleaned` only ever contains balanced, KaTeX-compilable delimiters (all
bad ones hidden inside code spans), marked-katex physically cannot cascade.
`katex` is already a dependency and runs in Node, so this is fully unit-testable.

### Part B — Render integration (`src/ui/Markdown.tsx`)

For the **final** (non-streaming) render, insert `validateMath` after
`normalizeMathDelimiters` (which still converts `\(…\)` / `\[…\]` into `$` forms
first) and before `marked.parse`:

```
raw → encodeCitations? → normalizeMathDelimiters → validateMath().cleaned
    → marked.parse → DOMPurify → citation swap
```

During **streaming** (`streaming` prop true) keep today's lenient path: mid-stream
a closing `$` legitimately hasn't arrived yet, and the existing self-heal note in
`mathDelimiters.ts` covers the transient. Validation/neutralization is a
final-message concern.

Neutralized invalid spans therefore arrive at marked already wrapped as
inline-code, so they render as **inert `<code>`** (the raw LaTeX source) — "not
yet rendered" reads clearly and pairs with the spinner from Part D. No extra
mechanism in `Markdown.tsx` beyond calling `validateMath`; the code-span
wrapping done in Part A carries the styling.

### Part C — Surgical repair (`src/agent/mathRepair.ts`, new)

```ts
export interface MathFix { raw: string; fixed: string } // fixed = corrected LaTeX

export async function repairMathSpans(
  spans: MathSpan[],
  model: LanguageModel,          // same provider adapter the turn used
  signal: AbortSignal,
): Promise<Map<string, string>>  // raw → fixed; empty on any failure
```

- One structured model call: a tight prompt listing the invalid fragments and
  asking for corrected, compilable LaTeX for each, returned as a JSON array
  `[{ raw, fixed }]`. No answer content is regenerated — only the fragments.
- **Every failure mode is a graceful no-op**: timeout, abort, non-JSON output,
  wrong length, or a `fixed` that itself fails `validateMath` ⇒ that entry is
  dropped and the deterministic best-effort stands. Never throws.
- A pure `spliceFixes(text, spans, fixes) → string` helper replaces each invalid
  span's `raw` at its recorded offsets with `fixed` (right-to-left so earlier
  offsets stay valid).

### Part D — Chat wiring (`src/ui/Chat.tsx`)

When an assistant message reaches its final state (turn/continuation chain
complete, not mid-stream):

1. Run `validateMath(message.rawText)`. If `invalid` is empty, done.
2. Set a transient per-message flag (`fixingMath`) → Part B shows inert-code
   spans + a small "fixing math…" spinner.
3. Call `repairMathSpans(invalid, model, signal)` — **capped at one automatic
   attempt**, abort-tied to the turn, skipped if no provider is selected.
4. `spliceFixes` the returned fixes into the message text; re-run `validateMath`
   to confirm improvement (accept only fixes that compile).
5. Persist the corrected text to the conversation store (IndexedDB) and clear
   `fixingMath` so the UI re-renders the now-rendered math.

The repair call **never throws into the turn loop** — worst case the message
keeps its deterministic best-effort (inert code, no garble).

## Data flow

- **Render (every message):**
  `raw → normalizeMathDelimiters → validateMath.cleaned → marked+KaTeX → DOMPurify`
  → cascade impossible.
- **Fallback (final chat message with `invalid.length > 0`):**
  `validateMath(raw).invalid → repairMathSpans → spliceFixes → validateMath (confirm) → save + re-render`.

## Error handling

- Per-span KaTeX compile is wrapped; a throw only marks that one span invalid.
- `repairMathSpans` is timeout- and abort-guarded and returns an empty map on
  any failure; accepted fixes must re-compile.
- Only completed messages are validated/repaired; streaming is untouched.
- No provider selected ⇒ deterministic layer still runs; fallback is skipped.

## Testing

Pure logic gets Vitest coverage (matching the repo's convention):

- **`src/ui/mathValidate.test.ts`**
  - balanced `$…$` and `$$…$$` (own-line and inline) survive unchanged;
  - a stray/unpaired `$` is escaped and does **not** desync a later valid pair;
  - an unclosed `$…` to end-of-paragraph is escaped;
  - `$` inside fenced/inline code and a literal `\$` are left untouched;
  - **the exact reported screenshot text** → `cleaned` renders the intended
    equations and `invalid` lists `(x=0$)`, `$|sigma`, the unclosed `$dq…`.
- **`src/agent/mathRepair.test.ts`** (mock model)
  - `spliceFixes` maps fixes back to the right offsets (multi-span, right-to-left);
  - malformed JSON / wrong-length / non-compiling `fixed` ⇒ dropped, no throw.

End-to-end (per `CLAUDE.md`): `npm run build`, reload unpacked, ask the local
model a Gaussian-charge-style question, confirm the panel shows clean equations
(and, if the model emits garbage, a brief "fixing math…" then clean math).

## Files touched

- `src/ui/mathValidate.ts` — new (pure validator/neutralizer).
- `src/ui/mathValidate.test.ts` — new.
- `src/ui/Markdown.tsx` — call `validateMath` on final render; inert-code for
  neutralized spans.
- `src/agent/mathRepair.ts` — new (surgical model repair + splice).
- `src/agent/mathRepair.test.ts` — new.
- `src/ui/Chat.tsx` — post-turn validate → repair → splice → persist; transient
  `fixingMath` state.
- `src/ui/styles.css` — inert-math-code + "fixing math…" spinner styling.
