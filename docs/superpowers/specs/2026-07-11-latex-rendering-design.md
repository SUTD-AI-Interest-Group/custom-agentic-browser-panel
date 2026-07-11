# LaTeX math rendering + `writing-math` skill — design

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan

## Problem

The chat panel renders assistant text as Markdown (`marked` → `DOMPurify` →
`dangerouslySetInnerHTML`, in `src/ui/Markdown.tsx`). Mathematical notation has
no first-class rendering: an equation the model writes as `$\frac{a}{b}$` shows
as raw LaTeX source, and models left to their own devices often fall back to
Unicode symbols (α, ≤, ×) or ad-hoc plain text that reads poorly. We want proper
math typesetting in the panel **and** an agent that reliably emits render-ready
LaTeX for math/science questions.

## Goals

- Render inline (`$…$`) and display (`$$…$$`) LaTeX math in assistant messages.
- Ship a built-in `writing-math` skill that teaches the agent good LaTeX
  practice, auto-loadable for math/science questions.
- Guarantee render-ready output even for quick answers via a short always-on
  system-prompt nudge (independent of a user's custom system prompt).
- Stay entirely client-side and MV3-CSP-safe: no backend, no remote code, no
  manifest CSP change.

## Non-goals

- Chemistry (`mhchem` / `\ce{}`), equation-editing UI, server-side rendering —
  future additions.
- The broader response-object polish (link cards, interactive widgets) raised
  separately — a follow-up, not part of this spec.

## Decisions (from brainstorming)

- **Renderer:** KaTeX, bundled locally. Chosen over MathJax for bundle size,
  synchronous rendering, offline operation, and no remote code (MV3 CSP).
- **Research depth:** targeted lookups (done) — confirmed the library facts and
  the DOMPurify behavior below.
- **Skill delivery:** a loadable built-in skill **plus** an always-on baseline
  nudge, so even quick math replies use delimiters that render.

## Architecture

Three tightly-related parts. The renderer is the only visual change; the nudge
and skill steer the model to produce input the renderer can typeset.

### Part A — Renderer (`src/ui/Markdown.tsx`)

**Dependencies**

- `katex` — bundled; ships its own CSS + woff2 fonts.
- `marked-katex-extension@^5.1` — compatible with the project's `marked ^15`;
  provides the `$…$` / `$$…$$` tokenizer that correctly skips code spans and
  fenced code blocks. (`nonStandard` option available; we keep the default
  `nonStandard: false` to limit `$`-in-prose false positives.)
- Bump `dompurify ^3.2 → ^3.4`. **3.4.0+ preserves `<semantics>`,
  `<annotation>`, `<annotation-xml>` and the `encoding` attribute by default**,
  so KaTeX's `htmlAndMathml` output survives sanitization with **no manual
  allowlist**. This is why plain render-then-sanitize is safe.

**Pipeline** (shape unchanged from today):

1. `normalizeMathDelimiters(text)` — safety-net pre-pass (below).
2. `marked.parse(text)` — with the KaTeX extension configured **once at module
   load**: `marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))`.
   `throwOnError: false` makes malformed LaTeX render as an inline error node
   rather than throwing and losing the message.
3. `DOMPurify.sanitize(html)` — unchanged call; dompurify ≥3.4 keeps KaTeX
   output intact.
4. `dangerouslySetInnerHTML` — unchanged.

`import 'katex/dist/katex.min.css'` at module level (in `Markdown.tsx`). Vite
emits the fonts to `dist/assets/` and rewrites the CSS `url()`s; the fonts load
from the extension's own origin (`chrome-extension://…/assets/…`) under the
default MV3 CSP — confirmed no `content_security_policy` is set in
`public/manifest.json`, so **no manifest change is required**.

**Considered and rejected:** sanitize-then-inject KaTeX (more moving parts) and
HTML-only output (loses MathML accessibility). The dompurify-3.4 finding makes
render-then-sanitize both simplest and a11y-preserving.

**Delimiter normalization safety-net (`normalizeMathDelimiters`)**

Some models (notably OpenAI-family) emit `\(…\)` / `\[…\]`, which
`marked-katex-extension` does **not** recognize. A small guarded pass converts
`\(…\)` → `$…$` and `\[…\]` → `$$…$$` **while skipping fenced code blocks and
inline code spans**, so code samples containing those sequences are never
corrupted. It is conservative by design — the nudge and skill make `$` the
primary path; this only mops up stragglers. Guarding code is a hard requirement,
not optional: the implementation must not transform inside ``` fences or `` `…` ``
inline code.

**Streaming**

No special handling. An unclosed `$$…` won't match the tokenizer until the
closing delimiter streams in, so it shows as literal LaTeX briefly, then snaps
to rendered. The existing `useMemo(() => …, [text])` in `Markdown` re-runs per
token, so this is automatic.

### Part B — Baseline nudge (always-on)

A new short constant note appended in the system-prompt assembly at
`src/ui/Chat.tsx:719` (alongside `accessNote` / `browsingInsightsNote(...)`),
so it is present **regardless of the user's editable `settings.systemPrompt`**:

> When your answer includes mathematical notation, write it in LaTeX — `$…$` for
> inline math and `$$…$$` on their own lines for display math (these render in
> the panel). Prefer LaTeX commands over Unicode symbols (`\alpha`, `\leq`,
> `\times`). Escape a literal dollar sign as `\$`.

Kept deliberately short — the context window is a shared resource.

### Part C — Built-in skill `writing-math`

New entry in `src/data/builtinSkills.ts` `BUILTIN_SKILLS`:

- `name: 'writing-math'`, `icon: '➗'`, `source: 'builtin'`,
  `userInvocable: true`, `modelInvocable: true`.
- Seeding is idempotent (`seedBuiltinSkills` inserts missing built-ins by name),
  so the skill appears for existing users on next load without migration.
- **Description (the sole trigger signal):** "Formats mathematical and
  scientific answers as LaTeX that renders in the panel. Use when the user asks
  a math, physics, statistics, or engineering question, or to write equations,
  formulas, derivations, or proofs."
- **Body (concise good-practices)** covers:
  - Inline `$…$` vs display `$$…$$` (display on its own lines).
  - Environments: `aligned` for multi-line/aligned steps (`&`, `\\`),
    `bmatrix`/`pmatrix` for matrices, `cases` for piecewise functions.
  - Core commands: `\frac`, `\sqrt`, `^`, `_`, `\left…\right` for auto-sizing.
  - Prefer LaTeX over Unicode symbols.
  - Units and text inside math via `\text{…}` (e.g. `5\,\text{m/s}`); thin space
    `\,` before units.
  - Escaping: `\$`, `\%`, `\#`, `\&`, `\_` outside math.
  - Stay within the KaTeX-supported command set — link
    `https://katex.org/docs/supported.html`; malformed/unsupported commands show
    as an inline error.
  - One worked example: the quadratic formula inline + a short `aligned`
    derivation in display mode.
  - Follow the existing built-in skills' concise style; no time-sensitive notes.

## Edge cases

- **Literal currency** (`$5 … $10`): residual false-positive risk from `$`
  delimiters. The default `nonStandard: false` reduces it; the skill/nudge
  instruct `\$` for literal dollars. Accepted as low residual risk.
- **Malformed LaTeX:** `throwOnError: false` → inline KaTeX error node; the
  message never crashes.
- **Copy as Markdown** (`MessageToolbar.copyMarkdown`): already copies raw
  `part.text`, so `$…$` source is preserved. No change.
- **Copy as PNG** (`copyElementAsPng`): renders the live DOM including KaTeX;
  expected to work — verify.

## Testing / verification

No automated suite exists; verify via `/verify-extension`:

1. `npm run build` (tsc + vite; fails fast on type errors).
2. Reload the unpacked extension, open the panel, and exercise:
   - inline `$…$` and display `$$…$$` render correctly;
   - an `aligned` multi-line derivation renders;
   - `\(…\)` / `\[…\]` input still renders (normalization works) and a code
     block containing `\(` is left untouched;
   - malformed LaTeX degrades to an inline error, not a crash;
   - streaming: raw LaTeX briefly shows then snaps to rendered;
   - Copy as Markdown preserves `$…$`; Copy as PNG captures rendered math;
   - a math question with no explicit skill invocation still yields rendered
     LaTeX (nudge working).

## Implementation notes

- Per this repo's concurrent-session convention, implement in a **git worktree**
  with pathspec-scoped commits to avoid colliding with parallel sessions.
- Files touched: `package.json` (deps), `src/ui/Markdown.tsx` (renderer +
  normalization), `src/ui/Chat.tsx` (nudge note), `src/data/builtinSkills.ts`
  (skill). Possibly a small `src/ui/mathDelimiters.ts` if the normalization pass
  is non-trivial enough to warrant its own tested unit.

## Sources

- marked-katex-extension — https://github.com/UziTech/marked-katex-extension
- DOMPurify semantics/annotation default (issue #673 / 3.4.0) —
  https://github.com/cure53/DOMPurify/issues/673
- KaTeX supported functions — https://katex.org/docs/supported.html
