# Agent Skills — Design Spec

**Date:** 2026-07-10
**Status:** Approved design → ready for implementation plan
**Feature:** User-authored "agent skills" for the browser side-panel chat, invoked via `/commands` and auto-loadable by the agent, plus a masonry "Skills Library" UI and a `/create-skill` meta-skill.

---

## 1. Overview & goals

Add **Agent Skills** to the extension: named bundles of procedural instructions (Anthropic-style `SKILL.md`: YAML frontmatter with `name` + `description`, plus a markdown instruction body) that the agent can adopt to perform a class of task well.

Goals:

1. **Author & manage skills** in a visual "Skills Library" (masonry grid), opened from a new archival-box icon in the top bar (left of the settings gear).
2. **Invoke skills two ways** (hybrid, confirmed):
   - **Explicitly** by typing `/skill-name` in the chat composer (deterministic — the app injects that skill's instructions for the turn).
   - **Autonomously** by the agent, via progressive disclosure — a compact catalog of every skill's `name`+`description` sits in the system prompt, and the agent loads a skill's full body on demand with the `ReadSkill` tool.
3. **Let the agent create/refine skills** via an approval-gated `SaveSkill` tool, so `/create-skill` can persist a finished skill after the user approves.
4. **Ship a `/create-skill` meta-skill** encoding skill-authoring best practices, plus 2–3 example skills that double as worked examples.

This is grounded in two research passes (Anthropic Agent Skills spec + Vercel AI SDK v5), summarized in §9.

### Non-goals (v1 / YAGNI)

- **No executable scripts or bundled binary resources.** The extension is client-side with no runtime/filesystem, so Anthropic's Level-3 "scripts/" and "assets/" are out of scope. Skills are single-file (`SKILL.md`) + instruction body only. (Confirmed decision.)
- **No multi-file skill directories** (single-file only, confirmed).
- **No `activeTools`/`prepareStep` per-step gating.** The existing pre-turn `system`/`tools` composition is sufficient; `agent.ts` is unchanged.
- **No cross-device sync / no skill marketplace / no remote import.** Skills live in local IndexedDB. (Local `.md` import/export is in scope; network fetch is not.)

---

## 2. What a "skill" is here

A skill is a single markdown document conceptually equal to `SKILL.md`:

```markdown
---
name: summarizing-pages
description: Summarizes the web page the user is viewing into a tight brief with key points and next actions. Use when the user asks to summarize, TL;DR, digest, or recap the current page or an article.
metadata:
  icon: "📰"
  color: "#3b82f6"
  userInvocable: "true"
  modelInvocable: "true"
---

# Summarizing pages

When the user asks for a summary of what they're viewing:

1. If you don't already have the page content, call `ViewCurrentTab` to read it.
2. Produce: a one-sentence gist, then 3–6 bullet key points, then any action items.
...
```

### Field rules (from the real spec — §9.1)

- `name`: unique slug; lowercase `a-z`, `0-9`, `-`; 1–64 chars; no leading/trailing hyphen; no `--`; must not be or contain the reserved words `anthropic`/`claude`; no XML tags. **This is the invocation name** (`/name`).
- `description`: 1–1024 chars, non-empty; **third person**; states both *what it does* and *when to use it*, ideally with trigger keywords. This is the sole trigger signal for autonomous loading, so it carries real weight.
- `metadata` (optional, spec-compatible string→string map) carries our client extensions:
  - `icon` — an emoji for the Library card (optional; `/create-skill` picks a sensible one).
  - `color` — accent hex (optional; auto-derived from `name` when absent — see §6).
  - `userInvocable` — `"true"`/`"false"` (default true): appears in the `/` menu.
  - `modelInvocable` — `"true"`/`"false"` (default true): included in the always-on catalog for autonomous loading.

### Progressive disclosure (two levels here)

- **Level 1 — catalog (always in context):** `name` + `description` of every `modelInvocable` skill, injected into the system prompt each turn (~100 tokens/skill). Lets the agent know what it *could* load.
- **Level 2 — body (on demand):** the full instruction body enters context only when the skill is invoked via `/` (app injects it) or when the agent calls `ReadSkill` (tool returns it).

---

## 3. Data model & storage

New module `src/data/skills.ts` (a peer of `conversations.ts`/`memory.ts`), backed by a dedicated **IndexedDB** store `skills`.

```ts
export type SkillSource = 'builtin' | 'user'

export interface Skill {
  id: string            // uuid
  name: string          // unique slug; the /invocation name
  description: string
  body: string          // markdown instruction body (no frontmatter)
  source: SkillSource
  userInvocable: boolean
  modelInvocable: boolean
  icon?: string         // emoji
  color?: string        // accent hex; auto-derived from name if undefined
  createdAt: number
  updatedAt: number
}

// Compact form used for the system-prompt catalog & ListAllSkills.
export interface SkillMeta {
  name: string
  description: string
  source: SkillSource
}
```

Store API (all async, IndexedDB):

- `listSkills(): Promise<Skill[]>`
- `getSkill(name: string): Promise<Skill | null>`
- `saveSkill(input: SaveSkillInput): Promise<Skill>` — upsert **by `name`** (create or overwrite body/description/flags/icon). Validates `name`. Refuses to overwrite a `builtin` unless `source: 'builtin'` is passed by the seeder.
- `deleteSkill(name: string): Promise<void>` — refuses to delete `builtin` skills.
- `listSkillMetas(opts?: { modelInvocableOnly?: boolean }): Promise<SkillMeta[]>`
- `seedBuiltinSkills(): Promise<void>` — idempotent: inserts any missing builtin (by name) on first load; leaves user edits to non-builtins alone. Builtins are re-seeded if absent (so "reset to default" = delete + re-seed).

### SKILL.md serialization (no YAML dependency)

Two tiny hand-rolled helpers in `skills.ts`:

- `serializeSkill(skill: Skill): string` — emits frontmatter (`name`, `description`, nested `metadata:` block with `icon`/`color`/`userInvocable`/`modelInvocable`) + `\n\n` + body. Used by **Export .md** and to render a skill for the model.
- `parseSkillMarkdown(md: string): ParsedSkill` — a minimal frontmatter parser: reads the leading `---`…`---` block, supports top-level `key: value` and a single nested `metadata:` block of 2-space-indented `key: value` pairs; everything after the closing `---` is the body. Defensive: missing frontmatter → treat whole text as body with empty name/description (caller validates). Booleans parsed from `"true"`/`"false"`. Used by **Import .md** and `SaveSkill` when given raw markdown.

**Validation** (`validateSkillName`, `validateSkill`): enforce the §2 name rules and description length; return a human-readable error string on failure (surfaced in the editor and returned from `SaveSkill`).

---

## 4. Agent integration

All three tools live in `createAgentTools()` in `src/tools/tools.ts` and route through the existing `requestApproval` gate (invariant preserved).

### 4.1 Tools

| Tool | Input | Returns | Approval |
|---|---|---|---|
| `ListAllSkills` | `{}` | `{ skills: SkillMeta[] }` | **Auto-approved** (benign local read) |
| `ReadSkill` | `{ name: string }` | `{ name, description, body }` or `{ error }` | **Auto-approved** (benign local read) |
| `SaveSkill` | `{ name, description, body, icon?, userInvocable?, modelInvocable? }` | `{ saved: true, name }` or `DENIED`/`{ error }` | **Card shown** (mutates local store) |

- `ReadSkill` is the progressive-disclosure Level-2 loader — the classic "tool that returns instructions" pattern (§9.2). Its returned `body` re-enters the model context as a `tool-result` on the next step of the existing `stopWhen: stepCountIs(10)` loop; **no changes to `runAgentTurn`**.
- `SaveSkill` upserts by name (create + edit). The approval card summary reads e.g. `Save skill "summarizing-pages"`; `reason` shows the model's stated purpose. On name-validation failure it returns `{ error }` (not denial) so the model can fix and retry.

### 4.2 Approval policy for reads

`ReadSkill`/`ListAllSkills` only ever read the user's own local skill store — as benign as `SearchMemory`. They still *call* `requestApproval` inside `execute()` (invariant), but `Chat.tsx`'s `requestApproval` short-circuits a module-level `AUTO_APPROVED_TOOLS = new Set(['ReadSkill','ListAllSkills'])` to `true` (same short-circuit shape as `sessionAllowed`/`turnAllowed`). `SaveSkill` is never in that set. *(This is the one policy call in the design; documented here so it's an intentional decision, not an accident.)*

### 4.3 System-prompt composition (`Chat.tsx` `send()`)

Extend the existing template (`Chat.tsx:486`) with two new blocks, built the same way as `accessNote`/`memoryContext`:

```ts
system: `${settings.systemPrompt}${accessNote}${memoryContext}${skillsCatalog}${activeSkills}`
```

- `skillsCatalog` — Level 1. From `listSkillMetas({ modelInvocableOnly: true })`: a labeled block listing each skill as `- name: description`, prefixed with a short instruction ("These skills are available. When a request matches one, call `ReadSkill` with its name to load its full instructions before proceeding."). Omitted entirely when there are no skills.
- `activeSkills` — Level 2 for **explicitly invoked** skills. When the user's message begins with `/skill-name`, the app looks up that skill and appends a block: ``The user invoked the "name" skill. Follow these instructions for this task:\n\n<body>``. Deterministic — no tool round-trip for explicit invocation.

The base `DEFAULT_SYSTEM_PROMPT` (`settings.ts`) gains a short paragraph explaining skills exist and how the catalog/`ReadSkill` work (mirrors how it already documents tabs & memory).

### 4.4 Step budget

`MAX_STEPS` stays 10. Explicit `/` invocation costs **zero** steps (body injected up front). Autonomous `ReadSkill` costs one step per load — acceptable headroom. (Noted; not changed in v1.)

---

## 5. Composer `/` slash menu (mirrors the `@` popover)

New composer affordance in `Chat.tsx`, structurally parallel to the existing mention system (`detectMention`/`refreshMentionCandidates`/`selectMention`/popover/key handling).

- **Detection** `detectSlash(value, caret)`: active only while the caret is still inside a leading command token — i.e. `value.slice(0, caret)` matches `/^\/([a-z0-9-]*)$/`. `query` = the captured group. Typing a space (start of arguments) closes the popover; the `/name` token stays as the recorded invocation. `/` mid-message (not at start) is ignored.
- **Candidates** = `userInvocable` skills whose `name`/`description` match `query`, plus a pinned **Create a skill** entry mapping to `/create-skill`, plus a **Browse skills…** entry that opens the Library. Reuses `.mention-popover`/`.mention-item` styling (or a `.slash-popover` variant with a distinct leading glyph).
- **Selection** inserts `/name ` at the start and records the active skill name (like a mention). Arrow/Enter/Tab/Esc identical to mentions.
- **On send**: parse the leading `/name` from trimmed text (`/^\/([a-z0-9-]+)(\s|$)/`). If it resolves to a `userInvocable` skill, mark it active for the turn → its body goes into `activeSkills` (§4.3). The visible user message keeps the text the user typed (`/create-skill build me…`), the trailing text being the arguments. **One skill per message via slash** in v1 (the agent may still `ReadSkill` others autonomously).
- **Empty-state hint** updated: "…or type `/` to run one of your skills."

---

## 6. Skills Library UI (masonry)

### 6.1 Entry point (`App.tsx`)

Add a third `icon-btn` to `topbar-actions`, **left of the settings gear**, with an archival-box icon (a lidded box / archive glyph). It toggles a new `showSkills` boolean, mirroring `showSettings`:

- Both panels overlay the always-mounted `Chat` (via `view-host is-hidden`), and are mutually exclusive (opening one closes the other), so a chat is never lost.
- The button gets `.active` styling while open, like the gear.

### 6.2 `src/ui/SkillsLibrary.tsx`

A scrollable panel with:

- **Header**: title + a **New skill** button + a one-line tip: "Tip: type `/create-skill` in chat to build one with the agent."
- **Masonry grid** of skill cards via CSS `column-count` (responsive: 1 col in the narrow side panel, 2 where width allows) with `break-inside: avoid` cards — true masonry so variable-length descriptions pack naturally.
- **Skill card**: emoji `icon` in an accent-tinted chip, `name`, `description` (clamped), a source badge (**Built-in** / **Custom**), and hover actions: **Edit** (all) and **Delete** (custom only). Accent `color` = `skill.color` or a deterministic hash of `name` → hue (HSL) so every card looks intentional with zero user effort.
- **Empty/near-empty**: with only builtins present, show a prominent "Create your first skill" CTA alongside them.

### 6.3 Editor (inline in `SkillsLibrary.tsx`, or `SkillEditor.tsx`)

Opened by **New skill**, **Edit**, or clicking a card:

- Fields: `name` (validated live via `validateSkillName`), `description`, `body` (auto-growing `<textarea>`), `icon` (single emoji text input), toggles for `userInvocable`/`modelInvocable`. Color is auto (from name) with an optional override left out of v1 per the "auto color" decision (icon + auto color).
- Actions: **Save** (writes via `saveSkill`; blocks on validation errors with an inline message), **Delete** (custom only, confirm), **Export .md** (`serializeSkill` → download/clipboard), **Import .md** (paste/upload → `parseSkillMarkdown` → prefill the form).
- **Built-ins are read-only**: fields disabled, with a **Duplicate to customize** action that clones into a new `user` skill (name suffixed, e.g. `-copy`) for editing.

### 6.4 Styling (`styles.css`)

New classes reuse existing tokens (`--surface`, `--border`, `--pill-bg`, `--text-muted`, radii 12–14px): `.skills`, `.skills-grid` (`column-count`), `.skill-card` (`break-inside: avoid`), `.skill-icon`, `.skill-badge.builtin`/`.custom`, `.skill-editor`, and a `.slash-popover` (or reuse `.mention-*`).

---

## 7. The `/create-skill` built-in + example seeds

### 7.1 `/create-skill` (builtin, `modelInvocable: false`, `userInvocable: true`)

Its **body is the deliverable**: a distilled, best-practice skill-authoring guide derived from Anthropic's `skill-creator` and the authoring docs (§9.1). It instructs the agent to:

1. **Interview** the user briefly about the workflow the skill should capture (the task, the trigger phrases, inputs/outputs, any strict steps).
2. **Draft** a `SKILL.md`, applying the rules it teaches:
   - `description` in **third person**, stating *what + when* with concrete trigger keywords.
   - `name` in **gerund** form (`summarizing-pages`) or an acceptable noun-phrase (`page-summary`), obeying the slug constraints.
   - **Conciseness** ("the context window is a public good" — only add what the model doesn't already know).
   - **Match degrees of freedom to task fragility** (prose heuristics vs. exact step lists).
   - **One skill = one capability**; concrete input/output examples for style-sensitive tasks.
3. **Show** the draft and iterate with the user.
4. **Persist** by calling `SaveSkill` (→ approval card). Confirm and point the user to the Library.

Set `modelInvocable: false` so the agent doesn't spontaneously try to author skills; it's a user-triggered action (mirrors Claude Code's `disable-model-invocation` for side-effectful commands).

### 7.2 Example seeds (2–3, all `source: 'builtin'`, editable-by-duplication, both `Invocable` true)

Chosen to be genuinely useful for this browser agent *and* exemplary SKILL.md structure:

1. **`summarizing-pages`** — summarize the current page (uses `ViewCurrentTab`).
2. **`extracting-tables`** — pull tabular/structured data from the current page into clean Markdown/CSV (uses `ViewCurrentTab`).
3. **`drafting-replies`** — draft a reply to the email/comment/thread on the current page, matching the user's tone (uses `ViewCurrentTab`).

Each is short (well under 500 lines), demonstrates a strong `description`, and references the app's real tools by exact name.

---

## 8. File-by-file change map

**New files**

- `src/data/skills.ts` — `Skill`/`SkillMeta` types, IndexedDB store CRUD, `listSkillMetas`, `serializeSkill`/`parseSkillMarkdown`, `validateSkill*`, `seedBuiltinSkills`.
- `src/data/builtinSkills.ts` — the `/create-skill` body + the 3 example seeds as `Skill` literals.
- `src/ui/SkillsLibrary.tsx` — the masonry panel + inline editor (may split `SkillEditor.tsx`).

**Edited files**

- `src/tools/tools.ts` — add `ListAllSkills`, `ReadSkill`, `SaveSkill` to `createAgentTools()`; no other tools change.
- `src/ui/Chat.tsx` — `/` slash menu (detect/candidates/select/keys/popover), skill activation on send, `skillsCatalog`+`activeSkills` in `system`, `AUTO_APPROVED_TOOLS` short-circuit in `requestApproval`, new `ToolPill` labels for the three tools, updated empty-state hint.
- `src/ui/App.tsx` — archival-box `icon-btn` + `showSkills` overlay (mutually exclusive with `showSettings`); call `seedBuiltinSkills()` once on load (the single seeding site).
- `src/ui/styles.css` — masonry grid, skill card, badges, slash popover.
- `src/data/settings.ts` — extend `DEFAULT_SYSTEM_PROMPT` with a short "Skills" paragraph.
- `README.md` — document the Skills feature and update the architecture map (housekeeping).

---

## 9. Research grounding (primary sources)

### 9.1 Anthropic Agent Skills

- `SKILL.md` = YAML frontmatter + markdown body. **Required:** `name` (≤64, lowercase slug, no `anthropic`/`claude`), `description` (≤1024, third person, what+when). **Optional:** `license`, `compatibility`, `metadata` (string→string), `allowed-tools` (experimental).
- **Progressive disclosure** (3 levels): metadata always loaded → body on trigger (<~5k tokens) → resources/scripts on demand. The `description` is the sole trigger.
- **Authoring best practices**: third-person descriptions with keywords; gerund naming; conciseness ("context window is a public good"); match degrees of freedom to fragility; one skill = one capability (<500 lines); concrete examples; evaluation-driven iteration. Anthropic's `skill-creator` operationalizes this — the model for our `/create-skill`.
- **Claude Code** merged slash-commands and skills: a skill is invocable both by the user (`/name`) and the model, narrowed by `disable-model-invocation` / `user-invocable`. This maps onto our `userInvocable`/`modelInvocable`.
- Sources: platform.claude.com Agent Skills overview & best-practices; agentskills.io spec; Anthropic engineering blog "Equipping agents for the real world with Agent Skills"; code.claude.com/docs/en/skills; github.com/anthropics/skills.

### 9.2 Vercel AI SDK v5 (verified against installed `ai@5.0.210`)

- **No first-class skills primitive.** Build it with a dynamic `system` string + a tool that returns markdown — the pattern the codebase already uses.
- `streamText`'s `system` is a plain `string`; compose per turn (already done in `Chat.tsx:486`).
- **Conditional tools**: build a different `ToolSet` per call (already done: `delete tools.ViewOpenedTabs`). `activeTools` and `prepareStep` exist in v5 but aren't needed for v1.
- **Tool-returns-instructions**: `execute()`'s return becomes a `tool-result` that re-enters context on the next step of the `stopWhen: stepCountIs(n)` loop — **`runAgentTurn` needs no changes**.
- The AI SDK cookbook "Add Skills to Your Agent" confirms the `loadSkill` tool + `buildSkillsPrompt` catalog pattern this design uses.

---

## 10. Testing & verification

No test suite exists; verification is manual via the `/verify-extension` skill (`npm run build` → reload unpacked → exercise the flow). Acceptance checks:

1. **Build/typecheck** clean (`npm run build`).
2. **Library**: archival-box icon opens the masonry panel; `/create-skill` + 3 examples render as cards with icons/accents/badges; New/Edit/Delete/Import/Export work; built-ins are read-only + duplicable.
3. **Slash invocation**: typing `/` opens the picker; selecting a skill inserts `/name`; sending makes the agent follow that skill's instructions (visible in the reply/behavior).
4. **Autonomous loading**: with no slash, a request that matches a skill's `description` prompts the agent to call `ReadSkill` (auto-approved, shown as a tool pill) and follow it.
5. **`/create-skill` round-trip**: invoking it, describing a workflow, and approving `SaveSkill` creates a new custom skill that then appears in the Library and is invocable via `/`.
6. **Approval policy**: `SaveSkill` shows the permission card; `ReadSkill`/`ListAllSkills` do not.

---

## 11. Open questions

None blocking. Deferred (future): per-skill color override UI, multi-file/resource skills, remote import/marketplace, per-step `activeTools` gating, allowing multiple slash skills per message.
