# LaTeX self-correction / validation loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee the side-panel never renders garbled/cascaded LaTeX, and silently repair broken math the model emits by re-asking it to fix only the broken fragments.

**Architecture:** Two layers. A pure **deterministic validator** (`validateMath`) runs before `marked` on every final message — it KaTeX-trial-compiles each `$…$`/`$$…$$` span and wraps any that won't compile in an inert code span, so a stray `$` can never desync the rest. It also returns the broken spans; for chat replies, `Chat.tsx` then fires one automatic, silent, surgical model call (`repairMessageText`) that fixes only those fragments and splices them back.

**Tech Stack:** TypeScript (strict), React 18, `marked` ^15 + `marked-katex-extension` ^5.1, `katex` ^0.17, Vercel AI SDK v5 (`generateText`), Vitest (jsdom env).

## Global Constraints

- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** … */` on exported types/functions.
- **No backend, client-side only.** The repair uses the same OpenAI-compatible endpoint the turn used (`createModel`), as a side-call — like `generateChatTitle`/`testModel` in `src/agent/provider.ts`.
- **Not an agent tool.** The repair is a direct model side-call, so it does **not** route through `requestApproval`/`createAgentTools` (that gate is only for page/network/data tools). Do not add it there.
- **`katex` is already a dependency** (`^0.17.0`); `katex.renderToString(tex, { throwOnError: true, displayMode })` throws `ParseError` on invalid input.
- **KaTeX is lenient — this bounds the contract.** Verified against the installed KaTeX 0.17: it throws only on *structural* errors (unbalanced braces `\frac{a}{`, undefined control sequences `\notacommand`, dangling `a^`/`\sqrt{`), and silently renders loose text such as `|sigma is bad`, `x=5`, or `) and ` as implicit-multiplication variables **without throwing**. So `validateMath` neutralizes/flags only *structurally-invalid* LaTeX; a renderable-but-semantically-wrong span (e.g. a `\sigma` typed as `sigma`) is NOT caught and is out of scope. The primary anti-cascade guarantee comes from **balanced-delimiter pairing + escaping unpaired `$`**, which does not depend on KaTeX rejecting anything. Use genuinely-uncompilable LaTeX (unbalanced brace `$\frac{a}{$`) in tests that assert neutralization — never loose text.
- **Vitest env is `jsdom`** (see `vitest.config.ts`); tests run in Node with `DOMParser` available.
- **Scope: chat replies only.** The deterministic layer covers everything rendered by `Markdown.tsx` (chat + research reports) for free; the automatic model re-emit runs only for interactive chat turns.

---

### Task 1: `validateMath` — deterministic validator/neutralizer (pure)

**Files:**
- Create: `src/ui/mathValidate.ts`
- Test: `src/ui/mathValidate.test.ts`

**Interfaces:**
- Consumes: `katex` (`renderToString`).
- Produces:
  - `interface MathSpan { raw: string; start: number; end: number; display: boolean }`
  - `interface MathValidation { cleaned: string; invalid: MathSpan[] }`
  - `function validateMath(text: string): MathValidation`

- [ ] **Step 1: Write the failing test**

Create `src/ui/mathValidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateMath } from './mathValidate'

describe('validateMath', () => {
  it('leaves balanced inline and display math untouched', () => {
    const text = 'Peak at $x=0$ and\n\n$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$\n\ndone'
    const { cleaned, invalid } = validateMath(text)
    expect(invalid).toHaveLength(0)
    expect(cleaned).toBe(text)
  })

  it('neutralizes a structurally-invalid inline span as inline code and records it', () => {
    // KaTeX throws on an unbalanced brace (unlike loose text such as `|sigma`,
    // which it renders without error — see the notes on KaTeX leniency).
    const { cleaned, invalid } = validateMath('width $\\frac{a}{$ here')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].raw).toBe('$\\frac{a}{$')
    expect(invalid[0].display).toBe(false)
    expect(cleaned).toBe('width `$\\frac{a}{$` here')
  })

  it('an uncompilable span is neutralized without stopping a later valid one', () => {
    const { cleaned, invalid } = validateMath('bad $\\frac{a}{$ then good $x=5$ end')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].raw).toBe('$\\frac{a}{$')
    expect(cleaned).toContain('$x=5$') // the valid pair survives as math
    expect(cleaned).toContain('`$\\frac{a}{$`') // the bad one becomes inert code
  })

  it('escapes a lone trailing $ that never closes', () => {
    const { cleaned } = validateMath('cost is $5 today') // single unpaired $
    expect(cleaned).toBe('cost is \\$5 today')
  })

  it('never touches $ inside fenced or inline code, nor a literal \\$', () => {
    const fenced = '```\n$x$ not math\n```\ntext'
    expect(validateMath(fenced).cleaned).toBe(fenced)
    const inline = 'run `$PATH` here'
    expect(validateMath(inline).cleaned).toBe(inline)
    const literal = 'costs \\$5 flat'
    expect(validateMath(literal).cleaned).toBe(literal)
  })

  it('keeps a valid display integral while flagging a genuinely broken span', () => {
    const text = [
      'Peak density $\\lambda_0$ and a broken bit $\\frac{x}{$ here.',
      '',
      'Total charge: $$Q = \\int_{-\\infty}^{\\infty} \\lambda_0 e^{-\\frac{x^2}{2\\sigma^2}} dx$$',
    ].join('\n')
    const { invalid, cleaned } = validateMath(text)
    // The valid display integral survives; the structurally-broken span is caught.
    expect(cleaned).toContain('$$Q = \\int_{-\\infty}^{\\infty}')
    expect(invalid.some((s) => s.raw.includes('\\frac{x}{'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/mathValidate.test.ts`
Expected: FAIL — `Failed to resolve import "./mathValidate"` / `validateMath is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/mathValidate.ts`:

```ts
// Deterministic LaTeX safety net. Runs before marked on a FINAL message: it
// KaTeX-trial-compiles every $…$ / $$…$$ span and neutralizes any that would
// not render (wrapping it as inert inline code) so a single malformed or stray
// `$` can never desync marked-katex's delimiter pairing and cascade-break the
// rest of the message. It also reports the broken spans (with offsets into the
// ORIGINAL text) so the surgical model-repair fallback can splice fixes back.
import katex from 'katex'

/** A delimited math span, addressed by its offsets into the original text. */
export interface MathSpan {
  raw: string
  start: number
  end: number
  display: boolean
}

/** `cleaned` is safe to hand to marked-katex (never desyncs); `invalid` lists
 *  the spans that would not compile, in document order. */
export interface MathValidation {
  cleaned: string
  invalid: MathSpan[]
}

// Alternatives, code FIRST (so a `$` inside code is consumed as code and never
// treated as math), then display `$$…$$` before inline `$…$`. The opening
// delimiters use a (?<!\\) lookbehind so a literal `\$` is never opened as math.
// Mirrors the code-awareness of mathDelimiters.ts.
const SCAN =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|(`+)[\s\S]*?\1|(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:\\\$|[^$])+?)\$/g

function compiles(tex: string, display: boolean): boolean {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: display })
    return true
  } catch {
    return false
  }
}

// Wrap a bad span so marked renders it inert (monospace), never as math. LaTeX
// virtually never contains a backtick; if it does, fall back to escaping the $
// so it shows as literal text instead of breaking the code span.
function neutralize(raw: string): string {
  if (raw.includes('`')) return raw.replace(/\$/g, '\\$')
  return '`' + raw + '`'
}

// Escape any unpaired `$` left in a plain-text segment so marked-katex cannot
// pair it across the gap. A literal `\$` is left alone.
function escapeStrayDollars(segment: string): string {
  return segment.replace(/(?<!\\)\$/g, '\\$')
}

/** Validate + neutralize the math in `text`. Pure; safe to run on every render. */
export function validateMath(text: string): MathValidation {
  const invalid: MathSpan[] = []
  let cleaned = ''
  let last = 0
  SCAN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCAN.exec(text)) !== null) {
    const match = m[0]
    const display = m[2]
    const inline = m[3]
    cleaned += escapeStrayDollars(text.slice(last, m.index))
    const start = m.index
    const end = m.index + match.length
    last = end
    if (display !== undefined) {
      if (compiles(display.trim(), true)) cleaned += match
      else {
        cleaned += neutralize(match)
        invalid.push({ raw: match, start, end, display: true })
      }
    } else if (inline !== undefined) {
      if (compiles(inline.trim(), false)) cleaned += match
      else {
        cleaned += neutralize(match)
        invalid.push({ raw: match, start, end, display: false })
      }
    } else {
      cleaned += match // code region — passthrough
    }
  }
  cleaned += escapeStrayDollars(text.slice(last))
  return { cleaned, invalid }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/mathValidate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/mathValidate.ts src/ui/mathValidate.test.ts
git commit -m "feat(math): deterministic LaTeX validator/neutralizer"
```

---

### Task 2: Wire `validateMath` into the final Markdown render

**Files:**
- Modify: `src/ui/Markdown.tsx` (the `useMemo` at lines ~43–61)
- Test: `src/ui/mathRender.test.ts` (create)

**Interfaces:**
- Consumes: `validateMath` (Task 1), `normalizeMathDelimiters` (`src/ui/mathDelimiters.ts`).
- Produces: no new exports; behavioral change to `Markdown` (final render only).

- [ ] **Step 1: Write the failing test**

Create `src/ui/mathRender.test.ts` — asserts the composed transform yields the intended KaTeX nodes and no raw leak, exactly as `Markdown` will use it:

```ts
import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'

marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

// The exact sequence Markdown.tsx runs for a final (non-streaming) message.
function render(text: string): string {
  const normalized = normalizeMathDelimiters(text)
  const cleaned = validateMath(normalized).cleaned
  return marked.parse(cleaned, { async: false }) as string
}
const displayCount = (html: string) => (html.match(/katex-display/g) || []).length

describe('markdown math render (with validateMath)', () => {
  it('renders a clean display equation', () => {
    expect(displayCount(render('$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$'))).toBe(1)
  })

  it('an uncompilable inline span does not stop a later valid display equation', () => {
    const text = 'width $\\frac{a}{$ then\n\n$$Q = \\lambda_0 \\sigma$$'
    const html = render(text)
    expect(displayCount(html)).toBe(1) // the display equation still renders
    // the structurally-broken inline span is inert code, not a half-math node
    expect(html).toContain('<code>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/mathRender.test.ts`
Expected: FAIL — the malformed-span case renders `0` display equations (cascade) and/or no `<code>` until `validateMath` is wired. (If it happens to pass pre-wiring, keep the test; Step 3 still adds the guarantee.)

- [ ] **Step 3: Apply the wiring**

In `src/ui/Markdown.tsx`, add the import near the top (after the existing `normalizeMathDelimiters` import at line 6):

```ts
import { validateMath } from './mathValidate'
```

Then in the `useMemo` body, change the normalize→parse sequence (currently lines ~47–49):

```ts
    const src = citations ? encodeCitations(text) : text
    const normalized = normalizeMathDelimiters(src)
    const raw = marked.parse(normalized, { async: false }) as string
```

to insert the validator between `normalized` and `marked.parse`, gated on NOT streaming (mid-stream a closing `$` may not have arrived yet, so leave the lenient path):

```ts
    const src = citations ? encodeCitations(text) : text
    const normalized = normalizeMathDelimiters(src)
    // On the FINAL render, neutralize any LaTeX that won't compile so a stray
    // `$` can't cascade-break the rest. Mid-stream stays lenient (a closing `$`
    // may not have streamed yet); it self-heals when the stream completes.
    const safe = streaming ? normalized : validateMath(normalized).cleaned
    const raw = marked.parse(safe, { async: false }) as string
```

Add `streaming` to the `useMemo` dependency array (currently `[text, citations]`):

```ts
  }, [text, citations, streaming])
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/ui/mathRender.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Markdown.tsx src/ui/mathRender.test.ts
git commit -m "feat(math): neutralize uncompilable LaTeX before final render"
```

---

### Task 3: Repair primitives — prompt, parse, splice (pure)

**Files:**
- Create: `src/agent/mathRepair.ts`
- Test: `src/agent/mathRepair.test.ts`

**Interfaces:**
- Consumes: `MathSpan`, `validateMath` (Task 1).
- Produces:
  - `type Complete = (prompt: string) => Promise<string>`
  - `function buildRepairPrompt(spans: MathSpan[]): string`
  - `function parseFixes(raw: string, spans: MathSpan[]): Map<string, string>`
  - `function spliceFixes(text: string, spans: MathSpan[], fixes: Map<string, string>): string`

- [ ] **Step 1: Write the failing test**

Create `src/agent/mathRepair.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRepairPrompt, parseFixes, spliceFixes } from './mathRepair'
import type { MathSpan } from '../ui/mathValidate'

const span = (raw: string, start: number, end: number, display = false): MathSpan => ({
  raw,
  start,
  end,
  display,
})

describe('buildRepairPrompt', () => {
  it('numbers each broken fragment', () => {
    const p = buildRepairPrompt([span('$|sigma$', 0, 8), span('$$bad$$', 9, 16, true)])
    expect(p).toContain('1. $|sigma$')
    expect(p).toContain('2. $$bad$$')
  })
})

describe('parseFixes', () => {
  const spans = [span('$|sigma$', 6, 14)]

  it('accepts a valid, compilable fix keyed by original raw', () => {
    const fixes = parseFixes('[{"index":1,"fixed":"$\\\\sigma$"}]', spans)
    expect(fixes.get('$|sigma$')).toBe('$\\sigma$')
  })

  it('drops a fix that itself will not compile', () => {
    // The returned "fix" has an unbalanced brace, so validateMath rejects it.
    const fixes = parseFixes('[{"index":1,"fixed":"$\\\\frac{a}{$"}]', spans)
    expect(fixes.size).toBe(0)
  })

  it('returns an empty map on non-JSON output', () => {
    expect(parseFixes('sorry I cannot help', spans).size).toBe(0)
  })

  it('tolerates prose around the JSON array', () => {
    const fixes = parseFixes('Here you go:\n[{"index":1,"fixed":"$\\\\sigma$"}]\nDone', spans)
    expect(fixes.get('$|sigma$')).toBe('$\\sigma$')
  })
})

describe('spliceFixes', () => {
  it('replaces spans right-to-left so offsets stay valid', () => {
    const text = 'a $|x$ b $|y$ c'
    const spans = [span('$|x$', 2, 6), span('$|y$', 9, 13)]
    const fixes = new Map([
      ['$|x$', '$x$'],
      ['$|y$', '$y$'],
    ])
    expect(spliceFixes(text, spans, fixes)).toBe('a $x$ b $y$ c')
  })

  it('leaves spans with no fix unchanged', () => {
    const text = 'a $|x$ b'
    const spans = [span('$|x$', 2, 6)]
    expect(spliceFixes(text, spans, new Map())).toBe('a $|x$ b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/mathRepair.test.ts`
Expected: FAIL — `Failed to resolve import "./mathRepair"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/mathRepair.ts` (this step adds only the pure primitives; `repairMessageText` comes in Task 4):

```ts
// Surgical, silent LaTeX self-correction. When the deterministic validator
// (validateMath) cannot compile a math span, these helpers ask the model to fix
// ONLY the broken fragments and splice the corrected LaTeX back into the message
// — no answer content is regenerated. Every failure mode degrades to a no-op.
import { validateMath, type MathSpan } from '../ui/mathValidate'

/** A thin model call: prompt in, completion text out. Injected so this module
 *  stays pure/testable and unaware of the provider adapter. */
export type Complete = (prompt: string) => Promise<string>

/** Build the correction prompt for a set of broken fragments. */
export function buildRepairPrompt(spans: MathSpan[]): string {
  const list = spans.map((s, i) => `${i + 1}. ${s.raw}`).join('\n')
  return [
    'The following LaTeX math expressions from an assistant message are INVALID and will not render.',
    'Return corrected, valid LaTeX for each, keeping the same delimiters ($…$ for inline, $$…$$ for display).',
    'Fix only the LaTeX syntax — do not change the mathematical meaning, add commentary, or reorder.',
    'Respond with ONLY a JSON array, one object per item, in order:',
    '[{"index": 1, "fixed": "$$...$$"}]',
    '',
    'Expressions:',
    list,
  ].join('\n')
}

/** Parse the model's JSON reply into a map of originalRaw → fixedLatex, keeping
 *  only fixes that themselves compile clean. Any malformed output ⇒ empty map. */
export function parseFixes(raw: string, spans: MathSpan[]): Map<string, string> {
  const out = new Map<string, string>()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(arr)) return out
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const idx = (item as { index?: unknown }).index
    const fixed = (item as { fixed?: unknown }).fixed
    if (typeof idx !== 'number' || typeof fixed !== 'string') continue
    const span = spans[idx - 1]
    if (!span) continue
    const f = fixed.trim()
    if (!f || validateMath(f).invalid.length > 0) continue // accept only clean fixes
    out.set(span.raw, f)
  }
  return out
}

/** Splice fixes into `text` at each span's recorded offsets, right-to-left so
 *  earlier offsets remain valid as later spans are replaced. */
export function spliceFixes(
  text: string,
  spans: MathSpan[],
  fixes: Map<string, string>,
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start)
  let out = text
  for (const s of ordered) {
    const fix = fixes.get(s.raw)
    if (fix === undefined) continue
    out = out.slice(0, s.start) + fix + out.slice(s.end)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/mathRepair.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mathRepair.ts src/agent/mathRepair.test.ts
git commit -m "feat(math): repair primitives — prompt, parse, splice"
```

---

### Task 4: `repairMessageText` orchestrator (tested with a fake `Complete`)

**Files:**
- Modify: `src/agent/mathRepair.ts`
- Test: `src/agent/mathRepair.test.ts` (extend)

**Interfaces:**
- Consumes: `validateMath` (Task 1); `buildRepairPrompt`, `parseFixes`, `spliceFixes`, `Complete` (Task 3).
- Produces: `function repairMessageText(text: string, complete: Complete): Promise<string>` — returns the input unchanged when there is nothing to fix or the repair fails/does not improve; otherwise the spliced text.

- [ ] **Step 1: Write the failing test**

Append to `src/agent/mathRepair.test.ts`:

```ts
import { repairMessageText } from './mathRepair'

describe('repairMessageText', () => {
  it('returns text unchanged when all math is already valid', async () => {
    const text = 'clean $x=1$ and $$y=2$$'
    let called = false
    const fixed = await repairMessageText(text, async () => {
      called = true
      return ''
    })
    expect(fixed).toBe(text)
    expect(called).toBe(false) // no model call when nothing is broken
  })

  it('splices in a valid fix from the model', async () => {
    const text = 'width $\\frac{a}{$ here'
    const complete = async () => '[{"index":1,"fixed":"$\\\\sigma$"}]'
    expect(await repairMessageText(text, complete)).toBe('width $\\sigma$ here')
  })

  it('keeps the original when the model output is unusable', async () => {
    const text = 'width $\\frac{a}{$ here'
    expect(await repairMessageText(text, async () => 'no json here')).toBe(text)
  })

  it('keeps the original when the model call throws', async () => {
    const text = 'width $\\frac{a}{$ here'
    const complete = async () => {
      throw new Error('network')
    }
    expect(await repairMessageText(text, complete)).toBe(text)
  })

  it('does not regress: rejects a splice that leaves more broken spans', async () => {
    const text = 'width $\\frac{a}{$ here'
    // A "fix" that parses+compiles individually but we simulate no improvement:
    // return an empty array so no fix applies -> original preserved.
    expect(await repairMessageText(text, async () => '[]')).toBe(text)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/mathRepair.test.ts`
Expected: FAIL — `repairMessageText is not exported`.

- [ ] **Step 3: Add the orchestrator**

Append to `src/agent/mathRepair.ts`:

```ts
/** Validate `text`; if any math won't compile, ask `complete` to fix just those
 *  fragments and splice the corrected LaTeX back. Returns the original text on
 *  any failure or when the splice would not reduce the number of broken spans —
 *  so it can only ever improve the message, never regress it, and never throws. */
export async function repairMessageText(text: string, complete: Complete): Promise<string> {
  const { invalid } = validateMath(text)
  if (invalid.length === 0) return text
  let reply: string
  try {
    reply = await complete(buildRepairPrompt(invalid))
  } catch {
    return text
  }
  const fixes = parseFixes(reply, invalid)
  if (fixes.size === 0) return text
  const spliced = spliceFixes(text, invalid, fixes)
  return validateMath(spliced).invalid.length < invalid.length ? spliced : text
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/mathRepair.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mathRepair.ts src/agent/mathRepair.test.ts
git commit -m "feat(math): repairMessageText orchestrator (validate -> fix -> splice)"
```

---

### Task 5: Chat wiring — post-turn silent repair + `fixingMath` UI

**Files:**
- Modify: `src/agent/agent.ts` (add `fixingMath?: boolean` to `UIMessage`)
- Modify: `src/ui/Chat.tsx` (messagesRef, post-turn repair kickoff, spinner)
- Modify: `src/ui/styles.css` (spinner style)

**Interfaces:**
- Consumes: `repairMessageText`, `Complete` (Task 4); `createModel` (`src/agent/provider.ts`); `generateText` (`ai`).
- Produces: no new exports; behavioral change (final chat bubbles self-correct their math).

This task is Chrome/React-coupled — verified by typecheck + build + the `/verify-extension` flow, not unit tests (consistent with `CLAUDE.md`).

- [ ] **Step 1: Add the `fixingMath` flag to the message type**

In `src/agent/agent.ts`, in `interface UIMessage`, add after the `sources?` field:

```ts
  /** True while the silent LaTeX self-correction pass is re-asking the model to
   *  fix math this bubble contains; drives the "fixing math…" indicator. */
  fixingMath?: boolean
```

- [ ] **Step 2: Add a `messagesRef` mirror + imports in `Chat.tsx`**

Near the other refs (after `historyRef` at line ~410), add:

```ts
  const messagesRef = useRef<UIMessage[]>([])
```

Add an effect to keep it current (place it beside the other `useEffect`s, e.g. after the persistence effect at ~513):

```ts
  // Mirror the latest transcript into a ref so the async, fire-and-forget math
  // repair can read final bubble text without racing React state.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
```

Ensure the imports exist at the top of `Chat.tsx` (add any that are missing):

```ts
import { generateText } from 'ai'
import { createModel } from '../agent/provider'
import { repairMessageText, type Complete } from '../agent/mathRepair'
```

(`UIMessage` is already imported from `../agent/agent`; `createModel` is already imported and used at line ~1155 — do not duplicate. Add only what is not already present.)

- [ ] **Step 3: Track produced assistant bubble ids and kick off repair**

In `runTurnChain`, declare a collector next to `assistantTexts` (line ~1142):

```ts
    const assistantIds = new Set<string>()
```

Add `assistantId` to it at BOTH creation points — after line ~1146 and after line ~1206:

```ts
    assistantIds.add(assistantId)
```

Immediately after the success-path journal block (after `trace?.end({ output: assistantTexts.join('\n').trim() })` at line ~1215), fire the repair (fire-and-forget so it never blocks the `finally`):

```ts
      // Silent LaTeX self-correction: after the turn settles, repair any math the
      // deterministic render layer could not compile. Fire-and-forget.
      void repairAssistantMath([...assistantIds], model)
```

- [ ] **Step 4: Implement `repairAssistantMath`**

Add this helper inside the `Chat` component (a sibling of `runTurnChain`, so it closes over `setMessages`/`messagesRef`):

```ts
  // For each assistant bubble this turn produced, validate its text and, if any
  // math is uncompilable, silently re-ask the model to fix just those fragments
  // and splice the result in. Never throws; degrades to the deterministic
  // best-effort (inert code) on any failure.
  async function repairAssistantMath(ids: string[], model: { provider: ProviderConfig; modelId: string }) {
    const complete: Complete = (prompt) =>
      generateText({
        model: createModel(model.provider, model.modelId),
        prompt,
        abortSignal: AbortSignal.timeout(20_000),
      }).then((r) => r.text)

    for (const id of ids) {
      const msg = messagesRef.current.find((m) => m.id === id)
      const partIdx = msg?.parts.findIndex((p) => p.type === 'text') ?? -1
      if (!msg || partIdx < 0) continue
      const part = msg.parts[partIdx]
      if (part.type !== 'text') continue
      const original = part.text
      if (validateMath(original).invalid.length === 0) continue

      setMessages((m) => m.map((x) => (x.id === id ? { ...x, fixingMath: true } : x)))
      let fixed = original
      try {
        fixed = await repairMessageText(original, complete)
      } catch {
        fixed = original
      }
      setMessages((m) =>
        m.map((x) => {
          if (x.id !== id) return x
          const parts =
            fixed === original
              ? x.parts
              : x.parts.map((p, i) => (i === partIdx && p.type === 'text' ? { ...p, text: fixed } : p))
          return { ...x, parts, fixingMath: false }
        }),
      )
    }
  }
```

Add the missing imports for the types used above (top of `Chat.tsx`, if not already present):

```ts
import { validateMath } from './mathValidate'
import type { ProviderConfig } from '../data/settings'
```

- [ ] **Step 5: Show the "fixing math…" indicator**

In `MessageView` (the assistant branch, after the `message.parts.map(...)` block and before the closing `</div>` of `msg-assistant-body`, around line 1819), add:

```tsx
        {message.fixingMath && !streaming && (
          <div className="fixing-math" aria-live="polite">
            <span className="fixing-math-spinner" aria-hidden="true" />
            fixing math…
          </div>
        )}
```

`MessageView` renders `message` (a `UIMessage`) and already receives `streaming` — no new props needed. Confirm `fixingMath` is readable on `message`.

- [ ] **Step 6: Style the indicator**

Append to `src/ui/styles.css`:

```css
/* Silent LaTeX self-correction: shown while the model re-emits broken math. */
.fixing-math {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted, #888);
}
.fixing-math-spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: fixing-math-spin 0.7s linear infinite;
}
@keyframes fixing-math-spin {
  to {
    transform: rotate(360deg);
  }
}
```

(If `--text-muted` is not a variable in this codebase, use the muted color already used by `.msg-assistant` metadata — grep `styles.css` for the existing muted token and match it.)

- [ ] **Step 7: Typecheck + build**

Run: `npm run build`
Expected: `tsc --noEmit` passes, Vite build succeeds. Fix any type errors (e.g. the `model` param shape must match `selected`'s type — align with how `createModel(model.provider, model.modelId)` is already called at line ~1155).

- [ ] **Step 8: Full test suite**

Run: `npm test`
Expected: all prior tests + the new math tests pass (0 failures).

- [ ] **Step 9: Manual end-to-end verification**

Use the `/verify-extension` skill (or manually): `npm run build`, reload the unpacked extension at `chrome://extensions`, open the side panel, and ask the local model a math-heavy question (e.g. "derive the total charge of a Gaussian-distributed rod, show the integral"). Confirm:
- equations render cleanly (no raw `$$…$$` leaking, no cascaded half-math);
- if the model emits broken LaTeX, the broken spans briefly show as inert monospace with a "fixing math…" spinner, then snap to rendered math;
- the corrected message persists across a panel reload (it is saved via the existing conversation-persistence effect).

- [ ] **Step 10: Commit**

```bash
git add src/agent/agent.ts src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat(math): silent post-turn LaTeX self-correction in chat"
```

---

## Notes for the implementer

- **Do not** register the repair as an agent tool or route it through `requestApproval` — it is a side-call like `generateChatTitle`.
- **Offsets are into the original text.** `MathSpan.start/end` index the un-normalized message part text used by `spliceFixes`; `validateMath.cleaned` is a separate render-only string. Keep these straight.
- **Streaming stays lenient** by design (Task 2, Step 3): only the final render neutralizes, and only completed bubbles are repaired (Task 5).
- **Right-to-left splicing** (Task 3) is required — splicing left-to-right would invalidate later offsets.
- **The `model` type is confirmed:** `const model = selected` (line ~1071), where `selected = getSelectedProvider(settings)` returns `{ provider: ProviderConfig; modelId: string } | null` (`src/data/settings.ts:192`). The guard `if (!selected) return` at line ~1070 narrows it non-null, so `repairAssistantMath(ids, model: { provider: ProviderConfig; modelId: string })` matches exactly — no cast needed. Because the turn cannot run without a selected model, `model` is always present at the repair kickoff.
