# Syntax highlighting for code blocks — design

Date: 2026-07-23 · Status: approved (theme + language choices confirmed by user)

## Problem

Code blocks in the side panel render without syntax colors. The highlighting
*engine* already works: `src/ui/codeEnhance.ts` lazy-loads highlight.js, and
`Markdown.tsx` runs `highlightAll` once a message finishes streaming, stamping
`hljs-*` token spans into the DOM. But no `.hljs-*` theme CSS was ever added —
`styles.css` has zero `.hljs` rules — so every token renders in the plain text
color and the output looks unhighlighted.

Secondary gap: only 7 languages are hand-registered (js, ts, python, bash,
json, xml, css). Anything else falls back to auto-detection over those 7,
which mis-colors or stays plain.

## Decisions (user-approved)

1. **Theme: stock GitHub themes.** Copy the token-color rules from
   highlight.js v11's shipped `github.css` (light) and `github-dark.css`
   (dark) into `src/ui/styles.css`, following the file's existing
   `prefers-color-scheme: dark` structure.
2. **Languages: the hljs common set (~35).** Replace the hand-registered
   7-language loader with a single dynamic `import('highlight.js/lib/common')`.

## Changes

### `src/ui/styles.css`

Append a syntax-highlighting section: the light GitHub token rules, then a
`@media (prefers-color-scheme: dark)` block with the GitHub Dark token rules
(the file already uses several such blocks; this matches its pattern).

Deliberately **omitted** from the copied themes:

- `pre code.hljs` / `code.hljs` layout rules (display/overflow/padding) — the
  panel already lays out code blocks (`.code-block`).
- The `.hljs` **background** — GitHub's white / `#0d1117` would clash with the
  panel's neutral surfaces. The `.hljs` base *color* is kept: `hljs-subst` /
  `emphasis` / `strong` reference it, and it is near-identical to `--text`.
- Empty "purposely ignored" selector blocks.

**Kept**: all token colors, including `hljs-addition`/`hljs-deletion`'s tinted
backgrounds (they are per-token diff tints, not block surfaces). A provenance
comment records the source files and what was dropped.

### `src/ui/codeEnhance.ts`

`loadHljs()` becomes `import('highlight.js/lib/common')` (its default export
is a core instance with the common languages pre-registered). The lazy-load
memoization, `highlightCode` idempotence, auto-detect fallback, and the
defer-until-stream-ends call site in `Markdown.tsx` are unchanged. Vite splits
the import into an on-demand chunk, so the initial panel bundle is unchanged.

## Testing

- New `src/ui/codeEnhance.test.ts` (jsdom, matching the existing Vitest
  setup): the common set registers languages beyond the old 7 (`go`, `sql`,
  `rust`); `highlightCode` emits `hljs-*` token spans and adds the `hljs`
  class; a second call is a no-op (idempotence).
- `npm run typecheck`, `npm test`, `npm run build`.
- End-to-end: reload the unpacked extension, ask for code in several
  languages, verify colors in light and dark (DevTools scheme emulation).

## Out of scope

Highlighting while streaming (deliberate existing perf decision), line
numbers, theme customization UI, Shiki.
