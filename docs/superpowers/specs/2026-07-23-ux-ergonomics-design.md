# UX & Ergonomics Batch — Design Spec

Date: 2026-07-23
Status: Approved for implementation

Four independent user-experience features for Lychee AI (Chrome MV3 side-panel AI agent). Built sub-agent-driven in the `worktree-ux-ergonomics` worktree, then integrated.

## Decisions (locked)

- Conversation search: **title-only**, client-side filter.
- Rename: **inline edit** in the Library row (pencil → input; Enter saves, Esc cancels).
- Context menu: **open panel and send immediately** (no draft step), falling back to prefill only when no provider is configured.
- Draft persistence: **persist across panel close** via `chrome.storage.local`, keyed by conversation id.

---

## Shared contract: the composer-action mailbox

A one-shot mailbox carries a right-click action from the service worker to the side panel, surviving the panel being closed at click time. Lives in `src/platform/composerActions.ts` (created in the base commit so both the SW and panel sides can import it without either editing the other's files).

```ts
export type ComposerAction =
  | { kind: 'selection'; text: string; pageUrl: string; pageTitle?: string }
  | { kind: 'link'; url: string; pageUrl: string }
  | { kind: 'image'; srcUrl: string; pageUrl: string }
  | { kind: 'page'; pageUrl: string; pageTitle?: string }

// chrome.storage.session key + broadcast message type
export const COMPOSER_ACTION_MSG = 'composer-action'
export async function setComposerAction(a: ComposerAction): Promise<void>
export async function drainComposerAction(): Promise<ComposerAction | null> // get + remove (one-shot)
```

Flow: SW `contextMenus.onClicked` → `setComposerAction(a)` → `chrome.sidePanel.open({windowId})` (synchronous, in the gesture) → `chrome.runtime.sendMessage({type: COMPOSER_ACTION_MSG})` (best-effort; ignored if no panel listening yet). Panel drains the mailbox **on mount** and **on receiving `COMPOSER_ACTION_MSG`**, clearing it after handling.

---

## Feature 1 — Library: search + rename + pin

Files: `src/data/conversations.ts`, `src/ui/library/ConversationsList.tsx`.

- **Data model:** add `pinned?: boolean` to `StoredConversation` and `ConversationSummary`. Add `export async function togglePin(id: string): Promise<void>` (uses `mutate`, flips `pinned`). **Critical:** `saveConversation` reconstructs the record field-by-field — add `pinned: existing?.pinned ?? false` there or every transcript save wipes the pin. `listConversations` maps `pinned` through and sorts **pinned-first, then `updatedAt` desc**.
- **UI:** a search `<input>` above the list (title-only substring filter, case-insensitive; `'New chat'` fallback title is searchable). Each row gains a **pin** toggle (filled when pinned) and a **rename** pencil that swaps the title span for an `<input>` — Enter calls `renameConversation` + refresh, Esc reverts, blur cancels. Existing delete stays. `stopPropagation` on all row-action buttons so they don't trigger row-open. Empty-search state: "No conversations match."
- **CSS:** the agent uses semantic classNames (e.g. `library-search`, `library-row-pin`, `library-row-rename`, `library-rename-input`) and lists them in its report; the integrator adds the CSS to `styles.css` (single-owner to avoid a shared-file conflict).

## Feature 2 — Right-click "Ask Lychee about this" (service-worker side)

Files: `src/background.ts`, `public/manifest.json`. Imports the shared `composerActions.ts`.

- **Manifest:** add `"contextMenus"` to `permissions`.
- **SW:** on install, register menu items (parent "Ask Lychee about this" with children, or one item per context) for contexts `selection`, `link`, `image`, `page`. In `onClicked`, build the matching `ComposerAction` from `info` (`selectionText`, `linkUrl`, `srcUrl`, `pageUrl`, `tab.title`), `setComposerAction`, open the panel for `tab.windowId` **synchronously**, then broadcast `COMPOSER_ACTION_MSG`. Reuse the existing `openPanel`/`sidePanel.open` path (must stay synchronous — no await before `open`).

## Feature 3 + 4 + context-menu panel side — Composer

Files: `src/ui/Chat.tsx`, `src/ui/App.tsx` (only if the mailbox drain lives at app scope), new `src/ui/drafts.ts`. Imports the shared `composerActions.ts`.

### 3a. Draft persistence
- New `src/ui/drafts.ts`: `loadDraft(convId): Promise<string>`, `saveDraft(convId, text)` (debounced write to `chrome.storage.local` under `draft:<id>`), `clearDraft(convId)`.
- `Chat.tsx`: on conversation switch, load the draft into `input`; on `input` change, debounced-save; on successful send, `clearDraft`. Must not clobber a context-menu-injected message.

### 3b. Prompt-history recall
- On **ArrowUp** when the composer is empty (or caret at start and no newline yet), recall the current conversation's previous **user** messages, newest first; **ArrowDown** moves toward newest/back to the live draft; **Esc** restores the pre-recall draft. Source: the conversation's existing `messages` (user role) — no new storage. Guard against interfering with `@`/`/` popover navigation (those already use Arrow keys — history recall only fires when no popover is open).

### 3c. `@`-menu discoverability
- Extend `MentionCandidate` with `{kind:'page'}`, `{kind:'selection'}`, `{kind:'screenshot'}`. In `refreshMentionCandidates`, offer them by query prefix (`page`, `selection`, `screenshot`). `selectMention` maps: `page` → set `includeCurrentTab`; `selection` → capture + set `activeSelection`; `screenshot` → trigger `captureRegion` (same path as the camera button). Each inserts/removes a pill consistent with existing mention pills.

### 3d. `/`-menu descriptions
- Render each `SlashCandidate`'s `description` under its name in the slash popover (data already present). Purely presentational.

### 3e. Context-menu handler (panel side)
- On mount and on `COMPOSER_ACTION_MSG`, `drainComposerAction()`. Map the action to a send: `selection` → `"Explain this selection:\n\n<text>"` (with page context); `link` → `"Tell me about this page: <url>"`; `image` → attach the image (fetch `srcUrl` → data URL, via the existing image-attach path) + `"What's in this image?"`; `page` → `includeCurrentTab` + `"Summarize this page."` Then **send immediately** through the normal send path. **Guard:** if settings has no configured provider, prefill the composer instead of sending.

---

## Verification

- `npm run typecheck` clean; `npx vitest run` green (add pure tests where feasible — pinned-sort ordering, draft key helpers, mailbox serialization).
- `npm run build` succeeds.
- Browser pass (`/verify-extension`): right-click each context, ArrowUp recall, draft survives close, pin/rename/search in Library, `@page`/`@selection`/`@screenshot` mentions.

## Non-goals (YAGNI)

Content search, tags/folders, cross-conversation history recall, context-menu draft-vs-send toggle, editing assistant messages. Not in this batch.
