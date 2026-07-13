# Background Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an in-flight agent turn running when the user switches chats, surface running/updated status in the topbar and history dropdown, and provide per-chat turn isolation without remounting `<Chat>`.

**Architecture:** Lift the chat turn loop out of `<Chat>` into a per-conversation `ChatRun` hosted in `App`. A new `useChatTurn` factory returns a `ChatRun` with a `subscribe`/`getSnapshot` style API; `App` keeps a `Map<conversationId, ChatRun>` and re-renders the dropdown/topbar on any run's state change. `<Chat>` becomes a controlled view that reads from the run and calls back into it. The dropdown shows pulse/dot affordances; the topbar shows a pulsing badge for unseen updates.

**Tech Stack:** React 18, TypeScript (strict), Chrome MV3 side panel, Vite 6, Vitest 4.

## Global Constraints

- TypeScript strict; no `any` outside existing patterns.
- Match codebase conventions: no semicolons, single quotes, 2-space indent, `interface` for shapes, `type` for unions.
- The `key={conversationId}` prop on `<Chat>` is REMOVED in this plan.
- All Chrome-coupled logic is excluded from Vitest; the new `useChatTurn.ts` is dependency-injected so the state machine is testable as pure unit tests.
- Existing architecture invariants in `CLAUDE.md` must be preserved: every tool still routes through `requestApproval`; page-control session teardown is in the chain's outer `finally`; per-turn `activeNames` is created once per continuation chain.
- `npm test` runs Vitest; `npm run build` runs `tsc --noEmit && vite build`. The latter MUST pass at the end of every task.

## File Map

| File | Responsibility |
| --- | --- |
| `src/ui/chatTurnDeps.ts` (NEW) | Wires real Chrome-coupled deps for `useChatTurn` (model, IndexedDB, settings, observability, persistence). |
| `src/ui/useChatTurn.ts` (NEW) | The state machine + lifted `runTurnChain` + `ChatRun` factory. Pure, dependency-injected. |
| `src/ui/useChatTurn.test.ts` (NEW) | Vitest unit tests for state transitions, send/stop/continue, `discardUpdated`, soft-cap, and the `subscribe` notification. |
| `src/ui/App.tsx` (MOD) | Runs Map, state subscription, dropdown affordances, topbar badge, soft-cap toast, removed `key={conversationId}`. |
| `src/ui/Chat.tsx` (MOD) | Remove lifted state; read from `run` prop; call `run.*`; call `run.discardUpdated()` on mount. |
| `src/ui/styles.css` (MOD) | `.chat-menu-dot`, `.topbar-badge`, `.bg-cap-toast`, `@keyframes pulse-opacity`, `prefers-reduced-motion` rules. |

---

### Task 1: Define the `ChatRun` interface and dependency contract

**Files:**
- Create: `src/ui/chatTurnDeps.ts`
- Create: `src/ui/useChatTurn.ts` (scaffold only — types and a no-op `createChatRun`)

**Interfaces:**

```ts
// chatTurnDeps.ts
export interface ChatTurnDeps {
  conversationId: string
  settings: Settings
  selected: { provider: ProviderConfig; modelId: string } | null
  onConversationsChanged: () => void
  // ...more added in later tasks
}
```

```ts
// useChatTurn.ts
export type ChatState = 'idle' | 'streaming' | 'updated'

export interface ChatRunSnapshot {
  state: ChatState
  messages: UIMessage[]
  streaming: boolean
  turnStartedAt: number | null
  continuation: { checkpoint: Checkpoint | null } | null
  approval: PendingApproval | null
  sessionPlan: { plan: string; host: string } | null
  researchTasks: ResearchTask[]
}

export interface SendOptions {
  text: string
  images: CapturedImage[]
  mentions: TabMention[]
  useMemory: boolean
  useAll: boolean
  isFirstMessage: boolean
  includeCurrentTab: boolean
  includeDeicticTab: boolean
  activeSelection: { text: string; tabId: number } | null
  tabDismissed: boolean
  currentTab: CurrentTabInfo | null
  activeSkill: { name: string; body: string } | null
  conversationId: string
}

export interface ChatRun {
  conversationId: string
  getSnapshot: () => ChatRunSnapshot
  subscribe: (cb: () => void) => () => void
  send: (opts: SendOptions) => Promise<void>
  stop: () => void
  continueTask: () => Promise<void>
  settleApproval: (approved: boolean, forSession?: boolean) => void
  discardUpdated: () => void
  setResearchTasks: (tasks: ResearchTask[]) => void
  isActive: () => boolean
  setActive: (active: boolean) => void
}

export function createChatRun(deps: ChatTurnDeps): ChatRun
```

- [ ] **Step 1: Create `src/ui/chatTurnDeps.ts`**

Create the file with the following contents:

```ts
// Wired dependencies for a per-conversation turn host. The factory in
// useChatTurn.ts takes these so the state machine can be unit-tested with
// stubs (no chrome.*, no IndexedDB).
import type { Settings, ProviderConfig } from '../data/settings'
import type { ResearchTask } from '../data/researchTasks'

export interface ChatTurnDeps {
  /** Persisted conversation id. The run lives for the panel's lifetime. */
  conversationId: string
  settings: Settings
  selected: { provider: ProviderConfig; modelId: string } | null
  /** Called after every persisted turn so the history dropdown refreshes. */
  onConversationsChanged: () => void
}
```

- [ ] **Step 2: Create `src/ui/useChatTurn.ts` with the types and a stub factory**

Create the file with this exact content (a stub; later tasks will fill it in):

```ts
// Per-conversation turn host: the chat turn loop, the streaming state, the
// approval/page-control/session state, and the IndexedDB-backed persistence
// live here, not in <Chat>. The panel's App owns a Map<conversationId, ChatRun>
// so the loop survives a chat switch — switching away no longer remounts the
// running turn. <Chat> becomes a controlled view that reads getSnapshot() and
// calls back into the run.
import type { ModelMessage } from 'ai'
import type { Settings, ProviderConfig } from '../data/settings'
import type { ResearchTask } from '../data/researchTasks'
import type { UIMessage, UIPart, Checkpoint } from '../agent/agent'
import type { TabMention, CurrentTabInfo, PendingApproval } from './chatInternals'
import type { CapturedImage } from '../platform/capture'
import type { ChatTurnDeps } from './chatTurnDeps'

export type ChatState = 'idle' | 'streaming' | 'updated'

export interface ChatRunSnapshot {
  state: ChatState
  messages: UIMessage[]
  streaming: boolean
  turnStartedAt: number | null
  continuation: { checkpoint: Checkpoint | null } | null
  approval: PendingApproval | null
  sessionPlan: { plan: string; host: string } | null
  researchTasks: ResearchTask[]
}

export interface SendOptions {
  text: string
  images: CapturedImage[]
  mentions: TabMention[]
  useMemory: boolean
  useAll: boolean
  isFirstMessage: boolean
  includeCurrentTab: boolean
  includeDeicticTab: boolean
  activeSelection: { text: string; tabId: number } | null
  tabDismissed: boolean
  currentTab: CurrentTabInfo | null
  activeSkill: { name: string; body: string } | null
  conversationId: string
}

export interface ChatRun {
  conversationId: string
  getSnapshot: () => ChatRunSnapshot
  subscribe: (cb: () => void) => () => void
  send: (opts: SendOptions) => Promise<void>
  stop: () => void
  continueTask: () => Promise<void>
  settleApproval: (approved: boolean, forSession?: boolean) => void
  discardUpdated: () => void
  setResearchTasks: (tasks: ResearchTask[]) => void
  isActive: () => boolean
  setActive: (active: boolean) => void
}

export function createChatRun(deps: ChatTurnDeps): ChatRun {
  // Stub. Real implementation lands in Task 3.
  const snapshot: ChatRunSnapshot = {
    state: 'idle',
    messages: [],
    streaming: false,
    turnStartedAt: null,
    continuation: null,
    approval: null,
    sessionPlan: null,
    researchTasks: [],
  }
  return {
    conversationId: deps.conversationId,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    send: async () => {},
    stop: () => {},
    continueTask: async () => {},
    settleApproval: () => {},
    discardUpdated: () => {},
    setResearchTasks: () => {},
    isActive: () => false,
    setActive: () => {},
  }
}
```

- [ ] **Step 3: Create `src/ui/chatInternals.ts` with the lifted types**

`TabMention`, `CurrentTabInfo`, and `PendingApproval` are defined in `Chat.tsx` today. To avoid a circular import (Chat ↔ useChatTurn), move them to a new tiny file:

```ts
// Types that have to live outside <Chat> and <useChatTurn> so neither imports
// the other. PendingApproval adds the resolve() to ApprovalRequest.
import type { ApprovalRequest } from '../tools/tools'

export interface PendingApproval extends ApprovalRequest {
  resolve: (approved: boolean) => void
}

export interface CurrentTabInfo {
  tabId: number
  title: string
  url: string
  favIconUrl?: string
}

/** A tab the user @mentioned in the composer; its content syncs on send. */
export interface TabMention {
  tabId: number
  title: string
  url: string
  /** The literal token inserted into the input, e.g. `@My Doc Title`. */
  token: string
}
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: passes. The stub `createChatRun` is unused but typed; no consumers yet.

- [ ] **Step 5: Commit**

```bash
git add src/ui/chatTurnDeps.ts src/ui/useChatTurn.ts src/ui/chatInternals.ts
git commit -m "feat(bg-chats): scaffold ChatRun interface and dependency contract"
```

---

### Task 2: Implement the state machine + subscribe

The state machine is the smallest unit. The send/continue loop is added in Task 3; this task only covers `getSnapshot`, `subscribe`, `setActive`, `discardUpdated`, and the state transition rules.

**Files:**
- Modify: `src/ui/useChatTurn.ts`

**Interfaces (recap):**
- `state: 'idle' | 'streaming' | 'updated'`
- `setActive(active: boolean)` — called by App on chat switch.
- `discardUpdated()` — clears `updated` → `idle` only when state is `updated`.
- `subscribe(cb)` — pub/sub for React re-renders.

- [ ] **Step 1: Write the failing test for state transitions**

Create `src/ui/useChatTurn.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createChatRun, type ChatTurnDeps } from './useChatTurn'
import type { Settings } from '../data/settings'

const baseSettings = {
  providers: [],
  selected: { providerId: 'p', modelId: 'm' },
  systemPrompt: '',
  tabAccess: 'active-tab' as const,
  toolPolicies: {},
  onboarded: true,
} as unknown as Settings

const baseDeps: ChatTurnDeps = {
  conversationId: 'cid',
  settings: baseSettings,
  selected: null,
  onConversationsChanged: () => {},
}

describe('createChatRun state machine', () => {
  it('starts in idle', () => {
    const run = createChatRun(baseDeps)
    expect(run.getSnapshot().state).toBe('idle')
  })

  it('subscribe returns an unsubscribe and notifies on state change', () => {
    const run = createChatRun(baseDeps)
    const cb = vi.fn()
    const unsub = run.subscribe(cb)
    run.setActive(true)
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    run.setActive(false)
    expect(cb).toHaveBeenCalledTimes(1) // unsubbed; no further call
  })

  it('discardUpdated is a no-op when not in updated', () => {
    const run = createChatRun(baseDeps)
    run.discardUpdated()
    expect(run.getSnapshot().state).toBe('idle')
  })

  it('isActive defaults to false and is settable', () => {
    const run = createChatRun(baseDeps)
    expect(run.isActive()).toBe(false)
    run.setActive(true)
    expect(run.isActive()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/ui/useChatTurn.test.ts`
Expected: FAIL — the stub `createChatRun` does not implement state transitions; the test will throw or assert wrong values.

- [ ] **Step 3: Implement the state machine**

Replace the `createChatRun` body in `src/ui/useChatTurn.ts` with:

```ts
export function createChatRun(deps: ChatTurnDeps): ChatRun {
  let state: ChatState = 'idle'
  let active = false
  const listeners = new Set<() => void>()
  // The snapshot is identity-stable per `state` so React sees no flicker on
  // unrelated re-renders. The state machine mutates only `state`; the other
  // fields are written by send/stop/continue/setResearchTasks in later tasks.
  const snapshot: ChatRunSnapshot = {
    state,
    messages: [],
    streaming: false,
    turnStartedAt: null,
    continuation: null,
    approval: null,
    sessionPlan: null,
    researchTasks: [],
  }
  const notify = () => {
    snapshot.state = state
    listeners.forEach((cb) => cb())
  }
  return {
    conversationId: deps.conversationId,
    getSnapshot: () => snapshot,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    send: async () => {
      // Wired in Task 3.
    },
    stop: () => {
      // Wired in Task 3.
    },
    continueTask: async () => {
      // Wired in Task 3.
    },
    settleApproval: () => {
      // Wired in Task 3.
    },
    discardUpdated: () => {
      if (state === 'updated') {
        state = 'idle'
        notify()
      }
    },
    setResearchTasks: () => {
      // Wired in Task 6.
    },
    isActive: () => active,
    setActive: (next) => {
      active = next
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/ui/useChatTurn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/useChatTurn.test.ts src/ui/useChatTurn.ts
git commit -m "feat(bg-chats): state machine + subscribe in useChatTurn"
```

---

### Task 3: Lift `runTurnChain` into the run

**Files:**
- Modify: `src/ui/useChatTurn.ts` — replace stub `send`/`stop`/`continueTask`/`settleApproval` with the lifted loop.
- Modify: `src/ui/chatTurnDeps.ts` — add the model, observability, IndexedDB, tool-creation deps that the loop needs.

**Interfaces (this task's surface):**

```ts
// chatTurnDeps.ts additions
export interface ChatTurnDeps {
  // ...existing
  /** The model factory. Injected so tests can stub it. */
  createModel: (provider: ProviderConfig, modelId: string) => LanguageModel
  /** Observability config derived from settings. */
  observability: ObservabilityConfig
  /** Load the persisted conversation. Called once on first subscribe. */
  getConversation: (id: string) => Promise<{ messages: UIMessage[]; history: ModelMessage[] } | null>
  /** Persist after each turn. */
  saveConversation: (input: { id: string; messages: UIMessage[]; history: ModelMessage[] }) => Promise<void>
  /** Create the agent toolset; tests stub it to a no-op. */
  createAgentTools: (...args: unknown[]) => ToolSet
  /** Run one model turn. Tests stub this with a controllable promise. */
  runAgentTurn: typeof runAgentTurn
  /** Append to the journal for memory dreaming. */
  appendToEpisode: (id: string, entries: JournalEntry[]) => Promise<void>
  /** Cached memory context for the system prompt. */
  getMemoryContext: () => Promise<string>
  /** Granted browsing capabilities for this turn. */
  grantedCapabilities: () => Promise<Set<BrowsingCapability>>
  /** Skill catalog for the system prompt. */
  listSkillMetas: (opts: { modelInvocableOnly: boolean }) => Promise<SkillMeta[]>
  /** Generate a chat title from the first message. */
  generateChatTitle: (model: LanguageModel, text: string, id: string) => Promise<string | null>
  /** Rename a conversation in IndexedDB. */
  renameConversation: (id: string, title: string) => Promise<void>
  /** All current tool policy decisions (Ask/Never/Always) for one tool. */
  toolPolicy: (settings: Settings, name: string) => ToolPolicy
  /** Probe (and cache) whether the model can read images. */
  ensureVisionCapability: (provider: ProviderConfig, modelId: string) => Promise<boolean>
  /** Clear page-control index stamps on a tab. */
  clearIndex: (tabId: number) => Promise<void>
  /** Tear down the on-page presence overlay. */
  unmountPresence: (tabId: number) => Promise<void>
  unmountAllPresence: () => Promise<void>
  /** Page-control session reference (per-conversation). */
  createPageControlGate: () => PageControlGate
}
```

- [ ] **Step 1: Extend `ChatTurnDeps`**

In `src/ui/chatTurnDeps.ts`, add the fields above. The full file is small; rebuild it as:

```ts
// Wired dependencies for a per-conversation turn host. The factory in
// useChatTurn.ts takes these so the state machine can be unit-tested with
// stubs (no chrome.*, no IndexedDB).
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { Settings, ProviderConfig, ObservabilityConfig, ToolPolicy } from '../data/settings'
import type { ResearchTask } from '../data/researchTasks'
import type { UIMessage } from '../agent/agent'
import type { runAgentTurn } from '../agent/agent'
import type { BrowsingCapability } from '../platform/permissions'
import type { PageControlGate } from '../tools/tools'
import type { ApprovalRequest } from '../tools/tools'
import type { SkillMeta } from '../data/skills'

export interface JournalEntry {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface ChatTurnDeps {
  conversationId: string
  settings: Settings
  selected: { provider: ProviderConfig; modelId: string } | null
  onConversationsChanged: () => void
  createModel: (provider: ProviderConfig, modelId: string) => LanguageModel
  observability: ObservabilityConfig
  getConversation: (id: string) => Promise<{ messages: UIMessage[]; history: ModelMessage[] } | null>
  saveConversation: (input: { id: string; messages: UIMessage[]; history: ModelMessage[] }) => Promise<void>
  createAgentTools: (...args: unknown[]) => ToolSet
  runAgentTurn: typeof runAgentTurn
  appendToEpisode: (id: string, entries: JournalEntry[]) => Promise<void>
  getMemoryContext: () => Promise<string>
  grantedCapabilities: () => Promise<Set<BrowsingCapability>>
  listSkillMetas: (opts: { modelInvocableOnly: boolean }) => Promise<SkillMeta[]>
  generateChatTitle: (model: LanguageModel, text: string, id: string) => Promise<string | null>
  renameConversation: (id: string, title: string) => Promise<void>
  toolPolicy: (settings: Settings, name: string) => ToolPolicy
  ensureVisionCapability: (provider: ProviderConfig, modelId: string) => Promise<boolean>
  clearIndex: (tabId: number) => Promise<void>
  unmountPresence: (tabId: number) => Promise<void>
  unmountAllPresence: () => Promise<void>
  createPageControlGate: () => PageControlGate
}
```

Note: drop the `ResearchTask` import if unused. Add it back only if `ChatRunSnapshot.researchTasks` is referenced from this file (it isn't — keep the import minimal).

- [ ] **Step 2: Lift the existing `runTurnChain` body**

In `src/ui/useChatTurn.ts`, add a private `runTurnChain(ctx)` function adapted from the existing `runTurnChain` in `src/ui/Chat.tsx` (lines 1076–1269). The new version:

- Reads `state`, `setState`, `getMessages/setMessages`, etc. from the run's closures, not React state.
- Uses `deps.createModel`, `deps.runAgentTurn`, `deps.createAgentTools`, `deps.saveConversation`, `deps.getConversation`, `deps.appendToEpisode`, `deps.getMemoryContext`, `deps.grantedCapabilities`, `deps.listSkillMetas`, `deps.generateChatTitle`, `deps.renameConversation`, `deps.toolPolicy`, `deps.ensureVisionCapability`, `deps.clearIndex`, `deps.unmountPresence`, `deps.unmountAllPresence` — all from the injected deps.
- Calls `notify()` after any `setMessages` so subscribers re-render.
- Sets `state = 'streaming'` at the start of the chain, sets `state = 'updated'` if `!active` at the end, `state = 'idle'` if `active` at the end (today's behavior).
- Sets `state = 'idle'` on `stop()` (which aborts the in-flight AbortController).

Because this block is large, the actual lift is mechanical — copy the body of `runTurnChain` from `Chat.tsx:1076-1269`, then:

1. Replace `useState` calls with module-scope `let` bindings (`let messages: UIMessage[] = []` etc.).
2. Replace `setMessages((m) => …)` with a local `const setMessages = (fn: (m: UIMessage[]) => UIMessage[]) => { messages = fn(messages); notify() }`.
3. Replace `historyRef.current.push(...)` with `history.push(...)`.
4. Replace `abortRef.current?.abort()` with `abortController?.abort()`.
5. Replace `setStreaming(false)` and `setTurnStartedAt(null)` with the run's own setters (these flip `streaming` and `turnStartedAt` in the snapshot, then call `notify()`).
6. Replace `pageControl.endSession()` with `deps.createPageControlGate().endSession()`.
7. Replace `unmountAllPresence()` with `void deps.unmountAllPresence()`.
8. Add `if (!active) state = 'updated'; else state = 'idle'; notify();` in the success path's outer `finally`.
9. Add `state = 'idle'; streaming = false; notify();` in `stop()`.

(For brevity in the plan, the entire runTurnChain body is NOT repeated here. The implementer MUST read the source at `src/ui/Chat.tsx:1076-1269` and adapt it line by line. The structural changes above are the only mechanical differences; no business logic changes.)

- [ ] **Step 3: Wire `send`, `stop`, `continueTask`, `settleApproval`**

In `createChatRun`, replace the four stub methods:

```ts
    send: async (opts) => {
      if (state !== 'idle') return
      state = 'streaming'
      streaming = true
      turnStartedAt = Date.now()
      notify()
      // Pre-flight: kick off the title-namer in parallel (matches today's send()).
      if (opts.isFirstMessage && opts.text && deps.selected) {
        const titleModel = deps.createModel(deps.selected.provider, deps.selected.modelId)
        void deps.generateChatTitle(titleModel, opts.text, deps.conversationId)
          .then((t) =>
            t ? deps.renameConversation(deps.conversationId, t).then(deps.onConversationsChanged) : undefined,
          )
          .catch(() => {})
      }
      // Push the user message.
      setMessages((m) => [
        ...m,
        { id: uid(), role: 'user', parts: [{ type: 'text', text: opts.text }], images: opts.images.map((i) => i.dataUrl) },
      ])
      // Build the model-facing text and append the user message to history
      // (mirrors today's send() lines 989-1032).
      // ... (see Chat.tsx:989-1032 for the modelText build; lift it inline).
      history.push({ role: 'user', content: modelText })
      await runTurnChain({
        startedAt: turnStartedAt!,
        attachedSources: [],
        activeSkill: opts.activeSkill ? { name: opts.activeSkill.name, body: opts.activeSkill.body } : null,
        journalUserText: opts.text,
        droppableTail: true,
      })
    },
    stop: () => {
      abortController?.abort()
    },
    continueTask: async () => {
      continuation = null
      notify()
      state = 'streaming'
      streaming = true
      turnStartedAt = Date.now()
      notify()
      await runTurnChain({
        startedAt: turnStartedAt!,
        attachedSources: [],
        activeSkill: null,
        journalUserText: '[continued the task]',
        droppableTail: false,
      })
    },
    settleApproval: (approved, forSession) => {
      const a = approval
      if (!a) return
      if (approved && forSession) sessionAllowed.add(a.toolName)
      approval = null
      sessionPlan = null
      notify()
      a.resolve(approved)
    },
```

The `runTurnChain` function defined inside `createChatRun` references the local `let` bindings (messages, history, abortController, approval, sessionPlan, continuation, etc.). The signature is the same as today's `runTurnChain` in `Chat.tsx`. The body is the lifted one (Step 2).

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: passes. `Chat.tsx` is unchanged, so the unused `useChatTurn.ts` exports are inert.

- [ ] **Step 5: Commit**

```bash
git add src/ui/useChatTurn.ts src/ui/chatTurnDeps.ts
git commit -m "feat(bg-chats): lift runTurnChain into ChatRun"
```

---

### Task 4: Tests for send/stop/continue + the `updated` transition

**Files:**
- Modify: `src/ui/useChatTurn.test.ts` — add tests for the state machine's response to send/stop/continue.

The tests stub `runAgentTurn` to a controllable promise and stub `saveConversation` so no IndexedDB is touched. The factory is called with the real wiring for everything *except* the model and the run loop, so the test exercises the run's state transitions end-to-end.

- [ ] **Step 1: Add a stub-able `runAgentTurn` helper**

At the top of `src/ui/useChatTurn.test.ts`, add:

```ts
import type { AgentTurnResult } from '../agent/agent'

type TurnStub = {
  result: AgentTurnResult
  resolve: () => void
  reject: (err: unknown) => void
}
function makeRunAgentTurn() {
  const pending: TurnStub[] = []
  const fn = vi.fn(async (): Promise<AgentTurnResult> => {
    return new Promise<AgentTurnResult>((resolve, reject) => {
      pending.push({
        result: {
          parts: [{ type: 'text', text: 'ok' }],
          responseMessages: [],
          stop: { reason: 'completed', stepsUsed: 1 },
        },
        resolve: () => resolve(pending.shift()!.result),
        reject,
      })
    })
  }) as unknown as ChatTurnDeps['runAgentTurn']
  return { fn, pending }
}
```

- [ ] **Step 2: Write the failing test for the `updated` transition**

Add to the test file:

```ts
describe('state transitions during a turn', () => {
  function makeRun() {
    const { fn, pending } = makeRunAgentTurn()
    const saveConversation = vi.fn(async () => {})
    const run = createChatRun({
      ...baseDeps,
      runAgentTurn: fn,
      saveConversation,
      createModel: (() => ({} as any)) as ChatTurnDeps['createModel'],
      createAgentTools: (() => ({})) as ChatTurnDeps['createAgentTools'],
      getConversation: async () => null,
      appendToEpisode: async () => {},
      getMemoryContext: async () => '',
      grantedCapabilities: async () => new Set(),
      listSkillMetas: async () => [],
      generateChatTitle: async () => null,
      renameConversation: async () => {},
      toolPolicy: () => 'ask',
      ensureVisionCapability: async () => false,
      clearIndex: async () => {},
      unmountPresence: async () => {},
      unmountAllPresence: async () => {},
      createPageControlGate: () => ({ requestSession: () => Promise.resolve(true), session: () => null, endSession: () => {} }),
      observability: { enabled: false } as any,
    })
    return { run, pending, saveConversation }
  }

  it('goes to streaming on send and to idle on completion when active', async () => {
    const { run, pending } = makeRun()
    run.setActive(true)
    const sendPromise = run.send({
      text: 'hello',
      images: [],
      mentions: [],
      useMemory: false,
      useAll: false,
      isFirstMessage: true,
      includeCurrentTab: false,
      includeDeicticTab: false,
      activeSelection: null,
      tabDismissed: false,
      currentTab: null,
      activeSkill: null,
      conversationId: 'cid',
    })
    expect(run.getSnapshot().state).toBe('streaming')
    pending.shift()!.resolve()
    await sendPromise
    expect(run.getSnapshot().state).toBe('idle')
  })

  it('goes to updated on completion when not active', async () => {
    const { run, pending } = makeRun()
    run.setActive(false)
    const sendPromise = run.send({
      text: 'hello',
      images: [],
      mentions: [],
      useMemory: false,
      useAll: false,
      isFirstMessage: true,
      includeCurrentTab: false,
      includeDeicticTab: false,
      activeSelection: null,
      tabDismissed: false,
      currentTab: null,
      activeSkill: null,
      conversationId: 'cid',
    })
    expect(run.getSnapshot().state).toBe('streaming')
    pending.shift()!.resolve()
    await sendPromise
    expect(run.getSnapshot().state).toBe('updated')
  })

  it('stop() returns to idle even when not active', async () => {
    const { run, pending } = makeRun()
    run.setActive(false)
    const sendPromise = run.send({
      text: 'hello',
      images: [],
      mentions: [],
      useMemory: false,
      useAll: false,
      isFirstMessage: true,
      includeCurrentTab: false,
      includeDeicticTab: false,
      activeSelection: null,
      tabDismissed: false,
      currentTab: null,
      activeSkill: null,
      conversationId: 'cid',
    })
    expect(run.getSnapshot().state).toBe('streaming')
    run.stop()
    pending.shift()!.reject(new Error('aborted'))
    await sendPromise.catch(() => {})
    expect(run.getSnapshot().state).toBe('idle')
  })

  it('discardUpdated() clears updated but is a no-op for idle/streaming', async () => {
    const { run, pending } = makeRun()
    run.setActive(false)
    const sendPromise = run.send({
      text: 'hello',
      images: [],
      mentions: [],
      useMemory: false,
      useAll: false,
      isFirstMessage: true,
      includeCurrentTab: false,
      includeDeicticTab: false,
      activeSelection: null,
      tabDismissed: false,
      currentTab: null,
      activeSkill: null,
      conversationId: 'cid',
    })
    pending.shift()!.resolve()
    await sendPromise
    expect(run.getSnapshot().state).toBe('updated')
    run.discardUpdated()
    expect(run.getSnapshot().state).toBe('idle')
    run.discardUpdated() // no-op
    expect(run.getSnapshot().state).toBe('idle')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/ui/useChatTurn.test.ts`
Expected: FAIL — the `send` body in `useChatTurn.ts` does not exist yet, or it does not set `streaming`/`turnStartedAt` properly. The test will throw on the first `expect(run.getSnapshot().state).toBe('streaming')`.

- [ ] **Step 4: Implement send to flip state and to set updated vs idle on completion**

In `useChatTurn.ts`, the `runTurnChain` body (Task 3) MUST:

- Set `state = 'streaming'`, `streaming = true`, `turnStartedAt = Date.now()`, `notify()` at the entry of the chain.
- In the `try` block's success path, after the chain finishes, in the `finally`:
  - If `controller.signal.aborted`: `state = 'idle'`, `streaming = false`, `notify()`.
  - Else if the chain returned successfully and `!active`: `state = 'updated'`, `streaming = false`, `notify()`.
  - Else: `state = 'idle'`, `streaming = false`, `notify()`.
- `stop()` MUST abort the controller and the `finally` (above) handles the rest.

(If Task 3's lift already implemented this correctly, the test passes. If not, this step is the fix.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/ui/useChatTurn.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/useChatTurn.test.ts src/ui/useChatTurn.ts
git commit -m "test(bg-chats): cover state transitions for send/stop/updated"
```

---

### Task 5: Wire the App-level `runs` Map and the active subscription

**Files:**
- Modify: `src/ui/App.tsx`
- Create: `src/ui/chatTurnDeps.ts` builder — add `buildChatTurnDeps(args)` next to the `ChatTurnDeps` interface (or in App.tsx itself, calling the real modules).

**Interfaces (recap):**
- `runsRef = useRef(new Map<string, ChatRun>())`
- `runTick` is a state int; `useEffect` subscribes to every run's `subscribe` and bumps `runTick` on every event.
- The `<Chat>` is rendered with `run={getRun(conversationId)}` and no `key`.

- [ ] **Step 1: Build the deps builder**

In `src/ui/chatTurnDeps.ts`, add at the bottom:

```ts
import { createModel } from '../agent/provider'
import { runAgentTurn } from '../agent/agent'
import { getConversation, renameConversation, saveConversation } from '../data/conversations'
import { appendToEpisode, getMemoryContext } from '../data/memory'
import { grantedCapabilities } from '../platform/permissions'
import { listSkillMetas } from '../data/skills'
import { generateChatTitle } from '../agent/provider'
import { observabilityConfig, toolPolicy } from '../data/settings'
import { ensureVisionCapability } from '../agent/vision'
import { clearIndex } from '../platform/domIndex'
import { unmountPresence, unmountAllPresence } from '../platform/presence'
import { createAgentTools } from '../tools/tools'
import type { Settings } from '../data/settings'

export function buildChatTurnDeps(args: {
  conversationId: string
  settings: Settings
  selected: { provider: ProviderConfig; modelId: string } | null
  onConversationsChanged: () => void
}): ChatTurnDeps {
  return {
    conversationId: args.conversationId,
    settings: args.settings,
    selected: args.selected,
    onConversationsChanged: args.onConversationsChanged,
    createModel,
    observability: observabilityConfig(args.settings),
    getConversation,
    saveConversation: async (input) => saveConversation(input),
    createAgentTools: createAgentTools as unknown as ChatTurnDeps['createAgentTools'],
    runAgentTurn,
    appendToEpisode,
    getMemoryContext,
    grantedCapabilities,
    listSkillMetas,
    generateChatTitle,
    renameConversation,
    toolPolicy,
    ensureVisionCapability,
    clearIndex,
    unmountPresence,
    unmountAllPresence,
    createPageControlGate: () => ({
      requestSession: () => Promise.resolve(true),
      session: () => null,
      endSession: () => {},
    }),
  }
}
```

- [ ] **Step 2: Refactor App to own the runs Map**

In `src/ui/App.tsx`:

1. Add `import { createChatRun, type ChatRun, type ChatRunSnapshot } from './useChatTurn'`.
2. Add `import { buildChatTurnDeps } from './chatTurnDeps'`.
3. Inside `App`, add:

```ts
  const runsRef = useRef(new Map<string, ChatRun>())
  const [runTick, setRunTick] = useState(0)
  const getRun = useCallback((cid: string): ChatRun => {
    let run = runsRef.current.get(cid)
    if (!run) {
      run = createChatRun(buildChatTurnDeps({
        conversationId: cid,
        settings: settings!,
        selected: settings ? getSelectedProvider(settings) : null,
        onConversationsChanged: refreshConversations,
      }))
      runsRef.current.set(cid, run)
      const unsub = run.subscribe(() => setRunTick((n) => n + 1))
      // The Map lives for the panel's lifetime; no cleanup.
      // We hold `unsub` for symmetry but it is never called.
      void unsub
    }
    return run
  }, [settings, refreshConversations])
```

4. Replace `<Chat key={conversationId} ... />` with `<Chat run={getRun(conversationId)} settings={settings} ... />` (remove `conversationId` from Chat's props, add `run`).
5. Mark active: when `conversationId` changes, call `getRun(oldCid).setActive(false)` and `getRun(newCid).setActive(true)`. This happens in an effect:

```ts
  useEffect(() => {
    const run = getRun(conversationId)
    run.setActive(true)
    return () => { run.setActive(false) }
  }, [conversationId, getRun])
```

- [ ] **Step 3: Build to verify the refactor compiles**

Run: `npm run build`
Expected: FAIL with TypeScript errors — Chat still expects `conversationId` and a different shape. The next task fixes Chat.

- [ ] **Step 4: Commit the App changes (interim)**

```bash
git add src/ui/App.tsx src/ui/chatTurnDeps.ts
git commit -m "refactor(bg-chats): App owns runs Map; Chat is now a controlled view (WIP)"
```

---

### Task 6: Refactor `Chat.tsx` to read from `run`

**Files:**
- Modify: `src/ui/Chat.tsx` — remove lifted state, read from `run`, call `run.*`.

- [ ] **Step 1: Replace the props signature**

Replace the props interface at the top of `Chat.tsx` (lines 340-360):

```ts
export default function Chat({
  run,
  settings,
  onUpdateSettings,
  onOpenSettings,
  onOpenSkills,
  onConversationsChanged,
  pendingResearchId,
  onPendingResearchHandled,
}: {
  run: ChatRun
  settings: Settings
  onUpdateSettings: (next: Settings) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  onConversationsChanged: () => void
  /** A research task the Library asked to reveal in this (now-mounted) chat. */
  pendingResearchId?: string | null
  onPendingResearchHandled?: () => void
}) {
```

- [ ] **Step 2: Subscribe to the run in the body**

Right at the top of the function body (after the `useState`/`useRef` declarations for UI state), add:

```ts
  const snapshot = useSyncExternalStore(
    run.subscribe,
    run.getSnapshot,
    run.getSnapshot,
  )
  useEffect(() => {
    // Mounting the active chat clears its `updated` flag so the dropdown
    // affordance and topbar badge disappear.
    run.discardUpdated()
  }, [run])
```

Add `import { useSyncExternalStore } from 'react'` to the imports at the top of `Chat.tsx`.

- [ ] **Step 3: Replace local state with snapshot reads**

Remove these `useState` calls (they live in the run now):
- `messages`, `streaming`, `turnStartedAt`, `continuation`, `approval`, `sessionPlan`, `researchTasks` (the `researchTasks` is partially local; the run's `setResearchTasks` will own it — see Step 5), `turnSeq`.

Replace the **read sites** in render:

- `messages` → `snapshot.messages`
- `streaming` → `snapshot.streaming`
- `turnStartedAt` → `snapshot.turnStartedAt`
- `continuation` → `snapshot.continuation`
- `approval` → `snapshot.approval`
- `sessionPlan` → `snapshot.sessionPlan`

Delete the `useRef` declarations for:
- `historyRef`, `abortRef`, `approvalRef`, `pageSessionRef`, `autoContinuesRef`, `turnAllowed`, `sharedTabsRef`, `episodeIdRef`, `messagesRef`.

(The remaining refs `inputRef`, `scrollRef`, `toolsMenuRef`, `moreMenuRef`, `bodyRef` are UI-only — keep them.)

- [ ] **Step 4: Replace local `send`/`stop`/`continueTask`/`settleApproval` with calls into the run**

Delete the bodies of `send()`, `stop()` (in Chat.tsx, the local `stop`), `continueTask()`, `settleApproval()`, and `requestApproval()`. Replace the call sites:

- The composer `onClick` for `send-btn`: `onClick={() => void run.send({...})}`
  - Build a `SendOptions` object from Chat's local state (input, attachments, mentions, current tab, etc.) at the moment of send. Mirror today's `send()` (Chat.tsx:917-1064) for the modelText build, but stop before `runTurnChain` — pass the assembled options into `run.send`.
- The Stop button: `onClick={() => run.stop()}`.
- `ContinueTask`: `onClick={() => void run.continueTask()}`.
- `ApprovalCard` buttons: `onAllow={() => run.settleApproval(true)}`, `onAllowSession={() => run.settleApproval(true, true)}`, `onDeny={() => run.settleApproval(false)}`.

The `requestApproval` and `pageControl` factories (Chat.tsx:693-734) are no longer needed in Chat — they are inside the run.

- [ ] **Step 5: Move the research-tasks effect to App**

Delete the `useEffect` that subscribes to `chrome.storage.onChanged` for research tasks (Chat.tsx:577-589). The `run.setResearchTasks(tasks)` is now called by App, which owns the storage subscription (added in Step 6). Chat still reads `snapshot.researchTasks` and renders the dock/sheet the same way.

The `myTasks` filter, `dockTasks` derivation, and `openSheetTask` lookup all read from `snapshot.researchTasks` instead of local state.

- [ ] **Step 6: Add the research-tasks subscription to App**

In `src/ui/App.tsx`, add a single `useEffect`:

```ts
  useEffect(() => {
    let cancelled = false
    const load = () => listTasks().then((t) => { if (!cancelled) {
      for (const run of runsRef.current.values()) run.setResearchTasks(t)
    }})
    void load()
    const onChanged = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.researchTasks) void load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(onChanged) }
  }, [])
```

Add `import { listTasks } from '../data/researchTasks'` to App.tsx.

- [ ] **Step 7: Drop the useEffect for restore + persist + math-repair ref mirror**

These are now inside the run. Delete:

- The restore effect (Chat.tsx:443-457).
- The persist effect (Chat.tsx:518-530).
- The `messagesRef` mirror effect (Chat.tsx:534-536).
- The `repairAssistantMath` function (Chat.tsx:1275-1321) and its call from `runTurnChain` (now in the run; the run's `runTurnChain` calls a local copy).

- [ ] **Step 8: Build to verify**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui/Chat.tsx src/ui/App.tsx
git commit -m "refactor(bg-chats): Chat reads from run; App drives research + runs"
```

---

### Task 7: Add the dropdown affordances and topbar badge

**Files:**
- Modify: `src/ui/App.tsx` — dropdown items render with optional `pulse` and `dot`; topbar shows badge when other chats are `updated`.
- Modify: `src/ui/styles.css` — `.chat-menu-dot`, `.topbar-badge`, `.chat-menu-item.pulse .chat-menu-title`, `@keyframes pulse-opacity`, reduced-motion rules.

- [ ] **Step 1: Compute the dropdown state per row**

In App's render, where the dropdown is built, compute per-conversation state:

```ts
  const getRunState = (cid: string) => runsRef.current.get(cid)?.getSnapshot().state ?? 'idle'
  const updatedCount = conversations.reduce(
    (n, c) => n + (c.id !== conversationId && getRunState(c.id) === 'updated' ? 1 : 0),
    0,
  )
```

(Note: this must read `runTick` so the count updates; either reference `runTick` in the body of the component, or compute it inside a `useMemo` keyed on `[runTick, conversations, conversationId]`.)

- [ ] **Step 2: Update the dropdown item**

In `App.tsx`, the existing JSX:

```tsx
                conversations.map((c) => (
                  <button
                    key={c.id}
                    className={`chat-menu-item ${c.id === conversationId ? 'active' : ''}`}
                    onClick={() => openConversation(c.id)}
                  >
                    <span className="chat-menu-title">{c.title ?? 'New chat'}</span>
                    <span className="chat-menu-time">{relativeTime(c.updatedAt)}</span>
                  </button>
                ))
```

Replace with:

```tsx
                conversations.map((c) => {
                  const st = getRunState(c.id)
                  const isActive = c.id === conversationId
                  const pulse = !isActive && st === 'streaming'
                  const dot = !isActive && st === 'updated'
                  return (
                    <button
                      key={c.id}
                      className={`chat-menu-item ${isActive ? 'active' : ''} ${pulse ? 'pulse' : ''} ${dot ? 'has-dot' : ''}`}
                      onClick={() => openConversation(c.id)}
                    >
                      {dot && <span className="chat-menu-dot" aria-hidden />}
                      <span className="chat-menu-title">{c.title ?? 'New chat'}</span>
                      <span className="chat-menu-time">{relativeTime(c.updatedAt)}</span>
                    </button>
                  )
                })
```

- [ ] **Step 3: Update the topbar title**

In `App.tsx`, the topbar title button currently is:

```tsx
          <button className="topbar-title" title="Chat history" onClick={() => setMenuOpen((o) => !o)}>
            <span className="topbar-title-text">{title}</span>
            <svg … chevron …/>
          </button>
```

Replace with:

```tsx
          <button className={`topbar-title ${updatedCount > 0 ? 'has-update' : ''}`} title="Chat history" onClick={() => setMenuOpen((o) => !o)}>
            <span className="topbar-title-text">{title}</span>
            {updatedCount > 0 && <span className="topbar-badge" aria-label={`${updatedCount} chat${updatedCount > 1 ? 's' : ''} updated`} />}
            <svg … chevron …/>
          </button>
```

- [ ] **Step 4: Add CSS**

Append to `src/ui/styles.css`:

```css
/* Background-chats affordances: pulse the title of a non-active chat that is
   currently streaming, and dot it when it finished in the background. */
.chat-menu-item.has-dot .chat-menu-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  margin-left: -2px;
}
.chat-menu-item .chat-menu-title {
  flex: 1 1 auto;
}
@keyframes pulse-opacity {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
.chat-menu-item.pulse .chat-menu-title {
  animation: pulse-opacity 1.6s ease-in-out infinite;
}
.topbar-badge {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: pulse-opacity 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .chat-menu-item.pulse .chat-menu-title,
  .topbar-badge {
    animation: none;
  }
}
```

- [ ] **Step 5: Build + manual check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx src/ui/styles.css
git commit -m "feat(bg-chats): dropdown pulse/dot + topbar badge"
```

---

### Task 8: Soft-cap warning toast

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/styles.css`

The cap is 5 background turns. We watch the count of `streaming` runs (excluding the active chat). When it crosses from `< 5` to `≥ 5`, we show a toast. While it stays `≥ 5`, we do not refire. If it drops back below 5 and crosses again later, we refire.

- [ ] **Step 1: Track the cap state**

In `App.tsx`, add:

```ts
  const [toast, setToast] = useState<string | null>(null)
  const wasCapped = useRef(false)
  const streamingOthers = conversations.filter(
    (c) => c.id !== conversationId && getRunState(c.id) === 'streaming',
  ).length
  useEffect(() => {
    if (streamingOthers >= 5 && !wasCapped.current) {
      wasCapped.current = true
      setToast(`${streamingOthers} chats are running in the background — your model may slow down.`)
    } else if (streamingOthers < 5) {
      wasCapped.current = false
    }
  }, [streamingOthers])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(id)
  }, [toast])
```

- [ ] **Step 2: Render the toast**

At the bottom of the App's JSX, just before `</div>` of `.app`:

```tsx
      {toast && (
        <div className="bg-cap-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
```

- [ ] **Step 3: Add CSS**

Append to `src/ui/styles.css`:

```css
.bg-cap-toast {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  z-index: 30;
  max-width: 320px;
  text-align: center;
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx src/ui/styles.css
git commit -m "feat(bg-chats): soft-cap warning toast at 5 background turns"
```

---

### Task 9: End-to-end manual verification

**Files:** none.

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual end-to-end (use the verify-extension skill)**

Use the `superpowers:verify-extension` skill. Run through the four scenarios from the spec:

1. **Streaming into a non-active chat**: open chat A, send a long prompt. Click `+` for chat B. The dropdown shows chat A pulsing. Chat A continues streaming; chat B is empty.
2. **Completion as `updated`**: while chat A streams and you are in chat B, wait for A to finish. The dropdown's A row stops pulsing and gets a dot. The topbar (showing B) shows a pulsing badge.
3. **View clears the dot**: click chat A in the dropdown. The badge disappears; A's row loses its dot; chat A shows the full reply.
4. **Approval parks a background turn**: open chat A, send a prompt that triggers a tool approval. Switch to chat B. The dropdown's A row stays `pulse` (state is still `streaming` — parked). Switch back to A. The approval card is visible; resolve it; A continues.
5. **Soft cap**: in the same panel, start 6 streaming chats. The 6th start shows a one-time toast. All 6 keep running.

- [ ] **Step 4: Commit any small fixes**

If the manual run surfaced a small UI or behavior bug (no spec change, no architecture change), fix and commit. Otherwise, do nothing.

---

## Self-review

1. **Spec coverage:**
   - State machine `idle | streaming | updated` — Tasks 2, 3, 4.
   - `streaming` only set while running; `updated` only set when non-active at completion — Task 4.
   - `discardUpdated()` on mount clears `updated` — Task 6 (Chat's mount effect).
   - Dropdown pulse/dot — Task 7.
   - Topbar badge — Task 7.
   - Soft cap at 5 with one-time toast — Task 8.
   - Approval cards on non-active chats park the turn (no cross-chat approval) — implied by Task 3's `runTurnChain` (the existing `requestApproval` semantics; we do not change them).
   - Page-control session on non-active chats — same: `createPageControlGate` is per-run; the on-page presence overlay is mounted by `RequestPageControl` regardless of which chat the panel is showing. The user must visit the chat to see the session card.
   - `key={conversationId}` removed — Task 6.
   - Runs Map lifetime — Task 5 (panel-scoped).
   - `useSyncExternalStore` in Chat — Task 6.
   - App's `runTick` bumps on every run event — Task 5.
   - Out of scope (panel close, cross-chat approval, stop on non-active): respected.

2. **Placeholders / TODOs:** none.

3. **Type consistency:**
   - `ChatRun` interface defined in Task 1, used in Tasks 2, 3, 5, 6.
   - `ChatRunSnapshot` defined in Task 1, mutated in Task 2, read in Task 6.
   - `SendOptions` defined in Task 1, used in Tasks 3, 4, 6.
   - `ChatTurnDeps` defined in Task 1, extended in Task 3, built in Task 5.
   - `setActive` is in `ChatRun` (Task 2) and called by App (Task 5).
   - `discardUpdated` is in `ChatRun` (Task 2) and called by Chat (Task 6).
   - `setResearchTasks` is in `ChatRun` (Task 1) and called by App (Task 6).

4. **Risks / known sharp edges (called out in tasks):**
   - The `runTurnChain` lift in Task 3 is the largest single change. The implementer MUST read `src/ui/Chat.tsx:1076-1269` and adapt it line by line; the structural deltas are listed in the task.
   - `useSyncExternalStore`'s third arg (server snapshot) is a fallback for SSR. We pass the same as the client; the panel does not SSR.
   - The toast's `wasCapped.current` is a ref so the effect does not loop. It is the only stateful part of the cap.
