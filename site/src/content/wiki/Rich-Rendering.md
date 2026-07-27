# Rich Rendering

Assistant replies render as Markdown with syntax-highlit code, KaTeX math, inline
citations, link previews, image carousels, collapsible JSON trees, and scrollable
tables. All of it client-side, none of it allowed to bloat the initial bundle.

This is the feature area with the highest bug-per-line ratio in the project, and
almost every bug has the same shape: **a text stream is not a document.**

---

## The sanitizer ate our math

`ad1d9e1` added KaTeX. Its code comment confidently asserted:

> DOMPurify ≥3.4 preserves KaTeX's MathML… so plain render-then-sanitize is safe.

**Twelve minutes later**, `f13b488` had to fix it:

> DOMPurify's default MathML profile **forbids** those two tags
> (`<semantics>` / `<annotation>`) — it would unwrap them, orphaning the raw-TeX
> fallback as loose text.

The failure mode is nasty: KaTeX embeds the original TeX source inside
`<annotation>` as an accessibility fallback. DOMPurify stripped the wrapper and
left the *raw LaTeX source* dumped into the visible page next to the rendered
equation. The fix is `ADD_TAGS: ['semantics','annotation']`.

The lesson isn't about DOMPurify. It's that we wrote a comment asserting a
library's behaviour **without testing it**, and shipped the assertion as fact. The
comment was wrong for twelve minutes and would have been wrong forever if nobody
had looked at an equation.

## Streaming breaks every parser you own

Markdown arrives one token at a time, which means your parser is constantly
looking at *syntactically invalid* documents that will become valid in 200ms.

- **`3dfbd07`** — the math-delimiter normalizer (which converts `\(…\)` / `\[…\]`
  into the `$` forms KaTeX wants) split on a code-span regex that assumed single
  backticks and *closed* fences. A double-backtick span, or a fence still
  streaming with no closing ` ``` ` yet, meant `\(` inside a code block got
  rewritten as math. Rewritten as one combined regex where code alternatives match
  first, so any code region — closed or not — passes through untouched.
- **`4c52318`** documents a residual caveat we chose to *live with* rather than
  fix: an inline code span needs its closing backtick to be recognised, so a
  half-streamed span can briefly convert a `\(` inside it. **It self-heals the
  instant the closing backtick arrives.** A flicker measured in milliseconds
  wasn't worth a more complex parser.
- **`afa4921`** — syntax highlighting is deferred until a message *finishes*
  streaming, because *"highlighting is O(n) per call and re-running it on every
  streamed token would be O(n²)."* The naive version re-highlights the entire code
  block on every token.

## Three more, quickly

**`ecbec8b` — the trailing-paren bug.** Bare-URL detection trimmed trailing
punctuation (`.,;:!?)`) — which amputates the closing paren from every
`..._(disambiguation)` Wikipedia link. Now a `)` is only stripped if the token
contains no `(`.

**`ee9fa03` / `343388a` — the link-preview SSRF guard, and its false positive.**
Link previews fetch OpenGraph tags, so they need the same private-address guard as
[Deep Research](Deep-Research). The first version blocked IPv6 unique-local
addresses by checking `host.startsWith('fc')` or `'fd'` — which also blocked
**`fdic.gov`** and **`fcbank.com`**. Fixed by only applying IPv6 rules when the
host actually contains a `:`. A security guard that blocks real domains is a bug,
and it's the kind users report as "your app is broken," never as "your guard is
overzealous."

**`2e81df2` — a privacy toggle you could bypass by having been faster.**
`getLinkPreview` checked its in-memory cache *before* checking the
`fetchLinkPreviews` setting. So a URL cached before you turned the setting off
kept rendering its preview for the rest of the session. **A privacy setting must
be the first thing consulted, not the second** — anything cached in front of it is
a hole.

## Built: LaTeX self-correction

When this page was first written, the most recent spec on `main`
([`2026-07-13-latex-self-correction-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-13-latex-self-correction-design.md))
diagnosed a **reproduced** failure we had *not* yet fixed: a single stray or
unbalanced `$` mid-paragraph desyncs KaTeX's `$…$` pairing and cascades — dragging
*neighbouring valid* math out of the renderer into raw text. Measured: 4 rendered
math nodes collapse to 1. Smaller local models trip it even with the prompt nudge and
the `writing-math` skill in place.

It's built now, in two layers, deliberately ordered cheap-first:

- **A deterministic validator/neutraliser** (`d983878`), run before the final render
  (`6f6529f`). It's pure and unit-tested, contains no model, and only claims to catch
  **structural, KaTeX-detectable** errors — the spec bounds the contract to exactly
  that (`d59ab80`), because promising to repair *semantically* wrong LaTeX with a
  regex is how you ship a worse bug than the one you started with.
- **A silent, post-turn repair pass** (`93aec77` primitives → `57afb0b` orchestrator
  → `8c343c2`) that re-asks the model to fix math a bubble still can't compile, then
  splices the correction back in by offset. It runs *after* the turn, so it never
  blocks streaming, and it drives the "fixing math…" indicator.

Two fixes landed almost immediately after — the usual tax on anything that touches a
stream: `de36132` repairs **every** text part of a bubble, not just the first (a
reply with two math-bearing paragraphs had only the first one healed); and `1b113d2`
**rejects a repair that comes back with no delimiters** before persisting it, so a
model that "fixes" `$x$` into a bare `x` can't silently delete the very math it was
asked to save.

We left this section's old title — "Still open" — behind on purpose. A log that
quietly edits its unfinished work into finished work, with no visible seam, is just
marketing with better production values.

## One anecdote we're keeping

The rich-rendering spec records that a user-reported raw-`$$` bug **could not be
reproduced** against merged code — *"which points to a stale build."*

We hardened the delimiter normalizer anyway. A non-reproduction is not an absence
of a bug; it's an absence of information.
