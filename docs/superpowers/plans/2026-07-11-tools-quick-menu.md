# Tools Quick-Access Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tools button left of the composer's screenshot button that opens a popover listing every agent tool grouped by category, each with an on/off switch, so users can enable/disable tools and see their permission state without leaving the chat.

**Architecture:** A new `.tools-btn` in `Chat.tsx`'s `.composer-btns` toggles a `.tools-popover` anchored above it. The popover renders `TOOL_CATALOG` grouped by the shared `GROUP_ORDER`/`GROUP_LABELS` (lifted from `PermissionsTab.tsx` into `settings.ts`). Each tool's switch reads `toolPolicy(settings, name)` and writes through the existing `onUpdateSettings` path — off → `never`, on → delete the override (reverts to catalog default), so the popover and the Settings matrix stay in sync and Always is never silently downgraded.

**Tech Stack:** React 18, TypeScript (strict), Vite 6, Chrome Extension MV3. No backend, no runtime deps added.

## Global Constraints

- **No test suite exists.** "Verify" steps run `npm run build` (this runs `tsc --noEmit` first, then the Vite build — type errors fail fast) and then a manual browser check: reload the unpacked extension at `chrome://extensions`, open the side panel, exercise the flow. This is the project's standard per `/verify-extension`.
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions.
- **Every agent tool routes through `requestApproval`** — unchanged here; this feature only edits stored policy, it does not add a tool or bypass any gate.
- **Commits go to `main`.** Pathspec-scope every commit to only the files it touches (parallel Claude sessions run on this repo). End each commit message with the trailer:
  `Claude-Session: https://claude.ai/code/session_01QMHvF4WBFA4cvQofrqYB1P`
- **No Co-Authored-By / Generated-with trailers.**

---

### Task 1: Lift shared group metadata into settings.ts

Move `GROUP_ORDER` and `GROUP_LABELS` out of `PermissionsTab.tsx` (where they are private) into `src/data/settings.ts` next to `TOOL_CATALOG`, so both the Permissions tab and the new popover derive grouping from one source. No behavior change.

**Files:**
- Modify: `src/data/settings.ts` (add two exports after `TOOL_CATALOG`, ~line 67)
- Modify: `src/ui/settings/PermissionsTab.tsx:1-33` (remove local defs, import from settings)

**Interfaces:**
- Produces: `export const GROUP_ORDER: ToolGroup[]` and `export const GROUP_LABELS: Record<ToolGroup, string>` from `../data/settings`. Consumed by `PermissionsTab.tsx` (Task 1) and `Chat.tsx` (Task 3).

- [ ] **Step 1: Add the exports to settings.ts**

In `src/data/settings.ts`, immediately after the `TOOL_CATALOG` array (after its closing `]`, before `DEFAULT_TOOL_POLICIES`), add:

```ts
/** Display order of tool groups in the permission matrix and quick menu. */
export const GROUP_ORDER: ToolGroup[] = [
  'reading',
  'control',
  'navigation',
  'memory',
  'insights',
  'skills',
]

/** Human labels for each tool group. */
export const GROUP_LABELS: Record<ToolGroup, string> = {
  reading: 'Page reading',
  control: 'Page control',
  navigation: 'Navigation',
  memory: 'Long-term memory',
  insights: 'Browsing insights',
  skills: 'Skills',
}
```

- [ ] **Step 2: Consume them in PermissionsTab.tsx**

In `src/ui/settings/PermissionsTab.tsx`, replace the import block and the two local constants. Change the settings import (lines 2-8) to add `GROUP_ORDER` and `GROUP_LABELS` and drop the now-unused `ToolGroup`:

```ts
import {
  TOOL_CATALOG,
  toolPolicy,
  GROUP_ORDER,
  GROUP_LABELS,
  type Settings,
  type ToolPolicy,
} from '../../data/settings'
```

Then delete the local `GROUP_ORDER` and `GROUP_LABELS` definitions (the two `const` blocks at lines 17-33). Leave `POLICIES` / `POLICY_LABELS` and everything else untouched.

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: completes with no type errors (exit 0). A failure here means the import path or the dropped `ToolGroup` is wrong — fix before continuing.

- [ ] **Step 4: Verify Permissions tab is unchanged in the browser**

Reload the unpacked extension at `chrome://extensions`, open the side panel → Settings → Permissions. Confirm the "Tool permissions" matrix still renders all groups (Page reading, Page control, Navigation, Long-term memory, Browsing insights, Skills) in the same order with the same labels. No visual change expected.

- [ ] **Step 5: Commit**

```bash
git add src/data/settings.ts src/ui/settings/PermissionsTab.tsx
git commit -m "refactor: export GROUP_ORDER/GROUP_LABELS from settings

Lift the tool-group order and labels out of PermissionsTab into settings.ts
next to TOOL_CATALOG so the upcoming tools quick-menu and the Permissions tab
share one source. No behavior change.

Claude-Session: https://claude.ai/code/session_01QMHvF4WBFA4cvQofrqYB1P"
```

---

### Task 2: Tools button + popover shell (open/close)

Add the button left of the camera and an (almost) empty popover that opens on click and closes on outside-click or Esc. No tool rows yet — this task locks placement and open/close behavior so a reviewer can approve the interaction before the contents land.

**Files:**
- Modify: `src/ui/Chat.tsx` (add state + ref near line 218; add open/close effect; add button+popover wrapper before `.cam-btn` at ~line 1057)
- Modify: `src/ui/styles.css` (add `.tools-menu-wrap`, `.tools-btn`, `.tools-popover`, `.tools-popover-head` after the `.cam-btn` rules, ~line 907)

**Interfaces:**
- Consumes: nothing new.
- Produces: `toolsOpen` state, `toolsMenuRef`, and the `.tools-popover` element that Task 3 fills.

- [ ] **Step 1: Add state and ref**

In `src/ui/Chat.tsx`, alongside the other `useState` hooks in the `Chat` component (near line 218, after `const [dismissedSelection, setDismissedSelection] = useState('')`), add:

```ts
const [toolsOpen, setToolsOpen] = useState(false)
const toolsMenuRef = useRef<HTMLDivElement>(null)
```

- [ ] **Step 2: Add the open/close effect**

In the same component, add a `useEffect` that wires outside-click and Esc while the menu is open. Place it with the other effects (anywhere in the component body, before the `return`):

```ts
// Close the tools menu on outside-click or Esc; only listen while open.
useEffect(() => {
  if (!toolsOpen) return
  function onDown(e: MouseEvent) {
    if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
      setToolsOpen(false)
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') setToolsOpen(false)
  }
  document.addEventListener('mousedown', onDown)
  document.addEventListener('keydown', onKey)
  return () => {
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey)
  }
}, [toolsOpen])
```

- [ ] **Step 3: Add the button + popover shell before the camera button**

In `src/ui/Chat.tsx`, inside `<div className="composer-btns">` (around line 1056), insert this **before** the existing `<button className="cam-btn" ...>`:

```tsx
<div className="tools-menu-wrap" ref={toolsMenuRef}>
  <button
    className="tools-btn"
    title="Tools & permissions"
    aria-haspopup="menu"
    aria-expanded={toolsOpen}
    onClick={() => setToolsOpen((o) => !o)}
  >
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 5h4.5M11.5 5h2M2.5 11h2M9 11h4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="9" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  </button>
  {toolsOpen && (
    <div className="tools-popover" role="menu">
      <div className="tools-popover-head">Tools</div>
    </div>
  )}
</div>
```

- [ ] **Step 4: Add the CSS**

In `src/ui/styles.css`, after the `.cam-btn:disabled` rule (ends ~line 907, before the `/* ---- Screenshot attachments ---- */` comment), add:

```css
.tools-menu-wrap {
  position: relative;
  display: inline-flex;
}

.tools-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.tools-btn:hover,
.tools-btn[aria-expanded='true'] {
  background: var(--pill-bg);
  color: var(--text);
}

.tools-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 268px;
  max-height: 340px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.1);
  padding: 8px 10px 10px;
  z-index: 20;
}

.tools-popover-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  padding: 2px 2px 4px;
}
```

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: exit 0, no type errors.

- [ ] **Step 6: Verify placement and open/close in the browser**

Reload the unpacked extension, open the side panel. Confirm:
1. A circular tools button sits immediately **left** of the camera button in the composer.
2. Clicking it opens a popover **above** the button showing the "Tools" header, right-aligned so it does not overflow the panel edge.
3. Clicking the button again closes it; clicking outside closes it; pressing Esc closes it.
4. The button is usable even with **no model selected** (unlike the camera/send buttons).

- [ ] **Step 7: Commit**

```bash
git add src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat: tools menu button + popover shell in composer

Circular button left of the camera toggles a popover anchored above it;
closes on outside-click or Esc. Contents land next.

Claude-Session: https://claude.ai/code/session_01QMHvF4WBFA4cvQofrqYB1P"
```

---

### Task 3: Populate popover with grouped tool switches

Fill the popover with every tool grouped by category, each with an on/off switch, an `auto` badge for Always tools, and a footer link to full Settings. Wire the toggle to `onUpdateSettings`.

**Files:**
- Modify: `src/ui/Chat.tsx` (extend the settings import; add `toggleTool`; fill the `.tools-popover`)
- Modify: `src/ui/styles.css` (add `.tools-group`, `.tools-group-title`, `.tools-item`, `.tools-item-label`, `.tools-badge`, `.tools-item input`, `.tools-popover-foot` after the `.tools-popover-head` rule)

**Interfaces:**
- Consumes: `GROUP_ORDER`, `GROUP_LABELS`, `TOOL_CATALOG` from `../data/settings` (Task 1); `toolPolicy` (already imported); `settings`, `onUpdateSettings`, `onOpenSettings` props (already in scope); `toolsOpen`/`setToolsOpen`/`toolsMenuRef` (Task 2).
- Produces: `toggleTool(name: string, on: boolean): void`.

- [ ] **Step 1: Extend the settings import**

In `src/ui/Chat.tsx`, the current import is:

```ts
import { getSelectedProvider, toolPolicy, type Settings } from '../data/settings'
```

Replace it with:

```ts
import {
  getSelectedProvider,
  toolPolicy,
  TOOL_CATALOG,
  GROUP_ORDER,
  GROUP_LABELS,
  type Settings,
} from '../data/settings'
```

- [ ] **Step 2: Add the toggleTool helper**

In `src/ui/Chat.tsx`, inside the `Chat` component (near the other handlers, e.g. after the `capture` function), add:

```ts
// Quick-menu tool switch. Off → 'never' (hidden from the agent). On → delete the
// override so the tool reverts to its catalog default (ask, or always for the
// skills tools), which preserves an Always tool instead of downgrading it to ask.
function toggleTool(name: string, on: boolean) {
  const next = { ...(settings.toolPolicies ?? {}) }
  if (on) delete next[name]
  else next[name] = 'never'
  onUpdateSettings({ ...settings, toolPolicies: next })
}
```

- [ ] **Step 3: Fill the popover**

In `src/ui/Chat.tsx`, replace the popover shell from Task 2:

```tsx
{toolsOpen && (
  <div className="tools-popover" role="menu">
    <div className="tools-popover-head">Tools</div>
  </div>
)}
```

with the populated version:

```tsx
{toolsOpen && (
  <div className="tools-popover" role="menu">
    <div className="tools-popover-head">Tools</div>
    {GROUP_ORDER.map((group) => {
      const tools = TOOL_CATALOG.filter((t) => t.group === group)
      if (tools.length === 0) return null
      return (
        <div className="tools-group" key={group}>
          <div className="tools-group-title">{GROUP_LABELS[group]}</div>
          {tools.map((t) => {
            const policy = toolPolicy(settings, t.name)
            return (
              <label className="tools-item" key={t.name}>
                <span className="tools-item-label">
                  {t.label}
                  {policy === 'always' && <span className="tools-badge">auto</span>}
                </span>
                <input
                  type="checkbox"
                  checked={policy !== 'never'}
                  onChange={(e) => toggleTool(t.name, e.target.checked)}
                />
              </label>
            )
          })}
        </div>
      )
    })}
    <button
      className="tools-popover-foot"
      onClick={() => {
        setToolsOpen(false)
        onOpenSettings()
      }}
    >
      Open full permissions →
    </button>
  </div>
)}
```

- [ ] **Step 4: Add the row/badge/footer CSS**

In `src/ui/styles.css`, after the `.tools-popover-head` rule, add:

```css
.tools-group-title {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
  margin: 10px 2px 2px;
}

.tools-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 2px;
  cursor: pointer;
}

.tools-item + .tools-item {
  border-top: 1px solid var(--border);
}

.tools-item-label {
  font-size: 12.5px;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tools-badge {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-weight: 600;
  color: #16a34a;
  border: 1px solid #16a34a;
  border-radius: 5px;
  padding: 0 4px;
  line-height: 1.6;
}

.tools-item input {
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
  flex: none;
  cursor: pointer;
}

.tools-popover-foot {
  display: block;
  width: 100%;
  text-align: left;
  margin-top: 8px;
  padding: 8px 2px 2px;
  border: none;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tools-popover-foot:hover {
  text-decoration: underline;
}
```

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: exit 0, no type errors.

- [ ] **Step 6: Verify behavior in the browser**

Reload the unpacked extension, open the side panel, open the tools menu, and confirm:
1. All tools appear grouped: Page reading, Page control, Navigation, Long-term memory, Browsing insights, Skills. The skills tools (`List available skills`, `Load a skill`) show an **`auto`** badge (their default is Always).
2. Toggle "Read the current tab" **off** → open Settings → Permissions → its row shows **Never**. Return to the menu; it shows off.
3. Toggle it back **on** → Settings shows **Ask** (reverted to default). Toggle "Load a skill" off then on → Settings shows **Always** again (skills default), and the `auto` badge returns in the menu.
4. In Settings, set "Inspect interactive elements" to **Always** → the menu shows it on with an `auto` badge; leaving it untouched in the menu keeps it Always.
5. The footer "Open full permissions →" closes the menu and opens Settings.
6. Long list scrolls inside the popover (does not run off-screen).

- [ ] **Step 7: Commit**

```bash
git add src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat: tool switches in the composer quick menu

Popover lists every tool grouped by category with an on/off switch, an 'auto'
badge for Always tools, and a footer link to full Settings. Off sets 'never';
on deletes the override so the tool reverts to its catalog default, preserving
Always without a downgrade. Commits through onUpdateSettings so the Settings
matrix stays in sync.

Claude-Session: https://claude.ai/code/session_01QMHvF4WBFA4cvQofrqYB1P"
```

---

## Self-Review

**Spec coverage:**
- Placement left of camera → Task 2 Step 3. ✓
- Enabled with no model → Task 2 (button has no `disabled`), verified Task 2 Step 6.4. ✓
- Popover above button, right-aligned, scrolls → Task 2 Step 4 CSS, verified Task 2/3. ✓
- Grouped by category using shared metadata → Task 1 + Task 3. ✓
- On/off per tool, `auto` badge, render never mutates → Task 3 Step 3. ✓
- Toggle off→never, on→delete override → Task 3 Step 2. ✓
- Footer link to full Settings → Task 3 Step 3. ✓
- Outside-click + Esc close → Task 2 Step 2. ✓
- Shared `GROUP_ORDER`/`GROUP_LABELS` refactor → Task 1. ✓
- Sync with Settings matrix (same `onUpdateSettings` path) → Task 3 Step 2, verified Task 3 Step 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `toggleTool(name: string, on: boolean)` defined and called identically; `GROUP_ORDER`/`GROUP_LABELS`/`TOOL_CATALOG` exported in Task 1 and imported in Task 3; `toolsOpen`/`setToolsOpen`/`toolsMenuRef` created in Task 2 and used in Task 3. ✓

**No-test-suite adaptation:** Each task's "test cycle" is `npm run build` + a concrete manual browser check, per project convention. ✓
