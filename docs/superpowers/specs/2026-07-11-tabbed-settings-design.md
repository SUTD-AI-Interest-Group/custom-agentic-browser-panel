# Tabbed Settings — Design

Date: 2026-07-11
Status: Approved, in implementation

## Goal

Replace the single-scroll `Settings.tsx` with a four-tab settings surface, and add two
net-new capabilities along the way:

- **General** — System prompt, Keyboard shortcut, Providers
- **Permissions** — Tab visibility, Browsing insights, **Tool permissions (Never / Ask / Always)** *(new)*
- **Memory** — the existing `MemoryView`, lifted out of today's collapsed `<details>`
- **Skills** — a per-skill **enable/disable** toggle list *(new)* + a link to the full Skills Library

## Decisions (locked with the user)

1. **Skills tab** = lightweight enable/disable toggle list, plus a "Manage in Skills Library →"
   link that opens the existing standalone Library (unchanged) for create/edit.
2. **Tool permissions** = one Never/Ask/Always control **per individual tool** (~16 rows),
   visually grouped under subheadings for scanability.
   - **Never** = the tool is removed from the agent's toolset entirely (same mechanism as how
     tab-visibility and browsing-insights already hide tools) — the model never sees it.
   - **Ask** = today's per-call approval card.
   - **Always** = auto-approved, no card — **except** page-control point-of-no-return steps
     (form submits, cross-origin nav, passwords/payments), which still confirm every time.
3. **Save model** = apply instantly. No Save button. A subtle "Saved ✓" pulse confirms each
   commit. Browsing insights remain immediate (Chrome optional permissions, unchanged).

## Structure

New `src/ui/settings/` directory:

```
settings/Settings.tsx     — shell: tab bar + "Saved ✓" pulse + close X; routes to a tab
settings/GeneralTab.tsx   — System prompt, Keyboard shortcut, Providers
settings/PermissionsTab.tsx — Tab visibility, Browsing insights, Tool-permission matrix
settings/MemoryTab.tsx    — renders <MemoryView/>
settings/SkillsTab.tsx    — enable/disable list + "Manage in Skills Library →"
```

`ShortcutSection` and `BrowsingInsightsSection` move out of the old `Settings.tsx` (into
General and Permissions respectively). The old `src/ui/Settings.tsx` is deleted.

## Instant-save model

`SettingsView` receives `{ settings, onChange, onOpenSkills, onClose }`. `onChange` is App's
existing `updateSettings` (`setSettings` + `saveSettings`) — it no longer closes the panel.

`SettingsView` keeps a local mirror of `settings` for responsive typing:

- **Toggles / radios / policy cells / skill switches** → commit immediately on change.
- **Text fields** (system prompt, provider name/URL/key/models) → update local state per
  keystroke, commit on **blur** (avoids a `chrome.storage` write per keystroke).
- The provider normalization from today's `save()` (trim/drop empty model lines, keep
  `selected` valid, auto-select first model) moves into the commit path.
- Each commit flashes "Saved ✓" in the tab bar.

## Data-model changes

### `src/data/settings.ts`

```ts
export type ToolPolicy = 'never' | 'ask' | 'always'
// Settings gains:
toolPolicies?: Record<string, ToolPolicy>   // optional → old installs migrate cleanly
```

- `DEFAULT_TOOL_POLICIES`: every tool → `'ask'`, except `ReadSkill` & `ListAllSkills` →
  `'always'`. This **replaces** the hardcoded `AUTO_APPROVED_TOOLS` set in `Chat.tsx`, making
  those defaults visible and overridable in the UI.
- Helper `toolPolicy(settings, name): ToolPolicy` = stored ?? default ?? `'ask'`.
- A `TOOL_CATALOG` list (name + group + label) drives both the matrix UI and the default map,
  so the tool list has a single source of truth.

### `src/data/skills.ts`

```ts
// Skill gains:
enabled: boolean   // default true; a missing value is treated as true (migration)
```

- New `setSkillEnabled(name, enabled)` — a direct record `put` that **bypasses the
  built-in-overwrite guard** (toggling a built-in's `enabled` is a user preference, not an edit).
- `listSkillMetas` excludes `enabled === false` (so disabled skills leave the agent catalog).
- `saveSkill` defaults `enabled` to `true` for new records and preserves it on upsert.
- `builtinSkills.ts` seeding relies on the `true` default (no per-skill change needed).

## Tool-permission wiring

- **`createAgentTools`** gains a `policyFor: (name: string) => ToolPolicy` (or the resolved
  `Settings`). After the existing `tabAccess` / browsing-permission deletions, it deletes any
  tool whose policy is `'never'`. Composition: a browsing tool is present only if the Chrome
  permission is granted **and** its policy ≠ never.
- **`requestApproval` (`Chat.tsx`)** new precedence:
  1. `request.once` (point-of-no-return) → **always show the card**; skip every auto-approve path.
  2. policy `'always'` → resolve `true` (no card).
  3. `sessionAllowed` / `turnAllowed` ("Allow this chat") → `true`.
  4. else → show the card.
  - The hardcoded `AUTO_APPROVED_TOOLS` set is removed (now expressed as `'always'` defaults).

The matrix renders per-tool rows grouped under: Page reading · Page control · Navigation ·
Memory · Browsing insights · Skills.

## Skills enable wiring

A disabled skill must disappear from every path the agent or user can reach it:

- Composer `/` menu (`Chat.tsx:487`) → add `&& sk.enabled !== false`.
- Direct `/name` invocation (`Chat.tsx:555`) → add `&& invokedSkill.enabled !== false`.
- Agent catalog → handled centrally by `listSkillMetas` filter.
- `ReadSkill` (`tools.ts`) → guard: a disabled skill returns a "skill is disabled" error.

`SkillsTab` lists all skills (built-in + custom) with a switch per skill calling
`setSkillEnabled`, plus a "Manage in Skills Library →" link wired to `onOpenSkills` (App sets
`showSkills` and clears `showSettings`).

## App wiring

`App.tsx`: `SettingsView` props change from `{ settings, onSave }` to
`{ settings, onChange, onOpenSkills, onClose }`. App passes `onChange={updateSettings}`,
`onOpenSkills` (same handler Chat uses), and `onClose={() => setShowSettings(false)}`.

## Verification

No test suite. Run `npm run build`, reload the unpacked extension, then via `/verify-extension`:

- Switch all four tabs; confirm layout and "Saved ✓" pulse.
- Set a tool to **Never** → the agent stops offering it; **Always** → no approval card.
- Confirm a page-control **point-of-no-return** step still confirms under Always.
- Toggle a skill **off** → it vanishes from the `/` menu and the agent catalog; **on** → returns.
- Edit system prompt + a provider, reopen settings → values persisted.
```
