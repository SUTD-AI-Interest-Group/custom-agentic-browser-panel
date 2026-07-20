# GetScreenshot + GetElementScreenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `Screenshot` agent tool with two dedicated, clearly-named tools — `GetScreenshot` (rendered browser viewport, optional full page) and `GetElementScreenshot` (element/region crop) — that work for every model, including text-only ones.

**Architecture:** Both tools are thin wrappers over the existing `capture()` engine in `src/platform/screenshot.ts` (unchanged). The core change is reversing one invariant: instead of deleting the screenshot tool for text-only models, the tools are always present and a pure `planShotDelivery()` decides whether the captured image reaches the model (vision + budget) or is only saved as a user-facing artifact (text-only / budget-spent). The saved artifact already renders inline via `ShotCard` in `Chat.tsx`.

**Tech Stack:** TypeScript (strict), Vercel AI SDK v5 `tool()`, Zod schemas, React 18, Vitest, Chrome MV3 (`chrome.tabs.captureVisibleTab`, `chrome.scripting`).

## Global Constraints

- No semicolons (ASI). Single quotes. 2-space indentation. (Match by hand — no linter.)
- Prefer `interface` for object shapes; `type` for unions/aliases.
- Document exported types/functions with `/** ... */`; explain non-obvious *why* in block comments.
- Every agent tool must route through the `requestApproval` gate before `execute()` proceeds (unchanged security model).
- An image can only reach the model through `imageQueue`; never put image data in a tool's return value (the tool returns a `shotId`; the UI reads the picture from IndexedDB).
- Build gate: `npm run build` runs `tsc --noEmit` first, so type errors fail the build. `npm run typecheck` is the standalone check.
- Work happens in the worktree at `.claude/worktrees/screenshot-tools` (branch `worktree-screenshot-tools`). All paths below are relative to that worktree root. Commit pathspec-scoped (name the files) — this repo has concurrent sessions on `main`.
- No Claude attribution in commit messages (no `Co-Authored-By` / `Generated-with` trailers).

---

## File Structure

- `src/platform/screenshot.ts` — **modify**: add pure `planShotDelivery()` + `ShotDelivery` type (co-located with the other pure planners `planStitch`/`planTiles`). Capture engine otherwise unchanged.
- `src/platform/screenshot.test.ts` — **modify**: add `planShotDelivery` unit tests next to the existing planner tests.
- `src/tools/tools.ts` — **modify**: replace the `Screenshot` tool with a shared `runScreenshot` helper + `GetScreenshot` + `GetElementScreenshot`; remove the `delete tools.Screenshot` gate; update the `visionCapable` doc comment, the `RequestPageControl` cluster, and the `ReadPage(mode:"regions")` copy.
- `src/ui/Chat.tsx` — **modify**: the page-control-session `activeNames` seed, the vision comment, the tool-pill label, and the `ShotCard` render condition — all to the new tool names.
- `src/agent/agent.ts` — **modify**: two doc comments that name `Screenshot`.
- `README.md` — **modify**: tool table row, vision-probe paragraph, file map.
- `CLAUDE.md` — **modify**: the `imageQueue` invariant and the "Screenshots: one artifact for the user" invariant.

---

## Task 1: Pure `planShotDelivery` decision + tests

**Files:**
- Modify: `src/platform/screenshot.ts` (add near the other pure planners, after `planTiles`, ~line 164)
- Test: `src/platform/screenshot.test.ts`

**Interfaces:**
- Produces:
  - `type ShotDelivery = { kind: 'send'; maxTiles: number } | { kind: 'blind' } | { kind: 'budget' }`
  - `function planShotDelivery(visionCapable: boolean, imagesUsed: number, maxImages: number): ShotDelivery`

- [ ] **Step 1: Write the failing test**

Add to `src/platform/screenshot.test.ts` (import `planShotDelivery` — extend the existing import from `./screenshot`):

```ts
import { describe, it, expect } from 'vitest'
import { planShotDelivery } from './screenshot'

describe('planShotDelivery', () => {
  it('text-only model: never sends an image — the shot is saved for the user only', () => {
    // The reversed invariant: a blind model still captures (for the user), but no
    // tiles are queued and the caller must tell it plainly, so it does not loop.
    expect(planShotDelivery(false, 0, 12)).toEqual({ kind: 'blind' })
    expect(planShotDelivery(false, 5, 12)).toEqual({ kind: 'blind' })
  })

  it('vision model with budget left: sends up to the remaining per-turn budget', () => {
    expect(planShotDelivery(true, 0, 12)).toEqual({ kind: 'send', maxTiles: 12 })
    expect(planShotDelivery(true, 10, 12)).toEqual({ kind: 'send', maxTiles: 2 })
  })

  it('vision model, budget spent: saves for the user but sends nothing to the model', () => {
    expect(planShotDelivery(true, 12, 12)).toEqual({ kind: 'budget' })
    expect(planShotDelivery(true, 20, 12)).toEqual({ kind: 'budget' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- screenshot`
Expected: FAIL — `planShotDelivery` is not exported (import error / "is not a function").

- [ ] **Step 3: Implement `planShotDelivery`**

In `src/platform/screenshot.ts`, immediately after the `planTiles` function (after the closing brace near line 164), add:

```ts
/**
 * How a just-captured shot reaches the model, decided BEFORE tiling.
 *
 * `send`   — vision-capable with per-turn image budget left: tile up to `maxTiles`.
 * `blind`  — the model cannot read images: capture is saved for the USER only.
 * `budget` — vision-capable but this turn's image budget is spent: saved, not sent.
 *
 * `blind` and `budget` both send nothing, but they are distinct on purpose: each
 * needs its own model-facing note, or a text-only model sits and retries for an
 * image it will never be handed.
 */
export type ShotDelivery =
  | { kind: 'send'; maxTiles: number }
  | { kind: 'blind' }
  | { kind: 'budget' }

/** Pure delivery decision. Locks the "text-only still captures" invariant. */
export function planShotDelivery(
  visionCapable: boolean,
  imagesUsed: number,
  maxImages: number,
): ShotDelivery {
  if (!visionCapable) return { kind: 'blind' }
  const budget = Math.max(0, maxImages - imagesUsed)
  if (budget === 0) return { kind: 'budget' }
  return { kind: 'send', maxTiles: budget }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- screenshot`
Expected: PASS — all `planShotDelivery` tests green, plus the existing `planStitch`/`planTiles` tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/platform/screenshot.ts src/platform/screenshot.test.ts
git commit -m "feat(screenshot): pure planShotDelivery — route capture by vision + budget" src/platform/screenshot.ts src/platform/screenshot.test.ts
```

---

## Task 2: Replace the `Screenshot` tool with `GetScreenshot` + `GetElementScreenshot`

**Files:**
- Modify: `src/tools/tools.ts` — import (line 11); `visionCapable` param doc (~141-148); the `Screenshot` tool block (253-360); `RequestPageControl` cluster (452, 459); `ReadPage` regions copy (176, 209); the delete-gate block (920-926); the comment at line 130.

**Interfaces:**
- Consumes: `planShotDelivery`, `ShotDelivery` from `../platform/screenshot` (Task 1); existing `capture`, `tileShot`, `ShotError`, `saveShot`, `hostLabel`, `DENIED`, `getActiveTab`, `pageControl`, `requestApproval`, `visionCapable`, `imageQueue`, `conversationId`, `MAX_TILES_PER_CALL`, `MAX_SHOT_IMAGES_PER_TURN`, `shotImagesUsed` (closure `let`).
- Produces: tools `GetScreenshot` and `GetElementScreenshot` in the ToolSet (both discoverable via the auto-derived catalog); no `Screenshot` key remains.

- [ ] **Step 1: Extend the screenshot import**

Change line 11 from:

```ts
import { capture, tileShot, ShotError } from '../platform/screenshot'
```

to:

```ts
import { capture, tileShot, ShotError, planShotDelivery } from '../platform/screenshot'
```

- [ ] **Step 2: Add the shared `runScreenshot` helper**

Immediately after `let shotImagesUsed = 0` (line 171) and before `const tools: ToolSet = {` (line 173), insert:

```ts
  // Both screenshot tools share one capture→save→deliver path. The shot is ALWAYS
  // saved for the user (ShotCard renders it in chat); planShotDelivery then decides
  // whether the image also reaches the model. shotImagesUsed is the shared per-turn
  // image budget across both tools.
  const runScreenshot = async (
    toolName: 'GetScreenshot' | 'GetElementScreenshot',
    spec: { kind: 'viewport' | 'element' | 'fullpage'; region?: number; selector?: string },
    summary: string,
    reason: string,
  ) => {
    const tab = await getActiveTab()
    if (tab?.id === undefined) return { error: 'No active tab found.' }

    // Same exemption as ReadPage's perception modes: inside an open control session
    // the user has already granted sight of this tab, and a card between every click
    // and its verification shot would be unusable.
    const open = pageControl.session()
    const owned = !!open && open.active && open.tabId === tab.id
    if (!owned) {
      const approved = await requestApproval({ toolName, summary, reason })
      if (!approved) return DENIED
    }

    try {
      const { shot, meta } = await capture(tab, spec)
      // Saved for the user regardless of whether the model can afford to look at
      // it — the artifact and the perception are different products.
      const shotId = await saveShot({
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        url: meta.url,
        title: meta.title,
        label: meta.label,
        conversationId,
      })

      const host = hostLabel(meta.url)
      const truncatedNote = meta.truncated
        ? ' The page was taller than the capture limit, so this stops partway down.'
        : ''

      const delivery = planShotDelivery(visionCapable, shotImagesUsed, MAX_SHOT_IMAGES_PER_TURN)

      // Text-only model: the user sees the shot in chat, but the model cannot read
      // images. Say so plainly so it does not loop waiting for an image part.
      if (delivery.kind === 'blind') {
        return {
          ok: true,
          shotId,
          target: spec.kind,
          label: meta.label,
          width: shot.width,
          height: shot.height,
          note: `Captured ${meta.label} on ${host} and showed it to the user in the chat.${truncatedNote} You can't view images, so it was not sent to you — work from the page text if you need its contents.`,
        }
      }

      // Vision-capable but this turn's image budget is spent.
      if (delivery.kind === 'budget') {
        return {
          ok: true,
          shotId,
          target: spec.kind,
          label: meta.label,
          width: shot.width,
          height: shot.height,
          note: `Captured ${meta.label} on ${host} and saved it for the user, but this turn's image budget is spent, so it was not sent to you. Work from the page text instead.`,
        }
      }

      const { tiles, dropped } = await tileShot(shot, Math.min(MAX_TILES_PER_CALL, delivery.maxTiles))
      tiles.forEach((t, i) => {
        const where = tiles.length > 1 ? ` — tile ${i + 1} of ${tiles.length}, top to bottom` : ''
        imageQueue.push({
          dataUrl: t.dataUrl,
          caption: `Screenshot of ${meta.label} on ${host}${where}. This is a photograph of the page: there are no numbered boxes on it.`,
        })
      })
      shotImagesUsed += tiles.length

      // Say what was dropped. A silently truncated capture reads to the model as
      // "I have seen the whole thing", which is how it ends up confidently
      // describing a page section it was never shown.
      const droppedNote = dropped
        ? ` The page was too long to send in full: you are seeing the first ${tiles.length} of ${tiles.length + dropped} sections. Scroll and shoot again if you need the rest.`
        : ''

      return {
        ok: true,
        shotId,
        target: spec.kind,
        label: meta.label,
        width: shot.width,
        height: shot.height,
        images: tiles.length,
        note: `Captured ${meta.label} on ${host}.${truncatedNote}${droppedNote} The image follows.`,
      }
    } catch (err) {
      // A ShotError is an expected, explainable condition (restricted page, tab no
      // longer active, region gone) — hand the model the sentence so it can adapt.
      if (err instanceof ShotError) return { error: err.message }
      return {
        error: `Could not take the screenshot (${err instanceof Error ? err.message : String(err)}).`,
      }
    }
  }
```

- [ ] **Step 3: Replace the `Screenshot` tool block with the two new tools**

Replace the entire `Screenshot: tool({ ... }),` block (lines 253-360, from `Screenshot: tool({` through its closing `}),`) with:

```ts
    GetScreenshot: tool({
      description:
        'LOOK at the active tab as an image — a screenshot of the live rendered browser viewport (the composited page: charts, diagrams, maps, photos, rendered layout, anything whose meaning is visual and would be lost as text). Also use it to check your own work after a ControlPage action: confirm a click landed, or spot a modal, error, or CAPTCHA the element list does not convey. By default it shoots what is on screen; pass fullPage:true to scroll and stitch the whole page (costs several images — prefer the default). The shot is always shown to the user in the chat. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole scrolled page instead of just the visible viewport. Costs several images — prefer the default.'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To read the revenue chart"'),
      }),
      execute: async ({ fullPage, reason }) => {
        const summary = fullPage
          ? 'Take a screenshot of this whole page'
          : 'Take a screenshot of this page'
        return runScreenshot('GetScreenshot', { kind: fullPage ? 'fullpage' : 'viewport' }, summary, reason)
      },
    }),

    GetElementScreenshot: tool({
      description:
        'Screenshot ONE element/region of the active tab as a PNG — a chart, figure, table, image, or card you want to see on its own. Target it with a `region` number from ReadPage(mode:"regions") (preferred) or a CSS `selector`; give one or the other. The crop is always shown to the user in the chat. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        region: z
          .number()
          .optional()
          .describe('The region number from ReadPage(mode:"regions"), e.g. 2 for [r2].'),
        selector: z
          .string()
          .optional()
          .describe('A CSS selector, if you have no region number.'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To read the revenue chart"'),
      }),
      execute: async ({ region, selector, reason }) =>
        runScreenshot(
          'GetElementScreenshot',
          { kind: 'element', region, selector },
          'Take a screenshot of one element on this page',
          reason,
        ),
    }),
```

- [ ] **Step 4: Update the `ReadPage(mode:"regions")` copy to name the new tool**

Line 176 (the `ReadPage` `description`), change the `mode="regions"` sentence:

- From: `each with an [rN] — use to find something worth looking at, then pass its number to Screenshot.`
- To: `each with an [rN] — use to find something worth looking at, then pass its number to GetElementScreenshot.`

Line 209 (`note:` in the regions branch), change:

- From: `note: 'Pass a region number to Screenshot as \`region\` (e.g. region: 2 for [r2]) to look at it.',`
- To: `note: 'Pass a region number to GetElementScreenshot as \`region\` (e.g. region: 2 for [r2]) to look at it.',`

- [ ] **Step 5: Update the `RequestPageControl` control cluster**

Lines 452-459. Change the comment and the `activeNames.add`:

- Line 459: `activeNames.add('Screenshot')` → `activeNames.add('GetScreenshot')`
- Line 452 comment: replace `Screenshot joins it so the model can` with `GetScreenshot joins it so the model can` (and, one line down, keep the rest of the sentence about checking its own work).

- [ ] **Step 6: Remove the delete-gate and rewrite the `visionCapable` doc comment**

Delete the block at lines 920-926 entirely:

```ts
  // A blind model must not be handed a camera. Screenshot's entire product is an
  // image; against a text-only endpoint the model would call it, receive a result
  // that promises "the image follows", never see one, and loop. Removing the tool
  // outright (rather than failing at execute) is the same mechanism a "never"
  // policy uses, so it is absent from the catalog and ToolSearch/GetTool cannot
  // resurrect it.
  if (!visionCapable) delete tools.Screenshot
```

Then rewrite the `visionCapable` parameter doc comment (lines 141-148 — the `/** ... */` above `visionCapable: boolean,`) to:

```ts
  /**
   * Whether the selected model actually reads images (probed + cached by
   * ensureVisionCapability, resolved by the caller before this runs). This no
   * longer removes the screenshot tools — they always capture and always save the
   * shot for the user. It only routes whether the image ALSO reaches the model:
   * when false, planShotDelivery returns `blind` and the tool saves the artifact
   * and tells the model plainly it cannot see it (rather than queueing an image
   * part the endpoint would drop and the model would loop waiting for).
   */
  visionCapable: boolean,
```

Also update the comment at line 130 (`// rather than one illegible squashed strip (see planTiles), so one Screenshot call`) — change `one Screenshot call` to `one GetScreenshot call`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors. (In particular, `visionCapable` is still referenced, so no unused-variable error; both new tools are present in the ToolSet and the catalog derives from them automatically.)

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/platform/screenshot.ts
git commit -m "feat(tools): GetScreenshot + GetElementScreenshot, available to text-only models" src/tools/tools.ts
```

---

## Task 3: Render the new tools' shots in the chat UI

**Files:**
- Modify: `src/ui/Chat.tsx` — `activeNames` seed (1214); vision comment (1217-1222); tool-pill label (2407-2410); `ShotCard` render condition (2418-2419).

**Interfaces:**
- Consumes: the tool names `GetScreenshot` / `GetElementScreenshot` and their `output.shotId` / `output.label` (Task 2).

- [ ] **Step 1: Update the page-control-session `activeNames` seed**

Line 1214, inside the `if (openSession && openSession.active)` block:

- From: `activeNames.add('Screenshot')`
- To: `activeNames.add('GetScreenshot')`

- [ ] **Step 2: Rewrite the stale vision comment**

Lines 1217-1222 (the block comment above `const visionCapable = ...`). Replace with:

```ts
    // Does this model actually read images? This no longer removes any tool — the
    // screenshot tools always capture and save the shot for the user. It only
    // decides whether the image ALSO reaches the model (see planShotDelivery).
    // Probed once per provider+model and cached in chrome.storage.local, so this is
    // free after the first turn; a failed probe means "assume blind".
```

- [ ] **Step 3: Update the tool-pill label to match both tools**

Lines 2407-2410, change:

```ts
  else if (part.toolName === 'Screenshot')
    label = output?.error
      ? 'Could not take a screenshot'
      : `Took a screenshot · ${output?.label ?? 'the page'}`
```

to:

```ts
  else if (part.toolName === 'GetScreenshot' || part.toolName === 'GetElementScreenshot')
    label = output?.error
      ? 'Could not take a screenshot'
      : `Took a screenshot · ${output?.label ?? 'the page'}`
```

- [ ] **Step 4: Update the `ShotCard` render condition to match both tools**

Lines 2418-2419, change:

```ts
  const shotId: string | undefined =
    part.toolName === 'Screenshot' && part.state === 'done' && !denied ? output?.shotId : undefined
```

to:

```ts
  const shotId: string | undefined =
    (part.toolName === 'GetScreenshot' || part.toolName === 'GetElementScreenshot') &&
    part.state === 'done' &&
    !denied
      ? output?.shotId
      : undefined
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat(ui): render GetScreenshot/GetElementScreenshot shots; drop stale vision note" src/ui/Chat.tsx
```

---

## Task 4: Update docs (agent.ts comments, README, CLAUDE.md)

**Files:**
- Modify: `src/agent/agent.ts` (comments at lines 99 and 231).
- Modify: `README.md` (lines 106, 148, 278 area).
- Modify: `CLAUDE.md` (the `imageQueue` invariant line 49; the "Screenshots: one artifact for the user" invariant line 51).

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update `src/agent/agent.ts` comments**

Line 99 — in the `QueuedImage` doc comment, the phrase `and \`Screenshot\`'s` (describing the plain-crop captions). Change `Screenshot`'s to `the screenshot tools'`:

- From: `numbered boxes map to the click registry's \`[index]\` values, and \`Screenshot\`'s`
- To: `numbered boxes map to the click registry's \`[index]\` values, and the screenshot tools'`

Line 231 — in the `imageQueue` field doc, the parenthetical list of tools that stash captures:

- From: `"elements"/"regions", RequestPageControl, Screenshot) stash their capture`
- To: `"elements"/"regions", RequestPageControl, GetScreenshot/GetElementScreenshot) stash their capture`

- [ ] **Step 2: Update `README.md`**

Line 106 — the tool table row. Replace the single `Screenshot` row:

- From: `| \`Screenshot\` | Look at the page — viewport, a single element, or a stitched full page |`
- To (two rows):
  ```
  | `GetScreenshot` | Look at the page as an image — the rendered viewport, or `fullPage:true` for a stitched full page |
  | `GetElementScreenshot` | Screenshot one element/region (`[rN]` from ReadPage regions, or a CSS selector) |
  ```

Lines 147-149 — the vision-probe paragraph currently says `Screenshot` is deleted for text-only models. Replace that sentence:

- From (the clause): `The verdict is cached, and \`Screenshot\` is deleted from` ... (the toolset for text-only models).
- To: `The verdict is cached. The screenshot tools are never removed — they always save the shot for the user; the verdict only decides whether the image is also sent to the model.`

(Read the surrounding lines 145-150 and rewrite the sentence to flow; keep it to the same idea.)

Line 278 — the file map row for `src/platform/screenshot.ts` mentions "viewport / element / stitched full page" — no rename needed (the engine keeps its name). Leave line 278 as-is. No other README change.

- [ ] **Step 3: Update `CLAUDE.md` — the `imageQueue` invariant (line 49)**

In the sentence describing the queue mixing captions, replace `Screenshot`'s plain crops and the return-value clause:

- From: `with \`Screenshot\`'s plain crops (no boxes at all)` → To: `with the screenshot tools' plain crops (no boxes at all)`
- From: `(the \`Screenshot\` tool returns a \`shotId\`; the UI reads the picture from IndexedDB)` → To: `(GetScreenshot/GetElementScreenshot return a \`shotId\`; the UI reads the picture from IndexedDB)`

- [ ] **Step 4: Update `CLAUDE.md` — the "Screenshots" invariant (line 51)**

Replace the final sentence of that bullet (the deletion rule) with the new routing rule:

- From: `\`Screenshot\` is **deleted from the ToolSet when the vision probe says the model is text-only** (same mechanism as a \`never\` policy), because a tool whose whole product is an image is worse than absent for a blind model: it will call it, get nothing, and retry.`
- To: `The two screenshot tools — \`GetScreenshot\` (rendered viewport, \`fullPage:true\` for the stitched page) and \`GetElementScreenshot\` (one \`[rN]\`/selector region) — are **always present**: every capture is saved as a user-facing artifact (rendered by \`ShotCard\`). The vision probe no longer deletes them; the pure \`planShotDelivery\` only routes whether the image *also* reaches the model (\`send\`) or the shot is saved for the user alone with a note that stops a blind model looping (\`blind\`/\`budget\`).`

- [ ] **Step 5: Verify docs reference no stale tool name**

Run: `grep -rn "\bScreenshot\b" README.md CLAUDE.md src/agent/agent.ts`
Expected: no remaining reference to a `Screenshot` *tool*. (Matches on the `screenshot.ts` engine filename, the `screenshots.ts` store, or the human camera button are fine — confirm each hit is the engine/store/button, not the removed tool.)

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.ts README.md CLAUDE.md
git commit -m "docs: rename Screenshot tool to GetScreenshot/GetElementScreenshot; update vision-gate invariant" src/agent/agent.ts README.md CLAUDE.md
```

---

## Task 5: Full build + end-to-end verification

**Files:** None (verification only).

**Interfaces:** None.

- [ ] **Step 1: Typecheck, full test suite, production build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass (207 prior + the new `planShotDelivery` tests); `vite build` writes `dist/` with no error.

- [ ] **Step 2: Reload the unpacked extension**

In `chrome://extensions` → Developer mode → reload the extension pointing at this worktree's `dist/` (or Load unpacked → select `dist/`). This is a manual step — the build does not hot-reload.

- [ ] **Step 3: Exercise the vision path (a vision-capable model configured)**

Open the side panel on a content page and confirm each, watching the approval card + the inline `ShotCard`:
1. "take a screenshot of this page" → `GetScreenshot` (viewport) → card renders in chat, model can reference what it sees.
2. `ReadPage(mode:"regions")` then "screenshot [r2]" → `GetElementScreenshot` with `region:2` → element crop renders.
3. "screenshot the whole page" → `GetScreenshot` with `fullPage:true` → stitched strip renders (tiles sent to the model).

- [ ] **Step 4: Exercise the text-only path (the failure from the original report)**

Configure the text-only model from the report (or any model the probe marks text-only). Ask "take a screenshot of the models available". Confirm:
- `GetScreenshot`/`GetElementScreenshot` now appear in `ToolSearch` (not absent).
- The tool runs, the `ShotCard` renders the image **for the user** in chat.
- The model's turn ends cleanly with the "saved for the user; you can't view images" note — it does **not** loop retrying.

- [ ] **Step 5: Report results**

Report the typecheck/test/build output and the outcome of each end-to-end check. If any check fails, stop and investigate before finishing the branch.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Two named tools built on `capture()` → Task 2. Text-only availability + no-loop note → Tasks 1 (decision) + 2 (helper). `fullPage` flag → Task 2 `GetScreenshot`. UI rendering for new names → Task 3. Delete-gate removal + invariant docs → Tasks 2 & 4. Verification incl. text-only path → Task 5. All spec sections map to a task.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; every command has an expected result.
- **Type consistency:** `planShotDelivery(visionCapable, imagesUsed, maxImages): ShotDelivery` defined in Task 1 and consumed with the same signature in Task 2; `ShotDelivery.kind` values `'send' | 'blind' | 'budget'` used consistently; `runScreenshot(toolName, spec, summary, reason)` defined and both call sites match; tool names `GetScreenshot` / `GetElementScreenshot` identical across tools.ts, Chat.tsx, agent.ts, and docs.
