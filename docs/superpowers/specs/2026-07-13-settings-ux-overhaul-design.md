# Settings UI/UX overhaul — design

**Date:** 2026-07-13
**Branch:** `worktree-settings-ux-overhaul`

## Problem

The settings surface has four tabs (General / Permissions / Memory / Skills) and three distinct problems.

**It is cluttered and text-heavy.** `GeneralTab` alone carries the system prompt, the keyboard shortcut, a privacy checkbox, every provider card, *and* the six-control Langfuse observability panel. Each section hand-rolls an `<h2>` plus a multi-line `<p class="hint">`, so prose outweighs controls on every pane.

**The tool-permission matrix is daunting.** Fourteen tools, each a row with a three-button Never/Ask/Always segmented control, all expanded, in a ~400px-wide Chrome side panel.

**The permission copy over-promises — it is not merely unclear, it is false.**

1. `PermissionsTab.tsx:84` — *"Ask shows an approval card each time"*. The card also renders **"Allow this chat"** (`onAllowSession`, `Chat.tsx:1365`), which silences that tool for the remainder of the conversation.
2. `PermissionsTab.tsx:48` — Tab visibility's *"Individual reads still ask for permission"* is false whenever `ReadPage` is set to **Always**.
3. `PermissionsTab.tsx:167` — Browsing insights' *"Each lookup still asks for permission"* is false whenever `QueryBrowserData` is set to **Always**.

Two sections therefore promise a per-action prompt that a third section can silently switch off, and that third section under-describes its own escape hatch.

**There is no way to see or reclaim local storage.** No store exposes a clear-all: `conversations.ts` has only `deleteConversation(id)`, `memory.ts` only `deleteMemory(id)`, `screenshots.ts` only `deleteShotsForConversation()`. Nothing reports usage.

## Goals

- Providers get their own tab.
- A Data tab reports per-store usage and offers scoped clears, a settings reset, and a full erase.
- Every settings pane gets materially less prose.
- Permission copy is derived from behavior so it cannot drift from it.
- The tool matrix collapses from fourteen rows to six.

## Non-goals

- No change to the approval-card *behavior*. "Allow this chat" stays; only the copy is corrected. (Removing it would make long agentic sessions prohibitively click-heavy.)
- No change to the model picker, which already lives in the chat header.
- No redesign of the Memory manager or the Skills Library.

---

## 1. Storage layer

The Data tab must not know how five stores are built. A new `src/data/storage.ts` owns that knowledge and exposes exactly four entry points to the UI:

```ts
export type StoreKey = 'conversations' | 'screenshots' | 'memory' | 'skills' | 'research'

export interface StoreUsage {
  bytes: number
  count: number
  /** Secondary line, e.g. "2 custom" or "9 episodes". */
  detail?: string
}

export interface StorageReport {
  /** Sum of the per-store byte estimates — the rows always add up to this. */
  total: number
  /** Origin quota from navigator.storage.estimate(), or null if unavailable. */
  quota: number | null
  stores: Record<StoreKey, StoreUsage>
}

export async function storageReport(): Promise<StorageReport>
export async function clearStore(key: StoreKey): Promise<void>
export async function resetSettings(): Promise<void>
export async function eraseAllData(): Promise<void>
```

Each store gains the clear/measure export it is missing, kept beside its own data model per the repo's existing convention:

| Store | New export | Notes |
|---|---|---|
| `conversations.ts` | `clearConversations()` | |
| `memory.ts` | `clearMemory()` | Clears **both** the `MEMORIES` and `EPISODES` object stores. |
| `screenshots.ts` | `clearShots()` | Clears **both** the `shots` and `thumbs` object stores. |
| `skills.ts` | `clearCustomSkills()` | Deletes `source === 'user'`, then re-runs `seedBuiltinSkills()` and re-enables built-ins. Cannot simply drop the DB: `deleteSkill` throws on a built-in by design (`skills.ts:272`). |
| `researchTasks.ts` | `clearTasks()` | Lives in `chrome.storage.local`, not IndexedDB. |

### Measuring bytes

`navigator.storage.estimate()` returns an origin-wide figure that *includes* IndexedDB overhead and *excludes* `chrome.storage.local`. Using it as the headline would guarantee the rows never sum to it, which reads as a bug.

So: **the headline is the sum of the rows**, and `estimate()` supplies only the quota ("of ~2 GB available"). Per-row bytes come from a pure helper:

```ts
/** Rough byte size of a stored record: string lengths + fixed widths. */
export function estimateBytes(value: unknown): number
```

It walks the value summing string lengths and number/boolean widths. Screenshots are base64 data-URLs (one char ≈ one byte), which is precisely where accuracy matters — they dominate the total. Being pure, it is unit-tested.

`storageReport()` reads every store once. Record counts are dozens, so a single pass is cheap; the tab shows a skeleton while it resolves.

---

## 2. Tabs

`TabKey` in `Settings.tsx` gains `'providers'` and `'data'`:

**General · Providers · Permissions · Memory · Skills · Data**

Six labels do not fit ~400px, so `.settings-tabs` becomes horizontally scrollable (`overflow-x: auto`, hidden scrollbar) with a soft right-edge mask fade, so the overflow is discoverable rather than invisible. The active tab scrolls itself into view on selection.

---

## 3. Shared primitives

To stop each pane hand-rolling `<h2>` + `<p class="hint">` — the reason the de-cluttering would otherwise be a one-off copy edit that regrows — two small components land in `src/ui/settings/`:

- **`<Section title hint?>`** — a heading with an optional single-line muted hint.
- **`<Disclosure summary status? defaultOpen?>`** — a collapsible block. `status` renders a muted right-aligned state string (e.g. `Off`, `On · cloud.langfuse.com`).

Both are presentational and take children.

---

## 4. General tab

After providers move out, General holds: **System prompt · Keyboard shortcut · Privacy · Observability.**

- **Observability** collapses into a `<Disclosure>`, **closed by default** (it is beta and niche), summarised as `Off` or `On · <host>`. Its four-line Langfuse explainer becomes one line plus a "Learn more ↗" link.
- The **shortcut** explainer drops from three lines to one.
- The system-prompt textarea shrinks from `rows={8}` to `rows={5}`, and **"Reset to default" only renders when the prompt actually differs** from `DEFAULT_SYSTEM_PROMPT`.

---

## 5. Providers tab

The provider cards and the preset row move over unchanged in behavior, then tighten:

- A configured provider **collapses to a single line**: name · host · "3 models" · an **Active** chip when it holds `settings.selected`. Expanding reveals Base URL / API key / Models exactly as today.
- A newly added provider starts **expanded**.
- The privacy hint reduces to one line.

`normalizeSettings` in `Settings.tsx` is untouched — it already keeps `selected` pointed at a real provider+model.

---

## 6. Permissions tab

### Tool permissions — the accordion

Two new **pure** helpers in `settings.ts`, so the grouping logic is testable without Chrome:

```ts
/** The policy shared by every tool in a group, or 'mixed' if they disagree. */
export function groupPolicy(settings: Settings, group: ToolGroup): ToolPolicy | 'mixed'

/** Set every tool in a group to one policy. Returns a new Settings. */
export function setGroupPolicy(settings: Settings, group: ToolGroup, policy: ToolPolicy): Settings
```

The matrix becomes six collapsed group rows. Each shows a chevron, the group label, and either the Never/Ask/Always segmented control (when the group is uniform) or a **Mixed** pill. Clicking a group's segment sets every tool in it. Expanding a group reveals today's per-tool rows, unchanged. Expansion is local component state — always collapsed on open, never persisted.

The *"risky steps still confirm"* caveat moves under **Page control**, the only group where it is true, rather than floating as a global claim.

### Honest, derived status lines

**Tab visibility** and **Browsing insights** keep their controls but lose their false promises. Each gains a status line **computed from the real policy**, not asserted:

- Tab visibility reads `toolPolicy(draft, 'ReadPage')` → `Page reads currently run without asking` / `… ask each time` / `Page reading is off`.
- Browsing insights reads `toolPolicy(draft, 'QueryBrowserData')` → the same three shapes.

Each ends in a **Change** affordance that expands the corresponding group in the matrix below. Because the sentence is rendered *from* the policy, it cannot drift from behavior — which is the actual fix for the misleading copy, not merely rewording it.

The Ask description gains the missing escape hatch: *"Ask — approve each call, or allow it for the rest of the chat."*

---

## 7. Data tab

```
DATA & STORAGE

  4.2 MB used         ▓▓▓▓░░░░░░░░░░░░
  of ~2 GB available

  Conversations   12 chats      1.1 MB [Clear]
  Screenshots     31 images     2.8 MB [Clear]
  Memory          48 + 9 eps    0.2 MB [Clear]
  Skills          6 (2 custom)  0.1 MB [Clear]
  Research        3 reports     0.4 MB [Clear]

  ── Danger zone ────────────────────────────
  Reset settings to defaults        [Reset]
  ⤷ keeps chats, memory, skills
  Erase all data & start over       [Erase]
  ⤷ including your API keys
```

### Semantics

| Action | Effect |
|---|---|
| Clear conversations | All chats **and their screenshots**. |
| Clear screenshots | All shots + thumbs. |
| Clear memory | Memories **and** episodes (the dream history). |
| Clear skills | Custom skills deleted; built-ins restored and re-enabled. |
| Clear research | Saved reports and task history. |
| Reset settings | Prompt, permissions, tab access, shortcuts → defaults. **Keeps providers and API keys**, so a mis-tap cannot lock the user out. |
| Erase all data | All five stores **plus** providers and keys; sets `onboarded: false`. |

### Confirmation

Destructive actions confirm **inline and two-step**: `Clear` flips to a red `Sure?` that reverts after ~4s. The panel has no modal system and modals are miserable at 400px wide.

The single exception is **Erase all data** — it takes the user's API keys with it and is irreversible, so it requires typing `erase` before the button arms.

After an erase, `onboarded: false` means `App.tsx:99` re-renders the onboarding wizard with no further plumbing.

---

## 8. Testing

Two new Vitest files for the genuinely pure logic:

- `src/data/storage.test.ts` — `estimateBytes` over strings, nested records, arrays, data-URLs.
- `src/data/settings.test.ts` — `groupPolicy` (uniform / mixed / defaults-only / unset overrides) and `setGroupPolicy`.

The rest is Chrome-coupled and is verified by `npm run build`, reloading the unpacked extension, and exercising each tab — including a real clear and a real erase.

## Risks

- **`estimateBytes` is an estimate, not a true on-disk figure.** IndexedDB overhead and structured-clone encoding are not modelled. This is acceptable: the number exists to answer *"what is eating my space"* (screenshots, invariably), not to audit the quota. The quota figure is real, from `estimate()`.
- **`clearCustomSkills` re-enabling built-ins is a deliberate choice**, not an oversight: "Clear" should return skills to a known state.
