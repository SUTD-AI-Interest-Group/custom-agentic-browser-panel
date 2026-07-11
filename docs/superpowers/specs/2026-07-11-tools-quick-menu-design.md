# Tools quick-access menu — design

## Problem

Tool permissions live in **Settings → Permissions**, behind the settings screen.
Toggling a tool on or off (or checking what the agent is currently allowed to do)
means leaving the chat, opening Settings, finding the tab, and coming back. There
is no in-context way to see the available tools and adjust them while chatting.

## Goal

Add a **tools button** in the composer button row, immediately to the **left** of
the screenshot (camera) button. Clicking it opens a compact popover listing every
agent tool grouped by category, each with a simple on/off switch, so the user can
enable/disable tools and see their permission state without leaving the chat.

This is **quick access**, not a replacement — the full three-state (Never / Ask /
Always) matrix and browsing-insight grants stay in Settings, one click away via a
footer link.

## What already exists (reused, not rebuilt)

- `src/data/settings.ts` — `TOOL_CATALOG` (single source of truth for which tools
  exist and their groups), `ToolPolicy = 'never' | 'ask' | 'always'`,
  `DEFAULT_TOOL_POLICIES`, and `toolPolicy(settings, name)` which resolves
  user override → catalog default → `ask`. Per-tool overrides persist in
  `settings.toolPolicies` (sparse).
- `src/ui/settings/PermissionsTab.tsx` — renders the full Never/Ask/Always matrix.
  Currently owns `GROUP_ORDER` and `GROUP_LABELS` as private constants.
- `src/ui/Chat.tsx` — already receives `settings` and
  `onUpdateSettings(next: Settings)`, and calls `onOpenSettings()`. Commits made
  from the popover use the exact same path as `PermissionsTab`, so the Settings
  matrix and the popover stay in sync automatically.

## Design

### 1. Placement & trigger

- New icon button `.tools-btn` added to `.composer-btns` in `Chat.tsx`,
  positioned **before** `.cam-btn` (so it sits left of the camera).
- Icon: a sliders/tune glyph (signals "adjust"), inline SVG matching the existing
  camera/send button style (`stroke="currentColor"`, 15×15 viewBox).
- The button stays **enabled even when no model is selected** — editing
  permissions is independent of the model (camera/send are disabled without a
  model; the tools button is not).
- Clicking toggles a `toolsOpen` boolean state. `aria-haspopup="menu"` and
  `aria-expanded={toolsOpen}` on the button.

### 2. Popover

- New `.tools-popover` element, rendered as a sibling of `.tools-btn` inside a
  `position: relative` wrapper (`.tools-menu-wrap`) so it anchors to the button.
- Positioned **above** the button: `position: absolute; bottom: 100%`, and
  **right-aligned** (`right: 0`) so it never overflows the panel's right edge.
- Visual language shared with the existing `.mention-popover` (same surface,
  border, shadow, radius).
- `max-height` with `overflow-y: auto` so a long tool list scrolls internally
  instead of running off-screen.
- Contents, top to bottom:
  - A small header row: title "Tools".
  - For each group in `GROUP_ORDER` (Page reading, Page control, Navigation,
    Long-term memory, Browsing insights, Skills), skipping empty groups: a group
    title (`GROUP_LABELS[group]`) followed by one row per tool in that group.
  - Each tool row: tool `label` on the left; an `auto` badge when the tool's
    effective policy is `always`; a toggle switch on the right.
  - Footer link "Open full permissions →" that calls `onOpenSettings()`.

### 3. Toggle semantics (on/off, preserve Always, no downgrade)

The underlying model has three states; this menu presents one on/off control per
tool while never silently downgrading an Always tool.

- **Render** (read-only; never mutates state):
  - `toolPolicy(settings, name) === 'never'` → switch **off**.
  - `=== 'ask'` → switch **on**, no badge.
  - `=== 'always'` → switch **on**, `auto` badge shown.
- **Toggle off** → set `toolPolicies[name] = 'never'` (tool removed from the
  agent's toolset entirely).
- **Toggle on** → **delete** the `toolPolicies[name]` override, so the tool
  reverts to its catalog default via `toolPolicy()`:
  - most tools default to `ask`;
  - the skills tools (`ListAllSkills`, `ReadSkill`) default to `always`, so
    turning them back on restores their natural auto-run rather than forcing
    `ask`.
- Because rendering is pure, a tool the user set to `always` in Settings stays
  `always` (shown on + `auto`) unless they explicitly flip it off. The only path
  that loses a *user-customized* Always is off → on, which resets to the catalog
  default — this is the accepted "newly-enabled defaults to the tool's default"
  behavior.

Commit helper (in `Chat.tsx`), mirroring `PermissionsTab`'s `setPolicy`:

```ts
function toggleTool(name: string, on: boolean) {
  const next = { ...(settings.toolPolicies ?? {}) }
  if (on) delete next[name]        // revert to catalog default (ask, or always for skills)
  else next[name] = 'never'
  onUpdateSettings({ ...settings, toolPolicies: next })
}
```

### 4. Shared group metadata (small in-scope refactor)

`GROUP_ORDER` and `GROUP_LABELS` are currently private to `PermissionsTab.tsx`.
Lift both into `src/data/settings.ts` (next to `TOOL_CATALOG`, the source of truth
for tool grouping) and export them. `PermissionsTab.tsx` imports them instead of
defining its own; the new popover imports the same. No behavior change, single
source of truth.

### 5. Open / close & accessibility

- Opens on button click.
- Closes on: outside click (a `useEffect` document `mousedown` listener guarded by
  the wrapper ref) and `Escape` keydown.
- Toggles are `<input type="checkbox">` switches reusing the existing
  `.toggle-row` checkbox styling from Settings; each has an accessible label
  (the tool's `label`).
- The popover stays open across multiple toggles (it is a multi-select menu, not a
  one-shot picker).

## Edge cases

- **No model selected** — button remains enabled; popover works normally.
- **In-flight turn** — policy changes take effect on the next tool call; no attempt
  to interrupt a running turn.
- **Long tool list** — capped height with internal scroll.
- **Empty group** — skipped (no group with zero tools currently, but guarded).
- **Old installs / new tools** — unaffected; `toolPolicy()` already migrates sparse
  `toolPolicies` cleanly, and delete-on-enable naturally falls back to defaults.

## Out of scope

- Making the `auto` badge interactive (flip ask↔always in place) — Always is set in
  full Settings; the badge here is display-only.
- Browsing-insight Chrome permission grants — those need user-gesture grant flows
  and stay in the Settings Permissions tab.
- Tab-visibility (active-tab / all-tabs) — stays in Settings.

## Files touched

- `src/ui/Chat.tsx` — tools button, popover, `toolsOpen` state, `toggleTool`,
  outside-click/Esc handling.
- `src/data/settings.ts` — export `GROUP_ORDER` and `GROUP_LABELS`.
- `src/ui/settings/PermissionsTab.tsx` — import the shared group metadata.
- `src/ui/styles.css` — `.tools-btn`, `.tools-menu-wrap`, `.tools-popover`, badge,
  and any switch/spacing rules not already covered by `.toggle-row`.

## Verification

No test suite. Verify per `/verify-extension`: `npm run build`, reload the unpacked
extension, open the side panel, then:
1. Confirm the tools button sits left of the camera; popover opens above it.
2. Toggle a tool off → its Settings → Permissions row shows **Never**; toggle on →
   reverts to its default (Ask, or Always for skills, with the `auto` badge).
3. Set a tool to Always in Settings → popover shows it on with `auto`; leaving it
   untouched keeps Always.
4. Outside-click and Esc close the popover; footer link opens Settings.
5. Popover works with no model selected.
