# Code-Block Syntax Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make code blocks in the side panel render with GitHub-style syntax colors in light and dark mode, across the highlight.js common (~35) language set.

**Architecture:** The engine already exists (`codeEnhance.ts` lazy-loads highlight.js; `Markdown.tsx` highlights after streaming ends) but no `.hljs-*` theme CSS was ever shipped, so tokens are colorless. Task 1 widens the language set to `highlight.js/lib/common` with a jsdom test; Task 2 adds the GitHub / GitHub Dark token colors to `styles.css`; Task 3 is full verification.

**Tech Stack:** highlight.js 11 (already a dependency), Vitest + jsdom (already configured), plain CSS.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-syntax-highlighting-design.md`
- Code style: no semicolons, single quotes, 2-space indent; `/** ... */` on exports; explain non-obvious *why* in block comments.
- Type-check with `npm run typecheck` (never `npx tsc` — it fetches a decoy package).
- Commits: pathspec-scoped (`git commit -m msg -- paths…`), no Co-Authored-By/Generated-with trailers.
- Do not touch the copied GitHub token *colors* — they are a faithful upstream copy; only the documented omissions (layout rules, `.hljs` background, empty trailing block) differ.

---

### Task 1: Switch the lazy loader to the hljs common language set (TDD)

**Files:**
- Modify: `src/ui/codeEnhance.ts:64-87` (the `loadHljs` block)
- Test: create `src/ui/codeEnhance.test.ts`

**Interfaces:**
- Consumes: existing exports `highlightCode(code: HTMLElement, lang: string): Promise<void>` and `highlightAll(root: HTMLElement): void` — signatures unchanged.
- Produces: `loadHljs()` now resolves the `highlight.js/lib/common` instance (~35 grammars). No exported signature changes; Task 2/3 rely only on the emitted `hljs-*` / `hljs` classes.

- [ ] **Step 1: Write the failing test**

Create `src/ui/codeEnhance.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { highlightCode } from './codeEnhance'

/** Build a marked-style <pre><code class="language-x"> block in the jsdom body. */
function codeEl(lang: string, text: string): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.className = `language-${lang}`
  code.textContent = text
  pre.append(code)
  document.body.append(pre)
  return code
}

describe('highlightCode with the common language set', () => {
  it('tokenizes a language outside the old 7 (go) with its real grammar', async () => {
    const code = codeEl('go', 'package main\n\nfunc main() {\n}\n')
    await highlightCode(code, 'go')
    // `func` is only a keyword under the genuine go grammar — auto-detect over
    // the old 7-language set (js/ts/python/bash/json/xml/css) never tags it.
    expect(code.innerHTML).toContain('<span class="hljs-keyword">func</span>')
    expect(code.classList.contains('hljs')).toBe(true)
  })

  it('tokenizes sql keywords', async () => {
    const code = codeEl('sql', 'SELECT id FROM users WHERE age > 21;')
    await highlightCode(code, 'sql')
    expect(code.innerHTML).toContain('hljs-keyword')
  })

  it('still tokenizes the original set (typescript)', async () => {
    const code = codeEl('typescript', 'const x: number = 1')
    await highlightCode(code, 'typescript')
    expect(code.innerHTML).toContain('hljs-keyword')
  })

  it('is idempotent — a second call leaves the DOM unchanged', async () => {
    const code = codeEl('go', 'func main() {}')
    await highlightCode(code, 'go')
    const once = code.innerHTML
    await highlightCode(code, 'go')
    expect(code.innerHTML).toBe(once)
  })
})
```

- [ ] **Step 2: Run the test to verify the go/sql cases fail**

Run: `npm test -- src/ui/codeEnhance.test.ts`
Expected: the `go` test FAILS (no `<span class="hljs-keyword">func</span>` — auto-detect over 7 registered languages mis-tags it); `typescript` and idempotence PASS. If `sql` accidentally passes via auto-detect, that is acceptable — the `go` assertion is the load-bearing one.

- [ ] **Step 3: Replace the hand-registered loader**

In `src/ui/codeEnhance.ts`, replace lines 64–87 (the `hljsPromise` declaration and `loadHljs` function) with:

```ts
// Lazy highlight.js "common" build (~35 mainstream languages pre-registered),
// loaded once and shared. The dynamic import keeps every grammar out of the
// initial sidepanel bundle — Vite splits it into an on-demand chunk fetched
// the first time a finished message contains a code block.
let hljsPromise: Promise<typeof import('highlight.js/lib/common').default> | null = null
async function loadHljs() {
  if (!hljsPromise) {
    hljsPromise = import('highlight.js/lib/common').then((m) => m.default)
  }
  return hljsPromise
}
```

Also update the stale file-header comment on line 5 (`Syntax highlighting is layered on in Task 6.`) to describe reality: syntax highlighting is provided by `highlightCode`/`highlightAll` below, themed by the `.hljs-*` rules in `styles.css`.

- [ ] **Step 4: Run the test file to verify all cases pass**

Run: `npm test -- src/ui/codeEnhance.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exits 0, no output.

```bash
git add src/ui/codeEnhance.ts src/ui/codeEnhance.test.ts
git commit -m 'feat(code): highlight with the hljs common set (~35 languages), tested' -- src/ui/codeEnhance.ts src/ui/codeEnhance.test.ts
```

---

### Task 2: GitHub / GitHub Dark token colors in styles.css

**Files:**
- Modify: `src/ui/styles.css` (append at end of file)

**Interfaces:**
- Consumes: the `hljs` / `hljs-*` classes Task 1's engine stamps on `<code>` elements.
- Produces: visible token colors; no selectors or variables consumed elsewhere.

- [ ] **Step 1: Append the theme rules**

Append to the end of `src/ui/styles.css` exactly:

```css
/* ---- Code syntax highlighting ------------------------------------------
   Token colors copied from highlight.js v11's github.css / github-dark.css
   (themselves GitHub's prettylights palette). Deliberately omitted from the
   upstream files: the `pre code.hljs` layout rules and the `.hljs`
   background — .code-block already owns code-block layout and surfaces, and
   GitHub's white / #0d1117 would fight the panel's neutral ramp. The .hljs
   base *color* is kept (hljs-subst/emphasis/strong reference it). Dark mode
   follows the file's prefers-color-scheme pattern. */

.hljs {
  color: #24292e;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
  color: #d73a49;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
  color: #6f42c1;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
  color: #005cc5;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
  color: #032f62;
}
.hljs-built_in,
.hljs-symbol {
  color: #e36209;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
  color: #6a737d;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
  color: #22863a;
}
.hljs-subst {
  color: #24292e;
}
.hljs-section {
  color: #005cc5;
  font-weight: bold;
}
.hljs-bullet {
  color: #735c0f;
}
.hljs-emphasis {
  color: #24292e;
  font-style: italic;
}
.hljs-strong {
  color: #24292e;
  font-weight: bold;
}
.hljs-addition {
  color: #22863a;
  background-color: #f0fff4;
}
.hljs-deletion {
  color: #b31d28;
  background-color: #ffeef0;
}

@media (prefers-color-scheme: dark) {
  .hljs {
    color: #c9d1d9;
  }
  .hljs-doctag,
  .hljs-keyword,
  .hljs-meta .hljs-keyword,
  .hljs-template-tag,
  .hljs-template-variable,
  .hljs-type,
  .hljs-variable.language_ {
    color: #ff7b72;
  }
  .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__,
  .hljs-title.function_ {
    color: #d2a8ff;
  }
  .hljs-attr,
  .hljs-attribute,
  .hljs-literal,
  .hljs-meta,
  .hljs-number,
  .hljs-operator,
  .hljs-variable,
  .hljs-selector-attr,
  .hljs-selector-class,
  .hljs-selector-id {
    color: #79c0ff;
  }
  .hljs-regexp,
  .hljs-string,
  .hljs-meta .hljs-string {
    color: #a5d6ff;
  }
  .hljs-built_in,
  .hljs-symbol {
    color: #ffa657;
  }
  .hljs-comment,
  .hljs-code,
  .hljs-formula {
    color: #8b949e;
  }
  .hljs-name,
  .hljs-quote,
  .hljs-selector-tag,
  .hljs-selector-pseudo {
    color: #7ee787;
  }
  .hljs-subst {
    color: #c9d1d9;
  }
  .hljs-section {
    color: #1f6feb;
    font-weight: bold;
  }
  .hljs-bullet {
    color: #f2cc60;
  }
  .hljs-emphasis {
    color: #c9d1d9;
    font-style: italic;
  }
  .hljs-strong {
    color: #c9d1d9;
    font-weight: bold;
  }
  .hljs-addition {
    color: #aff5b4;
    background-color: #033a16;
  }
  .hljs-deletion {
    color: #ffdcd7;
    background-color: #67060c;
  }
}
```

- [ ] **Step 2: Verify the rules landed and the file still builds**

Run: `grep -c 'hljs' src/ui/styles.css`
Expected: a number ≥ 60 (was 0).

Run: `npm run build`
Expected: `tsc --noEmit` passes, then Vite build succeeds with `dist/` output and no CSS syntax warnings.

- [ ] **Step 3: Commit**

```bash
git add src/ui/styles.css
git commit -m 'feat(code): GitHub light/dark token colors for highlighted code' -- src/ui/styles.css
```

---

### Task 3: Full verification

**Files:** none new — runs the whole suite and the real extension.

**Interfaces:**
- Consumes: Tasks 1–2 complete.
- Produces: evidence for the completion claim.

- [ ] **Step 1: Full test suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all existing tests (268 at baseline) plus the 4 new ones pass; build succeeds. Confirm the hljs chunk is code-split: `ls dist/assets | grep -i common` (or inspect build output for a separate chunk containing highlight languages).

- [ ] **Step 2: End-to-end in Chrome**

Reload the unpacked extension from this worktree's `dist/` in `chrome://extensions`, open the side panel, and ask the model for code samples in go, sql, and typescript. Verify: colored tokens after each message finishes streaming, correct colors in both light and dark (emulate via DevTools rendering → prefers-color-scheme), copy button and collapse toggle still work. If Chrome-driving isn't possible in this environment, verify what is automatable and report the manual step to the user honestly.
