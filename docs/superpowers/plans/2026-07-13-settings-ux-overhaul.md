# Settings UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split providers into their own tab, add a Data tab that reports per-store storage usage and offers scoped clears plus a full reset, collapse the 14-row tool-permission matrix into a 6-group accordion, and cut the prose across every settings pane.

**Architecture:** Three layers, acyclic. `src/data/usage.ts` is a pure leaf (byte estimation + the shared usage/report types) that imports nothing. Each store imports it to expose its own `clearX()` / `xUsage()` beside its data model. `src/data/storage.ts` sits on top, importing the stores, and is the only module that knows all five exist — it composes one `StorageReport` and dispatches the destructive actions. The UI grows two tabs (`ProvidersTab`, `DataTab`) plus two shared primitives (`Section`, `Disclosure`) that replace the hand-rolled `<h2>` + `<p class="hint">` pattern. Permission *copy* stops asserting behavior and is instead **rendered from** `toolPolicy()`, so it cannot drift from it.

**Tech Stack:** React 18, TypeScript (strict), Vite 6, Vitest, IndexedDB, `chrome.storage.local`.

## Global Constraints

- **No semicolons** (ASI style). **Single quotes.** **2-space indent.** No linter enforces this — match by hand.
- Prefer `interface` for object/record shapes; `type` only for unions/aliases.
- Document exported types/functions with `/** ... */`; explain non-obvious *why* in block comments.
- **The dependency graph must stay acyclic.** `usage.ts` imports nothing from `src/data/`. Stores import `usage.ts`. `storage.ts` imports stores + `usage.ts`. Never make `usage.ts` import a store, and never make a store import `storage.ts` — that closes a cycle and neither module compiles alone.
- **`skills.ts` must not import `seedBuiltinSkills`.** `builtinSkills.ts` already imports `saveSkill`/`listSkills` from `skills.ts`; importing back would close a cycle. `storage.ts` composes the wipe with the re-seed.
- Every new pure function gets a Vitest test. Chrome-coupled code is verified by `npm run build` + reloading the unpacked extension.
- Commit after every task, **pathspec-scoped** (`git commit -- <paths>`) — other Claude sessions share this repo.
- Verification commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Pure settings helpers (group policy + reset)

**Files:**
- Modify: `src/data/settings.ts` (append after `toolPolicy`, ~line 152)
- Test: `src/data/settings.test.ts` (create)

**Interfaces:**
- Consumes: existing `Settings`, `ToolPolicy`, `ToolGroup`, `TOOL_CATALOG`, `toolPolicy`, `EMPTY` (module-private).
- Produces:
  - `groupPolicy(settings: Settings, group: ToolGroup): ToolPolicy | 'mixed'`
  - `setGroupPolicy(settings: Settings, group: ToolGroup, policy: ToolPolicy): Settings`
  - `resetSettingsKeepingProviders(settings: Settings): Settings`
  - `defaultSettings(): Settings`

- [ ] **Step 1: Write the failing test**

Create `src/data/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_PROMPT,
  defaultSettings,
  groupPolicy,
  resetSettingsKeepingProviders,
  setGroupPolicy,
  toolPolicy,
  type Settings,
} from './settings'

function base(overrides: Partial<Settings> = {}): Settings {
  return {
    providers: [],
    selected: null,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tabAccess: 'active-tab',
    onboarded: true,
    ...overrides,
  }
}

describe('groupPolicy', () => {
  it('returns the shared policy when every tool in the group agrees', () => {
    // 'reading' holds ReadPage, ReadTabs, ExtractData, StartResearch — all default 'ask'.
    expect(groupPolicy(base(), 'reading')).toBe('ask')
  })

  it("returns 'mixed' when the group's tools disagree", () => {
    const s = base({ toolPolicies: { ReadPage: 'always' } })
    expect(groupPolicy(s, 'reading')).toBe('mixed')
  })

  it('reflects catalog defaults, not just explicit overrides', () => {
    // ListAllSkills + ReadSkill default to 'always', SaveSkill to 'ask'.
    expect(groupPolicy(base(), 'skills')).toBe('mixed')
  })

  it('returns the shared policy when overrides make a mixed group uniform', () => {
    const s = base({ toolPolicies: { SaveSkill: 'always' } })
    expect(groupPolicy(s, 'skills')).toBe('always')
  })
})

describe('setGroupPolicy', () => {
  it('sets every tool in the group and leaves other groups alone', () => {
    const next = setGroupPolicy(base(), 'reading', 'never')
    expect(toolPolicy(next, 'ReadPage')).toBe('never')
    expect(toolPolicy(next, 'ReadTabs')).toBe('never')
    expect(toolPolicy(next, 'ExtractData')).toBe('never')
    expect(toolPolicy(next, 'StartResearch')).toBe('never')
    expect(toolPolicy(next, 'NavigateTab')).toBe('ask')
    expect(groupPolicy(next, 'reading')).toBe('never')
  })

  it('does not mutate the input', () => {
    const s = base()
    setGroupPolicy(s, 'reading', 'never')
    expect(s.toolPolicies).toBeUndefined()
  })
})

describe('resetSettingsKeepingProviders', () => {
  const configured = base({
    providers: [{ id: 'p1', name: 'OpenAI', baseURL: 'u', apiKey: 'sk-secret', models: ['m'] }],
    selected: { providerId: 'p1', modelId: 'm' },
    systemPrompt: 'my custom prompt',
    tabAccess: 'all-tabs',
    toolPolicies: { ReadPage: 'always' },
  })

  it('keeps providers, keys and the selected model', () => {
    const next = resetSettingsKeepingProviders(configured)
    expect(next.providers).toEqual(configured.providers)
    expect(next.selected).toEqual({ providerId: 'p1', modelId: 'm' })
  })

  it('restores prompt, tab access and tool policies to defaults', () => {
    const next = resetSettingsKeepingProviders(configured)
    expect(next.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(next.tabAccess).toBe('active-tab')
    expect(toolPolicy(next, 'ReadPage')).toBe('ask')
  })

  it('stays onboarded so the user is not thrown back into the wizard', () => {
    expect(resetSettingsKeepingProviders(configured).onboarded).toBe(true)
  })

  it('does not alias the input providers array', () => {
    const next = resetSettingsKeepingProviders(configured)
    next.providers[0].apiKey = 'changed'
    expect(configured.providers[0].apiKey).toBe('sk-secret')
  })
})

describe('defaultSettings', () => {
  it('is a fresh, un-onboarded, provider-less config', () => {
    const d = defaultSettings()
    expect(d.onboarded).toBe(false)
    expect(d.providers).toEqual([])
    expect(d.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/settings.test.ts`
Expected: FAIL — the four new exports do not resolve.

- [ ] **Step 3: Write the implementation**

Append to `src/data/settings.ts`, immediately after the existing `toolPolicy` function:

```ts
/**
 * The policy shared by every tool in a group, or `'mixed'` when they disagree.
 * Drives the collapsed group row in the permissions accordion: a uniform group
 * shows a segmented control, a mixed one shows a "Mixed" pill. Resolved through
 * `toolPolicy`, so catalog defaults count — the `skills` group reads as mixed on
 * a fresh install because its tools ship with different defaults.
 */
export function groupPolicy(settings: Settings, group: ToolGroup): ToolPolicy | 'mixed' {
  const tools = TOOL_CATALOG.filter((t) => t.group === group)
  if (tools.length === 0) return 'ask'
  const first = toolPolicy(settings, tools[0].name)
  return tools.every((t) => toolPolicy(settings, t.name) === first) ? first : 'mixed'
}

/** Set every tool in a group to one policy. Returns a new Settings; never mutates. */
export function setGroupPolicy(settings: Settings, group: ToolGroup, policy: ToolPolicy): Settings {
  const toolPolicies = { ...settings.toolPolicies }
  for (const t of TOOL_CATALOG) {
    if (t.group === group) toolPolicies[t.name] = policy
  }
  return { ...settings, toolPolicies }
}

/** A pristine config — what a brand-new install starts from. */
export function defaultSettings(): Settings {
  return structuredClone(EMPTY)
}

/**
 * Factory-reset everything *except* the provider list and selected model.
 * Deliberate: "Reset settings" sits one tap away from a user's only copy of their
 * API keys, and a reset that silently destroyed them would lock the user out of
 * their own endpoint. Erasing keys is what "Erase all data" is for.
 */
export function resetSettingsKeepingProviders(settings: Settings): Settings {
  return {
    ...structuredClone(EMPTY),
    providers: structuredClone(settings.providers),
    selected: settings.selected ? { ...settings.selected } : null,
    // EMPTY is un-onboarded, but a user with providers has plainly onboarded.
    onboarded: true,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/settings.test.ts && npm run typecheck`
Expected: PASS — 11 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/settings.ts src/data/settings.test.ts
git commit -m "feat(settings): pure group-policy and reset helpers" -- src/data/settings.ts src/data/settings.test.ts
```

---

### Task 2: Pure usage leaf — `src/data/usage.ts`

**Files:**
- Create: `src/data/usage.ts`
- Test: `src/data/usage.test.ts` (create)

**Interfaces:**
- Consumes: nothing. **This module imports nothing from `src/data/` and must stay that way** — it is the leaf that keeps the storage graph acyclic.
- Produces:
  - `type StoreKey = 'conversations' | 'screenshots' | 'memory' | 'skills' | 'research'`
  - `interface StoreUsage { bytes: number; count: number; detail?: string }`
  - `interface StorageReport { total: number; quota: number | null; stores: Record<StoreKey, StoreUsage> }`
  - `estimateBytes(value: unknown): number`
  - `formatBytes(n: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/data/usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { estimateBytes, formatBytes } from './usage'

describe('estimateBytes', () => {
  it('counts a string by its length', () => {
    expect(estimateBytes('hello')).toBe(5)
  })

  it('counts nothing for null and undefined', () => {
    expect(estimateBytes(null)).toBe(0)
    expect(estimateBytes(undefined)).toBe(0)
  })

  it('counts object keys as well as their values', () => {
    // 'id'(2) + 'ab'(2) + 'body'(4) + 'xyz'(3) = 11
    expect(estimateBytes({ id: 'ab', body: 'xyz' })).toBe(11)
  })

  it('sums arrays element-wise', () => {
    expect(estimateBytes(['a', 'bb', 'ccc'])).toBe(6)
  })

  it('recurses into nested records', () => {
    // 'a'(1) + 'b'(1) + 'cd'(2) = 4
    expect(estimateBytes({ a: { b: 'cd' } })).toBe(4)
  })

  it('gives numbers and booleans fixed widths', () => {
    expect(estimateBytes(42)).toBe(8)
    expect(estimateBytes(true)).toBe(4)
  })

  it('measures a data URL at roughly its character count — the case that matters', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(1000)}`
    expect(estimateBytes({ dataUrl })).toBeGreaterThan(1000)
    expect(estimateBytes({ dataUrl })).toBeLessThan(1040)
  })
})

describe('formatBytes', () => {
  it('renders bytes, KB, MB and GB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/usage.test.ts`
Expected: FAIL — cannot resolve `./usage`.

- [ ] **Step 3: Write the implementation**

Create `src/data/usage.ts`:

```ts
// Storage accounting, as pure functions and shared types.
//
// This is a LEAF: it imports nothing from src/data/. The stores import it to
// report their own size, and storage.ts imports both. Making this file import a
// store would close a cycle and neither module would compile alone.

/** The five clearable stores, in Data-tab display order. */
export type StoreKey = 'conversations' | 'screenshots' | 'memory' | 'skills' | 'research'

export interface StoreUsage {
  /** Estimated bytes — see `estimateBytes`. */
  bytes: number
  /** Primary row count (chats, images, memories, skills, reports). */
  count: number
  /** Secondary line, e.g. "6 skills · 2 custom". */
  detail?: string
}

export interface StorageReport {
  /**
   * Sum of the per-store estimates. Deliberately NOT
   * `navigator.storage.estimate().usage`: that figure is origin-wide, includes
   * IndexedDB's own overhead and excludes chrome.storage.local, so the rows
   * would never add up to it — and a total that disagrees with its own rows
   * reads as a bug. The rows are what we can honestly account for; the quota
   * below is the only part we borrow from the browser.
   */
  total: number
  /** Origin quota from navigator.storage.estimate(), or null when unavailable. */
  quota: number | null
  stores: Record<StoreKey, StoreUsage>
}

/**
 * Rough byte size of a stored record: string lengths plus fixed widths for
 * scalars. An estimate, not an audit — structured-clone encoding and IndexedDB
 * overhead are not modelled, and a non-ASCII character counts as one byte where
 * UTF-8 would spend more.
 *
 * That imprecision is fine for the job. This number exists to answer "what is
 * eating my space", and the answer is always screenshots — which are base64 data
 * URLs, i.e. exactly the case where one char really is one byte.
 */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      return value.length
    case 'number':
      return 8
    case 'boolean':
      return 4
    case 'object':
      break
    default:
      return 0
  }
  if (Array.isArray(value)) {
    let n = 0
    for (const v of value) n += estimateBytes(v)
    return n
  }
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    n += k.length + estimateBytes(v)
  }
  return n
}

/** Human-readable byte size for the Data tab. */
export function formatBytes(n: number): string {
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  if (n < KB) return `${n} B`
  if (n < MB) return `${(n / KB).toFixed(1)} KB`
  if (n < GB) return `${(n / MB).toFixed(1)} MB`
  return `${(n / GB).toFixed(2)} GB`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/usage.test.ts && npm run typecheck`
Expected: PASS — 9 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/usage.ts src/data/usage.test.ts
git commit -m "feat(data): pure byte-estimation leaf for storage accounting" -- src/data/usage.ts src/data/usage.test.ts
```

---

### Task 3: Per-store clear + usage exports

**Files:**
- Modify: `src/data/conversations.ts` (add an import; append at end)
- Modify: `src/data/memory.ts` (add an import; append at end)
- Modify: `src/data/screenshots.ts` (add an import; append at end)
- Modify: `src/data/skills.ts` (add an import; append at end)
- Modify: `src/data/researchTasks.ts` (add an import; append at end)

**Interfaces:**
- Consumes: `estimateBytes`, `StoreUsage` from `./usage` (Task 2); each file's existing module-private `requestOf` / `requestOn` / `serialize` / `all` helpers, and its own `DB`/store constants (`MEMORIES`, `EPISODES`, `THUMBS`, `KEY`).
- Produces:
  - `clearConversations(): Promise<void>`, `conversationsUsage(): Promise<StoreUsage>`
  - `clearShots(): Promise<void>`, `shotsUsage(): Promise<StoreUsage>`
  - `clearMemory(): Promise<void>`, `memoryUsage(): Promise<StoreUsage>`
  - `clearSkills(): Promise<void>`, `skillsUsage(): Promise<StoreUsage>`
  - `clearTasks(): Promise<void>`, `tasksUsage(): Promise<StoreUsage>`

- [ ] **Step 1: `conversations.ts`**

Add to the imports at the top:

```ts
import { estimateBytes, type StoreUsage } from './usage'
```

Append at the end. Note `conversations.ts`'s `requestOf` is already bound to its single store, so it takes `(mode, fn)`:

```ts
/**
 * Wipe every stored conversation. Screenshots are keyed by conversation but live
 * in their own database, so the caller (`storage.ts`) clears them alongside.
 */
export async function clearConversations(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab. */
export async function conversationsUsage(): Promise<StoreUsage> {
  const all = await requestOf<StoredConversation[]>('readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: all.length === 1 ? '1 chat' : `${all.length} chats`,
  }
}
```

- [ ] **Step 2: `screenshots.ts`**

Add to the imports at the top:

```ts
import { estimateBytes, type StoreUsage } from './usage'
```

Append at the end. `screenshots.ts`'s `requestOf` is bound to the `shots` store; reach `thumbs` through the underlying `requestOn(store, mode, fn)`:

```ts
/** Wipe every screenshot and its thumbnail. */
export async function clearShots(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
  await requestOn(THUMBS, 'readwrite', (s) => s.clear())
}

/**
 * Byte/row estimate for the Data tab. Shots are base64 data URLs, so
 * `estimateBytes`'s one-char-per-byte assumption is very close here — and this is
 * the store that actually dominates the total.
 */
export async function shotsUsage(): Promise<StoreUsage> {
  const shots = await requestOf<StoredShot[]>('readonly', (s) => s.getAll())
  const thumbs = await requestOn<ShotThumb[]>(THUMBS, 'readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(shots) + estimateBytes(thumbs),
    count: shots.length,
    detail: shots.length === 1 ? '1 image' : `${shots.length} images`,
  }
}
```

- [ ] **Step 3: `memory.ts`**

Add to the imports at the top:

```ts
import { estimateBytes, type StoreUsage } from './usage'
```

Append at the end. `memory.ts` owns **two** object stores, so its `requestOf` takes the store name first — `(store, mode, fn)`:

```ts
/** Wipe long-term memory *and* the episode log the dreamer consolidates from. */
export async function clearMemory(): Promise<void> {
  await requestOf(MEMORIES, 'readwrite', (s) => s.clear())
  await requestOf(EPISODES, 'readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab, counting both object stores. */
export async function memoryUsage(): Promise<StoreUsage> {
  const memories = await requestOf<MemoryRecord[]>(MEMORIES, 'readonly', (s) => s.getAll())
  const episodes = await requestOf<EpisodeRecord[]>(EPISODES, 'readonly', (s) => s.getAll())
  const eps = episodes.length === 1 ? '1 episode' : `${episodes.length} episodes`
  return {
    bytes: estimateBytes(memories) + estimateBytes(episodes),
    count: memories.length,
    detail: `${memories.length} memories · ${eps}`,
  }
}
```

- [ ] **Step 4: `skills.ts`**

Add to the imports at the top:

```ts
import { estimateBytes, type StoreUsage } from './usage'
```

Append at the end. **Do not re-seed here** — importing `seedBuiltinSkills` would close an import cycle (`builtinSkills.ts` already imports `saveSkill`/`listSkills` from this file). `storage.ts` composes the wipe with the re-seed:

```ts
/**
 * Wipe the whole skills store — built-ins included. Deliberately raw: re-seeding
 * lives in `storage.ts`, because importing `seedBuiltinSkills` here would close an
 * import cycle (builtinSkills.ts already imports saveSkill/listSkills from this
 * module).
 */
export async function clearSkills(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab. */
export async function skillsUsage(): Promise<StoreUsage> {
  const all = await requestOf<Skill[]>('readonly', (s) => s.getAll())
  const custom = all.filter((s) => s.source === 'user').length
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: `${all.length} skills · ${custom} custom`,
  }
}
```

- [ ] **Step 5: `researchTasks.ts`**

Add to the imports at the top:

```ts
import { estimateBytes, type StoreUsage } from './usage'
```

Append at the end. This store lives in `chrome.storage.local`, not IndexedDB, and its writes go through the existing `serialize` chain so a concurrent `saveTask` cannot resurrect what we just removed:

```ts
/** Drop every saved research task and report. */
export async function clearTasks(): Promise<void> {
  await serialize(async () => {
    await chrome.storage.local.remove(KEY)
  })
}

/** Byte/row estimate for the Data tab. */
export async function tasksUsage(): Promise<StoreUsage> {
  const map = await all()
  const tasks = Object.values(map)
  return {
    bytes: estimateBytes(map),
    count: tasks.length,
    detail: tasks.length === 1 ? '1 report' : `${tasks.length} reports`,
  }
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all existing tests still pass. If `StoredConversation`, `StoredShot`, `ShotThumb`, `MemoryRecord`, `EpisodeRecord` or `Skill` are not in scope where you appended, they are declared earlier in the same file — no import needed.

- [ ] **Step 7: Commit**

```bash
git add src/data/conversations.ts src/data/screenshots.ts src/data/memory.ts src/data/skills.ts src/data/researchTasks.ts
git commit -m "feat(data): per-store clear + usage exports" -- src/data/conversations.ts src/data/screenshots.ts src/data/memory.ts src/data/skills.ts src/data/researchTasks.ts
```

---

### Task 4: Storage aggregator — `src/data/storage.ts`

**Files:**
- Create: `src/data/storage.ts`

**Interfaces:**
- Consumes: the ten Task-3 exports; `seedBuiltinSkills` from `./builtinSkills`; the types from `./usage`.
- Produces:
  - `storageReport(): Promise<StorageReport>`
  - `clearStore(key: StoreKey): Promise<void>`
  - `eraseAllData(): Promise<void>`

- [ ] **Step 1: Create `storage.ts`**

```ts
// The destructive resets and the storage report behind Settings → Data.
//
// This is the one module that knows all five stores exist. Each store owns its
// clear/usage pair (they live beside their data model); this file composes them
// into a single report and dispatches "clear this one" / "erase everything", so
// the Data tab never opens a database itself.

import { clearConversations, conversationsUsage } from './conversations'
import { clearMemory, memoryUsage } from './memory'
import { clearShots, shotsUsage } from './screenshots'
import { clearSkills, skillsUsage } from './skills'
import { clearTasks, tasksUsage } from './researchTasks'
import { seedBuiltinSkills } from './builtinSkills'
import type { StorageReport, StoreKey, StoreUsage } from './usage'

/** Read every store once and total it up. Counts are dozens, so one pass is cheap. */
export async function storageReport(): Promise<StorageReport> {
  const [conversations, screenshots, memory, skills, research] = await Promise.all([
    conversationsUsage(),
    shotsUsage(),
    memoryUsage(),
    skillsUsage(),
    tasksUsage(),
  ])
  const stores: Record<StoreKey, StoreUsage> = {
    conversations,
    screenshots,
    memory,
    skills,
    research,
  }
  const total = Object.values(stores).reduce((n, s) => n + s.bytes, 0)
  // estimate() is absent in some contexts; the quota bar simply hides then.
  const quota = await navigator.storage
    ?.estimate?.()
    .then((e) => e.quota ?? null)
    .catch(() => null)
  return { total, quota: quota ?? null, stores }
}

/**
 * Clear one store. Two of these deliberately cascade:
 * - conversations also drops screenshots, which are keyed by conversation and
 *   would otherwise be unreachable garbage holding the biggest share of the quota.
 * - skills re-seeds the built-ins afterwards, so "Clear" returns skills to a known
 *   state rather than an empty one. `deleteSkill` refuses to remove a built-in by
 *   design, so a user who wiped them would otherwise have no way back.
 */
export async function clearStore(key: StoreKey): Promise<void> {
  switch (key) {
    case 'conversations':
      await clearConversations()
      await clearShots()
      return
    case 'screenshots':
      await clearShots()
      return
    case 'memory':
      await clearMemory()
      return
    case 'skills':
      await clearSkills()
      await seedBuiltinSkills()
      return
    case 'research':
      await clearTasks()
      return
  }
}

/**
 * Erase everything: all five stores plus the whole chrome.storage.local namespace
 * — settings, API keys, the vision-probe cache, the lot. The caller sends the user
 * back to onboarding afterwards; with the settings key gone, `loadSettings()`
 * returns an un-onboarded config and `App.tsx` renders the wizard on its own.
 */
export async function eraseAllData(): Promise<void> {
  await Promise.all([clearConversations(), clearShots(), clearMemory(), clearSkills(), clearTasks()])
  await chrome.storage.local.clear()
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add src/data/storage.ts
git commit -m "feat(data): storage report, scoped clears and full erase" -- src/data/storage.ts
```

---

### Task 5: Shared settings primitives — `Section` + `Disclosure`

**Files:**
- Create: `src/ui/settings/primitives.tsx`
- Modify: `src/ui/styles.css` (append after the existing `.settings .hint` rule, ~line 2502)

**Interfaces:**
- Produces:
  - `<Section title={string} hint?={ReactNode} action?={ReactNode}>`
  - `<Disclosure summary={string} status?={ReactNode} defaultOpen?={boolean}>`

- [ ] **Step 1: Create the primitives**

Create `src/ui/settings/primitives.tsx`:

```tsx
import { useState, type ReactNode } from 'react'

/**
 * A settings section: heading, optional one-line hint, optional right-aligned
 * action. Exists so panes stop hand-rolling `<h2>` + `<p className="hint">` —
 * that pattern is what let the prose grow unchecked, and a shared component is
 * the only thing that stops the de-cluttering from regrowing.
 *
 * A hint is one line. A section that needs a paragraph needs a Disclosure.
 */
export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-section-block">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

/**
 * A collapsible block whose closed state still says where it stands — `status`
 * renders muted beside the summary (e.g. "Off", "On · cloud.langfuse.com"), so
 * folding a section away never hides whether it is doing something.
 */
export function Disclosure({
  summary,
  status,
  defaultOpen = false,
  children,
}: {
  summary: string
  status?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`disclosure ${open ? 'open' : ''}`}>
      <button className="disclosure-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M3 1l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="disclosure-summary">{summary}</span>
        {status && <span className="disclosure-status">{status}</span>}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Add the CSS**

Append to `src/ui/styles.css`:

```css
.settings-section-block + .settings-section-block {
  margin-top: 22px;
}

.settings-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.settings-section-head h2 {
  margin: 0;
}

/* Collapsible block. The chevron rotates rather than swapping glyphs, so open and
   closed read as one control rather than two. */
.disclosure {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}

.disclosure-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.disclosure-head:hover {
  background: var(--bg);
}

.disclosure-chevron {
  flex: none;
  color: var(--text-muted);
  transition: transform 0.15s ease;
}

.disclosure.open .disclosure-chevron {
  transform: rotate(90deg);
}

.disclosure-summary {
  flex: 1;
  font-weight: 500;
}

.disclosure-status {
  flex: none;
  color: var(--text-muted);
  font-size: 12px;
}

.disclosure-body {
  padding: 12px;
  border-top: 1px solid var(--border);
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean. Nothing imports the primitives yet — that starts in Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/primitives.tsx src/ui/styles.css
git commit -m "feat(settings): shared Section + Disclosure primitives" -- src/ui/settings/primitives.tsx src/ui/styles.css
```

---

### Task 6: Providers tab

**Files:**
- Create: `src/ui/settings/ProvidersTab.tsx`
- Modify: `src/ui/settings/GeneralTab.tsx` (delete `PRESETS`, the three provider mutators, and the Providers JSX block at lines 93–159)
- Modify: `src/ui/settings/Settings.tsx` (add the `providers` and `data` tab keys; render `providers`)
- Modify: `src/ui/styles.css` (scrollable tab strip; collapsed provider card)

**Interfaces:**
- Consumes: `Settings`, `ProviderConfig` from `../../data/settings`; `Section` from `./primitives`; the `draft`/`buffer`/`commit`/`commitDraft` props `Settings.tsx` already threads to `GeneralTab`.
- Produces: `export default function ProvidersTab({ draft, buffer, commit, commitDraft })` — prop shape identical to `GeneralTab`.

- [ ] **Step 1: Create `ProvidersTab.tsx`**

`PRESETS` and the three mutators move here **verbatim** from `GeneralTab.tsx`. What is new is that a configured provider collapses to one line:

```tsx
import { useState } from 'react'
import type { ProviderConfig, Settings } from '../../data/settings'
import { Section } from './primitives'

// Common OpenAI-compatible endpoints, offered as one-click starting points.
// Anything not listed still works via "Custom".
const PRESETS: Array<Pick<ProviderConfig, 'name' | 'baseURL'> & { models: string[] }> = [
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', models: ['claude-sonnet-5'] },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', models: [] },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', models: [] },
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', models: ['llama3.1'] },
  { name: 'Custom', baseURL: '', models: [] },
]

/** Drop the scheme so a collapsed card reads "api.openai.com/v1", not the whole URL. */
function hostLabel(baseURL: string): string {
  return baseURL.replace(/^https?:\/\//, '') || 'not configured'
}

/**
 * Providers tab: every OpenAI-compatible endpoint the user has configured. Text
 * fields buffer on keystroke and persist on blur; add/remove persist immediately.
 *
 * A configured provider collapses to a single summary line — the panel is ~400px
 * wide, and four expanded cards used to bury everything below them. A card the
 * user just added starts open, since it is by definition unconfigured.
 */
export default function ProvidersTab({
  draft,
  buffer,
  commit,
  commitDraft,
}: {
  draft: Settings
  buffer: (next: Settings) => void
  commit: (next: Settings) => void
  commitDraft: () => void
}) {
  // Which cards are expanded. Not persisted: reopening Settings starts collapsed.
  const [open, setOpen] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    buffer({
      ...draft,
      providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })
  }

  function addProvider(preset: (typeof PRESETS)[number]) {
    const provider: ProviderConfig = {
      id: crypto.randomUUID(),
      name: preset.name === 'Custom' ? '' : preset.name,
      baseURL: preset.baseURL,
      apiKey: '',
      models: [...preset.models],
    }
    commit({ ...draft, providers: [...draft.providers, provider] })
    // A brand-new provider has no key yet — open it so the user can fill it in.
    setOpen((prev) => new Set(prev).add(provider.id))
  }

  function removeProvider(id: string) {
    commit({
      ...draft,
      providers: draft.providers.filter((p) => p.id !== id),
      selected: draft.selected?.providerId === id ? null : draft.selected,
    })
  }

  return (
    <div className="settings-tabpane">
      <Section
        title="Providers"
        hint="Any OpenAI-compatible endpoint. Keys stay in your browser and are sent only to that endpoint."
      >
        {draft.providers.length === 0 && (
          <p className="hint">No providers yet — add one below to get started.</p>
        )}

        {draft.providers.map((p) => {
          const expanded = open.has(p.id)
          const active = draft.selected?.providerId === p.id
          return (
            <div className={`provider-card ${expanded ? 'open' : ''}`} key={p.id}>
              <button className="provider-head" aria-expanded={expanded} onClick={() => toggle(p.id)}>
                <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M3 1l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="provider-name">{p.name || 'Unnamed provider'}</span>
                {active && <span className="provider-active">Active</span>}
                <span className="provider-meta">
                  {hostLabel(p.baseURL)} · {p.models.length}{' '}
                  {p.models.length === 1 ? 'model' : 'models'}
                </span>
              </button>

              {expanded && (
                <div className="provider-body">
                  <div className="field-row">
                    <label>
                      Name
                      <input
                        value={p.name}
                        placeholder="e.g. OpenRouter"
                        onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                        onBlur={commitDraft}
                      />
                    </label>
                    <button
                      className="icon-btn danger"
                      title="Remove provider"
                      onClick={() => removeProvider(p.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3 3l8 8M11 3l-8 8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                  <label>
                    Base URL
                    <input
                      value={p.baseURL}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
                      onBlur={commitDraft}
                    />
                  </label>
                  <label>
                    API key
                    <input
                      type="password"
                      value={p.apiKey}
                      placeholder="sk-…"
                      onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                      onBlur={commitDraft}
                    />
                  </label>
                  <label>
                    Models (one per line)
                    <textarea
                      rows={3}
                      value={p.models.join('\n')}
                      placeholder={'gpt-4o-mini\ngpt-4o'}
                      onChange={(e) => updateProvider(p.id, { models: e.target.value.split('\n') })}
                      onBlur={commitDraft}
                    />
                  </label>
                </div>
              )}
            </div>
          )
        })}

        <div className="preset-row">
          {PRESETS.map((preset) => (
            <button key={preset.name} className="btn ghost small" onClick={() => addProvider(preset)}>
              + {preset.name}
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}
```

- [ ] **Step 2: Strip providers out of `GeneralTab.tsx`**

In `src/ui/settings/GeneralTab.tsx`:
- Delete the `PRESETS` const (lines 11–20).
- Delete `updateProvider`, `addProvider`, `removeProvider` (lines 38–62).
- Delete the `<h2>Providers</h2>` heading, its `<p className="hint">`, the `draft.providers.map(...)` block, and the `.preset-row` div (lines 93–159).
- Drop `ProviderConfig` from the `../../data/settings` import (it is now unused — `tsc` will flag it).

Leave `ShortcutSection` and `ObservabilitySection` alone; Task 7 restyles them.

- [ ] **Step 3: Wire the tab into `Settings.tsx`**

```tsx
import ProvidersTab from './ProvidersTab'

type TabKey = 'general' | 'providers' | 'permissions' | 'memory' | 'skills' | 'data'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'providers', label: 'Providers' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'memory', label: 'Memory' },
  { key: 'skills', label: 'Skills' },
  { key: 'data', label: 'Data' },
]
```

and in the body, right after the `general` pane:

```tsx
{tab === 'providers' && (
  <ProvidersTab draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
)}
```

The `data` tab arrives in Task 9; until then selecting it renders an empty pane, which is fine mid-plan.

- [ ] **Step 4: Scrollable tab strip + collapsed-card CSS**

In `src/ui/styles.css`, **merge these into** the existing `.settings-tabs` and `.settings-tab` rules — keep their current padding/border declarations, add these:

```css
/* Six tabs do not fit ~400px. Scroll horizontally rather than wrap to two rows
   (which would cost vertical space on every pane), and mask the right edge so the
   overflow is visibly there rather than silently cut off. */
.settings-tabs {
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
}

.settings-tabs::-webkit-scrollbar {
  display: none;
}

.settings-tab {
  white-space: nowrap;
  flex: none;
}
```

Then append the provider-card rules. The existing `.provider-card` rule keeps its border and radius but must **lose any internal padding** — the head and body own their own now:

```css
.provider-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.provider-head:hover {
  background: var(--bg);
}

.provider-card.open .disclosure-chevron {
  transform: rotate(90deg);
}

.provider-name {
  flex: none;
  font-weight: 500;
}

.provider-active {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--pill-bg);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.provider-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--text-muted);
  font-size: 11px;
}

.provider-body {
  padding: 0 12px 12px;
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/ProvidersTab.tsx src/ui/settings/GeneralTab.tsx src/ui/settings/Settings.tsx src/ui/styles.css
git commit -m "feat(settings): providers get their own tab with collapsible cards" -- src/ui/settings/ProvidersTab.tsx src/ui/settings/GeneralTab.tsx src/ui/settings/Settings.tsx src/ui/styles.css
```

---

### Task 7: De-clutter the General tab

**Files:**
- Modify: `src/ui/settings/GeneralTab.tsx`

**Interfaces:**
- Consumes: `Section`, `Disclosure` from `./primitives` (Task 5).

- [ ] **Step 1: Rewrite the main component to use `Section` and cut the prose**

```tsx
import { useEffect, useState } from 'react'
import {
  DEFAULT_SYSTEM_PROMPT,
  observabilityConfig,
  type ObservabilityConfig,
  type Settings,
} from '../../data/settings'
import { testLangfuseConnection } from '../../agent/observability'
import { Disclosure, Section } from './primitives'

/**
 * General tab: system prompt, keyboard shortcut, privacy, observability. Text
 * fields buffer on keystroke (`buffer`) and persist on blur (`commitDraft`);
 * toggles persist immediately (`commit`). Providers live in their own tab.
 */
export default function GeneralTab({
  draft,
  buffer,
  commit,
  commitDraft,
}: {
  draft: Settings
  buffer: (next: Settings) => void
  commit: (next: Settings) => void
  commitDraft: () => void
}) {
  const customPrompt = draft.systemPrompt !== DEFAULT_SYSTEM_PROMPT

  return (
    <div className="settings-tabpane">
      <Section
        title="System prompt"
        action={
          // Only offer the reset when there is something to reset — an
          // always-visible "Reset to default" beside an untouched default is noise.
          customPrompt ? (
            <button
              className="link-btn"
              onClick={() => commit({ ...draft, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
            >
              Reset to default
            </button>
          ) : undefined
        }
      >
        <textarea
          className="system-prompt"
          rows={5}
          value={draft.systemPrompt}
          onChange={(e) => buffer({ ...draft, systemPrompt: e.target.value })}
          onBlur={commitDraft}
        />
      </Section>

      <ShortcutSection />

      <Section title="Privacy">
        <label className="check">
          <input
            type="checkbox"
            checked={draft.fetchLinkPreviews !== false}
            onChange={(e) => commit({ ...draft, fetchLinkPreviews: e.target.checked })}
          />
          Fetch link previews
        </label>
        <p className="hint">Contacts linked sites for their title, description and image.</p>
      </Section>

      <ObservabilitySection draft={draft} buffer={buffer} commit={commit} commitDraft={commitDraft} />
    </div>
  )
}
```

- [ ] **Step 2: Collapse Observability into a `Disclosure`**

Replace the whole `ObservabilitySection`. The controls are unchanged — only the wrapper and the copy change:

```tsx
/**
 * Beta: opt-in Langfuse observability. Collapsed by default — it is beta, niche and
 * six controls deep, and it used to dominate the General tab. The closed summary
 * still reports whether it is on, so folding it away never hides that.
 */
function ObservabilitySection({
  draft,
  buffer,
  commit,
  commitDraft,
}: {
  draft: Settings
  buffer: (next: Settings) => void
  commit: (next: Settings) => void
  commitDraft: () => void
}) {
  const obs = observabilityConfig(draft)
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'err'; message: string }>({
    state: 'idle',
    message: '',
  })

  // Apply an observability patch, either buffering (text) or committing (toggles).
  const patch = (p: Partial<ObservabilityConfig>, persist: (next: Settings) => void) =>
    persist({ ...draft, observability: { ...obs, ...p } })

  const host = obs.host.replace(/^https?:\/\//, '')

  return (
    <Section title="Observability">
      <Disclosure summary="Langfuse tracing (beta)" status={obs.enabled ? `On · ${host}` : 'Off'}>
        <p className="hint">
          Trace every model call — turns, tools, tokens, cost — to your own{' '}
          <a href="https://langfuse.com" target="_blank" rel="noreferrer">
            Langfuse
          </a>{' '}
          project. Nothing leaves the browser until you turn this on.
        </p>
        <div className="switch-row">
          <span className="switch-label">Enable Langfuse observability</span>
          <label className="switch-toggle">
            <input
              type="checkbox"
              checked={obs.enabled}
              onChange={(e) => patch({ enabled: e.target.checked }, commit)}
            />
            <span className="track" />
            <span className="thumb" />
          </label>
        </div>

        {obs.enabled && (
          <div className="obs-panel">
            <label>
              Public key
              <input
                value={obs.publicKey}
                placeholder="pk-lf-…"
                onChange={(e) => patch({ publicKey: e.target.value }, buffer)}
                onBlur={commitDraft}
              />
            </label>
            <label>
              Secret key
              <input
                type="password"
                value={obs.secretKey}
                placeholder="sk-lf-…"
                onChange={(e) => patch({ secretKey: e.target.value }, buffer)}
                onBlur={commitDraft}
              />
            </label>
            <label>
              Host
              <input
                value={obs.host}
                placeholder="https://cloud.langfuse.com"
                onChange={(e) => patch({ host: e.target.value }, buffer)}
                onBlur={commitDraft}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={obs.captureContent}
                onChange={(e) => patch({ captureContent: e.target.checked }, commit)}
              />
              Capture prompt &amp; response content
            </label>
            <label className="check sub">
              <input
                type="checkbox"
                checked={obs.captureScreenshots}
                disabled={!obs.captureContent}
                onChange={(e) => patch({ captureScreenshots: e.target.checked }, commit)}
              />
              Include screenshots (heavy)
            </label>
            <div className="obs-actions">
              <button
                className="btn ghost small"
                disabled={test.state === 'testing' || !obs.publicKey || !obs.secretKey || !obs.host}
                onClick={async () => {
                  setTest({ state: 'testing', message: 'Testing…' })
                  const r = await testLangfuseConnection(obs.host, obs.publicKey, obs.secretKey)
                  setTest({ state: r.ok ? 'ok' : 'err', message: r.message })
                }}
              >
                Test connection
              </button>
              {test.state !== 'idle' && (
                <span
                  className={`obs-status ${test.state === 'ok' ? 'ok' : test.state === 'err' ? 'err' : ''}`}
                >
                  {test.message}
                </span>
              )}
            </div>
          </div>
        )}
      </Disclosure>
    </Section>
  )
}
```

- [ ] **Step 3: Cut the shortcut prose**

Replace `ShortcutSection`'s `<h2>` + three-line hint with a `Section`. The `useEffect` is unchanged:

```tsx
// Chrome owns browser-global shortcuts: an extension can read its current binding
// but cannot set it, so rebinding delegates to Chrome's shortcuts page. We refresh
// on window focus to reflect a change made there without a reload.
function ShortcutSection() {
  const [shortcut, setShortcut] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const refresh = () =>
      chrome.commands
        .getAll()
        .then((cmds) => {
          const c = cmds.find((x) => x.name === 'toggle-panel')
          setShortcut(c?.shortcut ? c.shortcut : null)
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  return (
    <Section
      title="Keyboard shortcut"
      hint="Chrome owns global shortcuts, so rebinding opens its shortcuts page."
    >
      <div className="shortcut-row">
        <span className="shortcut-label">Toggle sidebar</span>
        <kbd className="shortcut-key">{loaded ? shortcut ?? 'Not set' : '…'}</kbd>
        <button
          className="btn ghost small"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          Change ↗
        </button>
      </div>
    </Section>
  )
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/GeneralTab.tsx
git commit -m "refactor(settings): de-clutter General — collapse observability, cut prose" -- src/ui/settings/GeneralTab.tsx
```

---

### Task 8: Permissions accordion + derived status lines

**Files:**
- Modify: `src/ui/settings/PermissionsTab.tsx` (substantial rewrite)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `groupPolicy`, `setGroupPolicy`, `toolPolicy`, `TOOL_CATALOG`, `GROUP_ORDER`, `GROUP_LABELS`, `ToolGroup`, `ToolPolicy` from `../../data/settings` (Task 1); `Section` from `./primitives` (Task 5).

- [ ] **Step 1: Rewrite `PermissionsTab.tsx`**

```tsx
import { useEffect, useState } from 'react'
import {
  TOOL_CATALOG,
  toolPolicy,
  groupPolicy,
  setGroupPolicy,
  GROUP_ORDER,
  GROUP_LABELS,
  type Settings,
  type ToolGroup,
  type ToolPolicy,
} from '../../data/settings'
import {
  BROWSING_CAPABILITIES,
  type BrowsingCapability,
  grantedCapabilities,
  requestCapabilities,
  removeCapabilities,
} from '../../platform/permissions'
import { Section } from './primitives'

const POLICIES: ToolPolicy[] = ['never', 'ask', 'always']
const POLICY_LABELS: Record<ToolPolicy, string> = {
  never: 'Never',
  ask: 'Ask',
  always: 'Always',
}

/**
 * Plain-English state of one tool's gate.
 *
 * Tab visibility and Browsing insights used to *assert* that reads "still ask for
 * permission" — which was simply false whenever that tool's policy was `always`.
 * Rendering the sentence *from* the policy rather than alongside it is the actual
 * fix: the copy cannot drift from the behavior because it is the behavior.
 */
function policySentence(policy: ToolPolicy, noun: string): string {
  if (policy === 'never') return `${noun} are turned off.`
  if (policy === 'always') return `${noun} run without asking.`
  return `${noun} ask for approval each time.`
}

/**
 * Permissions tab: tab visibility, browsing insights, and the tool-permission
 * accordion. Settings-backed controls commit instantly; browsing capabilities are
 * Chrome optional permissions and act on their own (flashing "Saved ✓" via onSaved).
 */
export default function PermissionsTab({
  draft,
  commit,
  onSaved,
}: {
  draft: Settings
  commit: (next: Settings) => void
  onSaved: () => void
}) {
  // Which groups are expanded. Local, never persisted: the matrix opens fully
  // collapsed every time, which is the whole point of the redesign.
  const [openGroups, setOpenGroups] = useState<Set<ToolGroup>>(new Set())

  function toggleGroup(group: ToolGroup) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  /** Open a group and scroll to it — the target of the "Change" links above. */
  function revealGroup(group: ToolGroup) {
    setOpenGroups((prev) => new Set(prev).add(group))
    requestAnimationFrame(() => {
      document.getElementById(`toolgroup-${group}`)?.scrollIntoView({ block: 'center' })
    })
  }

  function setToolPolicy(name: string, policy: ToolPolicy) {
    commit({ ...draft, toolPolicies: { ...draft.toolPolicies, [name]: policy } })
  }

  return (
    <div className="settings-tabpane">
      <Section title="Tab visibility" hint="How much of your browsing the agent may see.">
        <label className={`access-option ${draft.tabAccess === 'active-tab' ? 'chosen' : ''}`}>
          <input
            type="radio"
            name="tabAccessSetting"
            checked={draft.tabAccess === 'active-tab'}
            onChange={() => commit({ ...draft, tabAccess: 'active-tab' })}
          />
          <div>
            <div className="access-title">Only my current tab</div>
            <div className="access-desc">@mentions offer just the tab you're on.</div>
          </div>
        </label>
        <label className={`access-option ${draft.tabAccess === 'all-tabs' ? 'chosen' : ''}`}>
          <input
            type="radio"
            name="tabAccessSetting"
            checked={draft.tabAccess === 'all-tabs'}
            onChange={() => commit({ ...draft, tabAccess: 'all-tabs' })}
          />
          <div>
            <div className="access-title">All open tabs</div>
            <div className="access-desc">The agent can list and read any open tab.</div>
          </div>
        </label>
        <p className="derived-state">
          {policySentence(toolPolicy(draft, 'ReadPage'), 'Page reads')}{' '}
          <button className="link-btn" onClick={() => revealGroup('reading')}>
            Change
          </button>
        </p>
      </Section>

      <BrowsingInsightsSection
        draft={draft}
        onSaved={onSaved}
        onChangePolicy={() => revealGroup('insights')}
      />

      <Section title="Tool permissions">
        <ul className="policy-legend">
          <li>
            <strong>Never</strong> — the agent never sees the tool.
          </li>
          <li>
            <strong>Ask</strong> — approve each call, or allow it for the rest of the chat.
          </li>
          <li>
            <strong>Always</strong> — runs without asking.
          </li>
        </ul>

        {GROUP_ORDER.map((group) => {
          const tools = TOOL_CATALOG.filter((t) => t.group === group)
          if (tools.length === 0) return null
          const current = groupPolicy(draft, group)
          const expanded = openGroups.has(group)
          return (
            <div
              className={`tool-group ${expanded ? 'open' : ''}`}
              id={`toolgroup-${group}`}
              key={group}
            >
              <div className="tool-group-head">
                <button
                  className="tool-group-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group)}
                >
                  <svg className="disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M3 1l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="tool-group-title">{GROUP_LABELS[group]}</span>
                  <span className="tool-group-count">{tools.length}</span>
                </button>
                {current === 'mixed' ? (
                  <button className="mixed-pill" onClick={() => toggleGroup(group)}>
                    Mixed
                  </button>
                ) : (
                  <div className="policy-seg" role="radiogroup" aria-label={GROUP_LABELS[group]}>
                    {POLICIES.map((policy) => (
                      <button
                        key={policy}
                        role="radio"
                        aria-checked={current === policy}
                        className={`policy-opt ${policy} ${current === policy ? 'active' : ''}`}
                        onClick={() => commit(setGroupPolicy(draft, group, policy))}
                      >
                        {POLICY_LABELS[policy]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {expanded && (
                <div className="tool-group-body">
                  {group === 'control' && (
                    <p className="hint">
                      Form submits, cross-site navigation and password fields always confirm — even
                      on Always.
                    </p>
                  )}
                  {tools.map((t) => {
                    const toolCurrent = toolPolicy(draft, t.name)
                    return (
                      <div className="tool-row" key={t.name}>
                        <span className="tool-label">{t.label}</span>
                        <div className="policy-seg" role="radiogroup" aria-label={t.label}>
                          {POLICIES.map((policy) => (
                            <button
                              key={policy}
                              role="radio"
                              aria-checked={toolCurrent === policy}
                              className={`policy-opt ${policy} ${toolCurrent === policy ? 'active' : ''}`}
                              onClick={() => setToolPolicy(t.name, policy)}
                            >
                              {POLICY_LABELS[policy]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </Section>
    </div>
  )
}

// Browsing-data capabilities are Chrome optional permissions, not part of Settings
// — so this section acts immediately (grant/revoke on toggle), not on commit, and
// reads its state live from chrome.permissions. It stays in sync when the user
// grants/revokes elsewhere (e.g. chrome://extensions).
const CAPABILITY_LABELS: Record<BrowsingCapability, string> = {
  history: 'Browsing history',
  bookmarks: 'Bookmarks',
  topSites: 'Top sites',
  downloads: 'Downloads',
}

function BrowsingInsightsSection({
  draft,
  onSaved,
  onChangePolicy,
}: {
  draft: Settings
  onSaved: () => void
  onChangePolicy: () => void
}) {
  const [granted, setGranted] = useState<Set<BrowsingCapability>>(new Set())

  useEffect(() => {
    const refresh = () => grantedCapabilities().then(setGranted).catch(() => {})
    refresh()
    chrome.permissions.onAdded.addListener(refresh)
    chrome.permissions.onRemoved.addListener(refresh)
    return () => {
      // @types/chrome 0.0.280 omits removeListener from these permission events,
      // though Chrome provides it at runtime.
      type PermEvent = { removeListener(cb: () => void): void }
      ;(chrome.permissions.onAdded as unknown as PermEvent).removeListener(refresh)
      ;(chrome.permissions.onRemoved as unknown as PermEvent).removeListener(refresh)
    }
  }, [])

  // request/remove must be called from this click handler (the user gesture). We
  // re-read afterward so a denied prompt reverts the checkbox from state.
  async function toggle(caps: BrowsingCapability[], on: boolean) {
    if (on) await requestCapabilities(caps)
    else await removeCapabilities(caps)
    setGranted(await grantedCapabilities())
    onSaved()
  }

  const allOn = BROWSING_CAPABILITIES.every((c) => granted.has(c))
  const missing = BROWSING_CAPABILITIES.filter((c) => !granted.has(c))

  return (
    <Section
      title="Browsing insights"
      hint="Let the agent look up your history, bookmarks, top sites and downloads."
    >
      <label className="toggle-row master">
        <div className="access-title">Enable all browsing insights</div>
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) =>
            void toggle(e.target.checked ? missing : BROWSING_CAPABILITIES, e.target.checked)
          }
        />
      </label>
      {BROWSING_CAPABILITIES.map((cap) => (
        <label className="toggle-row" key={cap}>
          <div className="access-desc">{CAPABILITY_LABELS[cap]}</div>
          <input
            type="checkbox"
            checked={granted.has(cap)}
            onChange={(e) => void toggle([cap], e.target.checked)}
          />
        </label>
      ))}
      <p className="derived-state">
        {policySentence(toolPolicy(draft, 'QueryBrowserData'), 'Lookups')}{' '}
        <button className="link-btn" onClick={onChangePolicy}>
          Change
        </button>
      </p>
    </Section>
  )
}
```

- [ ] **Step 2: Add the CSS**

Append to `src/ui/styles.css`. The existing `.tool-group`, `.tool-group-title`, `.tool-row`, `.policy-seg` and `.policy-opt` rules all stay — `.tool-group-title` may need `margin: 0` to sit right inside the new flex head:

```css
/* The sentence under Tab visibility / Browsing insights, rendered from the real
   tool policy rather than asserted next to it. */
.derived-state {
  margin: 10px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.derived-state .link-btn {
  font-size: 12px;
}

.policy-legend {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: 12px;
}

.policy-legend li + li {
  margin-top: 3px;
}

.policy-legend strong {
  color: var(--text);
  font-weight: 600;
}

.tool-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tool-group-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tool-group.open .disclosure-chevron {
  transform: rotate(90deg);
}

.tool-group-count {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--user-bubble);
  color: var(--text-muted);
  font-size: 10px;
  line-height: 15px;
}

/* A group whose tools disagree cannot show one active segment without lying about
   the others, so it shows this instead — and it is a button, because the only
   useful next move is to open the group and look. */
.mixed-pill {
  flex: none;
  padding: 4px 10px;
  border: 1px dashed var(--border);
  border-radius: 999px;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.mixed-pill:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

.tool-group-body {
  padding: 4px 0 8px 16px;
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/PermissionsTab.tsx src/ui/styles.css
git commit -m "feat(settings): group accordion for tool policies; derive permission copy from policy" -- src/ui/settings/PermissionsTab.tsx src/ui/styles.css
```

---

### Task 9: Data tab

**Files:**
- Create: `src/ui/settings/DataTab.tsx`
- Modify: `src/ui/settings/Settings.tsx` (render the tab; thread `onErased`)
- Modify: `src/ui/App.tsx` (reload settings after an erase)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `storageReport`, `clearStore`, `eraseAllData` from `../../data/storage` (Task 4); `formatBytes`, `StorageReport`, `StoreKey` from `../../data/usage` (Task 2); `resetSettingsKeepingProviders` from `../../data/settings` (Task 1); `Section` from `./primitives` (Task 5).
- Produces: `export default function DataTab({ draft, commit, onErased })`.

- [ ] **Step 1: Create `DataTab.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { resetSettingsKeepingProviders, type Settings } from '../../data/settings'
import { clearStore, eraseAllData, storageReport } from '../../data/storage'
import { formatBytes, type StorageReport, type StoreKey } from '../../data/usage'
import { Section } from './primitives'

const ROWS: Array<{ key: StoreKey; label: string }> = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'screenshots', label: 'Screenshots' },
  { key: 'memory', label: 'Memory' },
  { key: 'skills', label: 'Skills' },
  { key: 'research', label: 'Research' },
]

/** What clearing each store actually destroys — revealed once the button is armed. */
const CLEAR_EFFECT: Record<StoreKey, string> = {
  conversations: 'Deletes every chat and its screenshots.',
  screenshots: 'Deletes every captured image.',
  memory: 'Deletes all memories and the episode log.',
  skills: 'Deletes your custom skills. Built-ins are restored.',
  research: 'Deletes all saved reports.',
}

/**
 * Data tab: what the extension is storing, and every way to throw it away.
 *
 * Destructive actions confirm inline and two-step (Clear → Sure?) rather than in a
 * modal: the panel has no modal system, and a dialog at ~400px is worse than the
 * thing it guards. The one exception is the full erase, which takes the user's API
 * keys with it and so demands the word typed out.
 */
export default function DataTab({
  draft,
  commit,
  onErased,
}: {
  draft: Settings
  commit: (next: Settings) => void
  onErased: () => void
}) {
  const [report, setReport] = useState<StorageReport | null>(null)
  // The row whose button is currently armed ("Sure?"), if any.
  const [armed, setArmed] = useState<StoreKey | 'settings' | null>(null)
  const [busy, setBusy] = useState(false)
  const [eraseText, setEraseText] = useState('')

  function refresh() {
    void storageReport()
      .then(setReport)
      .catch(() => setReport(null))
  }
  useEffect(refresh, [])

  // Disarm after a few seconds — an armed destructive button left sitting there is
  // a trap for the next click.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(t)
  }, [armed])

  async function doClear(key: StoreKey) {
    setBusy(true)
    await clearStore(key).catch(() => {})
    setArmed(null)
    setBusy(false)
    refresh()
  }

  async function doErase() {
    setBusy(true)
    await eraseAllData().catch(() => {})
    setBusy(false)
    onErased()
  }

  const pct = report && report.quota ? Math.min(100, (report.total / report.quota) * 100) : null

  return (
    <div className="settings-tabpane">
      <Section title="Data & storage">
        {!report ? (
          <p className="hint">Measuring…</p>
        ) : (
          <>
            <div className="usage-head">
              <span className="usage-total">{formatBytes(report.total)} used</span>
              {report.quota && (
                <span className="usage-quota">of {formatBytes(report.quota)} available</span>
              )}
            </div>
            {pct !== null && (
              <div className="usage-bar">
                {/* A sliver keeps the bar legible when usage rounds to ~0%. */}
                <div className="usage-fill" style={{ width: `${Math.max(pct, 0.5)}%` }} />
              </div>
            )}

            <div className="data-rows">
              {ROWS.map(({ key, label }) => {
                const usage = report.stores[key]
                const isArmed = armed === key
                return (
                  <div className={`data-row ${isArmed ? 'armed' : ''}`} key={key}>
                    <div className="data-row-main">
                      <span className="data-label">{label}</span>
                      <span className="data-detail">{usage.detail ?? `${usage.count} items`}</span>
                    </div>
                    <span className="data-bytes">{formatBytes(usage.bytes)}</span>
                    <button
                      className={`btn small ${isArmed ? 'danger-solid' : 'ghost'}`}
                      disabled={busy || usage.count === 0}
                      onClick={() => (isArmed ? void doClear(key) : setArmed(key))}
                    >
                      {isArmed ? 'Sure?' : 'Clear'}
                    </button>
                    {isArmed && <p className="data-warn">{CLEAR_EFFECT[key]}</p>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Section>

      <Section title="Danger zone">
        <div className="danger-row">
          <div className="data-row-main">
            <span className="data-label">Reset settings to defaults</span>
            <span className="data-detail">Keeps your chats, memory, skills and API keys.</span>
          </div>
          <button
            className={`btn small ${armed === 'settings' ? 'danger-solid' : 'ghost'}`}
            disabled={busy}
            onClick={() => {
              if (armed === 'settings') {
                commit(resetSettingsKeepingProviders(draft))
                setArmed(null)
              } else {
                setArmed('settings')
              }
            }}
          >
            {armed === 'settings' ? 'Sure?' : 'Reset'}
          </button>
        </div>

        <div className="danger-row">
          <div className="data-row-main">
            <span className="data-label">Erase all data & start over</span>
            <span className="data-detail">
              Everything above, plus your providers and API keys. This cannot be undone.
            </span>
          </div>
        </div>
        <div className="erase-confirm">
          <input
            value={eraseText}
            placeholder="Type erase to confirm"
            aria-label="Type erase to confirm"
            onChange={(e) => setEraseText(e.target.value)}
          />
          <button
            className="btn small danger-solid"
            disabled={busy || eraseText.trim().toLowerCase() !== 'erase'}
            onClick={() => void doErase()}
          >
            Erase
          </button>
        </div>
      </Section>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `Settings.tsx`**

Add the import, add `onErased: () => void` to `SettingsView`'s props, and render the pane:

```tsx
import DataTab from './DataTab'
```

```tsx
{tab === 'data' && <DataTab draft={draft} commit={commit} onErased={onErased} />}
```

- [ ] **Step 3: Handle the erase in `App.tsx`**

`eraseAllData()` has already emptied `chrome.storage.local`, so re-reading settings yields an un-onboarded config and the existing `if (!settings.onboarded)` gate at `App.tsx:99` renders the wizard by itself. Pass this to `<SettingsView>`:

```tsx
onErased={() => {
  setShowSettings(false)
  setConversations([])
  void loadSettings().then(setSettings)
}}
```

- [ ] **Step 4: Add the CSS**

Append to `src/ui/styles.css`:

```css
.usage-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.usage-total {
  font-size: 20px;
  font-weight: 600;
}

.usage-quota {
  color: var(--text-muted);
  font-size: 12px;
}

.usage-bar {
  height: 6px;
  margin: 8px 0 16px;
  border-radius: 999px;
  background: var(--user-bubble);
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.data-row,
.danger-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0;
}

.data-row + .data-row,
.danger-row + .danger-row {
  border-top: 1px solid var(--border);
}

.data-row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.data-label {
  font-size: 13px;
}

.data-detail {
  color: var(--text-muted);
  font-size: 11px;
}

.data-bytes {
  flex: none;
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* The armed row's consequence, spelled out only once the button is hot. */
.data-warn {
  flex-basis: 100%;
  margin: 6px 0 0;
  color: var(--danger);
  font-size: 11px;
}

.btn.danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.erase-confirm {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.erase-confirm input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/DataTab.tsx src/ui/settings/Settings.tsx src/ui/App.tsx src/ui/styles.css
git commit -m "feat(settings): Data tab — storage usage, scoped clears, danger zone" -- src/ui/settings/DataTab.tsx src/ui/settings/Settings.tsx src/ui/App.tsx src/ui/styles.css
```

---

### Task 10: End-to-end verification in Chrome

**Files:** none — this is the acceptance gate.

Most of this codebase is Chrome-coupled and has no test suite, so **this task is the proof the feature works**. Do not skip it, and do not claim the feature works without having done it. Report what you actually observed, including anything that did not work.

- [ ] **Step 1: Build and load**

Run `npm run build`, then `chrome://extensions` → reload the unpacked extension → open the side panel. (The `/verify-extension` skill automates this.)

- [ ] **Step 2: Walk every tab**

- The tab strip scrolls to reveal all six tabs, with the right edge fading rather than hard-cutting.
- **Providers:** existing providers render collapsed, one line each, with the right host and model count, and an **Active** chip on the selected one. Expanding reveals the fields. Adding a preset opens it. Editing a key and blurring still persists ("Saved ✓" flashes). Removing still works.
- **General:** Observability is collapsed, reading `Off`. Enabling it flips the summary to `On · cloud.langfuse.com`. "Reset to default" is absent until you edit the prompt, then it appears.
- **Permissions:** all six groups start collapsed; `Skills` reads **Mixed** on a fresh profile. Setting a group to `Never` flips every tool inside it (expand to confirm). The sentence under Tab visibility changes from "Page reads ask for approval each time" to "Page reads run without asking" when the `reading` group goes to Always. "Change" expands and scrolls to the right group.
- **Data:** the five rows show plausible sizes, Screenshots dominating if any exist; the rows sum to the headline.

- [ ] **Step 3: Exercise a real clear and a real erase**

- Send a message so a conversation exists, then **Clear conversations**: the button arms, fires, the row drops to `0 chats · 0 B`, and the topbar chat list empties.
- Create a custom skill in the Skills Library, then **Clear skills**: the custom one is gone, and the five built-ins are back and enabled.
- On a throwaway profile, type `erase` and confirm the panel drops straight to the Onboarding wizard with no providers.

- [ ] **Step 4: Final gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. Paste the actual output.

- [ ] **Step 5: Commit any fixes verification turned up**

```bash
git add -A src/
git commit -m "fix(settings): <whatever verification actually found>" -- src/
```

---

## Self-Review

**Spec coverage:**
- §1 storage layer → Tasks 2 (pure leaf), 3 (per-store), 4 (aggregator) ✓
- §2 tabs → Task 6 (strip + `providers`), Task 9 (`data`) ✓
- §3 primitives → Task 5 ✓
- §4 General de-clutter → Task 7 ✓
- §5 Providers tab → Task 6 ✓
- §6 Permissions accordion + derived copy → Task 8 ✓
- §7 Data tab + inline confirm + type-to-erase + re-onboard → Task 9 ✓
- §8 testing → Tasks 1, 2 (unit); Task 10 (end-to-end) ✓

**Placeholder scan:** none — every code step carries its full code, every command its expected output.

**Type consistency:** `StoreKey` / `StoreUsage` / `StorageReport` are declared once (Task 2, `usage.ts`) and imported under the same names in Tasks 3, 4 and 9. Store exports follow `clearX` / `xUsage` throughout. `resetSettingsKeepingProviders` is spelled identically in Tasks 1 and 9. `Section` / `Disclosure` are declared in Task 5 and consumed in 6–9.

**Dependency order:** strictly forward. `usage.ts` (2) ← stores (3) ← `storage.ts` (4). No task imports from a later one, and no import cycle exists — the flaw that the first draft of this plan contained, and the reason `usage.ts` exists at all.
