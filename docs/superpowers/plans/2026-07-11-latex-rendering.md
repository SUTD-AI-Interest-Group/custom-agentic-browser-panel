# LaTeX Math Rendering + `writing-math` Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline/display LaTeX math in assistant messages and ship a built-in `writing-math` skill (plus an always-on nudge) so the agent reliably emits render-ready LaTeX.

**Architecture:** KaTeX renders math during Markdown parsing (`marked-katex-extension`), then DOMPurify (bumped to ≥3.4, which preserves KaTeX's MathML) sanitizes the result — all in `src/ui/Markdown.tsx`. A guarded pre-pass normalizes `\(…\)`/`\[…\]` to `$…$`/`$$…$$`. A constant system-prompt note and a built-in skill steer the model to emit LaTeX.

**Tech Stack:** React 18, Vite 6, TypeScript (strict), `marked ^15`, `marked-katex-extension ^5`, `katex ^0.16`, `dompurify ^3.4`.

## Global Constraints

- **No test suite exists** (per CLAUDE.md). Each task verifies via `npm run build` (runs `tsc --noEmit` then `vite build`) plus a manual check in the reloaded unpacked extension (`/verify-extension`). The one pure function (`normalizeMathDelimiters`) additionally gets a deterministic `npx tsx` table-check (dev aid, not committed).
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** … */` on exported symbols.
- **Dependency floors:** `dompurify` ≥ `^3.4.0` (preserves `<semantics>`/`<annotation>`/`<annotation-xml>` + `encoding`); `marked-katex-extension` `^5` (compatible with `marked ^15`).
- **No manifest change** — `public/manifest.json` has no `content_security_policy`; KaTeX fonts load same-origin under the default MV3 CSP.
- **Skill body uses `String.raw`** so LaTeX backslashes stay literal (a normal template literal turns `\pi` into `pi` and throws on `\u…`). The body must contain no backtick and no `${`.
- **Commits:** pathspec-scope every commit (concurrent sessions run on this repo). **No Claude attribution / Co-Authored-By / "Generated with" trailers** in commit messages.
- **Isolation:** implement in a git worktree created at execution time via `superpowers:using-git-worktrees`.

## File Structure

- **Modify** `package.json` — add `katex`, `marked-katex-extension`, `@types/katex`; bump `dompurify`.
- **Modify** `src/ui/Markdown.tsx` — configure the KaTeX marked extension once, import KaTeX CSS, run normalization before parse. Single responsibility: turn assistant text into sanitized HTML.
- **Create** `src/ui/mathDelimiters.ts` — `normalizeMathDelimiters(text)`: pure `\(…\)`/`\[…\]` → `$…$`/`$$…$$` conversion that skips code. Own module so the fiddly code-guard logic is isolated and independently checkable.
- **Modify** `src/ui/Chat.tsx` — add `MATH_FORMATTING_NOTE` constant (after `browsingInsightsNote`, ~line 66) and splice it into the system-prompt assembly (line 719).
- **Modify** `src/data/builtinSkills.ts` — add `WRITING_MATH_BODY` constant and the `writing-math` entry to `BUILTIN_SKILLS`.

Task order: **A** (renderer) → **B** (normalization) → **C** (nudge) → **D** (skill). B builds on A; C and D are independent of A/B but sequenced last.

---

### Task A: KaTeX rendering in Markdown

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/ui/Markdown.tsx` (full rewrite of the 11-line file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Markdown` component now typesets `$…$` (inline) and `$$…$$` (display) LaTeX. Same props (`{ text: string }`).

- [ ] **Step 1: Install dependencies**

Run (updates `package.json` + lockfile to compatible versions):

```bash
npm install katex marked-katex-extension
npm install dompurify@^3.4.0
npm install -D @types/katex
```

Expected: installs succeed; `package.json` shows `katex ^0.16.x`, `marked-katex-extension ^5.x`, `dompurify ^3.4.x`, and dev `@types/katex ^0.16.x`.

- [ ] **Step 2: Rewrite `src/ui/Markdown.tsx`**

```tsx
import { useMemo } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

// Configure the KaTeX extension once at module load (marked.use mutates the
// shared marked instance; Markdown is the only consumer of marked). Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message. DOMPurify ≥3.4 preserves KaTeX's MathML
// (<semantics>/<annotation>), so plain render-then-sanitize is safe.
marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
```

- [ ] **Step 3: Type-check and build**

Run: `npm run build`
Expected: PASS (no TypeScript errors; `vite build` emits `dist/` including hashed `KaTeX_*.woff2` fonts under `dist/assets/`).

- [ ] **Step 4: Verify rendering in the extension**

Reload the unpacked extension (`chrome://extensions`), open the side panel, and send this echo prompt:

> Reply with exactly this line and nothing else: Inline $E=mc^2$ and display $$\int_0^1 x^2\,dx=\tfrac13$$

Expected: `E=mc^2` renders as typeset inline math; the integral renders centered as display math, both with proper KaTeX glyphs (not fallback serif, not raw `$…$`). Then send:

> Reply with exactly: $\frac{1}{$

Expected: renders as a small inline KaTeX error (red), not a blank/broken message.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/ui/Markdown.tsx
git commit -m "feat: render LaTeX math in chat via KaTeX"
```

---

### Task B: `\(…\)` / `\[…\]` delimiter normalization

**Files:**
- Create: `src/ui/mathDelimiters.ts`
- Modify: `src/ui/Markdown.tsx` (import + call before parse)
- Temp (do not commit): `mathDelimiters.check.ts` at repo root

**Interfaces:**
- Consumes: nothing.
- Produces: `export function normalizeMathDelimiters(text: string): string` — converts `\[…\]` → `$$…$$` and `\(…\)` → `$…$` outside code spans/blocks.

- [ ] **Step 1: Write the deterministic check script (expect it to fail)**

Create `mathDelimiters.check.ts` at the repo root:

```ts
import { normalizeMathDelimiters as n } from './src/ui/mathDelimiters'

const cases: [string, string][] = [
  // inline conversion
  ['area is \\(\\pi r^2\\).', 'area is $\\pi r^2$.'],
  // display conversion (may span newlines)
  ['\\[\nE = mc^2\n\\]', '$$\nE = mc^2\n$$'],
  // already-$ math is untouched
  ['inline $a^2$ ok', 'inline $a^2$ ok'],
  // inline code span guarded
  ['use `\\(x\\)` here', 'use `\\(x\\)` here'],
  // fenced code block guarded
  ['```\n\\[x\\]\n```', '```\n\\[x\\]\n```'],
  // prose without math untouched
  ['no math here', 'no math here'],
]

let ok = true
for (const [input, expected] of cases) {
  const got = n(input)
  if (got !== expected) {
    ok = false
    console.log(`FAIL\n  in:  ${JSON.stringify(input)}\n  exp: ${JSON.stringify(expected)}\n  got: ${JSON.stringify(got)}`)
  }
}
console.log(ok ? 'ALL PASS' : 'FAILURES ABOVE')
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx mathDelimiters.check.ts`
Expected: FAIL — module not found / `normalizeMathDelimiters` is not exported (file doesn't exist yet). (First run downloads `tsx`.)

- [ ] **Step 3: Implement `src/ui/mathDelimiters.ts`**

```ts
// Some models (notably OpenAI-family) emit LaTeX math as \(…\) / \[…\], but
// marked-katex-extension only tokenizes the $…$ / $$…$$ forms. Convert the
// backslash-delimited forms so they render too — but never inside code, or a
// code sample containing \( or \[ would be corrupted. We split the text on
// code spans/blocks (captured, so they land at odd indices) and rewrite only
// the non-code chunks.

/** Fenced blocks (``` or ~~~) and inline code spans — matched as one group so
 * String.prototype.split keeps them, interleaved at odd indices. */
const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/** Convert `\(…\)` → `$…$` and `\[…\]` → `$$…$$` outside code. */
export function normalizeMathDelimiters(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((chunk, i) => (i % 2 === 1 ? chunk : rewriteMath(chunk)))
    .join('')
}

function rewriteMath(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`)
}
```

- [ ] **Step 4: Run the check to confirm it passes**

Run: `npx tsx mathDelimiters.check.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Wire it into `src/ui/Markdown.tsx`**

Add the import and call `normalizeMathDelimiters` before `marked.parse`:

```tsx
import { useMemo } from 'react'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from './mathDelimiters'

marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const normalized = normalizeMathDelimiters(text)
    const raw = marked.parse(normalized, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
```

- [ ] **Step 6: Remove the temp check, type-check, build**

Run:

```bash
rm mathDelimiters.check.ts
npm run build
```

Expected: `mathDelimiters.check.ts` gone; `npm run build` PASS.

- [ ] **Step 7: Verify in the extension**

Reload, open the panel, and send:

> Reply with exactly this and nothing else: The identity is \(\sin^2\theta+\cos^2\theta=1\), and the block is \[a^2+b^2=c^2\]

Expected: both render as typeset math (inline + display). Then send:

> Reply with exactly this and nothing else, as a fenced code block containing the two characters backslash and open-paren: ```python\nprint("\\(")\n```

Expected: the code block shows the literal `\(` — it is NOT converted to `$`.

- [ ] **Step 8: Commit**

```bash
git add src/ui/mathDelimiters.ts src/ui/Markdown.tsx
git commit -m "feat: normalize \\(…\\) and \\[…\\] math delimiters outside code"
```

---

### Task C: Always-on math-formatting nudge

**Files:**
- Modify: `src/ui/Chat.tsx` (add constant ~line 66; splice into system string at line 719)

**Interfaces:**
- Consumes: nothing.
- Produces: every turn's system prompt contains `MATH_FORMATTING_NOTE`, regardless of the user's editable `settings.systemPrompt`.

- [ ] **Step 1: Add the constant after `browsingInsightsNote`**

In `src/ui/Chat.tsx`, immediately after the `browsingInsightsNote` function (ends ~line 66), add:

```tsx
// Appended to every system prompt (independent of the user's editable
// settings.systemPrompt) so math renders in the panel even on quick replies
// where the agent doesn't load the writing-math skill. Backslashes are doubled
// for the JS string; the model sees single-backslash LaTeX.
const MATH_FORMATTING_NOTE =
  '\n\nWhen your answer includes mathematical notation, write it in LaTeX: `$…$` for inline math and `$$…$$` on their own lines for display math (these render in the panel). Prefer LaTeX commands over Unicode symbols (e.g. `\\alpha`, `\\leq`, `\\times`). Escape a literal dollar sign as `\\$`.'
```

- [ ] **Step 2: Splice it into the system-prompt assembly (line 719)**

Change the `system:` template literal to include `${MATH_FORMATTING_NOTE}` after `browsingInsightsNote(granted)`:

```tsx
        system: `${settings.systemPrompt}${accessNote}${browsingInsightsNote(granted)}${MATH_FORMATTING_NOTE}${memoryContext ? `\n\n${memoryContext}` : ''}${skillsCatalog}${activeSkills}`,
```

- [ ] **Step 3: Type-check and build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Verify the nudge takes effect**

Reload, open the panel, and ask a plain question that does NOT name LaTeX or invoke a skill:

> What's the quadratic formula?

Expected: the answer shows the formula as typeset math (rendered fraction/roots), confirming the model emitted `$…$`/`$$…$$` without being explicitly told to.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat: nudge the agent to emit render-ready LaTeX for math"
```

---

### Task D: Built-in `writing-math` skill

**Files:**
- Modify: `src/data/builtinSkills.ts` (add body constant + `BUILTIN_SKILLS` entry)

**Interfaces:**
- Consumes: existing `SaveSkillInput` shape and `BUILTIN_SKILLS` array.
- Produces: a seeded built-in skill named `writing-math` (userInvocable + modelInvocable).

- [ ] **Step 1: Add the `WRITING_MATH_BODY` constant**

In `src/data/builtinSkills.ts`, add near the other `*_BODY` constants. Use `String.raw` so LaTeX backslashes are literal (no backtick, no `${` inside):

```ts
const WRITING_MATH_BODY = String.raw`# Writing math

When answering a math, physics, statistics, or engineering question — or whenever your reply contains equations, formulas, derivations, or proofs — format the math as LaTeX so it renders in the panel.

## Delimiters
- Inline math: wrap it in single dollar signs, e.g. write $\pi r^2$ for the area of a circle.
- Display (block) math: put $$ on its own line, then the expression, then $$ on its own line:
$$
E = mc^2
$$
- To show a literal dollar sign in prose, escape it as \$ so it is not read as a math delimiter.

## Prefer LaTeX over Unicode
Write \alpha, \leq, \times, \to, \infty rather than the Unicode characters α, ≤, ×, →, ∞. Unicode math renders inconsistently; LaTeX commands always typeset.

## Common constructs
- Fractions and roots: \frac{a}{b}, \sqrt{x}, \sqrt[3]{x}.
- Sub/superscripts: x^{2}, a_{i}, x_{i}^{2}.
- Auto-sized brackets: \left( \frac{a}{b} \right).
- Multi-line or aligned steps: use an aligned environment inside $$ … $$, with & to align on a symbol and \\ to end each line.
- Matrices: \begin{bmatrix} a & b \\ c & d \end{bmatrix}. Piecewise functions: \begin{cases} … \end{cases}.
- Text and units inside math: \text{…}; use a thin space \, before units, e.g. 5\,\text{m/s}.

## Stay within KaTeX
Rendering uses KaTeX, which supports most standard LaTeX math but not every macro. Stick to standard commands; an unsupported command shows as a small inline error. Reference: https://katex.org/docs/supported.html

## Example
Inline: the solutions of ax^2 + bx + c = 0 are $x = \dfrac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.

Display derivation:
$$
\begin{aligned}
(x + 1)^2 &= x^2 + 2x + 1 \\
          &= x(x + 2) + 1
\end{aligned}
$$`
```

- [ ] **Step 2: Add the entry to `BUILTIN_SKILLS`**

Append to the `BUILTIN_SKILLS` array (after `drafting-replies`):

```ts
  {
    name: 'writing-math',
    description:
      'Formats mathematical and scientific answers as LaTeX that renders in the panel. Use when the user asks a math, physics, statistics, or engineering question, or to write equations, formulas, derivations, or proofs.',
    body: WRITING_MATH_BODY,
    icon: '➗',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
```

- [ ] **Step 3: Type-check and build**

Run: `npm run build`
Expected: PASS (confirms the `String.raw` body has no stray backtick/`${` breaking the literal).

- [ ] **Step 4: Verify the skill seeded correctly**

Reload the extension (seeding runs on mount in `App.tsx:31`, idempotent by name). Then:
- Open **Skills** (Library): a `writing-math` card appears with the **Built-in** badge and the ➗ icon.
- Open it: the body displays **single-backslash** LaTeX (`\frac`, `\begin{aligned}`, `\pi`) — confirming `String.raw` preserved the backslashes.
- In the composer, type `/` : `writing-math` appears in the menu.
- Ask: `Derive the expansion of (x+1)^2 step by step.` Expected: the agent produces an aligned, typeset derivation (it may load the skill via `ReadSkill`; the math renders regardless).

- [ ] **Step 5: Commit**

```bash
git add src/data/builtinSkills.ts
git commit -m "feat: add built-in writing-math skill for LaTeX authoring"
```

---

## Self-Review

**1. Spec coverage** (checked against `docs/superpowers/specs/2026-07-11-latex-rendering-design.md`):
- Part A renderer (deps, KaTeX CSS, marked config, dompurify bump, render-then-sanitize) → Task A. ✓
- Delimiter normalization with code-guard → Task B. ✓
- Streaming (no special handling; `useMemo` re-runs) → inherent in Task A/B; verified implicitly by echo prompts. ✓
- Part B baseline nudge in `Chat.tsx:719` → Task C. ✓
- Part C `writing-math` skill (String.raw, `\text{}`/units, aligned example, katex link) → Task D. ✓
- Edge cases: malformed (`throwOnError:false`) → Task A Step 4; copy-as-markdown preserves source (no code change, unaffected) → noted, no task needed; copy-as-PNG → covered by manual verification, no code change. ✓
- No-manifest-change, same-origin fonts → Task A Step 3 (fonts emitted) + Global Constraints. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The `…` characters inside the skill body and nudge are intentional literal ellipsis copy, not placeholders. ✓

**3. Type consistency:** `normalizeMathDelimiters(text: string): string` is defined in Task B Step 3 and consumed identically in Task B Step 5. `Markdown` props unchanged (`{ text: string }`). `WRITING_MATH_BODY` (Task D Step 1) referenced as `body: WRITING_MATH_BODY` (Task D Step 2). `MATH_FORMATTING_NOTE` (Task C Step 1) spliced in Task C Step 2. All consistent. ✓
