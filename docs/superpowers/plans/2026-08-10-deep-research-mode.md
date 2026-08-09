# Deep Research Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make background research an explicit, user-armed mode whose question is visible and editable before anything runs, and whose launch card, live progress and finished report are one transcript object in one slot.

**Architecture:** A composer pill arms the mode. Sending while armed runs one structured-output framing call (no tool loop) that produces an editable *proposal* — question, brief, seed sub-questions, an optional premise flag, and a source scope. The proposal lives on the transcript message, not in `researchTasks` storage, so no never-started rows pollute the task map or the resume watchdog. On Start it becomes a real task and the same message mutates through `running` → `done`. The model loses the ability to launch: `StartResearch` becomes `ProposeResearch`, which only renders a chip.

**Tech Stack:** React 18 + Vite 6 + TypeScript (strict), Vercel AI SDK v5 (`generateObject`/`generateText`), Vitest, Chrome MV3 (`chrome.storage.local`, offscreen document, service worker).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-deep-research-mode-design.md` is the source of truth. Read it before Task 1.
- **Code style (no linter — match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes and `type` for unions, `/** … */` on exported types/functions, block comments explaining non-obvious *why*.
- **Verification:** `npm run typecheck` and `npm test` must pass before every commit. `npm run build` runs `tsc --noEmit && vite build`.
- **Exact copy strings (deliberated — do not paraphrase):**
  - Pill label: `Deep research` · glyph `◈`
  - Armed placeholder: `Research anything — this runs in the background…`
  - Duration line, used identically on the launch card AND the propose chip: `usually 10–20 min`
  - Launch card full duration line: `usually 10–20 min · keeps running if you close the panel`
  - Propose chip: `◈ Research this properly · usually 10–20 min`
  - Private-window line on the live card: `↳ in a private window`
  - Research tab page title: `Lychee is researching…`
- **Tool naming:** every tool name must match `^[a-zA-Z0-9_-]{1,64}$` — a bad name 400s the whole request (`src/tools/toolNames.test.ts`).
- **Never** put image data in a tool return value, and **never** write a secret outside `loadSettings`/`saveSettings`. Neither applies directly here, but both are repo invariants.
- **Empty source scope means unrestricted** — today's behavior — everywhere it is consumed.

---

### Task 1: `parseFraming` — the pure framing-output parser

**Files:**
- Create: `src/agent/researchFraming.ts`
- Create: `src/agent/researchFraming.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no Chrome / AI SDK imports — keep it that way).
- Produces: `ResearchFramingResult`, `parseFraming(raw: string | object, fallbackQuestion: string): ResearchFramingResult`, `normalizeHost(input: string): string | null`. Tasks 5, 6 and 10 consume these.

- [ ] **Step 1: Write the failing test**

Create `src/agent/researchFraming.test.ts`:

```ts
import { expect, test } from 'vitest'
import { normalizeHost, parseFraming } from './researchFraming'

const RAW = {
  question: 'Compare the specs of the 4 Aftershock prebuilt configs',
  brief: 'The overview page lists 4 configs; product pages hold the spec sheets.',
  subQuestions: ['CPU / GPU per config', 'RAM & storage'],
  sites: ['https://www.aftershockpc.com/pc/apex'],
  premise: { asserted: '5 setups', corrected: '4 setups' },
  clarifications: ['Budget range?'],
}

test('passes a well-formed object through, normalizing sites to hosts', () => {
  const r = parseFraming(RAW, 'fallback')
  expect(r.question).toBe('Compare the specs of the 4 Aftershock prebuilt configs')
  expect(r.sites).toEqual(['aftershockpc.com'])
  expect(r.premise).toEqual({ asserted: '5 setups', corrected: '4 setups' })
})

test('parses JSON out of a string, past a think block and a preamble', () => {
  const raw = `<think>the user said five</think>\nSure! Here you go:\n${JSON.stringify(RAW)}`
  expect(parseFraming(raw, 'fallback').question).toBe(RAW.question)
})

test('unwraps a quoted question', () => {
  expect(parseFraming({ question: '"Compare the configs"' }, 'fb').question).toBe('Compare the configs')
})

test('truncates clarifications to two', () => {
  const r = parseFraming({ question: 'q', clarifications: ['a', 'b', 'c'] }, 'fb')
  expect(r.clarifications).toEqual(['a', 'b'])
})

test('drops a premise missing either half', () => {
  expect(parseFraming({ question: 'q', premise: { asserted: '5' } }, 'fb').premise).toBeUndefined()
})

test('unusable output falls back to the raw message with no premise and no scope', () => {
  const r = parseFraming('not json at all', 'compare the setups')
  expect(r).toEqual({ question: 'compare the setups', subQuestions: [], sites: [] })
})

test('normalizeHost strips scheme, path, port and a leading www', () => {
  expect(normalizeHost('https://www.aftershockpc.com:443/pc/x')).toBe('aftershockpc.com')
  expect(normalizeHost('aftershockpc.com')).toBe('aftershockpc.com')
  expect(normalizeHost('   ')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/researchFraming.test.ts`
Expected: FAIL — "Failed to resolve import ./researchFraming".

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/researchFraming.ts`:

```ts
// Pure parsing/normalization for the research framing call. Kept free of any
// Chrome or AI-SDK import so it can be unit-tested directly — same split as
// title.ts (pure) vs provider.ts (the call).

/** The framing call's normalized output, and the body of a `ResearchProposal`. */
export interface ResearchFramingResult {
  /** The question that will actually be researched. */
  question: string
  /** What the conversation already established, prepended to the Scope & Plan phase. */
  brief?: string
  /** Seed coverage for the notebook. */
  subQuestions: string[]
  /** Source scope as registrable hosts. Empty means unrestricted. */
  sites: string[]
  /** Raised when the user's message asserted something the context contradicts. */
  premise?: { asserted: string; corrected: string }
  /** At most two, and never blocking. */
  clarifications?: string[]
}

/**
 * A URL or bare host reduced to the registrable host we scope on: scheme, path,
 * port and a leading `www.` are dropped. Returns null when there is nothing
 * host-shaped to keep, so callers can filter rather than store empty strings.
 */
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  // URL() needs a scheme; a bare host gets a throwaway one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let host: string
  try {
    host = new URL(withScheme).hostname
  } catch {
    return null
  }
  const bare = host.startsWith('www.') ? host.slice(4) : host
  return bare || null
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

/**
 * Normalize the framing call's output into a `ResearchFramingResult`.
 *
 * Accepts either the object `generateObject` returns or the raw text of the
 * `generateText` fallback, because not every OpenAI-compatible endpoint honours
 * structured output. The string path is defensive in the same ways sanitizeTitle
 * is — an inline `<think>` block and a conversational preamble both appear ahead
 * of the JSON on real endpoints.
 *
 * Never throws: anything unusable degrades to `fallbackQuestion` with no premise
 * and no scope, because a blocked launch is worse than an unframed one.
 */
export function parseFraming(raw: string | object, fallbackQuestion: string): ResearchFramingResult {
  const bare: ResearchFramingResult = { question: fallbackQuestion, subQuestions: [], sites: [] }
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    const thoughtless = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '')
    // The preamble ("Sure! Here you go:") is why we scan for the first brace
    // rather than parsing the whole string.
    const start = thoughtless.indexOf('{')
    const end = thoughtless.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        obj = JSON.parse(thoughtless.slice(start, end + 1))
      } catch {
        obj = null
      }
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return bare

  const question =
    typeof obj.question === 'string' ? obj.question.replace(/^["'“”]+|["'“”]+$/g, '').trim() : ''
  if (!question) return bare

  const out: ResearchFramingResult = {
    question,
    subQuestions: strings(obj.subQuestions),
    sites: [...new Set(strings(obj.sites).map(normalizeHost).filter((h): h is string => h !== null))],
  }
  const brief = typeof obj.brief === 'string' ? obj.brief.trim() : ''
  if (brief) out.brief = brief
  const p = obj.premise as { asserted?: unknown; corrected?: unknown } | undefined
  // Half a premise flag is worse than none — it would render an accusation with
  // no correction beside it.
  if (p && typeof p.asserted === 'string' && typeof p.corrected === 'string') {
    out.premise = { asserted: p.asserted, corrected: p.corrected }
  }
  const clarifications = strings(obj.clarifications).slice(0, 2)
  if (clarifications.length) out.clarifications = clarifications
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/researchFraming.test.ts && npm run typecheck`
Expected: PASS (7 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/researchFraming.ts src/agent/researchFraming.test.ts
git commit -m "feat(research): pure framing-output parser and host normalizer"
```

---

### Task 2: `scopeAllows` — source scope in the browse policy

**Files:**
- Modify: `src/tools/browsePolicy.ts` (append; do not alter `isSafeResearchAction` or `isSearchInput`)
- Modify: `src/tools/browsePolicy.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeHost` from Task 1.
- Produces: `scopeAllows(url: string, scope: string[]): boolean`. Tasks 7 and 8 consume it.

**Why here:** `browsePolicy.ts` is already the pure, exhaustively-tested layer deciding what the research agent may touch, and already the documented security model for that surface. Scope belongs beside it, not in the UI.

- [ ] **Step 1: Write the failing test**

Append to `src/tools/browsePolicy.test.ts`:

```ts
import { scopeAllows } from './browsePolicy'

test('an empty scope allows everything', () => {
  expect(scopeAllows('https://anything.example/x', [])).toBe(true)
})

test('a scoped host admits itself and its subdomains', () => {
  expect(scopeAllows('https://aftershockpc.com/pc', ['aftershockpc.com'])).toBe(true)
  expect(scopeAllows('https://www.aftershockpc.com/pc', ['aftershockpc.com'])).toBe(true)
  expect(scopeAllows('https://sg.aftershockpc.com/pc', ['aftershockpc.com'])).toBe(true)
})

test('a suffix-collision host is rejected', () => {
  expect(scopeAllows('https://aftershockpc.com.evil.net/x', ['aftershockpc.com'])).toBe(false)
  expect(scopeAllows('https://notaftershockpc.com/x', ['aftershockpc.com'])).toBe(false)
})

test('scheme and port are ignored, and any one scope entry suffices', () => {
  expect(scopeAllows('http://lenovo.com:8080/x', ['aftershockpc.com', 'lenovo.com'])).toBe(true)
})

test('an unparseable url is rejected under a non-empty scope', () => {
  expect(scopeAllows('not a url', ['aftershockpc.com'])).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/browsePolicy.test.ts`
Expected: FAIL — `scopeAllows` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/tools/browsePolicy.ts`:

```ts
import { normalizeHost } from '../agent/researchFraming'

/**
 * True when `url`'s host is within `scope`. An empty scope allows everything,
 * which is the unrestricted default and today's behavior.
 *
 * Matching is registrable-host based: a scope of `aftershockpc.com` admits
 * `www.` and `sg.` subdomains but NOT `aftershockpc.com.evil.net` — the dot in
 * the suffix check is what makes that collision fail rather than pass.
 */
export function scopeAllows(url: string, scope: string[]): boolean {
  if (scope.length === 0) return true
  const host = normalizeHost(url)
  if (!host) return false
  return scope.some((entry) => {
    const s = normalizeHost(entry)
    return s !== null && (host === s || host.endsWith(`.${s}`))
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/browsePolicy.test.ts && npm run typecheck`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/tools/browsePolicy.ts src/tools/browsePolicy.test.ts
git commit -m "feat(research): source-scope predicate in the browse policy"
```

---

### Task 3: `ResearchProposal` type + protocol fields

**Files:**
- Modify: `src/data/researchTasks.ts` (add `ResearchProposal`; extend `ResearchTask` and the `research.ensureAndStart` / `research.start` message variants)

**Interfaces:**
- Consumes: `ResearchFramingResult` (Task 1).
- Produces: `ResearchProposal`, and three new optional fields (`brief`, `subQuestions`, `sites`) on `ResearchTask`, `research.ensureAndStart` and `research.start`. Tasks 5, 7, 8, 9, 10 consume these.

**Note:** `ResearchStatus` is **not** extended. A proposal deliberately never becomes a `ResearchTask` until Start, so `isActiveStatus`, `resumableTasks` and the watchdog need no change.

- [ ] **Step 1: Add the proposal type**

Append near `ResearchTask` in `src/data/researchTasks.ts`:

```ts
/**
 * A launch card awaiting Start. Lives on the transcript message, NOT in
 * `researchTasks` storage — so a proposal the user never starts leaves no row
 * for the resume watchdog to find and no status for `isActiveStatus` to model.
 * `taskId` is minted here and becomes `ResearchTask.id` on Start, which is what
 * lets the launch card, the live card and the report share one slot.
 */
export interface ResearchProposal {
  taskId: string
  question: string
  brief?: string
  subQuestions: string[]
  /** Registrable hosts; empty means unrestricted. */
  sites: string[]
  premise?: { asserted: string; corrected: string }
  clarifications?: string[]
  /** Epoch ms the framing call produced this, so a stale brief reads as stale. */
  draftedAt: number
}
```

- [ ] **Step 2: Extend `ResearchTask`**

Add to the `ResearchTask` interface, after `partial?: boolean`:

```ts
  /** What the launching conversation already established, prepended to Scope & Plan. */
  brief?: string
  /** Seed coverage from the launch card. */
  subQuestions?: string[]
  /** Source scope (registrable hosts). Empty/absent = unrestricted. Retained so a
   *  resumed task keeps the scope the user approved. */
  sites?: string[]
```

- [ ] **Step 3: Extend both message variants**

In `ResearchMsg`, add the same three optional fields to `research.ensureAndStart` and to `research.start`:

```ts
  | { type: 'research.ensureAndStart'
      taskId: string
      question: string
      conversationId: string
      brief?: string
      subQuestions?: string[]
      sites?: string[]
    }
```

(and the identical three on the `research.start` variant, beside its existing `notebook?` field).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. All fields are optional, so no existing call site breaks.

- [ ] **Step 5: Commit**

```bash
git add src/data/researchTasks.ts
git commit -m "feat(research): proposal type and launch-payload protocol fields"
```

---

### Task 4: Settings — `StartResearch` → `ProposeResearch` with migration

**Files:**
- Modify: `src/data/settings.ts:111` (catalog entry) and `loadSettings` (`src/data/settings.ts:346`)
- Modify: `src/data/settings.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: catalog name `ProposeResearch`. Task 5 depends on this name existing.

- [ ] **Step 1: Write the failing test**

Append to `src/data/settings.test.ts`:

```ts
import { migrateResearchToolPolicy } from './settings'

test('carries a StartResearch policy over to ProposeResearch', () => {
  const out = migrateResearchToolPolicy({ StartResearch: 'never', ReadPage: 'always' })
  expect(out).toEqual({ ProposeResearch: 'never', ReadPage: 'always' })
})

test('an existing ProposeResearch policy wins over the legacy key', () => {
  const out = migrateResearchToolPolicy({ StartResearch: 'never', ProposeResearch: 'ask' })
  expect(out).toEqual({ ProposeResearch: 'ask' })
})

test('is a no-op when the legacy key is absent', () => {
  expect(migrateResearchToolPolicy({ ReadPage: 'ask' })).toEqual({ ReadPage: 'ask' })
  expect(migrateResearchToolPolicy(undefined)).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/settings.test.ts`
Expected: FAIL — `migrateResearchToolPolicy` is not exported.

- [ ] **Step 3: Rename the catalog entry**

In `TOOL_CATALOG` (`src/data/settings.ts:111`), replace the `StartResearch` line with:

```ts
  { name: 'ProposeResearch', group: 'reading', label: 'Propose background web research' },
```

`DEFAULT_TOOL_POLICIES` is derived from `TOOL_CATALOG`, so it follows automatically.

- [ ] **Step 4: Add the migration**

Add beside the other migrations in `src/data/settings.ts`:

```ts
/**
 * Migration: `StartResearch` was renamed `ProposeResearch` when the model lost
 * the ability to launch research (2026-08-10). Carry the user's policy across so
 * someone who set `never` keeps meaning it; an explicitly-set new key always wins.
 * Pure and exported so it can be unit-tested without chrome.storage.
 */
export function migrateResearchToolPolicy(
  policies: Record<string, ToolPolicy> | undefined,
): Record<string, ToolPolicy> | undefined {
  if (!policies || !('StartResearch' in policies)) return policies
  const { StartResearch, ...rest } = policies
  return 'ProposeResearch' in rest ? rest : { ...rest, ProposeResearch: StartResearch }
}
```

Call it in `loadSettings`, immediately after the `settings.providers` migration line and **before** `openSettings(settings)`:

```ts
  settings.toolPolicies = migrateResearchToolPolicy(settings.toolPolicies)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/data/settings.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/settings.ts src/data/settings.test.ts
git commit -m "feat(research): rename StartResearch to ProposeResearch with policy migration"
```

---

### Task 5: `ProposeResearch` — the model proposes, never launches

**Files:**
- Modify: `src/tools/research.ts:421` (replace `createStartResearchTool`)
- Modify: `src/tools/tools.ts:41,1882` (import + registration)
- Modify: `src/ui/Chat.tsx:123` (capability list) and `:4248` (tool-pill label)
- Modify: `src/tools/toolNames.test.ts` if it enumerates names explicitly

**Interfaces:**
- Consumes: catalog name from Task 4.
- Produces: tool `ProposeResearch` returning `{ proposed: true, question: string }`. Task 10 renders its chip.

- [ ] **Step 1: Replace the tool**

In `src/tools/research.ts`, replace `createStartResearchTool` entirely:

```ts
/**
 * Ungated, foreground-only tool: the model can PROPOSE research but can no
 * longer start it. It returns a proposal that the panel renders as a chip; the
 * human gate is the launch card the chip opens, which shows the question, allows
 * editing it, and scopes its sources.
 *
 * Deliberately ungated (like ToolSearch/GetTool): proposing touches no page, no
 * network and no data. This strengthens rather than erodes the approval
 * invariant — the old card was a yes/no on a question the user never saw.
 */
export function createProposeResearchTool(): ToolSet {
  return {
    ProposeResearch: tool({
      description:
        'Propose a background research task to the user. This does NOT start anything — the user ' +
        'sees an editable launch card and decides. Use it when a question needs far more reading ' +
        'than this turn can do. Say one short sentence about why, then end your turn.',
      inputSchema: z.object({ question: z.string().describe('The research question to propose.') }),
      execute: async ({ question }) => ({
        proposed: true,
        question,
        note: 'Shown to the user as a proposal chip. It has NOT started. Do not claim it is running, and do not research the question yourself.',
      }),
    }),
  }
}
```

Delete the now-unused `postResearchMsg` import from this file **only if** nothing else in it uses that import.

- [ ] **Step 2: Update the registration**

In `src/tools/tools.ts`, change the import on line 41 and the call on line 1882:

```ts
import { createProposeResearchTool } from './research'
// …
Object.assign(tools, createProposeResearchTool())
```

Note the signature lost both parameters — it needs neither approval gate nor conversation id now.

- [ ] **Step 3: Update the capability list and the pill label**

In `src/ui/Chat.tsx:123`, replace `StartResearch (background web research)` with:

```
ProposeResearch (propose background web research to the user — it does not start it)
```

In `src/ui/Chat.tsx:4248`, replace the label branch:

```ts
  else if (part.toolName === 'ProposeResearch') label = 'Proposed background research'
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. If `toolNames.test.ts` enumerates names, add `ProposeResearch` there.

- [ ] **Step 5: Commit**

```bash
git add src/tools/research.ts src/tools/tools.ts src/ui/Chat.tsx src/tools/toolNames.test.ts
git commit -m "feat(research): ProposeResearch replaces StartResearch, model can no longer launch"
```

---

### Task 6: The framing call

**Files:**
- Modify: `src/agent/researchFraming.ts` (append the call beside the pure parser)

**Interfaces:**
- Consumes: `parseFraming` (Task 1).
- Produces: `frameResearch(opts: FrameResearchOpts): Promise<ResearchFramingResult>`. Task 10 calls it.

- [ ] **Step 1: Append the call**

```ts
import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'

const FRAMING_TIMEOUT_MS = 20_000

const FRAMING_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question to research, self-contained and specific.' },
    brief: { type: 'string', description: 'What the conversation already established that research should not re-derive.' },
    subQuestions: { type: 'array', items: { type: 'string' }, description: '2-5 sub-questions to cover.' },
    sites: { type: 'array', items: { type: 'string' }, description: 'Hosts to restrict sources to, when the conversation clearly implies them. Empty if not.' },
    premise: {
      type: 'object',
      properties: { asserted: { type: 'string' }, corrected: { type: 'string' } },
      description: 'ONLY when the user asserted something the context contradicts.',
    },
    clarifications: { type: 'array', items: { type: 'string' }, description: 'At most 2, only when genuinely ambiguous.' },
  },
  required: ['question'],
} as const

export interface FrameResearchOpts {
  model: LanguageModel
  /** The armed message verbatim — also the fallback question. */
  message: string
  /** Recent conversation, newest last, already trimmed by the caller. */
  context: string
  signal?: AbortSignal
}

const PROMPT = (message: string, context: string) =>
  `Turn the user's request into a background research brief.\n\n` +
  `CRITICAL: if the request asserts a fact the conversation contradicts (a count, a name, a date), ` +
  `use the CORRECTED fact in "question" AND report both halves in "premise". Never silently correct ` +
  `and never research a premise you know to be wrong.\n\n` +
  `Set "sites" only when the conversation clearly points at specific hosts. Ask a clarification only ` +
  `when you genuinely cannot proceed — at most two.\n\n` +
  `Conversation so far:\n${context}\n\nThe request: ${message}`

/**
 * One cheap call that turns an armed message into an editable proposal.
 * Deliberately NOT a runAgentTurn: no tool loop, no step budget, no way for it
 * to wander into the browser. Same shape as the chat-title call.
 *
 * Falls back generateObject → generateText → raw message, because structured
 * output is unreliable on some OpenAI-compatible endpoints and a failed framing
 * must degrade the card, never block the launch.
 */
export async function frameResearch(opts: FrameResearchOpts): Promise<ResearchFramingResult> {
  const prompt = PROMPT(opts.message, opts.context)
  const signal = opts.signal ?? AbortSignal.timeout(FRAMING_TIMEOUT_MS)
  try {
    const { object } = await generateObject({
      model: opts.model,
      schema: jsonSchema(FRAMING_SCHEMA as any),
      prompt,
      abortSignal: signal,
    })
    return parseFraming(object as object, opts.message)
  } catch {
    try {
      const { text } = await generateText({
        model: opts.model,
        prompt: `${prompt}\n\nReply with JSON only.`,
        abortSignal: signal,
      })
      return parseFraming(text, opts.message)
    } catch {
      return { question: opts.message, subQuestions: [], sites: [] }
    }
  }
}
```

- [ ] **Step 2: Add a fallback test**

Append to `src/agent/researchFraming.test.ts`:

```ts
test('the schema requires only a question', () => {
  // Guards the contract frameResearch's fallbacks rely on: anything past
  // `question` is optional, so a partial model response still yields a proposal.
  expect(parseFraming({ question: 'q' }, 'fb')).toEqual({ question: 'q', subQuestions: [], sites: [] })
})
```

- [ ] **Step 3: Verify**

Run: `npx vitest run src/agent/researchFraming.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/researchFraming.ts src/agent/researchFraming.test.ts
git commit -m "feat(research): framing call producing an editable proposal"
```

---

### Task 7: `researchCardState` — the pure five-state resolver

**Files:**
- Create: `src/ui/researchCard.ts`
- Create: `src/ui/researchCard.test.ts`

**Interfaces:**
- Consumes: `ResearchProposal`, `ResearchTask` (Task 3).
- Produces: `type ResearchCardState`, `researchCardState(proposal, task): ResearchCardState`. Tasks 10 and 11 render from it.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { researchCardState } from './researchCard'
import type { ResearchProposal, ResearchTask } from '../data/researchTasks'

const proposal: ResearchProposal = {
  taskId: 'r-1', question: 'q', subQuestions: [], sites: [], draftedAt: 1,
}
const task = (status: ResearchTask['status']): ResearchTask =>
  ({ id: 'r-1', question: 'q', status, steps: [], startedAt: 1, updatedAt: 2 })

test('a proposal with no task is proposed', () => {
  expect(researchCardState(proposal, undefined)).toBe('proposed')
})

test('a task always wins over the proposal at the same id', () => {
  expect(researchCardState(proposal, task('running'))).toBe('running')
  expect(researchCardState(proposal, task('done'))).toBe('done')
})

test('paused reads as running — it is still the agent working', () => {
  expect(researchCardState(proposal, task('paused'))).toBe('running')
})

test('error and cancelled keep their own terminal states', () => {
  expect(researchCardState(undefined, task('error'))).toBe('error')
  expect(researchCardState(undefined, task('cancelled'))).toBe('cancelled')
})

test('neither present is proposed, so a card never renders blank', () => {
  expect(researchCardState(undefined, undefined)).toBe('proposed')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/researchCard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ResearchProposal, ResearchTask } from '../data/researchTasks'

/** The five faces of one transcript slot: launch card → live card → result row. */
export type ResearchCardState = 'proposed' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * Which face to render. The task always wins where both exist: the proposal is
 * the pre-launch draft, and once a task carries the same id the draft is spent.
 * `paused` folds into `running` because a retry backoff is still the agent
 * working — the pause reason shows inside the live card, not as its own state.
 */
export function researchCardState(
  proposal: ResearchProposal | undefined,
  task: ResearchTask | undefined,
): ResearchCardState {
  if (!task) return 'proposed'
  switch (task.status) {
    case 'running':
    case 'paused':
      return 'running'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/researchCard.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/researchCard.ts src/ui/researchCard.test.ts
git commit -m "feat(research): pure five-state resolver for the research card slot"
```

---

### Task 8: Enforce source scope in the research tools

**Files:**
- Modify: `src/tools/research.ts` (`WebSearch`, `FetchUrl`, `BrowseSite` execute paths; `createResearchTools` signature)
- Modify: `src/agent/research.ts` (thread `sites` from `runResearch` opts into `createResearchTools`)
- Modify: `src/background/offscreen.ts` (pass `sites` from the `research.start` message into `runResearch`)

**Interfaces:**
- Consumes: `scopeAllows` (Task 2), the `sites` protocol field (Task 3).
- Produces: scope-aware research tools. No new exports.

- [ ] **Step 1: Thread the scope through**

Add `sites?: string[]` to `createResearchTools`' options and to `runResearch`'s opts, defaulting to `[]`. In `src/background/offscreen.ts`, pass `msg.sites` through where the other `research.start` fields are forwarded.

- [ ] **Step 2: Filter search results**

In `WebSearch`'s `execute`, after results are obtained and before they are returned:

```ts
      // A snippet alone is enough to hallucinate from, so an out-of-scope result
      // must not reach the model even as a title — filtering at fetch time only
      // would be too late. `site:` narrows the query for up to 3 hosts; the
      // filter is what actually enforces it.
      const scoped = sites.length ? results.filter((r) => scopeAllows(r.url, sites)) : results
```

and build the query with `site:` operators when `sites.length > 0 && sites.length <= 3`:

```ts
      const scopedQuery = sites.length > 0 && sites.length <= 3
        ? `${query} (${sites.map((s) => `site:${s}`).join(' OR ')})`
        : query
```

- [ ] **Step 3: Refuse out-of-scope reads**

At the top of `FetchUrl`'s and `BrowseSite`'s `execute`, before any network work:

```ts
      if (!scopeAllows(url, sites)) {
        // Stated, not silent: a blocked read must appear in the step log so the
        // report's gaps are explicable.
        return { error: `Out of scope. This research is restricted to: ${sites.join(', ')}` }
      }
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. `sites` defaults to `[]` everywhere, so every existing path is unrestricted exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/tools/research.ts src/agent/research.ts src/background/offscreen.ts
git commit -m "feat(research): enforce the launch card's source scope in search, fetch and browse"
```

---

### Task 9: The armed composer pill

**Files:**
- Modify: `src/ui/Chat.tsx` (state + the `.composer-btns` cluster around `:3289`, the `<textarea>` placeholder at `:3120`, the `.composer` wrapper class at `:3027`)
- Modify: `src/ui/styles.css` (append near `.composer-btns` at `:2693` and the collapse rules at `:2703`)

**Interfaces:**
- Consumes: nothing.
- Produces: `researchArmed` state and `setResearchArmed`, read by Task 10's `submit()` branch.

- [ ] **Step 1: Add the state**

Beside the other composer state in `Chat.tsx`:

```ts
  // Deep-research mode is armed per-send, never sticky: it disarms the moment a
  // launch card is created, because sticky arming is how a second 20-minute task
  // gets fired by accident.
  const [researchArmed, setResearchArmed] = useState(false)
```

- [ ] **Step 2: Render the pill**

As the first child of `<div className="composer-btns">`:

```tsx
              <button
                className={researchArmed ? 'research-pill on' : 'research-pill'}
                title="Deep research — reads the web in the background and reports back"
                aria-pressed={researchArmed}
                disabled={!selected}
                onClick={() => setResearchArmed((a) => !a)}
              >
                <span className="research-pill__glyph" aria-hidden="true">◈</span>
                <span className="research-pill__label">Deep research</span>
              </button>
```

- [ ] **Step 3: Tint the box and swap the placeholder**

Change the composer wrapper to `className={researchArmed ? 'composer armed' : 'composer'}`, and change the placeholder expression so the armed string wins ahead of the streaming case:

```tsx
            placeholder={
              !selected
                ? 'Add a provider in settings to start'
                : researchArmed
                  ? 'Research anything — this runs in the background…'
                  : streaming
                    ? 'Reply — queues as a follow-up…'
                    : 'Ask anything…'
            }
```

- [ ] **Step 4: Style it**

Append to `src/ui/styles.css`:

```css
/* ---- Deep research pill ----
   Leads the .composer-btns cluster. Arming lights three things at once (pill,
   composer border, placeholder) because a button that lights alone is too easy
   to miss mid-task. */
.research-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  flex: none;
  border: none;
  border-radius: 999px;
  background: var(--btn-bg);
  color: var(--text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}
.research-pill.on {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.composer.armed {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
}

/* Collapse order. The pill is the control no existing user knows, so it is the
   LAST to go silent: the camera joins the "…" menu at the first breakpoint so
   the pill keeps its label, and only below a second, narrower breakpoint does
   the pill degrade to its bare glyph. */
@media (max-width: 420px) {
  .cam-btn { display: none; }
}
@media (max-width: 340px) {
  .research-pill__label { display: none; }
  .research-pill { padding: 0 7px; }
}
```

Confirm `--btn-bg` exists in the token block at the top of `styles.css`; if it does not, use the same background the sibling `.tools-btn` rule uses.

- [ ] **Step 5: Move the camera into the `…` menu at the first breakpoint**

The existing `.more-menu-wrap` popover renders `ToolsMenuBody` only. Add a screenshot row above it so the camera is not lost when hidden:

```tsx
                    <button className="tools-popover-row" onClick={() => { setMoreOpen(false); void capture() }}>
                      Screenshot part of the page
                    </button>
```

- [ ] **Step 6: Verify in the browser**

Run: `npm run build`, reload the unpacked extension at `chrome://extensions`, open the side panel.
Confirm: the pill toggles; arming tints the border and swaps the placeholder; narrowing the panel hides the camera first and the pill's label only when very narrow; the camera is reachable from `…`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat(research): armed deep-research pill in the composer"
```

---

### Task 10: The launch card

**Files:**
- Create: `src/ui/ResearchLaunchCard.tsx`
- Modify: `src/ui/Chat.tsx` (proposal state, the armed branch of `submit()`, the `ProposeResearch` chip, message rendering)
- Modify: `src/ui/styles.css` (card styles)

**Interfaces:**
- Consumes: `frameResearch` (Task 6), `ResearchProposal` (Task 3), `researchArmed` (Task 9), `researchCardState` (Task 7).
- Produces: `<ResearchLaunchCard proposal onChange onStart onCancel />`. Task 11 renders it as the `proposed` face.

- [ ] **Step 1: Build the card**

Create `src/ui/ResearchLaunchCard.tsx` with an editable `<textarea>` bound to `proposal.question`, a premise row rendered only when `proposal.premise` exists (`⚠ You said {asserted} — {corrected}.`), removable host chips for `proposal.sites` plus an add-host input that runs each entry through `normalizeHost`, a `<details>` block titled `What it already knows` holding `proposal.brief`, the clarifications as plain rows (never blocking), the literal line `usually 10–20 min · keeps running if you close the panel`, and `Cancel` / `Start` buttons.

- [ ] **Step 2: Branch `submit()` when armed**

In `Chat.tsx`'s `submit()`, before the ordinary turn path:

```ts
    if (researchArmed) {
      const text = input.trim()
      if (!text) return
      setInput('')
      setResearchArmed(false)
      const taskId = `r-${Date.now()}-${Math.floor(performance.now())}`
      // The card appears immediately in a framing state so the panel never looks
      // idle while the framing call runs.
      const framed = await frameResearch({ model, message: text, context: recentContext(messages) })
      setMessages((prev) => [...prev, {
        id: `research-${taskId}`,
        role: 'assistant' as const,
        parts: [],
        proposal: { ...framed, taskId, draftedAt: Date.now() },
      }])
      return
    }
```

- [ ] **Step 3: Wire Start and Cancel**

Start posts the launch and leaves the message in place — the task will take over the same slot:

```ts
  function startProposal(p: ResearchProposal) {
    postResearchMsg({
      type: 'research.ensureAndStart',
      taskId: p.taskId,
      question: p.question,
      conversationId,
      brief: p.brief,
      subQuestions: p.subQuestions,
      sites: p.sites,
    })
  }
```

Cancel removes the message, restores the text to the composer and **re-arms** the pill, leaving the user exactly where they were before Send:

```ts
  function cancelProposal(p: ResearchProposal) {
    setMessages((prev) => prev.filter((m) => m.id !== `research-${p.taskId}`))
    setInput(p.question)
    setResearchArmed(true)
  }
```

- [ ] **Step 4: Render the `ProposeResearch` chip**

In the tool-part renderer, when `part.toolName === 'ProposeResearch'` and `output?.proposed`, render a chip reading `◈ Research this properly · usually 10–20 min` whose click runs the same framing call on `output.question` and appends the proposal message.

- [ ] **Step 5: Verify in the browser**

Run: `npm run build`, reload, arm the pill, send *"compare the 5 setups on this page"* on a page listing four of something.
Confirm: a launch card appears with an editable question; if the model raises a premise flag it is visible; Cancel restores the text and re-arms; Start begins a task.

- [ ] **Step 6: Commit**

```bash
git add src/ui/ResearchLaunchCard.tsx src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat(research): editable launch card with premise flag and source scope"
```

---

### Task 11: One slot, three states

**Files:**
- Modify: `src/ui/Chat.tsx:932` (the injection effect → upsert)
- Create: `src/ui/ResearchCard.tsx` (the running / done / error / cancelled faces)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `researchCardState` (Task 7), `ResearchLaunchCard` (Task 10).
- Produces: the single mutating card. Task 12 observes its DOM node.

- [ ] **Step 1: Turn the effect into an upsert**

Replace the effect at `Chat.tsx:932`. Two changes: drop the terminal-status filter, and refresh an existing message in place instead of skipping it.

```ts
  useEffect(() => {
    if (!restored) return
    const mine = researchTasks
      .filter((t) => t.conversationId === conversationId)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    if (mine.length === 0) return
    setMessages((prev) => {
      const byId = new Map(mine.map((t) => [`research-${t.id}`, t]))
      let changed = false
      // Refresh every card that already has a slot…
      const next = prev.map((m) => {
        const t = byId.get(m.id)
        if (!t) return m
        byId.delete(m.id)
        changed = true
        return { ...m, parts: t.report ? [{ type: 'text' as const, text: t.report }] : [],
                 sources: t.sources,
                 research: { question: t.question, error: t.error, verification: t.verification, partial: t.partial } }
      })
      // …and append any task with no slot yet (a task started from the Library,
      // or one whose proposal message was lost with an un-restored draft).
      for (const t of byId.values()) {
        changed = true
        next.push({ id: `research-${t.id}`, role: 'assistant' as const,
                    parts: t.report ? [{ type: 'text' as const, text: t.report }] : [],
                    sources: t.sources,
                    research: { question: t.question, error: t.error, verification: t.verification, partial: t.partial } })
      }
      return changed ? next : prev
    })
  }, [restored, researchTasks, conversationId])
```

Note the `changed` guard: returning `prev` unchanged is what stops this effect looping on its own `setMessages`.

- [ ] **Step 2: Build the card faces**

`ResearchCard.tsx` renders by `researchCardState`: `proposed` delegates to `ResearchLaunchCard`; `running` shows phase + elapsed + progress bar + the coverage checklist from `task.notebook.coverage` + `↳ in a private window` + source count + Stop; `done` shows the collapsed row (`✓ Research finished · started {n} min ago`, the question, `{n} sources · verified`, expand chevron) that expands to the existing `ResearchReportMessage` body; `error` and `cancelled` are that row with their own icon and a one-line reason.

- [ ] **Step 3: Route messages to it**

At `Chat.tsx:3631`, replace the `message.research` branch so a message with **either** `research` or `proposal` renders `<ResearchCard>`.

- [ ] **Step 4: Verify in the browser**

Run: `npm run build`, reload, launch research from a launch card.
Confirm: the card becomes the live card **in place** (no second card at the bottom); coverage ticks over as sub-questions resolve; on completion the same card collapses to the result row; expanding shows the report; a later chat message appears *below* it and the report does not move.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ResearchCard.tsx src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat(research): one transcript slot for launch, progress and report"
```

---

### Task 12: Demote the dock to an off-screen indicator

**Files:**
- Modify: `src/ui/Chat.tsx:3078` (`<ResearchDock>` render site) and `:4672` (the component)

**Interfaces:**
- Consumes: the card's DOM node id `research-<id>` (Task 11).
- Produces: nothing new.

- [ ] **Step 1: Observe the card**

Add a hook that watches each active task's card element and reports whether it is on screen:

```ts
/**
 * True for each active task whose card is scrolled out of view. The dock exists
 * only to cover that case — when the card is visible the dock is redundant, and
 * showing both is how the same task ends up looking like two.
 */
function useOffscreenTasks(tasks: ResearchTask[]): Set<string> {
  const [offscreen, setOffscreen] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      setOffscreen((prev) => {
        const next = new Set(prev)
        for (const e of entries) {
          const id = e.target.id.replace(/^research-/, '')
          if (e.isIntersecting) next.delete(id)
          else next.add(id)
        }
        return next
      })
    })
    for (const t of tasks) {
      const el = document.getElementById(`research-${t.id}`)
      if (el) obs.observe(el)
    }
    return () => obs.disconnect()
  }, [tasks])
  return offscreen
}
```

- [ ] **Step 2: Filter the dock and change its click**

Pass only offscreen active tasks to `<ResearchDock>`, and change `onOpen` to scroll to the card rather than open the sheet:

```ts
    document.getElementById(`research-${t.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run build`, reload, start research, scroll the card out of view.
Confirm: the dock appears only then, tapping it scrolls back to the card, and scrolling the card into view hides the dock again.

- [ ] **Step 4: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat(research): dock appears only while the live card is off-screen"
```

---

### Task 13: The research window says what it is

**Files:**
- Create: `public/research-tab.html`
- Modify: `src/platform/researchTab.ts:107` (park the new tab on it)
- Modify: `vite.config.ts` only if `public/` assets are not copied verbatim (verify first — they are for `public/sandbox.html`)

**Interfaces:**
- Consumes: nothing.
- Produces: a parked page at `chrome.runtime.getURL('research-tab.html')`.

- [ ] **Step 1: Build the page**

`public/research-tab.html`, `<title>Lychee is researching…</title>`, self-contained CSS (no external fetch), stating that Lychee is reading pages for a research task, that the window is safe to close, and that research will reopen one if it needs to.

- [ ] **Step 2: Park the leased tab on it**

In `researchTab.ts`, give `windows.create` a `url` of `chrome.runtime.getURL('research-tab.html')` instead of leaving it on the default new-tab page, in both the incognito branch (`:107`) and the fallback branch (`:113`).

- [ ] **Step 3: Verify in the browser**

Run: `npm run build`, reload, start a research task, then un-minimize the incognito window Lychee opened.
Confirm: it reads `Lychee is researching…` rather than a blank new tab, and research still completes normally.

- [ ] **Step 4: Commit**

```bash
git add public/research-tab.html src/platform/researchTab.ts
git commit -m "feat(research): label the leased browsing window"
```

---

### Task 14: Update the architecture invariants

**Files:**
- Modify: `CLAUDE.md` (the approval-gate invariant and the background-research invariant)

- [ ] **Step 1: Amend the approval-gate invariant**

Add `ProposeResearch` to the short list of deliberately-ungated tools, with its justification: it touches no page, network or data; it only proposes, and the human gate is the launch card, which is strictly stronger than the approval card it replaces because it shows and permits editing of the question.

- [ ] **Step 2: Amend the background-research invariant**

Record that research is launched only from the panel's launch card (never by the model), that the launch payload now carries `brief`/`subQuestions`/`sites`, that a non-empty scope is enforced in `browsePolicy.ts` at search-filter, fetch and browse, and that the launch card, live card and report are one transcript message upserted in place.

- [ ] **Step 3: Full verification**

Run: `npm run build && npm test`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the deep-research mode invariants"
```

---

## Self-Review

**Spec coverage.** Armed pill → Task 9. Launch card with premise flag, clarifications, brief, scope → Tasks 6 + 10. Framing call as a non-agent-turn → Task 6. `ProposeResearch` + chip + ungating + policy migration → Tasks 4, 5, 10. One-slot upsert and the five states → Tasks 3, 7, 11. Dock demotion → Task 12. Labelled window + in-card narration → Tasks 11 (the `↳ in a private window` line) and 13. Source scoping enforced in `browsePolicy.ts` → Tasks 2, 8. Testing table → Tasks 1, 2, 4, 7 cover `parseFraming`, `scopeAllows`, the settings migration and `researchCardState`; `toolNames` is checked in Task 5. Invariants → Task 14. No gaps.

**Placeholder scan.** No TBD/TODO. Tasks 10, 11 and 13 describe component structure in prose rather than full JSX — deliberate, because they are Chrome-coupled view code whose exact markup must follow the surrounding file's conventions, and every literal copy string, class name, state name and handler signature they need is given exactly. Every pure unit has complete test and implementation code.

**Type consistency.** `ResearchFramingResult` (Task 1) is the body of `ResearchProposal` (Task 3) plus `taskId`/`draftedAt`; `frameResearch` (Task 6) returns the former and Task 10 spreads it into the latter. `normalizeHost` is defined once (Task 1) and consumed by Tasks 2 and 10. `scopeAllows(url, scope)` keeps one signature across Tasks 2 and 8. `researchCardState(proposal, task)` keeps its two-argument shape across Tasks 7 and 11. The `sites` field is `string[]` on the proposal and `string[] | undefined` on the wire and the task, normalized to `[]` at every consumer.

**One risk flagged for the implementer:** Task 11's upsert effect writes to `messages` from an effect that depends on `messages` indirectly through `setMessages`. The `changed` guard is what keeps it from looping — do not remove it, and do not add `messages` to the dependency array.
