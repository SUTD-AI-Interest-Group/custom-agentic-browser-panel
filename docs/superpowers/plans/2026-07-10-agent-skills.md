# Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-authored "agent skills" (single-file `SKILL.md`) to the browser side-panel chat — invocable via `/commands` and auto-loadable by the agent — with a masonry Skills Library UI and a `/create-skill` meta-skill.

**Architecture:** Skills live in a new IndexedDB store (`src/data/skills.ts`), peer to `conversations`/`memory`. The agent adopts them via (1) a Level-1 catalog (name+description) appended to the per-turn `system` string in `Chat.tsx`, (2) explicit `/name` invocation that injects the full body for that turn, and (3) three approval-gated tools (`ListAllSkills`, `ReadSkill`, `SaveSkill`) in `src/tools/tools.ts`. `runAgentTurn` is unchanged — the tool-result-re-enters-context mechanism already works. A new top-bar archival-box icon opens `SkillsLibrary.tsx` (masonry cards + inline editor), overlaying the mounted Chat exactly like Settings does.

**Tech Stack:** React 18 + TypeScript (strict), Vite 6, Vercel AI SDK v5 (`ai@5.0.210`), zod v3, IndexedDB, `chrome.storage.local`. No new dependencies.

## Global Constraints

- **No unit-test framework exists in this repo** (CLAUDE.md: "There is no test suite"). The per-task verification gate is `npm run typecheck` (`tsc --noEmit`); integration verification is `npm run build` + reload unpacked + manual exercise via the `/verify-extension` skill. **Do not add vitest/jest** — it is out of scope and against the repo's setup.
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indentation, `interface` for object shapes / `type` for unions, `/** … */` on exported symbols, block comments explain non-obvious *why*.
- **Every agent tool must call `requestApproval` before its `execute()` proceeds** (security invariant). New tools honor this even when auto-approved.
- **No new npm dependencies.** SKILL.md frontmatter is parsed by a hand-rolled parser (no YAML lib).
- **No `.env`/build-time secrets.** Everything is client-side.
- **Skill field rules (verbatim):** `name` = lowercase `a-z 0-9 -`, 1–64 chars, no leading/trailing hyphen, no `--`, must not contain `anthropic`/`claude`. `description` = 1–1024 chars, non-empty, third person, states what + when.
- **Commit after every task** (small project, commit directly to `main`). No `Co-Authored-By`/"Generated with" trailers.
- **Source layout:** `src/data/` persistence, `src/tools/` tools, `src/ui/` React, `src/agent/` agent core, `src/platform/` chrome utils.

---

### Task 1: Skills data layer (`src/data/skills.ts`)

**Files:**
- Create: `src/data/skills.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `interface Skill { id, name, description, body, source: 'builtin'|'user', userInvocable: boolean, modelInvocable: boolean, icon?: string, color?: string, createdAt: number, updatedAt: number }`
  - `interface SkillMeta { name: string; description: string; source: SkillSource }`
  - `interface SaveSkillInput { name, description, body, icon?, color?, userInvocable?, modelInvocable?, source? }`
  - `type SkillSource = 'builtin' | 'user'`
  - `interface ParsedSkill { name, description, icon?, color?, userInvocable, modelInvocable, body }`
  - `listSkills(): Promise<Skill[]>`, `getSkill(name): Promise<Skill|null>`, `listSkillMetas(opts?: {modelInvocableOnly?: boolean}): Promise<SkillMeta[]>`, `saveSkill(input: SaveSkillInput): Promise<Skill>`, `deleteSkill(name): Promise<void>`
  - `validateSkillName(name): string|null`, `validateSkill(input: {name,description,body}): string|null`
  - `serializeSkill(skill: Skill): string`, `parseSkillMarkdown(md: string): ParsedSkill`
  - `accentColor(skill: Pick<Skill,'name'|'color'>): string`

- [ ] **Step 1: Create `src/data/skills.ts` with the full module.**

```ts
// Agent skills, housed in their own IndexedDB database (extension origin, so
// the side panel and background worker share them). A "skill" is a single-file
// SKILL.md-style record: YAML-ish frontmatter (name + description + metadata)
// plus a Markdown instruction body the agent follows when the skill is invoked.
// Kept in its own DB (not the memory/conversation DBs) so schema versions stay
// independent.

export type SkillSource = 'builtin' | 'user'

export interface Skill {
  id: string
  /** Unique slug; this is the /invocation name. */
  name: string
  /** Third-person "what + when" sentence — the sole trigger signal. */
  description: string
  /** Markdown instructions the agent follows when the skill runs (no frontmatter). */
  body: string
  source: SkillSource
  /** Appears in the composer "/" menu. */
  userInvocable: boolean
  /** Included in the always-on system-prompt catalog (agent may auto-load). */
  modelInvocable: boolean
  /** Emoji shown on the Library card. */
  icon?: string
  /** Accent hex; auto-derived from name when absent. */
  color?: string
  createdAt: number
  updatedAt: number
}

/** Compact form for the system-prompt catalog and ListAllSkills. */
export interface SkillMeta {
  name: string
  description: string
  source: SkillSource
}

export interface SaveSkillInput {
  name: string
  description: string
  body: string
  icon?: string
  color?: string
  userInvocable?: boolean
  modelInvocable?: boolean
  /** Only the seeder passes 'builtin'; agent/UI saves are always 'user'. */
  source?: SkillSource
}

// ---------------------------------------------------------------------------
// IndexedDB (mirrors src/data/conversations.ts single-store shape)
// ---------------------------------------------------------------------------

const DB_NAME = 'agent-chat-skills'
const DB_VERSION = 1
const STORE = 'skills'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close()
          dbPromise = null
        }
        resolve(req.result)
      }
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function requestOf<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RESERVED_WORDS = ['anthropic', 'claude']

/** Returns a human-readable error, or null when the name is valid. */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required.'
  if (name.length > 64) return 'Name must be 64 characters or fewer.'
  // lowercase alphanumeric segments joined by single hyphens: no leading/
  // trailing hyphen, no consecutive hyphens.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    return 'Use lowercase letters, numbers and single hyphens, e.g. summarizing-pages.'
  if (RESERVED_WORDS.some((w) => name.includes(w)))
    return 'Name cannot contain “anthropic” or “claude”.'
  return null
}

/** Returns a human-readable error, or null when the skill is savable. */
export function validateSkill(input: { name: string; description: string; body: string }): string | null {
  const nameErr = validateSkillName(input.name)
  if (nameErr) return nameErr
  if (!input.description.trim()) return 'Description is required.'
  if (input.description.length > 1024) return 'Description must be 1024 characters or fewer.'
  if (!input.body.trim()) return 'Instructions cannot be empty.'
  return null
}

// ---------------------------------------------------------------------------
// SKILL.md serialization — a tiny hand-rolled frontmatter reader/writer so we
// avoid a YAML dependency. Only the fields we own are supported.
// ---------------------------------------------------------------------------

export interface ParsedSkill {
  name: string
  description: string
  icon?: string
  color?: string
  userInvocable: boolean
  modelInvocable: boolean
  body: string
}

export function serializeSkill(skill: Skill): string {
  const meta: string[] = []
  if (skill.icon) meta.push(`  icon: ${JSON.stringify(skill.icon)}`)
  if (skill.color) meta.push(`  color: ${JSON.stringify(skill.color)}`)
  meta.push(`  userInvocable: ${skill.userInvocable}`)
  meta.push(`  modelInvocable: ${skill.modelInvocable}`)
  const frontmatter = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    'metadata:',
    ...meta,
    '---',
  ].join('\n')
  return `${frontmatter}\n\n${skill.body.trim()}\n`
}

export function parseSkillMarkdown(md: string): ParsedSkill {
  const text = md.replace(/\r\n/g, '\n')
  const fallback: ParsedSkill = {
    name: '',
    description: '',
    userInvocable: true,
    modelInvocable: true,
    body: text.trim(),
  }
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return fallback

  const result: ParsedSkill = { ...fallback, body: text.slice(m[0].length).trim() }
  let inMeta = false
  for (const raw of m[1].split('\n')) {
    if (/^metadata:\s*$/.test(raw)) {
      inMeta = true
      continue
    }
    const indented = /^\s+\S/.test(raw)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const ci = trimmed.indexOf(':')
    if (ci === -1) continue
    const key = trimmed.slice(0, ci).trim()
    let val = trimmed.slice(ci + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (inMeta && indented) {
      if (key === 'icon') result.icon = val
      else if (key === 'color') result.color = val
      else if (key === 'userInvocable') result.userInvocable = val !== 'false'
      else if (key === 'modelInvocable') result.modelInvocable = val !== 'false'
    } else {
      inMeta = false
      if (key === 'name') result.name = val
      else if (key === 'description') result.description = val
    }
  }
  return result
}

/** Deterministic accent so every card looks intentional without user effort. */
export function accentColor(skill: Pick<Skill, 'name' | 'color'>): string {
  if (skill.color) return skill.color
  let h = 0
  for (let i = 0; i < skill.name.length; i++) h = (h * 31 + skill.name.charCodeAt(i)) % 360
  return `hsl(${h} 62% 55%)`
}

// ---------------------------------------------------------------------------
// CRUD (the store is tiny — tens of skills — so we getAll + filter in memory,
// matching how memory.ts searches.)
// ---------------------------------------------------------------------------

export async function listSkills(): Promise<Skill[]> {
  const all = await requestOf<Skill[]>('readonly', (s) => s.getAll())
  // Built-ins first, then custom, each alphabetical — stable Library order.
  return all.sort((a, b) =>
    a.source !== b.source ? (a.source === 'builtin' ? -1 : 1) : a.name.localeCompare(b.name),
  )
}

export async function getSkill(name: string): Promise<Skill | null> {
  const all = await requestOf<Skill[]>('readonly', (s) => s.getAll())
  return all.find((sk) => sk.name === name) ?? null
}

export async function listSkillMetas(opts?: { modelInvocableOnly?: boolean }): Promise<SkillMeta[]> {
  const all = await listSkills()
  const filtered = opts?.modelInvocableOnly ? all.filter((s) => s.modelInvocable) : all
  return filtered.map((s) => ({ name: s.name, description: s.description, source: s.source }))
}

/** Upsert by name. Preserves id/createdAt/source of an existing record. */
export async function saveSkill(input: SaveSkillInput): Promise<Skill> {
  const err = validateSkill(input)
  if (err) throw new Error(err)
  const existing = await getSkill(input.name)
  if (existing && existing.source === 'builtin' && input.source !== 'builtin') {
    throw new Error('Built-in skills cannot be overwritten. Duplicate it to customize.')
  }
  const now = Date.now()
  const record: Skill = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name,
    description: input.description.trim(),
    body: input.body.trim(),
    source: input.source ?? existing?.source ?? 'user',
    userInvocable: input.userInvocable ?? existing?.userInvocable ?? true,
    modelInvocable: input.modelInvocable ?? existing?.modelInvocable ?? true,
    icon: input.icon ?? existing?.icon,
    color: input.color ?? existing?.color,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await requestOf('readwrite', (s) => s.put(record))
  return record
}

export async function deleteSkill(name: string): Promise<void> {
  const existing = await getSkill(name)
  if (!existing) return
  if (existing.source === 'builtin') throw new Error('Built-in skills cannot be deleted.')
  await requestOf('readwrite', (s) => s.delete(existing.id))
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Sanity-check the pure helpers by reasoning through them (no runner available).**

Confirm by inspection: `validateSkillName('summarizing-pages')` → `null`; `validateSkillName('-bad')`, `'a--b'`, `'Claude-x'`, `'x'.repeat(65)` → non-null. `serializeSkill` then `parseSkillMarkdown` round-trips `name`/`description`/`icon`/`userInvocable`/`modelInvocable`/`body`. `parseSkillMarkdown('no frontmatter')` → `{ name:'', description:'', body:'no frontmatter', userInvocable:true, modelInvocable:true }`.

- [ ] **Step 4: Commit.**

```bash
git add src/data/skills.ts
git commit -m "feat: skills IndexedDB store + SKILL.md parse/validate"
```

---

### Task 2: Built-in skills (`src/data/builtinSkills.ts`)

**Files:**
- Create: `src/data/builtinSkills.ts`

**Interfaces:**
- Consumes: `SaveSkillInput`, `listSkills`, `saveSkill` from `./skills`.
- Produces: `BUILTIN_SKILLS: SaveSkillInput[]`, `seedBuiltinSkills(): Promise<void>`.

- [ ] **Step 1: Create `src/data/builtinSkills.ts`.**

```ts
// Skills shipped with the extension. Seeded into the store on first load (see
// seedBuiltinSkills). `create-skill` is the meta-skill whose body is a distilled
// skill-authoring guide; the rest are useful browser-workflow examples that
// double as worked examples of good SKILL.md structure. All are source
// 'builtin' — read-only in the Library (duplicate to customize) and undeletable.

import { listSkills, saveSkill, type SaveSkillInput } from './skills'

const CREATE_SKILL_BODY = `# Creating a skill

You are helping the user build a new **agent skill** — a reusable set of instructions you will later follow when the skill is invoked. Work through the steps below with the user, then save the result with the \`SaveSkill\` tool.

Keep to **one skill = one capability**. If the user describes several unrelated jobs, make several skills.

## Step 1 — Interview the user

Ask briefly, and only for what you don't already know:
- **Task**: what should happen when this skill runs, and what's the end result?
- **Triggers**: what will the user say that means "use this"? Collect concrete phrases and keywords.
- **Inputs**: does it need the current page, a selection, a screenshot, or memory? You have \`ViewCurrentTab\`, \`ViewOpenedTabs\`, and \`SearchMemory\`.
- **Output**: format, length, tone, must-haves.
- **Strictness**: an exact sequence to follow, or room to improvise?

## Step 2 — Write the description (most important)

The description is the *only* thing that decides when this skill triggers, so make it earn its place:
- Write in the **third person**: "Summarizes the current page…", never "I can…" or "You can…".
- State **what it does and when to use it**, and include the trigger keywords the user gave you.
- Good: \`Extracts tables from the current web page into clean Markdown or CSV. Use when the user asks to pull a table, list, or structured data from a page.\`
- Weak: \`Helps with tables.\`

## Step 3 — Name it

- Prefer the **gerund form**: \`summarizing-pages\`, \`drafting-replies\`. A noun phrase like \`page-summary\` is fine too.
- Rules: lowercase letters, numbers and single hyphens; 1–64 characters; no leading/trailing hyphen; cannot contain "anthropic" or "claude".
- Avoid vague names like \`helper\` or \`utils\`.

## Step 4 — Write the body

- **Be concise — the context window is a public good.** Only add what you wouldn't already know; cut generic filler.
- Give **concrete steps**. If the task is fragile and must happen in an exact order, spell that order out. If several approaches are fine, give guidance rather than rigid steps.
- Refer to tools by their exact name (\`ViewCurrentTab\`, etc.).
- For style-sensitive output, include a short **example** of the desired result — it teaches shape better than description does.
- Avoid time-sensitive notes ("as of 2025…"). Keep terminology consistent throughout.

## Step 5 — Show, refine, save

1. Show the user the full draft: name, description, and body.
2. Refine together until it's right.
3. Call \`SaveSkill\` with the final \`name\`, \`description\`, \`body\`, and an \`icon\` emoji. The user will be asked to approve the save.
4. Confirm it's saved and remind them they can run it by typing \`/name\`, edit it in the Skills Library, or ask you to improve it later.`

const SUMMARIZING_PAGES_BODY = `# Summarizing pages

When the user asks for a summary, TL;DR, or recap of the page they're viewing:

1. If the page content isn't already in the conversation, call \`ViewCurrentTab\` to read it.
2. Write the summary as:
   - **Gist** — one sentence capturing what the page is.
   - **Key points** — 3–6 tight bullets, most important first.
   - **Actions** — any next steps or to-dos the page implies (omit if there are none).
3. Keep it skimmable and use the page's own terms. If the page couldn't be read, say so — never invent content.`

const EXTRACTING_TABLES_BODY = `# Extracting tables

When the user asks to pull a table, list, or other structured data out of the current page:

1. If you don't already have the page content, call \`ViewCurrentTab\` to read it.
2. Identify the structured data the user means (ask only if genuinely ambiguous).
3. Output a clean **Markdown table** by default. If the user asked for CSV, output CSV in a fenced code block instead.
4. Preserve column headers and units. Don't invent or reorder rows; leave a missing cell blank. If nothing tabular is present, say so.`

const DRAFTING_REPLIES_BODY = `# Drafting replies

When the user asks you to draft a reply to an email, comment, chat, or thread shown on the current page:

1. If you don't already have the content, call \`ViewCurrentTab\` to read the thread being replied to.
2. Match the tone of the surrounding conversation unless the user asks for a specific tone.
3. Draft a reply that acknowledges the key point, answers or acts on it, and ends with a clear next step or sign-off.
4. Keep it to the length the medium expects — a chat reply is short, an email can be longer. Offer one draft, then adjust on request. Never send anything; you only draft.`

/** Seed data. `create-skill` is user-only (the agent shouldn't spontaneously
 * author skills); the examples are invocable both ways. */
export const BUILTIN_SKILLS: SaveSkillInput[] = [
  {
    name: 'create-skill',
    description:
      'Guides the user through building a new agent skill from scratch and saves it. Use when the user wants to create, author, design, or build a custom skill for a workflow they repeat.',
    body: CREATE_SKILL_BODY,
    icon: '🛠️',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: false,
  },
  {
    name: 'summarizing-pages',
    description:
      'Summarizes the web page the user is viewing into a tight brief with a gist, key points, and next actions. Use when the user asks to summarize, TL;DR, digest, or recap the current page or an article.',
    body: SUMMARIZING_PAGES_BODY,
    icon: '📰',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
  {
    name: 'extracting-tables',
    description:
      'Extracts tabular or structured data from the current web page into clean Markdown or CSV. Use when the user asks to pull a table, list, prices, or structured data out of a page.',
    body: EXTRACTING_TABLES_BODY,
    icon: '📊',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
  {
    name: 'drafting-replies',
    description:
      "Drafts a reply to the email, comment, or message thread on the current page, matching the user's tone. Use when the user asks to reply, respond to, or write a message about what's on screen.",
    body: DRAFTING_REPLIES_BODY,
    icon: '✉️',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
]

/** Idempotent: inserts any missing built-in by name. Leaves user edits and
 * existing built-ins untouched, so re-running on every startup is safe. */
export async function seedBuiltinSkills(): Promise<void> {
  const existing = new Set((await listSkills()).map((s) => s.name))
  for (const seed of BUILTIN_SKILLS) {
    if (!existing.has(seed.name)) await saveSkill(seed)
  }
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/data/builtinSkills.ts
git commit -m "feat: built-in /create-skill meta-skill + example seeds"
```

---

### Task 3: Skill tools (`src/tools/tools.ts`)

**Files:**
- Modify: `src/tools/tools.ts` (add three tools inside `createAgentTools()`)

**Interfaces:**
- Consumes: `getSkill`, `listSkillMetas`, `saveSkill` from `../data/skills`; existing `requestApproval`, `DENIED`.
- Produces: `ListAllSkills`, `ReadSkill`, `SaveSkill` entries in the returned `ToolSet`.

- [ ] **Step 1: Add the import at the top of `src/tools/tools.ts`.**

After the existing `import { saveMemory, searchMemories } from '../data/memory'` line, add:

```ts
import { getSkill, listSkillMetas, saveSkill } from '../data/skills'
```

- [ ] **Step 2: Add the three tools inside `createAgentTools`, immediately after the `SearchMemory` tool entry (before the closing `}` of the `tools` object literal).**

```ts
    ListAllSkills: tool({
      description:
        'List all skills available to you (name + description). The most relevant skills are already summarized in your system prompt; use this to see the full current list before loading one with ReadSkill.',
      inputSchema: z.object({}),
      execute: async () => {
        const approved = await requestApproval({
          toolName: 'ListAllSkills',
          summary: 'List your saved skills',
          reason: 'To see which skills are available',
        })
        if (!approved) return DENIED
        const skills = await listSkillMetas()
        return { skills }
      },
    }),

    ReadSkill: tool({
      description:
        "Load the full instructions for a skill by name, then follow them for the current task. Use when the user invokes a skill or when a request matches a skill listed in your system prompt. Returns the skill's instruction body.",
      inputSchema: z.object({
        name: z.string().describe('The exact skill name to load, e.g. "summarizing-pages"'),
      }),
      execute: async ({ name }) => {
        const approved = await requestApproval({
          toolName: 'ReadSkill',
          summary: `Load the “${name}” skill`,
          reason: "To follow this skill's instructions",
        })
        if (!approved) return DENIED
        const skill = await getSkill(name)
        if (!skill) return { error: `No skill named "${name}". Use ListAllSkills to see valid names.` }
        return { name: skill.name, description: skill.description, body: skill.body }
      },
    }),

    SaveSkill: tool({
      description:
        "Create or update a skill in the user's local Skills Library. Use when the user has agreed on a skill to save (for example during /create-skill). Upserts by name; an existing custom skill with the same name is overwritten. Asks the user for permission first. Built-in skills cannot be overwritten.",
      inputSchema: z.object({
        name: z
          .string()
          .describe('Skill slug: lowercase letters, numbers and single hyphens, ≤64 chars (e.g. "drafting-replies")'),
        description: z
          .string()
          .describe('Third-person sentence stating what the skill does and when to use it, with trigger keywords'),
        body: z.string().describe('The Markdown instruction body the assistant follows when the skill runs'),
        icon: z.string().optional().describe('A single emoji to represent the skill in the Library'),
      }),
      execute: async ({ name, description, body, icon }) => {
        const approved = await requestApproval({
          toolName: 'SaveSkill',
          summary: `Save skill “${name}”`,
          reason: description,
        })
        if (!approved) return DENIED
        try {
          const saved = await saveSkill({ name, description, body, icon })
          return { saved: true, name: saved.name }
        } catch (err) {
          // Validation / built-in-overwrite failures come back as text so the
          // model can correct the name and retry rather than treating it as denial.
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
```

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/tools/tools.ts
git commit -m "feat: ListAllSkills, ReadSkill, SaveSkill agent tools"
```

---

### Task 4: Wire skills into the agent turn (`src/ui/Chat.tsx`, `src/data/settings.ts`)

Makes `/skill-name` work (parsed from message text on send — no UI yet), injects the Level-1 catalog into `system`, auto-approves the read tools, and labels the new tool pills. The `/` autocomplete popover is Task 5.

**Files:**
- Modify: `src/ui/Chat.tsx`
- Modify: `src/data/settings.ts` (`DEFAULT_SYSTEM_PROMPT`)

**Interfaces:**
- Consumes: `getSkill`, `listSkillMetas` from `../data/skills`; existing `send()`, `requestApproval`, `ToolPill`.
- Produces: `system` string now ends with `${skillsCatalog}${activeSkills}`; `AUTO_APPROVED_TOOLS` short-circuit; tool-pill labels for the three tools.

- [ ] **Step 1: Add the skills import to `src/ui/Chat.tsx`.**

After `import { createAgentTools, type ApprovalRequest } from '../tools/tools'`, add:

```ts
import { getSkill, listSkillMetas } from '../data/skills'
```

- [ ] **Step 2: Add the auto-approve constant near the other module constants (e.g. just below `const SELECTION_MAX = 4000`).**

```ts
// Reading/listing skills only touches the user's own local skill store — as
// benign as SearchMemory — so these route through the approval gate (invariant)
// but are auto-approved. SaveSkill is NOT here: it mutates and shows the card.
const AUTO_APPROVED_TOOLS = new Set(['ReadSkill', 'ListAllSkills'])
```

- [ ] **Step 3: Short-circuit auto-approved tools in `requestApproval` (add as the first line of the function body, before the `sessionAllowed` check).**

```ts
  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (AUTO_APPROVED_TOOLS.has(request.toolName)) return Promise.resolve(true)
    if (sessionAllowed.current.has(request.toolName)) return Promise.resolve(true)
    if (turnAllowed.current.has(request.toolName)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const pending = { ...request, resolve }
      approvalRef.current = pending
      setApproval(pending)
    })
  }
```

- [ ] **Step 4: In `send()`, detect an explicitly invoked skill from the leading `/name` token. Add this right after the `const text = input.trim()` line.**

```ts
    // A leading "/skill-name" token explicitly invokes that skill for this turn:
    // its full instructions are injected into the system prompt below.
    const slashMatch = text.match(/^\/([a-z0-9-]+)(?:\s|$)/)
    const invokedSkill = slashMatch ? await getSkill(slashMatch[1]) : null
    const activeSkill = invokedSkill && invokedSkill.userInvocable ? invokedSkill : null
```

- [ ] **Step 5: Build the catalog + active-skill blocks and append them to `system`.** In the `try` block, find the `const memoryContext = await getMemoryContext().catch(() => '')` line and add immediately after it:

```ts
      // Level-1 progressive disclosure: name+description of every model-invocable
      // skill, so the agent knows what it can load via ReadSkill.
      const skillMetas = await listSkillMetas({ modelInvocableOnly: true }).catch(() => [])
      const skillsCatalog =
        skillMetas.length > 0
          ? `\n\n## Skills\nThese skills are available. When a request matches one, call ReadSkill with its name to load its full instructions before proceeding.\n${skillMetas
              .map((s) => `- ${s.name}: ${s.description}`)
              .join('\n')}`
          : ''
      // Level-2: an explicitly invoked skill's body is injected directly (the
      // user asked for it, so no ReadSkill round-trip is needed).
      const activeSkills = activeSkill
        ? `\n\n## Active skill: ${activeSkill.name}\nThe user invoked this skill. Follow these instructions for this task:\n\n${activeSkill.body}`
        : ''
```

Then change the `runAgentTurn` `system:` argument from:

```ts
        system: `${settings.systemPrompt}${accessNote}${memoryContext ? `\n\n${memoryContext}` : ''}`,
```

to:

```ts
        system: `${settings.systemPrompt}${accessNote}${memoryContext ? `\n\n${memoryContext}` : ''}${skillsCatalog}${activeSkills}`,
```

- [ ] **Step 6: Journal the invocation.** In the `notes` block (near `if (useMemory) notes.push('[asked to recall from memory]')`), add:

```ts
      if (activeSkill) notes.push(`[invoked skill: ${activeSkill.name}]`)
```

- [ ] **Step 7: Add tool-pill labels.** In the `ToolPill` component's label chain, before the final `else label = part.toolName`, add:

```ts
  else if (part.toolName === 'ListAllSkills')
    label = `Listed ${output?.skills?.length ?? 0} skill${(output?.skills?.length ?? 0) === 1 ? '' : 's'}`
  else if (part.toolName === 'ReadSkill')
    label = output?.error ? 'Skill not found' : `Loaded skill · ${output?.name ?? ''}`
  else if (part.toolName === 'SaveSkill')
    label = output?.saved ? `Saved skill · ${output?.name ?? ''}` : 'Skill not saved'
```

- [ ] **Step 8: Update the empty-state hint.** In the `.empty-hint` text, append a sentence about `/`:

```tsx
            <div className="empty-hint">
              The tab you're on is attached to your first message. @mention another tab to share
              it, type @memory to have me draw on what I remember, type / to run one of your
              skills, or snip a screenshot with the camera.
            </div>
```

- [ ] **Step 9: Extend `DEFAULT_SYSTEM_PROMPT` in `src/data/settings.ts`.** Add this paragraph immediately before the `Each tool call asks the user for permission first…` paragraph:

```ts
You also have skills — saved instruction sets for specific tasks. When any exist, they are listed in a "Skills" section of this prompt; when the user's request matches one, call ReadSkill with its name to load and follow it. The user can also invoke a skill directly by typing /skill-name.
```

- [ ] **Step 10: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add src/ui/Chat.tsx src/data/settings.ts
git commit -m "feat: inject skill catalog + invoked-skill body into agent turn"
```

---

### Task 5: Composer `/` slash menu (`src/ui/Chat.tsx`)

Adds the autocomplete popover that helps the user type `/skill-name` (activation itself already works from Task 4's text parsing). Mirrors the existing `@mention` machinery.

**Files:**
- Modify: `src/ui/Chat.tsx`
- Modify: `src/ui/App.tsx` (pass a new `onOpenSkills` prop — the "Browse skills…" entry)

**Interfaces:**
- Consumes: `listSkills` from `../data/skills`; existing composer state/refs.
- Produces: Chat gains an `onOpenSkills: () => void` prop; a `/` popover reusing `.mention-popover`/`.mention-item` styling.

- [ ] **Step 1: Add `onOpenSkills` to the `Chat` props type and destructuring.** In the `export default function Chat({ … })` signature add `onOpenSkills` to the destructured params and to the props interface:

```ts
  onOpenSettings,
  onOpenSkills,
  onConversationsChanged,
}: {
  conversationId: string
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  onConversationsChanged: () => void
}) {
```

- [ ] **Step 2: Add the slash import + candidate type + detector near the top of the file (below `detectMention`).**

```ts
// Composer "/" menu: like @mentions but anchored to the start of the message.
// A leading "/skill-name" token invokes that skill (parsed on send in `send`);
// this popover just autocompletes the name.
type SlashCandidate =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'browse' }

// Active only while the caret is still inside a leading "/token" (no space yet).
function detectSlash(value: string, caret: number): { query: string } | null {
  const before = value.slice(0, caret)
  const m = before.match(/^\/([a-z0-9-]*)$/)
  return m ? { query: m[1] } : null
}
```

- [ ] **Step 3: Add slash state next to the mention state (below the `mentionIndex` state).**

```ts
  const [slashQuery, setSlashQuery] = useState<{ query: string } | null>(null)
  const [slashCandidates, setSlashCandidates] = useState<SlashCandidate[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
```

- [ ] **Step 4: Add the candidate refresh + select handlers (next to `refreshMentionCandidates`/`selectMention`).**

```ts
  async function refreshSlashCandidates(s: { query: string }) {
    const all = await listSkills().catch(() => [])
    const q = s.query.trim().toLowerCase()
    const matched = all
      .filter((sk) => sk.userInvocable)
      .filter((sk) => !q || sk.name.includes(q) || sk.description.toLowerCase().includes(q))
      .slice(0, 8)
      .map((sk): SlashCandidate => ({ kind: 'skill', name: sk.name, description: sk.description }))
    setSlashCandidates([...matched, { kind: 'browse' }])
    setSlashIndex(0)
  }

  function selectSlash(c: SlashCandidate) {
    if (c.kind === 'browse') {
      setSlashQuery(null)
      onOpenSkills()
      return
    }
    // Replace the leading "/query" token with "/name ", keeping any arguments.
    const rest = input.replace(/^\/[a-z0-9-]*/, '').replace(/^\s+/, '')
    const next = `/${c.name} ${rest}`
    setInput(next)
    setSlashQuery(null)
    const pos = c.name.length + 2
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }
```

- [ ] **Step 5: Detect the slash in `handleInputChange` (extend the existing function).**

```ts
  function handleInputChange(value: string, caret: number) {
    setInput(value)
    const m = detectMention(value, caret)
    setMentionQuery(m)
    if (m) void refreshMentionCandidates(m)
    const s = detectSlash(value, caret)
    setSlashQuery(s)
    if (s) void refreshSlashCandidates(s)
  }
```

- [ ] **Step 6: Handle slash keys in the textarea `onKeyDown`.** Add this block *before* the existing `if (mentionQuery && …)` block so the two popovers never fight (they can't both be open, but order keeps it clear):

```ts
              if (slashQuery && slashCandidates.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setSlashIndex((i) => (i + delta + slashCandidates.length) % slashCandidates.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  selectSlash(slashCandidates[slashIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashQuery(null)
                  return
                }
              }
```

Also add `setSlashQuery(null)` to the `onBlur` handler alongside the existing mention reset:

```ts
            onBlur={() => setTimeout(() => {
              setMentionQuery(null)
              setSlashQuery(null)
            }, 150)}
```

- [ ] **Step 7: Render the slash popover.** Directly above the existing `{mentionQuery && mentionCandidates.length > 0 && (` popover block, add:

```tsx
        {slashQuery && slashCandidates.length > 0 && (
          <div className="mention-popover">
            {slashCandidates.map((c, i) => (
              <button
                key={c.kind === 'skill' ? c.name : 'browse'}
                className={`mention-item ${i === slashIndex ? 'active' : ''} ${c.kind === 'skill' ? 'skill' : 'browse'}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectSlash(c)
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                {c.kind === 'skill' ? (
                  <>
                    <span className="mention-title">/{c.name}</span>
                    <span className="mention-url">{c.description}</span>
                  </>
                ) : (
                  <>
                    <span className="mention-title">Browse skills…</span>
                    <span className="mention-url">Open the Skills Library</span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
```

- [ ] **Step 8: Clear the slash popover on send.** In `send()`, next to the existing `setMentionQuery(null)`, add `setSlashQuery(null)`.

- [ ] **Step 9: Pass `onOpenSkills` from `App.tsx`.** (Full App wiring is Task 6; for now add the prop to the existing `<Chat … />` so Task 5 typechecks.) In `src/ui/App.tsx`, add to the `<Chat>` element:

```tsx
          onOpenSkills={() => setShowSettings(false)}
```

(Task 6 replaces this with the real `setShowSkills(true)` handler.)

- [ ] **Step 10: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add src/ui/Chat.tsx src/ui/App.tsx
git commit -m "feat: composer / slash menu for invoking skills"
```

---

### Task 6: Skills Library UI (`src/ui/SkillsLibrary.tsx`, `src/ui/App.tsx`, `src/ui/styles.css`)

**Files:**
- Create: `src/ui/SkillsLibrary.tsx` (masonry panel + inline `SkillEditor`)
- Modify: `src/ui/App.tsx` (archival-box icon, `showSkills` overlay, seeding, real `onOpenSkills`)
- Modify: `src/ui/styles.css` (skills grid, cards, badges, editor, slash-item glyph)

**Interfaces:**
- Consumes: `accentColor`, `deleteSkill`, `listSkills`, `parseSkillMarkdown`, `saveSkill`, `serializeSkill`, `validateSkill`, `type Skill` from `../data/skills`; `seedBuiltinSkills` from `../data/builtinSkills`.
- Produces: default-exported `SkillsLibrary({ onClose }: { onClose: () => void })`.

- [ ] **Step 1: Create `src/ui/SkillsLibrary.tsx`.**

```tsx
import { useEffect, useState } from 'react'
import {
  accentColor,
  deleteSkill,
  listSkills,
  parseSkillMarkdown,
  saveSkill,
  serializeSkill,
  validateSkill,
  type Skill,
} from '../data/skills'

// The Skills Library: a masonry grid of skill cards plus an inline editor.
// Overlays the mounted Chat exactly like Settings does (see App.tsx).

type EditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; skill: Skill }
  | { kind: 'view'; skill: Skill } // built-in: read-only, duplicate to customize

export default function SkillsLibrary({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [editor, setEditor] = useState<EditorMode | null>(null)

  function refresh() {
    void listSkills().then(setSkills)
  }
  useEffect(refresh, [])

  if (editor) {
    return (
      <SkillEditor
        mode={editor}
        onBack={() => {
          setEditor(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div className="skills">
      <div className="skills-header">
        <h2>Skills</h2>
        <div className="skills-header-actions">
          <button className="btn primary sm" onClick={() => setEditor({ kind: 'new' })}>
            New skill
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <p className="hint">
        Skills are reusable instruction sets. Run one by typing <code>/name</code> in chat, or let the
        agent load a relevant one on its own. Tip: type <code>/create-skill</code> in chat to build one
        with the agent.
      </p>
      {skills.length === 0 ? (
        <p className="hint">No skills yet — click “New skill” to create your first.</p>
      ) : (
        <div className="skills-grid">
          {skills.map((s) => (
            <button
              key={s.id}
              className="skill-card"
              style={{ ['--accent' as string]: accentColor(s) } as React.CSSProperties}
              onClick={() =>
                setEditor(s.source === 'builtin' ? { kind: 'view', skill: s } : { kind: 'edit', skill: s })
              }
            >
              <div className="skill-card-top">
                <span className="skill-icon">{s.icon ?? '🧩'}</span>
                <span className={`skill-badge ${s.source}`}>
                  {s.source === 'builtin' ? 'Built-in' : 'Custom'}
                </span>
              </div>
              <div className="skill-name">{s.name}</div>
              <div className="skill-desc">{s.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillEditor({ mode, onBack }: { mode: EditorMode; onBack: () => void }) {
  const initial = mode.kind === 'new' ? null : mode.skill
  const readOnly = mode.kind === 'view'
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [userInvocable, setUserInvocable] = useState(initial?.userInvocable ?? true)
  const [modelInvocable, setModelInvocable] = useState(initial?.modelInvocable ?? true)
  const [notice, setNotice] = useState<string | null>(null)

  async function save() {
    const err = validateSkill({ name, description, body })
    if (err) {
      setNotice(err)
      return
    }
    try {
      await saveSkill({ name, description, body, icon: icon || undefined, userInvocable, modelInvocable })
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function duplicate() {
    try {
      // Save a customizable copy; validateSkill runs inside saveSkill.
      await saveSkill({
        name: `${name}-copy`,
        description,
        body,
        icon: icon || undefined,
        userInvocable,
        modelInvocable,
      })
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove() {
    if (!initial) return
    if (!window.confirm(`Delete the “${initial.name}” skill?`)) return
    try {
      await deleteSkill(initial.name)
      onBack()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  function exportMd() {
    const md = serializeSkill({
      id: initial?.id ?? '',
      name,
      description,
      body,
      icon: icon || undefined,
      color: initial?.color,
      source: initial?.source ?? 'user',
      userInvocable,
      modelInvocable,
      createdAt: 0,
      updatedAt: 0,
    })
    void navigator.clipboard.writeText(md)
    setNotice('Copied SKILL.md to clipboard.')
  }

  function importMd(text: string) {
    const p = parseSkillMarkdown(text)
    setName(p.name)
    setDescription(p.description)
    setBody(p.body)
    if (p.icon) setIcon(p.icon)
    setUserInvocable(p.userInvocable)
    setModelInvocable(p.modelInvocable)
    setNotice('Imported — review and Save.')
  }

  return (
    <div className="skill-editor">
      <div className="skills-header">
        <button className="link-btn" onClick={onBack}>
          ‹ Back
        </button>
        <h2>{mode.kind === 'new' ? 'New skill' : readOnly ? name : `Edit ${name}`}</h2>
      </div>
      {readOnly && (
        <p className="hint">This is a built-in skill and can't be edited. Duplicate it to customize.</p>
      )}

      <label className="field">
        Icon
        <input
          className="skill-input"
          value={icon}
          maxLength={4}
          disabled={readOnly}
          placeholder="🧩"
          onChange={(e) => setIcon(e.target.value)}
        />
      </label>
      <label className="field">
        Name
        <input
          className="skill-input"
          value={name}
          disabled={readOnly}
          placeholder="summarizing-pages"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        Description (what it does + when to use it)
        <textarea
          className="skill-input"
          rows={3}
          value={description}
          disabled={readOnly}
          placeholder="Summarizes the current page… Use when the user asks to summarize or TL;DR a page."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        Instructions
        <textarea
          className="skill-input mono"
          rows={12}
          value={body}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="check">
          <input
            type="checkbox"
            checked={userInvocable}
            disabled={readOnly}
            onChange={(e) => setUserInvocable(e.target.checked)}
          />
          Show in the “/” menu
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={modelInvocable}
            disabled={readOnly}
            onChange={(e) => setModelInvocable(e.target.checked)}
          />
          Let the agent auto-load it
        </label>
      </div>

      {notice && <div className="skill-notice">{notice}</div>}

      <div className="skill-editor-actions">
        <button className="btn ghost sm" onClick={exportMd}>
          Export .md
        </button>
        {!readOnly && (
          <label className="btn ghost sm">
            Import .md
            <input
              type="file"
              accept=".md,.markdown,text/markdown"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) importMd(await file.text())
                e.target.value = ''
              }}
            />
          </label>
        )}
        <span className="spacer" />
        {mode.kind === 'edit' && (
          <button className="btn ghost sm danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
        {readOnly ? (
          <button className="btn primary sm" onClick={() => void duplicate()}>
            Duplicate to customize
          </button>
        ) : (
          <button className="btn primary sm" onClick={() => void save()}>
            Save
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire `App.tsx`.** Add imports:

```ts
import { seedBuiltinSkills } from '../data/builtinSkills'
import SkillsLibrary from './SkillsLibrary'
```

Add state next to `showSettings`:

```ts
  const [showSkills, setShowSkills] = useState(false)
```

Seed built-ins in the mount effect (add the one line):

```ts
  useEffect(() => {
    loadSettings().then(setSettings)
    void seedBuiltinSkills().catch(() => {})
    void dreamIfDue().catch(() => {})
    refreshConversations()
  }, [refreshConversations])
```

Close skills when starting/opening a chat — add `setShowSkills(false)` inside `newChat()` and `openConversation()`.

- [ ] **Step 3: Add the archival-box icon to the top bar in `App.tsx`, immediately before the Settings `<button>` in `.topbar-actions`.**

```tsx
          <button
            className={`icon-btn ${showSkills ? 'active' : ''}`}
            title="Skills library"
            onClick={() => {
              setShowSkills((s) => !s)
              setShowSettings(false)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <path d="M3 6v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6.5 8.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
```

- [ ] **Step 4: Make Settings and Skills mutually exclusive + wire the overlay.** Change the Settings button `onClick` to also close skills:

```tsx
            onClick={() => {
              setShowSettings((s) => !s)
              setShowSkills(false)
            }}
```

Change the `view-host` hidden condition to hide under either panel:

```tsx
      <div className={`view-host ${showSettings || showSkills ? 'is-hidden' : ''}`}>
```

Replace the Task-5 placeholder `onOpenSkills` on `<Chat>` with the real handler:

```tsx
          onOpenSkills={() => {
            setShowSkills(true)
            setShowSettings(false)
          }}
```

Render the overlay next to the Settings overlay (after the `{showSettings && (…)}` block):

```tsx
      {showSkills && <SkillsLibrary onClose={() => setShowSkills(false)} />}
```

- [ ] **Step 5: Add styles to `src/ui/styles.css`** (append at the end, before any trailing media queries):

```css
/* ---- Skills library ---- */

.skills,
.skill-editor {
  flex: 1;
  overflow-y: auto;
  padding: 4px 16px 16px;
}

.skills-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.skills-header h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: 8px 0;
}

.skills-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skills-grid {
  column-count: 2;
  column-gap: 10px;
  margin-top: 6px;
}

@media (max-width: 400px) {
  .skills-grid {
    column-count: 1;
  }
}

.skill-card {
  display: block;
  width: 100%;
  text-align: left;
  break-inside: avoid;
  margin: 0 0 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent, var(--border));
  border-radius: 12px;
  padding: 10px 11px;
  cursor: pointer;
  color: var(--text);
}

.skill-card:hover {
  border-color: var(--accent, var(--border));
}

.skill-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.skill-icon {
  font-size: 18px;
  line-height: 1;
}

.skill-badge {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.skill-badge.builtin {
  color: var(--accent);
  border-color: var(--accent);
}

.skill-name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-word;
  margin-bottom: 2px;
}

.skill-desc {
  font-size: 11.5px;
  color: var(--text-muted);
}

/* editor */
.skill-editor .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.skill-input {
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
}

.skill-input.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.skill-input:disabled {
  opacity: 0.7;
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 2px 0 10px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}

.skill-notice {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--pill-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
  margin-bottom: 10px;
}

.skill-editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skill-editor-actions .spacer {
  flex: 1;
}

.btn.sm {
  padding: 5px 10px;
  font-size: 12px;
}

.btn.ghost.danger:hover {
  color: var(--danger);
}

/* "/" menu item glyph reuses the mention popover styling */
.mention-item.browse .mention-title {
  color: var(--text-muted);
}
```

- [ ] **Step 6: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Build + manual verification.**

Run: `npm run build`
Expected: PASS. Then reload the unpacked extension (`chrome://extensions`) and open the side panel. Verify:
- The archival-box icon sits left of the gear; clicking it opens the masonry Library with `create-skill`, `summarizing-pages`, `extracting-tables`, `drafting-replies` cards (icons, accents, Built-in badges).
- Opening/closing Skills and Settings are mutually exclusive; the chat transcript survives both.
- **New skill** → fill fields → **Save** adds a Custom card; **Edit** and **Delete** work on it; built-ins open read-only with **Duplicate to customize**; **Export .md** copies SKILL.md; **Import .md** fills the form.

- [ ] **Step 8: Commit.**

```bash
git add src/ui/SkillsLibrary.tsx src/ui/App.tsx src/ui/styles.css
git commit -m "feat: Skills Library masonry UI + editor + top-bar entry"
```

---

### Task 7: Docs + end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature in `README.md`.** Add a `## Skills` section (after "Memory & dreaming") describing: single-file SKILL.md skills; the `/` composer menu; the Library (archival-box icon); `/create-skill`; autonomous loading via the catalog + `ReadSkill`; and note `SaveSkill` is approval-gated while `ReadSkill`/`ListAllSkills` auto-approve. In the Architecture map, add:

```
src/data/skills.ts          IndexedDB: skills store + SKILL.md parse/serialize
src/data/builtinSkills.ts   /create-skill meta-skill + example seeds
src/ui/SkillsLibrary.tsx    Skills Library masonry UI + editor
```

- [ ] **Step 2: Full build.**

Run: `npm run build`
Expected: PASS (typecheck + vite build clean).

- [ ] **Step 3: End-to-end manual verification (via `/verify-extension`).** Reload unpacked, then confirm the acceptance checks from the spec §10:

1. **Slash invocation:** type `/` → picker opens → pick `summarizing-pages` → it inserts `/summarizing-pages ` → send on a real article → the agent calls `ViewCurrentTab` (approval card) and returns a Gist/Key points/Actions summary.
2. **Autonomous loading:** in a fresh chat (no slash), ask "pull the table off this page" on a page with a table → the agent calls `ReadSkill` (auto-approved; shows a "Loaded skill · extracting-tables" pill) and follows it.
3. **`/create-skill` round-trip:** type `/create-skill`, describe a workflow, approve the `SaveSkill` card → the new skill appears in the Library and is invocable via `/`.
4. **Approval policy:** `SaveSkill` shows the permission card; `ReadSkill`/`ListAllSkills` do not.

- [ ] **Step 4: Commit.**

```bash
git add README.md
git commit -m "docs: document agent skills feature"
```

---

## Self-Review

**Spec coverage:**
- §2 skill definition / field rules → Task 1 (types, `validateSkillName`/`validateSkill`, serialize/parse). ✓
- §3 data model & storage → Task 1 (IndexedDB store, CRUD, `listSkillMetas`, `accentColor`). ✓
- §4 agent integration: catalog + active body → Task 4; three tools → Task 3; approval policy (`AUTO_APPROVED_TOOLS`) → Task 4 Step 2–3; step budget unchanged → noted, `agent.ts` untouched. ✓
- §5 composer `/` menu → Task 5. ✓
- §6 Skills Library masonry + editor + top-bar icon → Task 6. ✓
- §7 `/create-skill` + 3 example seeds → Task 2. ✓
- §8 file map → matches Tasks 1–7. ✓
- §10 verification → Task 6 Step 7, Task 7 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; no "add error handling" hand-waves (validation is concrete in Task 1). ✓

**Type consistency:** `Skill`/`SkillMeta`/`SaveSkillInput`/`ParsedSkill` defined in Task 1 and consumed with matching field names in Tasks 2–6. Tool names (`ListAllSkills`/`ReadSkill`/`SaveSkill`) identical in Task 3 (definition), Task 4 (`AUTO_APPROVED_TOOLS`, pill labels). `accentColor`, `serializeSkill`, `parseSkillMarkdown`, `validateSkill`, `deleteSkill`, `saveSkill`, `listSkills` signatures match between Task 1 and Task 6 usage. `onOpenSkills` prop added in Task 5 and satisfied in Task 6. ✓

**Note on existing installs:** the `DEFAULT_SYSTEM_PROMPT` edit (Task 4 Step 9) only affects fresh installs / prompt resets; the operative instruction is the `skillsCatalog` block appended to `system` every turn regardless of the stored base prompt, so skills work for existing users too.
