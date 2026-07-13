# Background chats — design

## Problem

Today, switching chats or starting a new chat (`App.openConversation` / `newChat`) remounts the `Chat` component (it's keyed by `conversationId`). The remount tears down all the turn-loop state inside `Chat` — `abortRef`, `runTurnChain`, `pageSessionRef`, `approvalRef`, `historyRef`, message state — so any in-flight agent turn is dropped. The user sees their reply cut off mid-stream and the partial text is silently abandoned (only the last `saveConversation` snapshot, from `turnSeq`, survives). Background research tasks are unaffected because they already run in the SW/offscreen host.

This spec changes the panel so a chat turn keeps running in the background when the user switches away, and the dropdown surfaces which chats are running and which finished in the user's absence.

## Behavior

### Status states (per chat)

Every chat in the panel is in one of three states:

- `idle` — no turn is running, no unseen update.
- `streaming` — a `runTurnChain` is in progress. The chat may or may not be the active (currently mounted) one.
- `updated` — the most recent turn finished while the chat was NOT the active one. Cleared when the user views the chat (mounts it).

A chat that's `streaming` while the user is looking at it shows the existing in-chat indicators (thinking loader, Stop button, streaming reply text). The new indicators (pulse, dot, badge) are only for **other** chats.

### Switching chats

- `App.openConversation(id)` — the active chat changes. If the previous active chat was `streaming`, its turn continues running in the background; its state stays `streaming`. The new active chat renders. If the new chat is in `updated` state, App calls `discardUpdated()` so its dot clears on first render.
- `App.newChat()` — same as above, but the new active chat is a fresh UUID. No state is destroyed.
- The dropdown stays open/closed per the existing UX. No menu state change.

### Dropdown (`.chat-menu`) per item

Each `chat-menu-item` shows the title, the time, and an optional status affordance:

- If the chat's state is `streaming` AND it is not the active chat → the title gets a slow opacity pulse (~1.6s, 1 → 0.55 → 1).
- If the chat's state is `updated` AND it is not the active chat → a small accent-colored dot (6px, `var(--accent)`) sits at the LEFT of the title (a new leading slot in the flex row, before the title text).
- The active chat is shown without either affordance (it has its own in-chat indicators). Existing `.chat-menu-item.active` styling is unchanged.

The affordances are mutually exclusive: `streaming` shows pulse, `updated` shows dot. A chat that was `streaming` and just finished in the background transitions from pulse → dot on the same dropdown row, in place.

### Topbar title

The active chat's topbar title (the button that opens the dropdown) gets a small pulsing badge (~8px, accent color) to the right of the title text, sitting inline with the dropdown chevron, when **any OTHER chat** has state `updated`. The badge pulses (not the title). When all `updated` chats are viewed (state clears), the badge disappears.

The topbar title itself does NOT pulse. Only the badge pulses.

### Soft cap

5 background turns. Going over a 5th is allowed; one warning toast is shown ("N chats are running in the background — your model may slow down") and no further toasts fire while the count stays ≥ 5. No hard cap, no auto-cancel.

### Edge cases

- **Approval card from a non-active chat**: a `runTurnChain` parked on a tool approval in chat B (B not active) leaves state `streaming` and the title pulses. When the user switches to B, Chat renders the existing approval card from `approvalRef` (it was set in the run's state). The dropdown's B row stays `streaming` while the approval is pending. There is NO cross-chat approval UI (no "approve from chat A"); the user must visit B to resolve.
- **Page-control session on a non-active chat**: the session is held in `pageSessionRef` and the on-page presence overlay is mounted (existing `mountPresence` call inside `RequestPageControl`). The tint/overlay stays visible on the web page even if the panel is showing chat A — this is acceptable because the user who started the page-control session is the one who sees the tint. Switching back to B renders the session card. The dropdown's B row stays `streaming`.
- **Panel close / SW restart**: foreground turns abort on panel close (same as today; the run's AbortController fires). On reopen, the runs Map is empty, `listConversations` repopulates the dropdown, and all chats show as `idle`. A turn that was running when the panel closed does NOT auto-resume.
- **`useChatTurn` instances lifetime**: a `ChatRun` is created lazily on the first `send` for a conversation, and lives for the panel's lifetime. The runs Map is destroyed when the panel unmounts. The Map can grow to N = the number of conversations the user has ever sent a message in this session.
- **Send while a background turn is running on the active chat**: today, `send()` is gated by `if (... || streaming || ...) return`. The same gate stays. To send a new message while the active chat is streaming, the user must press Stop first (existing UX). A non-active chat cannot be sent to from the UI; switching to it and sending is the path.
- **Stop on a non-active chat**: there is no UI to stop a turn running in a non-active chat. Stop is in the active chat. If the user wants to stop chat B's turn, they switch to B and press Stop. This is acceptable because B's turn is only ever parked on an approval, which already requires a visit to resolve.
- **Memory / dreaming**: unchanged. The `episodeIdRef` keeps the same conversationId → episode binding; the journal appends per active turn, exactly as today.

## Architecture

### New module: `src/ui/useChatTurn.ts`

A per-conversation turn host. Exposes a `useChatTurn` hook factory and the data shape `ChatRun` it returns. Owns:

- `messages: UIMessage[]`
- `historyRef: ModelMessage[]`
- `abortRef: AbortController | null`
- `pageSessionRef: ControlSession | null`
- `approvalRef: PendingApproval | null`
- `turnSeq: number` (persistence trigger)
- `autoContinuesRef: number`
- `turnAllowed: Set<string>` (per-turn pre-authorized tools)
- `sharedTabsRef: Set<string>` (already-shared tabs for deictic de-dup)
- `episodeIdRef: string` (the dream journal's conversation id)
- `state: 'idle' | 'streaming' | 'updated'`
- `streaming: boolean` (alias of state for the existing render guards)
- `turnStartedAt: number | null`
- `continuation: { checkpoint: Checkpoint | null } | null`
- `requestApproval`, `pageControl` — the `requestApproval` resolves to the run's own approval promise; the approval card is shown in the Chat view via `approvalRef` state.

Public surface:

```ts
interface ChatRun {
  conversationId: string
  state: 'idle' | 'streaming' | 'updated'
  messages: UIMessage[]
  streaming: boolean
  turnStartedAt: number | null
  continuation: { checkpoint: Checkpoint | null } | null
  approval: PendingApproval | null
  sessionPlan: { plan: string; host: string } | null
  send: (text: string, opts: SendOptions) => Promise<void>
  stop: () => void
  continueTask: () => Promise<void>
  settleApproval: (approved: boolean, forSession?: boolean) => void
  discardUpdated: () => void
  setResearchTasks: (tasks: ResearchTask[]) => void
  researchTasks: ResearchTask[]
}
```

The hook returns a `ChatRun`. It is created on first call for a given `conversationId` and cached in the `Map` at the App level.

### App

- Owns `const runsRef = useRef(new Map<string, ChatRun>())` and a `const [runTick, setRunTick] = useState(0)`.
- `getRun(conversationId)` returns the existing run, or creates a new one (lazy, on first send). After any run's `state` changes, the run calls `setRunTick(n => n + 1)` (subscribed via a `subscribe(cb)` method on `ChatRun`). The `runTick` bump re-renders App, so the dropdown and topbar read fresh state.
- Each `ChatRun` exposes `subscribe(cb: () => void): () => void` (an `EventTarget`-style add/remove, returning an unsubscribe). App subscribes on creation and calls `setRunTick` on every event. The run auto-unsubscribes on `discardUpdated` (no, the subscription is just for App's tick bump; runs are alive for the panel's lifetime so the subscription stays for the run's life).
- The `key={conversationId}` on `<Chat>` is REMOVED. Chat is identity-stable across switches.
- `Chat` is given `run={getRun(conversationId)}` as a prop. Everything else (settings, callbacks) is unchanged. Chat re-renders when the run's `runTick` bumps; Chat also re-renders when the App's `runTick` bumps (which is the same event).
- The dropdown iterates `conversations` and reads `run.state` for each via `runsRef.current.get(c.id)?.state ?? 'idle'`. A conversation with no run yet (never sent in) reads as `idle`.

### Chat (per-conversation view)

- Removes: `useState` for `messages`, `streaming`, `turnStartedAt`, `continuation`, `approval`, `sessionPlan`, `turnSeq`. Removes: `useRef` for `historyRef`, `abortRef`, `approvalRef`, `pageSessionRef`, `sharedTabsRef`, `turnAllowed`, `autoContinuesRef`, `episodeIdRef`. Removes: `useEffect` for restore, persist, math-repair ref mirror. Removes: `runTurnChain`, `send`, `stop`, `continueTask`, `settleApproval`, `requestApproval`, `teardownSession`, `repairAssistantMath`.
- Keeps: composer, mention popovers, slash menu, attachment UI, tools menu, research dock, approval card renderer, page-control session card, message rendering, thinking indicator, math-repair spinner, all the local UI state (input, mentions, selection, attachments, capturing state, etc.).
- Reads from `run.messages`, `run.streaming`, `run.turnStartedAt`, `run.continuation`, `run.approval`, `run.sessionPlan` for render.
- Calls `run.send(text, opts)`, `run.stop()`, `run.continueTask()`, `run.settleApproval(...)` for actions.
- Calls `run.discardUpdated()` in a mount effect — but only when the run was `updated` at mount time. App handles the `updated` state externally; Chat just clears it on mount.

### useEffect migration

- **Restore on mount**: stays in `useChatTurn` (it doesn't depend on UI state). The run is created on first call and restores its conversation from IndexedDB exactly once.
- **Persist on turnSeq change**: stays in `useChatTurn`. The Chat no longer triggers it; the run does.
- **Research-tasks effect** (`chrome.storage.onChanged` listener, `listTasks` reload): stays at the App level. App feeds the resulting `ResearchTask[]` into every run via `run.setResearchTasks(tasks)`. Runs are pure of `chrome.storage` subscriptions.
- **DOM listeners** (`chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, window focus, `readSelection` interval, `@all` listener): each Chat has its own, because they're per-mounted-chat (only the active chat needs them). They reset when the active chat switches.

### Files

- New: `src/ui/useChatTurn.ts` — the hook + ChatRun type + the lifted-out `runTurnChain` body.
- New: `src/ui/useChatTurn.test.ts` — Vitest unit tests for the state machine.
- Modified: `src/ui/App.tsx` — runs Map, removed `key={conversationId}`, new status source, topbar badge, dropdown affordances.
- Modified: `src/ui/Chat.tsx` — state lifted out, render reads from `run` prop, action handlers call `run.*`, mount effect calls `run.discardUpdated()`.
- Modified: `src/ui/styles.css` — `.chat-menu-dot`, `.topbar-badge`, `@keyframes pulse-opacity`, the flex layout for `.chat-menu-item` to fit a leading dot.

## UI changes

### Dropdown (`.chat-menu-item`)

Current flex layout: `display: flex; justify-content: space-between; gap: 10px;` with `.chat-menu-title` and `.chat-menu-time` children. New layout adds a leading slot for the dot, then the title, then the time:

```
[•] | Chat title           2m ago
```

When the dot is absent, the slot is reserved (zero width) so titles don't reflow as state changes. A `.chat-menu-item.pulse .chat-menu-title` rule applies the opacity pulse to the title. The pulse is disabled when the user has `prefers-reduced-motion`.

### Topbar (`.topbar-title`)

Current structure: `<button class="topbar-title"><span class="topbar-title-text">…</span><svg …chevron…/></button>`. New structure: a small `<span class="topbar-badge">` is inserted between the title text and the chevron, conditionally rendered when `updatedCount > 0`. The badge is an 8px circle with `var(--accent)` background, with a separate pulse animation on the badge (opacity + slight scale, ~1.6s loop). The title text itself does not pulse.

### Soft cap toast

A one-time toast at ≥ 5 background turns. Implementation: a small `useEffect` in App that watches the count of `streaming` runs; once per crossing, calls a tiny custom toast (added to `styles.css` as a non-blocking notification). The toast auto-dismisses after 6s. If the count drops back below 5 and crosses again later, a new toast fires.

## Data flow

### On send

1. Chat calls `run.send(text, { images, mentions, ... })`.
2. `run.send` builds `modelText` from the text, attachments, synced tab contents, selection, etc. (the same code path as today's `send()`).
3. `run.send` pushes the user message into `run.messages` and the model message into `run.historyRef`.
4. `run.send` kicks off `runTurnChain` (now in `useChatTurn.ts`).
5. The run's `state` flips to `streaming`; App re-renders the dropdown; the dropdown title starts pulsing for any chat that is `streaming` and not active.

### On stream chunk

1. `runTurnChain` calls `onUpdate(parts)`, which updates `run.messages` (via setMessages equivalent) and bumps a tick so React re-renders.
2. If the active chat is this run, Chat re-renders. If not, the messages update silently in the background; on switch-back, Chat renders the full state.

### On turn end

1. The run's `state` flips from `streaming` to `updated` (not `idle`) when:
   - The run was the active chat at the time of completion. (Today's behavior: the topbar shows the same chat, no dot. The new behavior preserves this — a completion on the active chat does NOT set `updated`.)
   - OR the run is NOT the active chat at the time of completion. (`updated` is set; the dot appears.)
2. Persistence fires (`turnSeq` increments). The IndexedDB record is current.
3. Math repair runs as today, in the background.

### On switch to an `updated` chat

1. App changes `conversationId`.
2. Chat's mount effect runs, sees the run's state is `updated`, calls `run.discardUpdated()`.
3. The run's state flips to `idle`. App re-renders. The dropdown's row loses its dot; the topbar badge count decrements.

## Testing

### Unit (Vitest)

- `useChatTurn.test.ts`:
  - `state` transitions: idle → streaming (on send) → updated (on turn end while non-active) → idle (on `discardUpdated`).
  - `state` does NOT go to `updated` if the run was active at the moment of completion.
  - `state` stays `streaming` if the run was non-active at the moment of completion but a tool approval parks it.
  - `stop()` aborts the in-flight AbortController and the state goes back to `idle` (not `updated`).
  - `continueTask()` resumes from a checkpoint.
  - `discardUpdated()` is a no-op when state is `streaming` or `idle` (defensive).

Mock `runAgentTurn` and `createModel` with a controllable promise + a manual emitter; mount the hook via a `renderHook` from `@testing-library/react`. Restore the chat from IndexedDB by stubbing `getConversation`.

### Manual (verify-extension skill)

End-to-end walk:

1. Open chat A, send a long prompt that streams visibly.
2. Click `+` for a new chat. Chat A continues streaming; chat B is empty.
3. Open the dropdown. Chat A's title pulses; chat B is plain.
4. Wait for chat A to finish. The dropdown's A row stops pulsing, gets a dot.
5. The topbar (now showing chat B) shows a pulsing badge.
6. Click chat A in the dropdown. The badge disappears; the A row's dot disappears; chat A shows the full reply.
7. Switch back to chat B. No badge, no dot.

Approval-card parking:

1. Open chat A, send a prompt that will trigger a tool approval (e.g. a NavigateTab or ReadPage-with-action that requires permission).
2. Switch to chat B before resolving the approval.
3. The dropdown's A row is still pulsing (state is still `streaming` — it's parked on the approval).
4. Switch back to A. The approval card is visible; resolve it; A continues.

Soft cap:

1. Start 6 streaming chats. The 6th start shows a one-time toast.
2. The 6 chats keep running. No auto-cancel.

## Out of scope

- Persisting "turn was running" across panel close/SW restart. The next panel open shows all chats as `idle`.
- A way to send a new message to a non-active chat from the dropdown.
- Cross-chat approval UI (approving chat B's tool from chat A's view).
- A way to stop a non-active chat's turn without switching to it.
- Anything about background research — already runs in the SW/offscreen host and survives chat switches today.

## Migration / risk

- `key={conversationId}` removal: confirmed needed. The component becomes identity-stable.
- The runs Map grows with the user's session. Realistic upper bound: a few hundred runs in a heavy session. Each run holds a small transcript reference (real data lives in IndexedDB), a handful of refs, and a state string. Memory cost is bounded and small.
- The lifted `runTurnChain` body is large (~200 lines) but is a straight relocation; the surface area to Chat does not change. The local UI state (input, mentions, attachments, selection) stays in Chat.
- Page-control: the session is held in the run's `pageSessionRef`. The on-page presence overlay is mounted when the session opens (existing behavior). The on-page overlay lives on the web page, not in the panel, so it survives a chat switch. Switching back to the chat renders the session card as today.
- Restored chats: `useChatTurn` runs its IndexedDB restore on first call (lazy). A chat that has never been sent in doesn't get a run until the user sends. The dropdown shows it as `idle` (no pulse, no dot).
- The research-tasks effect (currently a `useEffect` in Chat with `chrome.storage.onChanged`) moves to App. The runs subscribe to the resulting `ResearchTask[]` list (which they re-filter to their own conversationId).
