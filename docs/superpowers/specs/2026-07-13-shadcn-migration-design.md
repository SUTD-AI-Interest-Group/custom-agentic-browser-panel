# Migrating Lychee AI's UI to shadcn/ui

**Status:** approved design, not yet planned
**Date:** 2026-07-13

## Why

Adding a `<select>` to Settings shipped it wearing the browser's default chrome next to a pane of
styled inputs. The cause was structural: form controls were styled only by *ancestor-scoped* rules
(`.provider-card input`, `.obs-panel input`, `.erase-confirm input`), each re-declaring the same box,
with no rule for `<select>` at all. A control added to a section nobody had listed fell through to the
UA stylesheet. `fb4b026` fixed that class of bug with a form-control baseline and a `Select` primitive,
but it treats a symptom: the panel has a token layer and *layout* primitives (`Section`, `Disclosure`)
and nothing else. Every control is hand-assembled, and complex widgets (the tools menu, the mention
menu) are hand-rolled on a `useDismissOnOutside` hook with no keyboard or focus handling.

Four goals, all stated as wanted:

1. **Consistency by construction** — new UI cannot render naked.
2. **A component kit** — dialogs, dropdowns, tooltips, tabs, without hand-rolling each.
3. **Accessibility** — keyboard nav, focus traps, ARIA on the complex widgets.
4. **Velocity** — write UI in a familiar idiom.

## What we are buying, honestly

An audit of `styles.css` (3,977 lines, 272 class selectors) by domain:

| slice                                                   | share | shadcn replaces it? |
| ------------------------------------------------------- | ----- | ------------------- |
| agent surfaces (tool cards, approval cards, research)    | 31%   | no                  |
| chat transcript, bubbles, sources, citations             | 15%   | no                  |
| **generic UI (buttons, forms, sections)**                | 15%   | **yes**             |
| tokens / resets                                          | 19%   | port, don't replace |
| app chrome, markdown/KaTeX, composer                     | 17%   | mostly no           |

**shadcn has components for ~15% of this CSS.** Phases 3–5 below re-express working, bespoke product
CSS as Tailwind utilities and buy no components — they buy only a uniform end state. That is the
deliberate cost of a full migration, chosen with the trade-off on the table. The alternative
(adopt shadcn only where it pays, leave the bespoke 85%) was considered and rejected.

## Decisions

| decision                | choice                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| Visual fidelity         | **Preserve the current look exactly.** shadcn is plumbing, not a re-skin.     |
| Token ownership         | **The existing `:root` block stays canonical.** shadcn reads *from* it.       |
| Dark mode               | `@custom-variant dark (@media (prefers-color-scheme: dark))` — no `.dark` class, no provider, no JS. Behaviourally identical to today. |
| Preflight               | **On in Phase 0**, not at the end. Absorb the reset early, with the harness watching. |
| Verification            | **Playwright visual-regression baselines** over a kitchen-sink page, light + dark. |
| Primitive library       | Radix (shadcn default).                                                       |

### Non-goals

- Redesigning anything. A phase that changes a pixel it did not mean to has failed.
- Re-deriving the palette. The two brand reds carry a WCAG proof (see below) and are not to be touched.
- Migrating vendor CSS (KaTeX, highlight.js). Those stylesheets stay as they are.
- A user-facing theme toggle. If one is wanted later, dark mode moves to the `.dark` class then.

## Architecture

### Token bridge

Tailwind v4 themes through CSS variables, so shadcn's semantic tokens are pointed at the existing ones
rather than replacing them:

```css
@theme inline {
  --color-background: var(--bg);
  --color-card: var(--surface);
  --color-foreground: var(--text);
  --color-muted-foreground: var(--text-muted);
  --color-border: var(--border);
  --color-input: var(--border);
  --color-primary: var(--accent);
  --color-primary-foreground: var(--accent-text);
  --color-destructive: var(--danger);
}
```

`:root` and its `prefers-color-scheme` counterpart remain the single source of truth. This is what
preserves the contrast work: `--accent` is `#c9304a` light / `#f2687e` dark because each must clear
WCAG AA (4.5:1) in *two* roles — as text on `--bg` and as a fill under `--accent-text`. The existing
comment records the measurements and the trap (the logo's brighter `#d93a54` fails the text role at
4.3:1). **That comment migrates verbatim.** A migration that collapses the two reds has broken the
product.

The same applies to the other load-bearing comments in `styles.css` — the composer's
shrink-to-ellipsize rule on `.model-select`, the sticky-element handling in stitched screenshots.
These encode *why*, and utilities cannot hold a paragraph. They move to the component source.

### Build

- `@tailwindcss/vite` plugin; Tailwind v4.
- `@/` path alias in `tsconfig.json` + `vite.config.ts` (shadcn requires it; the repo has none today).
- `components.json` with `cssVariables: true`, base Radix.
- shadcn components land in `src/ui/components/ui/`, matching the existing `src/ui/` layering. The
  `cn()` helper goes in `src/ui/lib/utils.ts`.

`styles.css` is imported *after* Tailwind so its explicit rules win over preflight during coexistence,
and shrinks phase by phase until Phase 6 deletes it.

### Verification harness

The panel is Chrome-coupled: `chrome.tabs`, `chrome.storage`, `chrome.sidePanel` do not exist on a bare
page. So the harness does **not** drive the live extension. Instead:

- `kitchen.html` — a dev-only Vite entry rendering every surface from **fixtures** (a fixed transcript,
  a tool-approval card, a research dock, each settings pane, the composer in each state), in light and
  dark, at the panel's real width (~400px). Presentational components take fixture props; anything that
  reaches for `chrome.*` is stubbed at the entry.
- **Excluded from the production build** (`dist/`) so it never ships to the Web Store.
- Playwright screenshots each fixture at a fixed viewport and device scale. `npm run visual:baseline`
  captures; `npm run visual:diff` compares.

Baselines are captured on **today's CSS, before any Tailwind lands**. That snapshot is the contract for
every subsequent phase.

**Honest limit:** the harness proves the *components* did not change. It cannot prove the live panel
still works — `chrome.*` flows (tab reading, approval gates, page control) are outside it. Each phase
therefore also requires a manual pass in the real extension via `/verify-extension`.

## Phases

Each phase is independently shippable. Exit criteria for **every** phase: `npm run build` green,
`npm test` green, **visual diff clean** (or every delta explicitly reviewed and approved), a manual pass
in the loaded extension, and the bundle budget respected.

| #     | phase                                                                                                | slice | buys                            |
| ----- | ---------------------------------------------------------------------------------------------------- | ----- | ------------------------------- |
| **0** | Tailwind v4 + shadcn init, `@/` alias, token bridge, preflight + its fallout, kitchen sink, baselines | —     | the safety net                  |
| **1** | generic UI → `Button`, `Input`, `Select`, `Switch`, `Label`, `Tabs`, `Dialog`; settings panes         | 15%   | the kit                         |
| **2** | app chrome → `DropdownMenu`, `Tabs`, `Sheet`; retires `useDismissOnOutside`                          | 6%    | **accessibility**               |
| **3** | agent surfaces → tool cards, approval cards, research dock + sheet                                    | 31%   | uniformity only                 |
| **4** | transcript + composer                                                                                 | 20%   | uniformity only                 |
| **5** | markdown / KaTeX / hljs wrappers (vendor stylesheets untouched)                                       | 6%    | uniformity only                 |
| **6** | teardown: delete `styles.css`, dead-class sweep, WCAG re-verify, bundle report                        | —     | the end state                   |

Phase 0's preflight fallout is expected to concentrate in markdown (list and heading margins that the
UA stylesheet currently supplies). The harness catches it; Phase 0 does not exit until the diff is clean.

## Risks

- **Bundle.** Today: `sidepanel.js` 637 KB raw / 203 KB gzipped, plus 81 KB CSS. Radix is tree-shakeable
  but not free. Budget: **+40 KB gzipped JS maximum** across the whole migration; CSS should shrink.
  Measured and reported at every phase; blowing the budget stops the migration for a decision.
- **`background-chats` lands first.** It is 2 commits ahead, touches 8 `src/ui` files and adds 152 lines
  to `styles.css`. Rebasing it across this migration would be brutal. It merges to `main` before Phase 1
  begins. (`library-view` and `lychee-branding` are already merged and stale — no conflict.)
- **No UI tests today.** The harness is the mitigation, and it is Phase 0 for that reason. Any phase
  that starts before baselines exist is flying blind.
- **Regression surface is the whole product.** 22 components, every surface. Phases are ordered
  cheapest-and-safest first so the machinery is proven on the 15% before it meets the 31%.

## Rollback

Every phase is a separate commit on `worktree-shadcn-migration`, and each leaves the panel shippable.
A phase that cannot reach a clean visual diff is reverted rather than patched forward — the whole point
of the exercise is that the look does not drift.
