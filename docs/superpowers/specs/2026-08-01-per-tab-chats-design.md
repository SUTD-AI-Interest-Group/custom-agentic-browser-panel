# Per-tab chats

Date: 2026-08-01

## Goal

A chat belongs to the tab it was opened on. Switching tabs gives you a fresh
chat; coming back gives you the old one. History stays unified and global — any
finished chat can be reopened anywhere. A turn already running when you switch
away keeps running, and tells you when it lands.

## The binding

A chat is bound to **tab id + origin**. Navigating the bound tab to a different
origin mints a fresh chat, exactly as switching tabs does; navigating within the
same origin keeps the chat.

`src/ui/tabChats.ts` owns the map and its rules. `App` is its only consumer.

```ts
interface TabBinding { conversationId: string; originKey: string }
type TabChatMap = Record<number, TabBinding>
```

`originKey(url)` is `protocol + '//' + host`, falling back to the raw URL string
when parsing fails — so `chrome://extensions`, `about:blank` and `file:///…` key
distinctly instead of collapsing onto one empty origin.

Two pure functions carry the logic and are unit-tested:

- `originKey(url: string): string`
- `resolveBinding(map, tabId, url)` → `{ kind: 'existing', conversationId }` or
  `{ kind: 'fresh' }`

The map is mirrored to `chrome.storage.session`. That area is wiped on browser
restart — precisely when tab ids stop meaning anything — so the map and its keys
expire together. A panel close/reopen mid-session still lands on the right chat.

Resolution runs on `tabs.onActivated`, and on `tabs.onUpdated` when the origin
changes. `tabs.onRemoved` drops the binding; the conversation itself survives in
history.

Empty chats are never written to IndexedDB — the existing `turnSeq === 0` guard
in `Chat.tsx` already sees to this — so tab-hopping does not pollute history.

### Reopening from the Library

Opening an older chat rebinds it to the **current** tab and evicts that tab's
previous binding. Nothing is lost: a chat with messages is already persisted.

The Library **blocks opening a chat that is currently running** — it stays pinned
to its own tab until it finishes. The running set also lives in
`chrome.storage.session`, so a second window's panel sees it and cannot mount the
same conversation twice.

## Tool pinning and the park

`createAgentTools` gains one seam: a `resolveTab: () => Promise<chrome.tabs.Tab |
undefined>` parameter that replaces its ~10 internal `getActiveTab()` calls. A
chat passes `() => chrome.tabs.get(boundTabId)`; callers that do not pin keep
`getActiveTab` as the default. That single seam is the whole retargeting change —
reads driven by `chrome.scripting.executeScript` work on a background tab
unmodified.

Captures cannot. `chrome.tabs.captureVisibleTab` only ever returns the active tab
of a window, as `src/platform/screenshot.ts` already documents. `tools.ts` also
already checks `tabs.query({ active: true, windowId })` before a set-of-marks
capture and degrades when the tab is no longer frontmost. That check is lifted
into a shared `requireForeground(tab)` and applied to every capture and every
page-control step.

When it fails the tool **parks** rather than errors: it returns a hand-off
telling the model the page is not in front, and `runTurnChain` stops the chain at
that step boundary with `stop.reason === 'needs-foreground'`. This reuses the
`Checkpoint` hand-off shape wholesale rather than inventing a second one.

Re-activating the bound tab auto-resumes the chain on a fresh step budget, **not**
charged against `MAX_AUTO_CONTINUES` — the same treatment steering already gets,
since the user's intent was given once already and a park is not the model
running away with the turn.

Parking is a stop, not an error: the turn keeps its history, its `activeNames`
set and its page-control grant.

### Approvals

No new mechanism. A background chat's `requestApproval` promise simply stays
pending; the chat is flagged `needs-you` and surfaces through the same bar and
toast as a finished one. Consent still happens in the chat that asked for it,
with its own card and its own context.

### Page control

An open control session survives a switch-away with its overlay hidden via the
existing `setPresenceHidden`, and re-shown on return — rather than being torn
down and its grant lost. The cross-origin drift rule is unchanged: drifting the
bound tab to another origin mid-session still ends the session.

The teardown invariant is unchanged in substance but moves with the chat: the
session and overlay are torn down in the continuation chain's **outer** `finally`,
which now lives in a chat that may be hidden. A hidden chat still tears down.

## Mounting

`App` renders a **set** of chats rather than one:

```
liveChatIds = [visibleId, ...ids that are running or parked]
```

Idle chats unmount exactly as today. Typical cost is one visible plus zero to two
background — not one per tab.

```tsx
<Chat
  key={id}
  conversationId={id}
  hidden={id !== visibleId}
  boundTabId={bindingFor(id)}
  onStatusChange={setStatus}
  …
/>
```

`hidden` suppresses the chat's **ambient** effects — the current-tab chip
refresh, selection polling, mention and slash candidate refresh, the one-second
`now` timer, and the focus effects. This is a correctness fix, not only an
optimization: those effects resolve "the active tab", and a hidden chat must
never read the tab you just switched to.

`hidden` must **not** suppress the turn loop, transcript persistence, or the
research-task effects. Those are the point.

`Chat` reports `idle | running | parked | needs-you` up to `App` via
`onStatusChange`, which is what drives both `liveChatIds` and the bar.

## Notification

Two surfaces, because the panel may not be in front of you:

**In-panel bar.** A dismissible bar naming the chat — "Chat on github.com
finished". Clicking it calls `chrome.tabs.update(tabId, { active: true })`, and
the ordinary binding path swaps the panel to that chat. Reusing tab activation
keeps one code path for "show me that chat" instead of two.

**System toast.** `chrome.notifications.create('chat:<tabId>', …)`, mirroring how
research already announces completion. The `notifications` permission is already
granted, so this adds no new install warning.

The toast fires only when the chat is not the visible one, or the panel is
unfocused (`document.hasFocus()`). Creation lives in the panel, which is what
knows the status; the `onClicked` handler lives in `background.ts`, so it still
works after the panel closes — it focuses the window and activates the tab
encoded in the notification id.

## Edge cases

- **Bound tab closed mid-turn.** `resolveTab` returns undefined and page tools
  report that the chat's page is gone, rather than today's misleading "No active
  tab found." The chat stays in history; the binding is dropped on
  `tabs.onRemoved`.
- **Bound tab navigates cross-origin mid-turn.** A running chat keeps its binding
  until the turn ends — a chat is never ripped away mid-turn. The origin check
  applies on activation and navigation for idle chats.
- **Two windows.** Tab ids are globally unique, so each window's panel resolves
  its own active tab and the map stays coherent. The running-chat block in the
  Library is what stops the same conversation being mounted in both.
- **Panel closed.** Out of scope, and inherently so: the agent loop, the approval
  gate and MCP are all panel-resident, and a turn that cannot ask for consent
  must not keep running. Closing the panel ends in-flight turns as it does today.

## Testing

Pure logic in `src/ui/tabChats.ts` gets unit tests beside it
(`tabChats.test.ts`), per the repo's convention: `originKey`, `resolveBinding`,
`liveChatIds`, and the toast predicate.

The park's stop condition is locked down in `src/agent/agent.test.ts` alongside
the existing `steerPending` test, which already establishes the pattern.

Everything else is Chrome-coupled and verified live via the `/verify-extension`
skill: a chat sticks to its tab, switching mints a fresh one, returning restores
it, a mid-turn switch keeps the turn running, a capture parks it, and both the
bar and the toast fire on completion.
