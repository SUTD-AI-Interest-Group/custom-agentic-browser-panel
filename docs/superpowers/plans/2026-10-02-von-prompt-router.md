# Von Prompt Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a plain composer message reaches the chat model, ask Von once whether it is a quick `search` or `switch-tab` action; gate it under a one-shot "Prompt Router (beta)" policy; render handled actions as a shiny timed Von bubble; and measure zero-shot Von against a regex baseline.

**Architecture:** A pure `src/router/` core (candidates → policy → validate → plan) plus one orchestrator `runRouter` with injected deps, called from `startFreshTurn` in `src/ui/Chat.tsx` before `buildUserTurn`. Every failure returns `fallthrough`, after which `startFreshTurn` continues unchanged. The eval reuses `scripts/system1-eval/run.mjs`'s browser lab for Von and runs the heuristic in Node.

**Tech Stack:** TypeScript (strict), React 18, Vitest (jsdom), Chrome MV3 APIs (`chrome.tabs`, `chrome.windows`, `chrome.search`, `chrome.permissions`), the existing System-1 engine (`DecideRequest`/`DecideResult`), esbuild + Playwright for the eval.

**Spec:** `docs/superpowers/specs/2026-10-02-von-prompt-router-design.md`

## Global Constraints

- Von never produces text: every route the router can take is a member of a candidate set the harness built; the search query is cut from the user's words by `extractSearchQuery`, never generated.
- Policy id is exactly `PromptRouter`; label "Prompt Router — Von quick actions (beta)"; default `ask`; its own `beta` group (so no group-level setter can opt it in).
- Router cards are always `once: true` — no "Allow this chat"; `sessionAllowed`/`turnAllowed` are never consulted. Only the Settings-level `always` lets a router action run without a card.
- `ROUTE_CONFIDENCE = 0.85`, `ROUTE_TRY_CONFIDENCE = 0.5` until Task 9 replaces them with eval-fitted values.
- `DECIDE_BUDGET_MS = 300`; a cold engine falls through without waiting (and is warmed).
- The `search` permission is **optional** (`optional_permissions`), requested only from a card's Allow click; until granted, every `search` decision is carded even under `always`.
- Every router failure looks like absence: `startFreshTurn` continues to `buildUserTurn` exactly as today, and the user's bubble is never stranded (Stop is the one deliberate exception — the user asked to stop).
- The user's message is never rewritten; the history line for a handled action is past tense: `[Quick action by Lychee: searched the web for "<query>"]` / `[Quick action by Lychee: switched to the tab "<title>" (<host>)]`.
- Test runner: `npx vitest run <path>`; type check: `npm run typecheck` (never `npx tsc`); full build: `npm run build`.
- Commits: pathspec-scoped (`git commit -- <paths>`), no Co-Authored-By / Generated-with trailers.

## Review Focus

1. **A tab title carrying `[MASK]`/`[SEP]` or quotes** — must be neutralized and clipped in its option line, never break the request or smuggle a special token (pinned in Task 2).
2. **Stop pressed while a router card is up** — no chat turn starts, and nothing executes (pinned in Task 5).
3. **The chosen tab closes between decide and execute** — falls through to chat silently, no error bubble (pinned in Task 5).
4. **"search for" with nothing after it, or a 2,000-char message** — no `search` option offered for the empty query; the state is clipped at 300 chars (pinned in Tasks 2 and 4).
5. **Switching to a tab in another window** — that window is focused as well, otherwise the user sees nothing happen (pinned in Task 5).

---

### Task 1: Engine `booted` flag and `System1Runtime.isWarm()`

The router must fall through on a cold engine instead of paying the 1.2–6 s boot, so the runtime needs to say whether the worker is booted.

**Files:**
- Modify: `src/system1/engine.ts` (class `System1Engine`)
- Modify: `src/system1/runtime.ts` (interface `System1Runtime`, `resolveSystem1`)
- Test: `src/system1/engine.test.ts`

**Interfaces:**
- Produces: `System1Engine#booted: boolean` (getter); `System1Runtime.isWarm(): boolean`.

- [ ] **Step 1: Write the failing test** — append inside `describe('System1Engine', …)` in `src/system1/engine.test.ts`:

```ts
  it('booted is false before boot, true after warm(), false again after dispose()', async () => {
    vi.useFakeTimers()
    stubCaches()
    const engine = new System1Engine(() => new FakeWorker(() => 'ok'))
    expect(engine.booted).toBe(false)
    await engine.warm()
    expect(engine.booted).toBe(true)
    engine.dispose()
    expect(engine.booted).toBe(false)
  })

  it('booted stays false after a failed boot', async () => {
    vi.useFakeTimers()
    stubCaches()
    const engine = new System1Engine(() => new FakeWorker(() => 'boot-fail'))
    await engine.warm()
    expect(engine.booted).toBe(false)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/system1/engine.test.ts`
Expected: FAIL — `engine.booted` is `undefined`.

- [ ] **Step 3: Implement.** In `System1Engine` add a field and getter next to `_healthy`:

```ts
  private _booted = false
  /** True once the worker has answered `ready` and has not since been torn down — a decide will not pay the boot. */
  get booted() {
    return this._booted
  }
```

In `boot()`, immediately after `this.failedAt = 0` add `this._booted = true`. In `destroy()`, add `this._booted = false` as its first line.

In `src/system1/runtime.ts`, extend the interface:

```ts
  /** Whether the engine is booted right now. A caller with a hard latency budget falls through when this is false (and calls warm()). */
  isWarm(): boolean
```

and the return in `resolveSystem1`:

```ts
    return { decide: (req) => engine.decide(req), warm: () => void engine.warm(), isWarm: () => engine.booted }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/system1/engine.test.ts && npm run typecheck`
Expected: PASS, no type errors. (If `typecheck` flags another object literal typed `System1Runtime` — e.g. in `scripts/system1-eval/` or a test — add `isWarm: () => true` there.)

- [ ] **Step 5: Commit**

```bash
git add src/system1/engine.ts src/system1/runtime.ts src/system1/engine.test.ts
git commit -m "feat(system1): engine.booted + System1Runtime.isWarm() — lets a latency-budgeted caller fall through on a cold engine" -- src/system1/engine.ts src/system1/runtime.ts src/system1/engine.test.ts
```

---

### Task 2: Search-query extraction and the route candidate set

**Files:**
- Create: `src/router/query.ts`, `src/router/candidates.ts`
- Test: `src/router/query.test.ts`, `src/router/candidates.test.ts`

**Interfaces:**
- Consumes: `neutralize` from `src/system1/vonPolicy.ts`, `clip` from `src/system1/observation.ts`.
- Produces:
  - `extractSearchQuery(message: string): string | null`
  - `interface RouteTab { id: number; title: string; url: string; lastAccessed?: number }`
  - `type RouteCandidate = ChatCandidate | SearchCandidate | TabCandidate` with
    `ChatCandidate = { key: 'chat'; kind: 'chat'; text: string }`,
    `SearchCandidate = { key: 'search'; kind: 'search'; text: string; query: string }`,
    `TabCandidate = { key: \`tab:${number}\`; kind: 'switch-tab'; text: string; tabId: number; title: string; host: string }`
  - `type ActionCandidate = SearchCandidate | TabCandidate`
  - `MAX_TAB_OPTIONS = 40`
  - `buildRouteCandidates(message: string, tabs: readonly RouteTab[], currentTabId?: number): RouteCandidate[]` — `chat` always first.

- [ ] **Step 1: Write the failing tests**

`src/router/query.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractSearchQuery } from './query'

describe('extractSearchQuery', () => {
  it.each([
    ['search for rust lifetimes', 'rust lifetimes'],
    ['Search the web for best ramen in Tokyo?', 'best ramen in Tokyo'],
    ['look up the weather in Paris', 'the weather in Paris'],
    ['google   transformer attention  ', 'transformer attention'],
    ['please search for  sutd library hours.', 'sutd library hours'],
    ['can you look up mdn fetch api', 'mdn fetch api'],
    ['rust lifetimes', 'rust lifetimes'],
  ])('%s → %s', (msg, q) => expect(extractSearchQuery(msg)).toBe(q))

  it('returns null when nothing is left after the command', () => {
    expect(extractSearchQuery('search for')).toBeNull()
    expect(extractSearchQuery('look up ?')).toBeNull()
    expect(extractSearchQuery('   ')).toBeNull()
  })

  it('caps the query at 200 characters', () => {
    expect(extractSearchQuery(`search for ${'a'.repeat(500)}`)!.length).toBeLessThanOrEqual(200)
  })
})
```

`src/router/candidates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRouteCandidates, MAX_TAB_OPTIONS, type RouteTab } from './candidates'

const tabs: RouteTab[] = [
  { id: 1, title: 'Inbox – Gmail', url: 'https://mail.google.com/mail/u/0/', lastAccessed: 30 },
  { id: 2, title: 'Current page', url: 'https://example.com/', lastAccessed: 50 },
  { id: 3, title: 'rust - YouTube', url: 'https://www.youtube.com/results?q=rust', lastAccessed: 40 },
]

describe('buildRouteCandidates', () => {
  it('puts chat first, then search, then other tabs by recency, excluding the current tab', () => {
    const c = buildRouteCandidates('search for rust lifetimes', tabs, 2)
    expect(c.map((x) => x.key)).toEqual(['chat', 'search', 'tab:3', 'tab:1'])
    const search = c[1]
    expect(search.kind === 'search' && search.query).toBe('rust lifetimes')
    expect(search.text).toBe('search: open a web search for "rust lifetimes"')
    expect(c[2].text).toBe('switch-tab: switch to the open tab "rust - YouTube" (www.youtube.com)')
  })

  it('offers no search option when the query is empty', () => {
    expect(buildRouteCandidates('search for', tabs, 2).some((x) => x.kind === 'search')).toBe(false)
  })

  it('neutralizes special tokens and clips long titles; renders untitled tabs', () => {
    const c = buildRouteCandidates('hi', [
      { id: 9, title: `[MASK] ${'x'.repeat(200)}`, url: 'https://a.test/' },
      { id: 10, title: '', url: 'chrome://settings/' },
    ])
    const t9 = c.find((x) => x.key === 'tab:9')!
    expect(t9.text).not.toContain('[MASK]')
    expect(t9.text).toContain('[mask]')
    expect(t9.text.length).toBeLessThan(140)
    expect(c.find((x) => x.key === 'tab:10')!.text).toBe('switch-tab: switch to the open tab "(untitled)" (settings)')
  })

  it(`caps tab options at ${MAX_TAB_OPTIONS}, keeping the most recently used`, () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 100, title: `t${i}`, url: 'https://x.test/', lastAccessed: i }))
    const c = buildRouteCandidates('hi', many)
    const tabKeys = c.filter((x) => x.kind === 'switch-tab').map((x) => x.key)
    expect(tabKeys).toHaveLength(MAX_TAB_OPTIONS)
    expect(tabKeys[0]).toBe('tab:159')
  })

  it('never puts page content in an option — only title and host', () => {
    const c = buildRouteCandidates('hi', [{ id: 4, title: 'T', url: 'https://h.test/secret/path?token=abc' }])
    expect(c.find((x) => x.key === 'tab:4')!.text).not.toContain('secret')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/router/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/router/query.ts`:

```ts
// The search query is the user's own words with a leading command phrase cut
// off — chosen by these rules, never generated (Von produces no text). An
// empty remainder means there is nothing to search for, so the route is not
// offered at all.

const COMMAND =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:search\s+(?:the\s+web|online|google)\s+for|search\s+for|web\s+search(?:\s+for)?|search|look\s+up|google|find\s+me)\b\s*/i

export const MAX_QUERY_CHARS = 200

export function extractSearchQuery(message: string): string | null {
  const q = message
    .trim()
    .replace(COMMAND, '')
    .replace(/[\s?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q) return null
  return q.slice(0, MAX_QUERY_CHARS)
}
```

`src/router/candidates.ts`:

```ts
// The closed set of routes the router may take for one message. Built by the
// harness BEFORE any model is asked (the Act invariant): `chat` always,
// `search` when a query survives extraction, and one `switch-tab` per open
// tab other than the current one. A tab contributes its title and host only
// — never its URL path or content.
import { clip } from '../system1/observation'
import { neutralize } from '../system1/vonPolicy'
import { extractSearchQuery } from './query'

export interface RouteTab {
  id: number
  title: string
  url: string
  lastAccessed?: number
}

export interface ChatCandidate { key: 'chat'; kind: 'chat'; text: string }
export interface SearchCandidate { key: 'search'; kind: 'search'; text: string; query: string }
export interface TabCandidate { key: `tab:${number}`; kind: 'switch-tab'; text: string; tabId: number; title: string; host: string }
export type RouteCandidate = ChatCandidate | SearchCandidate | TabCandidate
export type ActionCandidate = SearchCandidate | TabCandidate

/** ~25 tokens per tab option keeps the whole request far under Von's window. */
export const MAX_TAB_OPTIONS = 40

export const CHAT_TEXT = 'chat: answer, explain, or do anything else with the assistant'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function buildRouteCandidates(message: string, tabs: readonly RouteTab[], currentTabId?: number): RouteCandidate[] {
  const out: RouteCandidate[] = [{ key: 'chat', kind: 'chat', text: CHAT_TEXT }]
  const query = extractSearchQuery(message)
  if (query) out.push({ key: 'search', kind: 'search', query, text: `search: open a web search for "${clip(neutralize(query), 120)}"` })
  const others = tabs
    .filter((t) => t.id !== currentTabId)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, MAX_TAB_OPTIONS)
  for (const t of others) {
    const title = t.title.trim() || '(untitled)'
    const host = hostOf(t.url)
    out.push({
      key: `tab:${t.id}`,
      kind: 'switch-tab',
      tabId: t.id,
      title,
      host,
      text: `switch-tab: switch to the open tab "${clip(neutralize(title), 80)}" (${host})`,
    })
  }
  return out
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/router/`
Expected: PASS. If the `chrome://settings/` case gives a host other than `settings` under jsdom's URL, adjust only the expectation in that test to what `new URL('chrome://settings/').host` returns in Node (`node -e "console.log(new URL('chrome://settings/').host)"`) — the rule is "host as `URL` reports it".

- [ ] **Step 5: Commit**

```bash
git add src/router/query.ts src/router/candidates.ts src/router/query.test.ts src/router/candidates.test.ts
git commit -m "feat(router): search-query extraction and the closed route candidate set" -- src/router/query.ts src/router/candidates.ts src/router/query.test.ts src/router/candidates.test.ts
```

---

### Task 3: Membership validation and the band × policy plan

**Files:**
- Create: `src/router/validate.ts`, `src/router/plan.ts`
- Test: `src/router/validate.test.ts`, `src/router/plan.test.ts`

**Interfaces:**
- Consumes: `RouteCandidate` (Task 2), `ToolPolicy` from `src/data/settings.ts`.
- Produces:
  - `validateRoute(key: string, candidates: readonly RouteCandidate[]): RouteCandidate` (non-member → the `chat` candidate)
  - `ROUTE_CONFIDENCE = 0.85`, `ROUTE_TRY_CONFIDENCE = 0.5`
  - `type RoutePlan = 'run' | 'card' | 'chat'`
  - `planRoute(a: { kind: RouteCandidate['kind']; top: number; policy: ToolPolicy; searchPermitted: boolean }): RoutePlan`

- [ ] **Step 1: Write the failing tests**

`src/router/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRouteCandidates } from './candidates'
import { validateRoute } from './validate'

const c = buildRouteCandidates('search for x', [{ id: 7, title: 'T', url: 'https://t.test/' }])

describe('validateRoute', () => {
  it('returns the member candidate', () => {
    expect(validateRoute('tab:7', c).key).toBe('tab:7')
    expect(validateRoute('search', c).key).toBe('search')
  })
  it('maps anything outside the set to chat', () => {
    expect(validateRoute('tab:8', c).kind).toBe('chat')
    expect(validateRoute('', c).kind).toBe('chat')
    expect(validateRoute('__proto__', c).kind).toBe('chat')
  })
})
```

`src/router/plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planRoute, ROUTE_CONFIDENCE as HI, ROUTE_TRY_CONFIDENCE as LO } from './plan'

const mid = (HI + LO) / 2
const low = LO / 2

describe('planRoute — spec §4 table', () => {
  it.each([
    // kind, top, policy, searchPermitted, expected
    ['chat', 0.99, 'always', true, 'chat'],
    ['chat', 0.99, 'ask', true, 'chat'],
    ['switch-tab', HI, 'always', true, 'run'],
    ['switch-tab', HI, 'ask', true, 'card'],
    ['switch-tab', mid, 'always', true, 'card'],
    ['switch-tab', mid, 'ask', true, 'card'],
    ['switch-tab', low, 'always', true, 'chat'],
    ['switch-tab', low, 'ask', true, 'chat'],
    ['search', HI, 'always', true, 'run'],
    ['search', HI, 'always', false, 'card'], // first use: the card is the only gesture that can grant `search`
    ['search', mid, 'always', false, 'card'],
    ['search', low, 'always', false, 'chat'],
    ['search', 0.99, 'never', true, 'chat'],
    ['switch-tab', 0.99, 'never', true, 'chat'],
  ] as const)('%s @%s under %s (search permitted: %s) → %s', (kind, top, policy, searchPermitted, expected) => {
    expect(planRoute({ kind, top, policy, searchPermitted })).toBe(expected)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/router/validate.test.ts src/router/plan.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/router/validate.ts`:

```ts
// The router never trusts its policy: a key that is not a member of the set
// the harness built becomes `chat` — the one route that does nothing.
import type { RouteCandidate } from './candidates'

export function validateRoute(key: string, candidates: readonly RouteCandidate[]): RouteCandidate {
  const chat = candidates.find((c) => c.kind === 'chat')!
  return candidates.find((c) => c.key === key) ?? chat
}
```

`src/router/plan.ts`:

```ts
// Spec §4 in one function: what a decision may do under the user's policy.
// `never` → nothing (the caller does not even run the router); `ask` → a card
// above the floor; `always` → no card only in the high band, and never for a
// `search` before Chrome's optional `search` permission is granted — the card's
// Allow click is the only user gesture that can request it.
import type { ToolPolicy } from '../data/settings'
import type { RouteCandidate } from './candidates'

/** Conservative until the eval fits them (scripts/router-eval/README.md). */
export const ROUTE_CONFIDENCE = 0.85
export const ROUTE_TRY_CONFIDENCE = 0.5

export type RoutePlan = 'run' | 'card' | 'chat'

export function planRoute(a: { kind: RouteCandidate['kind']; top: number; policy: ToolPolicy; searchPermitted: boolean }): RoutePlan {
  if (a.policy === 'never' || a.kind === 'chat') return 'chat'
  if (a.top < ROUTE_TRY_CONFIDENCE) return 'chat'
  if (a.policy === 'always' && a.top >= ROUTE_CONFIDENCE && (a.kind !== 'search' || a.searchPermitted)) return 'run'
  return 'card'
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/router/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router/validate.ts src/router/plan.ts src/router/validate.test.ts src/router/plan.test.ts
git commit -m "feat(router): membership validation and the band × policy plan" -- src/router/validate.ts src/router/plan.ts src/router/validate.test.ts src/router/plan.test.ts
```

---

### Task 4: The `RoutePolicy` interface, the Von adapter and the regex baseline

**Files:**
- Create: `src/router/policy.ts`, `src/router/vonRoutePolicy.ts`, `src/router/heuristicPolicy.ts`
- Test: `src/router/vonRoutePolicy.test.ts`, `src/router/heuristicPolicy.test.ts`

**Interfaces:**
- Consumes: `RouteCandidate` (Task 2); `DecideRequest`, `DecideResult` from `src/system1/protocol.ts`; `neutralize` (vonPolicy.ts), `clip` (observation.ts).
- Produces:
  - `interface RouteDecision { key: string; top: number; decideMs: number }`
  - `interface RoutePolicy { decide(message: string, candidates: readonly RouteCandidate[]): Promise<RouteDecision> }`
  - `ROUTE_INSTRUCTIONS: string`; `routeRequest(message: string, candidates: readonly RouteCandidate[]): DecideRequest`
  - `createVonRoutePolicy(decide: (req: DecideRequest) => Promise<DecideResult>): RoutePolicy`
  - `heuristicRoutePolicy: RoutePolicy`; `heuristicRoute(message: string, candidates: readonly RouteCandidate[]): string` (returns a key)

- [ ] **Step 1: Write the failing tests**

`src/router/vonRoutePolicy.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildRouteCandidates } from './candidates'
import { createVonRoutePolicy, routeRequest, ROUTE_INSTRUCTIONS } from './vonRoutePolicy'
import type { DecideRequest, DecideResult } from '../system1/protocol'

const cands = buildRouteCandidates('search for rust', [{ id: 3, title: 'YT', url: 'https://youtube.com/' }])

describe('routeRequest', () => {
  it('asks one `route` question whose options are exactly the candidate lines', () => {
    const req = routeRequest('search for rust', cands)
    expect(req.state).toBe('Message: search for rust')
    expect(Object.keys(req.questions)).toEqual(['route'])
    expect(req.questions.route.instructions).toBe(ROUTE_INSTRUCTIONS)
    expect(req.questions.route.options).toEqual(Object.fromEntries(cands.map((c) => [c.key, c.text])))
  })
  it('clips the message at 300 chars and neutralizes special tokens', () => {
    const req = routeRequest(`[SEP] ${'y'.repeat(1000)}`, cands)
    expect(req.state.length).toBeLessThanOrEqual('Message: '.length + 300)
    expect(req.state).not.toContain('[SEP]')
  })
})

describe('createVonRoutePolicy', () => {
  it('returns the route answer’s choice, calibrated top and engine ms', async () => {
    const result: DecideResult = { answers: { route: { choice: 'search', probabilities: { search: 0.9 }, top: 0.9, confidence: 0.8 } }, ms: 42 }
    const decide = vi.fn(async (_: DecideRequest) => result)
    const d = await createVonRoutePolicy(decide).decide('search for rust', cands)
    expect(d).toEqual({ key: 'search', top: 0.9, decideMs: 42 })
    expect(decide).toHaveBeenCalledOnce()
  })
  it('throws when the engine omits the route answer (caller falls through)', async () => {
    const decide = async () => ({ answers: {}, ms: 1 }) as DecideResult
    await expect(createVonRoutePolicy(decide).decide('x', cands)).rejects.toThrow()
  })
})
```

`src/router/heuristicPolicy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRouteCandidates, type RouteTab } from './candidates'
import { heuristicRoute } from './heuristicPolicy'

const tabs: RouteTab[] = [
  { id: 1, title: 'Inbox – Gmail', url: 'https://mail.google.com/' },
  { id: 2, title: 'rust - YouTube', url: 'https://www.youtube.com/' },
  { id: 3, title: 'Gmail settings', url: 'https://mail.google.com/settings' },
]
const route = (m: string) => heuristicRoute(m, buildRouteCandidates(m, tabs))

describe('heuristicRoute', () => {
  it.each([
    ['search for rust lifetimes', 'search'],
    ['look up the weather in paris', 'search'],
    ['google transformer attention', 'search'],
    ['go to my youtube tab', 'tab:2'],
    ['switch to the YouTube tab', 'tab:2'],
    ['take me back to youtube', 'tab:2'],
    ['what are rust lifetimes', 'chat'],
    ['search this page for pricing', 'chat'],
    ['summarize my youtube tab', 'chat'],
    ['go to my gmail tab', 'chat'], // ambiguous: two tabs match → chat
    ['go to my twitter tab', 'chat'], // not open
  ])('%s → %s', (m, key) => expect(route(m)).toBe(key))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/router/vonRoutePolicy.test.ts src/router/heuristicPolicy.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/router/policy.ts`:

```ts
// The boundary between the router and any routing model, mirroring
// src/system1/policy.ts: given the message and the FINITE candidate set,
// return one key and a confidence. Von and the regex baseline implement it
// and are scored on identical inputs (scripts/router-eval/). The router never
// trusts an adapter: validate.ts checks membership before anything runs.
import type { RouteCandidate } from './candidates'

export interface RouteDecision {
  key: string
  /** Calibrated top probability — what the bands in plan.ts compare against. */
  top: number
  decideMs: number
}

export interface RoutePolicy {
  decide(message: string, candidates: readonly RouteCandidate[]): Promise<RouteDecision>
}
```

`src/router/vonRoutePolicy.ts`:

```ts
// Von as a zero-shot router on the pinned act-head weights: ONE question,
// options = the candidate lines, state = the message. Von 1.2 scores each
// option against the prefix alone, so every line carries its own meaning.
import { clip } from '../system1/observation'
import type { DecideRequest, DecideResult } from '../system1/protocol'
import { neutralize } from '../system1/vonPolicy'
import type { RouteCandidate } from './candidates'
import type { RoutePolicy } from './policy'

export const ROUTE_INSTRUCTIONS = "Choose what to do with the user's message: a quick browser action, or hand it to the assistant."

export function routeRequest(message: string, candidates: readonly RouteCandidate[]): DecideRequest {
  return {
    state: `Message: ${neutralize(clip(message.trim(), 300))}`,
    questions: { route: { instructions: ROUTE_INSTRUCTIONS, options: Object.fromEntries(candidates.map((c) => [c.key, c.text])) } },
  }
}

export function createVonRoutePolicy(decide: (req: DecideRequest) => Promise<DecideResult>): RoutePolicy {
  return {
    async decide(message, candidates) {
      const r = await decide(routeRequest(message, candidates))
      const a = r.answers.route
      if (!a) throw new Error('the engine returned no route answer')
      return { key: a.choice, top: a.top, decideMs: r.ms }
    },
  }
}
```

`src/router/heuristicPolicy.ts`:

```ts
// The regex baseline Von must beat (spec §7). Eval-only: never wired into the
// product. Confidence is 1 for whatever it picks — it has no notion of doubt.
import type { RouteCandidate } from './candidates'
import type { RoutePolicy } from './policy'

const SEARCH = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:search(?:\s+(?:the\s+web|online|google))?\s+for|look\s+up|google)\s+\S/i
const IN_PAGE = /\b(?:this|the|current)\s+(?:page|site|tab|doc(?:ument)?|pdf)\b/i
const SWITCH = /^(?:please\s+)?(?:go|switch|jump|take\s+me)\s+(?:back\s+)?to\s+(?:my\s+|the\s+)?(.+?)(?:\s+tab)?[.!?]?$/i

export function heuristicRoute(message: string, candidates: readonly RouteCandidate[]): string {
  const m = message.trim()
  if (SEARCH.test(m) && !IN_PAGE.test(m) && candidates.some((c) => c.kind === 'search')) return 'search'
  const s = m.match(SWITCH)
  if (s) {
    const term = s[1].toLowerCase()
    const hits = candidates.filter((c) => c.kind === 'switch-tab' && (c.title.toLowerCase().includes(term) || c.host.toLowerCase().includes(term)))
    if (hits.length === 1) return hits[0].key
  }
  return 'chat'
}

export const heuristicRoutePolicy: RoutePolicy = {
  async decide(message, candidates) {
    return { key: heuristicRoute(message, candidates), top: 1, decideMs: 0 }
  },
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/router/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router/policy.ts src/router/vonRoutePolicy.ts src/router/heuristicPolicy.ts src/router/vonRoutePolicy.test.ts src/router/heuristicPolicy.test.ts
git commit -m "feat(router): RoutePolicy boundary, zero-shot Von adapter and the regex baseline" -- src/router/policy.ts src/router/vonRoutePolicy.ts src/router/heuristicPolicy.ts src/router/vonRoutePolicy.test.ts src/router/heuristicPolicy.test.ts
```

---

### Task 5: `runRouter` orchestrator, the approval request, and the Chrome executor

**Files:**
- Create: `src/router/run.ts`, `src/router/execute.ts`
- Modify: `src/tools/tools.ts` (`ApprovalRequest`: widen `via`, add `allowLabel`/`denyLabel`)
- Test: `src/router/run.test.ts`, `src/router/execute.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4; `ApprovalRequest` from `src/tools/tools.ts`; `ToolPolicy`.
- Produces:
  - `ApprovalRequest.via?: 'Act' | 'Von'`, `ApprovalRequest.allowLabel?: string`, `ApprovalRequest.denyLabel?: string`
  - `DECIDE_BUDGET_MS = 300`
  - `interface RouterInput { message: string; tabs: RouteTab[]; currentTabId?: number }`
  - `interface RouterDeps { policy: RoutePolicy; toolPolicy: ToolPolicy; searchPermitted: () => Promise<boolean>; approve: (req: ApprovalRequest) => Promise<boolean>; execute: (route: ActionCandidate) => Promise<void>; signal: AbortSignal; now?: () => number; budgetMs?: number }`
  - `interface RouteTiming { decideMs: number; actMs: number; top: number }`
  - `type FallthroughReason = 'never' | 'cold' | 'chat' | 'low-confidence' | 'timeout' | 'engine-error' | 'declined' | 'execute-failed'`
  - `type RouterOutcome = { kind: 'handled'; route: ActionCandidate; timing: RouteTiming } | { kind: 'fallthrough'; reason: FallthroughReason } | { kind: 'stopped' }`
  - `routeApproval(route: ActionCandidate, needsSearchPermission: boolean): ApprovalRequest`
  - `routeHistoryLine(route: ActionCandidate): string`; `routeBubbleText(route: ActionCandidate): string`
  - `runRouter(input: RouterInput, deps: RouterDeps): Promise<RouterOutcome>`
  - `executeRoute(route: ActionCandidate): Promise<void>`; `searchPermitted(): Promise<boolean>`

- [ ] **Step 1: Widen `ApprovalRequest`** in `src/tools/tools.ts` — replace the `via?: 'Act'` member and its doc comment with:

```ts
  /**
   * Set when the decision came from the local System-1 model rather than the
   * chat model: `'Act'` for a step inside an `Act` call, `'Von'` for a Prompt
   * Router quick action. Purely a label for the card (a badge and ring); it
   * changes nothing about the gate itself.
   */
  via?: 'Act' | 'Von'
  /** Primary-button label; defaults to "Allow". */
  allowLabel?: string
  /** Deny-button label; defaults to "Deny". */
  denyLabel?: string
```

Run `npm run typecheck` — expected clean (only `=== 'Act'` comparisons exist).

- [ ] **Step 2: Write the failing tests**

`src/router/run.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { runRouter, routeApproval, routeHistoryLine, type RouterDeps } from './run'
import type { RoutePolicy } from './policy'
import type { RouteTab } from './candidates'

const tabs: RouteTab[] = [{ id: 5, title: 'Inbox – Gmail', url: 'https://mail.google.com/' }]
// top 1 sits in the high band whatever Task 9 fits (its floors keep ROUTE_CONFIDENCE <= 1).
const fixed = (key: string, top = 1): RoutePolicy => ({ decide: async () => ({ key, top, decideMs: 10 }) })

function deps(over: Partial<RouterDeps> = {}): RouterDeps {
  return {
    policy: fixed('search'),
    toolPolicy: 'always',
    searchPermitted: async () => true,
    approve: vi.fn(async () => true),
    execute: vi.fn(async () => {}),
    signal: new AbortController().signal,
    ...over,
  }
}
const input = { message: 'search for rust', tabs, currentTabId: 1 }

describe('runRouter', () => {
  it('runs a high-confidence action under `always` with no card', async () => {
    const d = deps()
    const out = await runRouter(input, d)
    expect(out.kind).toBe('handled')
    expect(d.approve).not.toHaveBeenCalled()
    expect(d.execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'search', query: 'rust' }))
  })

  it('always cards under `ask`, one-shot, Von-labelled', async () => {
    const d = deps({ toolPolicy: 'ask' })
    await runRouter(input, d)
    expect(d.approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'PromptRouter', once: true, via: 'Von' }))
  })

  it('cards a first-use search under `always` and asks for the permission', async () => {
    const d = deps({ searchPermitted: async () => false })
    await runRouter(input, d)
    expect(d.approve).toHaveBeenCalledWith(expect.objectContaining({ needsPermissions: ['search'] }))
  })

  it('does not run the policy at all under `never`', async () => {
    const decide = vi.fn()
    const out = await runRouter(input, deps({ toolPolicy: 'never', policy: { decide } }))
    expect(out).toEqual({ kind: 'fallthrough', reason: 'never' })
    expect(decide).not.toHaveBeenCalled()
  })

  it.each([
    ['chat route', deps({ policy: fixed('chat') }), 'chat'],
    ['low confidence', deps({ policy: fixed('search', 0.1) }), 'low-confidence'],
    ['non-member key', deps({ policy: fixed('tab:999') }), 'chat'],
    ['engine throws', deps({ policy: { decide: async () => { throw new Error('boom') } } }), 'engine-error'],
    ['declined card', deps({ toolPolicy: 'ask', approve: async () => false }), 'declined'],
    ['tab closed before execute', deps({ policy: fixed('tab:5'), execute: async () => { throw new Error('No tab with id: 5') } }), 'execute-failed'],
  ] as const)('falls through on %s', async (_, d, reason) => {
    expect(await runRouter(input, d)).toEqual({ kind: 'fallthrough', reason })
  })

  it('falls through when decide exceeds the budget', async () => {
    vi.useFakeTimers()
    const slow: RoutePolicy = { decide: () => new Promise((r) => setTimeout(() => r({ key: 'search', top: 1, decideMs: 900 }), 900)) }
    const p = runRouter(input, deps({ policy: slow, budgetMs: 300 }))
    await vi.advanceTimersByTimeAsync(301)
    expect(await p).toEqual({ kind: 'fallthrough', reason: 'timeout' })
    vi.useRealTimers()
  })

  it('Stop while the card is up: stopped, nothing executes', async () => {
    const ctrl = new AbortController()
    const execute = vi.fn(async () => {})
    const approve = vi.fn(async () => { ctrl.abort(); return false })
    const out = await runRouter(input, deps({ toolPolicy: 'ask', approve, execute, signal: ctrl.signal }))
    expect(out).toEqual({ kind: 'stopped' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('timing excludes the time the card waited on the user', async () => {
    let t = 0
    const now = () => t
    const policy: RoutePolicy = { decide: async () => { t += 80; return { key: 'search', top: 0.9, decideMs: 70 } } }
    const approve = async () => { t += 10_000; return true }
    const execute = async () => { t += 20 }
    const out = await runRouter(input, deps({ toolPolicy: 'ask', policy, approve, execute, now }))
    expect(out.kind === 'handled' && out.timing).toEqual({ decideMs: 80, actMs: 20, top: 0.9 })
  })
})

describe('routeApproval / routeHistoryLine', () => {
  it('names the exact query and tab, past tense in history', async () => {
    const out = await runRouter({ ...input, message: 'go to my gmail tab' }, deps({ policy: fixed('tab:5') }))
    if (out.kind !== 'handled') throw new Error('expected handled')
    expect(routeApproval(out.route, false)).toMatchObject({ summary: 'Switch to "Inbox – Gmail"', items: [{ title: 'Inbox – Gmail', host: 'mail.google.com' }], allowLabel: 'Switch', denyLabel: 'Ask Lychee instead' })
    expect(routeHistoryLine(out.route)).toBe('[Quick action by Lychee: switched to the tab "Inbox – Gmail" (mail.google.com)]')
  })
})
```

`src/router/execute.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeRoute } from './execute'

afterEach(() => vi.unstubAllGlobals())

function stubChrome(tab: { id: number; windowId: number }) {
  const chrome = {
    tabs: { get: vi.fn(async () => tab), update: vi.fn(async () => tab) },
    windows: { update: vi.fn(async () => ({})) },
    search: { query: vi.fn(async () => {}) },
  }
  vi.stubGlobal('chrome', chrome)
  return chrome
}

describe('executeRoute', () => {
  it('switches the tab AND focuses its window (a tab in another window would otherwise switch invisibly)', async () => {
    const c = stubChrome({ id: 5, windowId: 2 })
    await executeRoute({ key: 'tab:5', kind: 'switch-tab', tabId: 5, title: 'T', host: 'h', text: '' })
    expect(c.tabs.update).toHaveBeenCalledWith(5, { active: true })
    expect(c.windows.update).toHaveBeenCalledWith(2, { focused: true })
  })
  it('searches with the user’s default engine in a new tab', async () => {
    const c = stubChrome({ id: 1, windowId: 1 })
    await executeRoute({ key: 'search', kind: 'search', query: 'rust', text: '' })
    expect(c.search.query).toHaveBeenCalledWith({ text: 'rust', disposition: 'NEW_TAB' })
  })
  it('rejects when the tab is gone (runRouter turns that into a fall-through)', async () => {
    const c = stubChrome({ id: 5, windowId: 2 })
    c.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 5'))
    await expect(executeRoute({ key: 'tab:5', kind: 'switch-tab', tabId: 5, title: 'T', host: 'h', text: '' })).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/router/run.test.ts src/router/execute.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`src/router/run.ts`:

```ts
// One router pass for one composer message: candidates → policy (under a hard
// latency budget) → membership → band × policy → card / execute. Every
// failure is a `fallthrough` — the caller then continues to the chat model
// exactly as if the router did not exist. `stopped` is the one exception:
// the user pressed Stop while a router card was up, so nothing runs at all.
import type { ToolPolicy } from '../data/settings'
import type { ApprovalRequest } from '../tools/tools'
import { buildRouteCandidates, type ActionCandidate, type RouteTab } from './candidates'
import { planRoute } from './plan'
import type { RoutePolicy } from './policy'
import { validateRoute } from './validate'

export const DECIDE_BUDGET_MS = 300

export interface RouterInput {
  message: string
  tabs: RouteTab[]
  currentTabId?: number
}

export interface RouterDeps {
  policy: RoutePolicy
  toolPolicy: ToolPolicy
  searchPermitted: () => Promise<boolean>
  approve: (req: ApprovalRequest) => Promise<boolean>
  execute: (route: ActionCandidate) => Promise<void>
  signal: AbortSignal
  now?: () => number
  budgetMs?: number
}

export interface RouteTiming {
  decideMs: number
  actMs: number
  top: number
}

export type FallthroughReason = 'never' | 'cold' | 'chat' | 'low-confidence' | 'timeout' | 'engine-error' | 'declined' | 'execute-failed'

export type RouterOutcome =
  | { kind: 'handled'; route: ActionCandidate; timing: RouteTiming }
  | { kind: 'fallthrough'; reason: FallthroughReason }
  | { kind: 'stopped' }

const fallthrough = (reason: FallthroughReason): RouterOutcome => ({ kind: 'fallthrough', reason })

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout])
}

export function routeApproval(route: ActionCandidate, needsSearchPermission: boolean): ApprovalRequest {
  const base = { toolName: 'PromptRouter', once: true, via: 'Von' as const, denyLabel: 'Ask Lychee instead' }
  if (route.kind === 'search') {
    return {
      ...base,
      summary: `Search the web for "${route.query}"`,
      reason: 'Von read your message as a quick web search. "Ask Lychee instead" sends it to the assistant.',
      allowLabel: 'Search',
      ...(needsSearchPermission ? { needsPermissions: ['search'] } : {}),
    }
  }
  return {
    ...base,
    summary: `Switch to "${route.title}"`,
    reason: 'Von read your message as switching to an open tab. "Ask Lychee instead" sends it to the assistant.',
    items: [{ title: route.title, host: route.host }],
    allowLabel: 'Switch',
  }
}

export function routeBubbleText(route: ActionCandidate): string {
  return route.kind === 'search' ? `Searched the web for "${route.query}"` : `Switched to "${route.title}"`
}

export function routeHistoryLine(route: ActionCandidate): string {
  return route.kind === 'search'
    ? `[Quick action by Lychee: searched the web for "${route.query}"]`
    : `[Quick action by Lychee: switched to the tab "${route.title}" (${route.host})]`
}

export async function runRouter(input: RouterInput, deps: RouterDeps): Promise<RouterOutcome> {
  if (deps.toolPolicy === 'never') return fallthrough('never')
  const now = deps.now ?? (() => performance.now())
  const t0 = now()
  const candidates = buildRouteCandidates(input.message, input.tabs, input.currentTabId)
  let decision
  try {
    const r = await withBudget(deps.policy.decide(input.message, candidates), deps.budgetMs ?? DECIDE_BUDGET_MS)
    if (r === 'timeout') return fallthrough('timeout')
    decision = r
  } catch {
    return fallthrough('engine-error')
  }
  const decideMs = Math.round(now() - t0)
  if (deps.signal.aborted) return { kind: 'stopped' }
  const route = validateRoute(decision.key, candidates)
  if (route.kind === 'chat') return fallthrough('chat')
  const permitted = route.kind === 'search' ? await deps.searchPermitted() : true
  const plan = planRoute({ kind: route.kind, top: decision.top, policy: deps.toolPolicy, searchPermitted: permitted })
  if (plan === 'chat') return fallthrough('low-confidence')
  if (plan === 'card') {
    const ok = await deps.approve(routeApproval(route, route.kind === 'search' && !permitted))
    if (deps.signal.aborted) return { kind: 'stopped' }
    if (!ok) return fallthrough('declined')
  }
  const t1 = now()
  try {
    await deps.execute(route)
  } catch {
    return fallthrough('execute-failed')
  }
  return { kind: 'handled', route, timing: { decideMs, actMs: Math.round(now() - t1), top: decision.top } }
}
```

`src/router/execute.ts`:

```ts
// The Chrome side of a router action. Thin on purpose: run.ts decides, this
// only does. A rejection (tab gone, search failed) becomes a fall-through.
import type { ActionCandidate } from './candidates'

export async function executeRoute(route: ActionCandidate): Promise<void> {
  if (route.kind === 'search') {
    await chrome.search.query({ text: route.query, disposition: 'NEW_TAB' })
    return
  }
  // Re-read by id right before acting: the tab may have closed since decide.
  const tab = await chrome.tabs.get(route.tabId)
  await chrome.tabs.update(route.tabId, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
}

/** Whether Chrome's optional `search` permission is already granted. */
export function searchPermitted(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ['search'] }).catch(() => false)
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/router/ && npm run typecheck`
Expected: PASS. (If `chrome.search.query` returns `void` rather than a Promise in `@types/chrome@0.0.280`, wrap it: `await new Promise<void>((resolve) => chrome.search.query({ text: route.query, disposition: 'NEW_TAB' }, resolve))` and update the test's mock to call its callback.)

- [ ] **Step 6: Commit**

```bash
git add src/router/run.ts src/router/execute.ts src/router/run.test.ts src/router/execute.test.ts src/tools/tools.ts
git commit -m "feat(router): runRouter — budgeted decide, one-shot Von card, fall-through on every failure; Chrome executor" -- src/router/run.ts src/router/execute.ts src/router/run.test.ts src/router/execute.test.ts src/tools/tools.ts
```

---

### Task 6: The "Prompt Router (beta)" policy and the optional `search` permission

**Files:**
- Modify: `src/data/settings.ts` (`ToolGroup`, `ToolCatalogEntry`, `TOOL_CATALOG`, `GROUP_ORDER`, `GROUP_LABELS`, new `visibleCatalog`)
- Modify: `src/ui/settings/PermissionsTab.tsx:126`, `src/ui/Chat.tsx:656` (use `visibleCatalog`)
- Modify: `manifest.json` (`optional_permissions` += `"search"`)
- Test: `src/data/settings.test.ts`

**Interfaces:**
- Produces: `ToolGroup` gains `'beta'`; `ToolCatalogEntry.requires?: 'system1'`; `visibleCatalog(settings: Settings): ToolCatalogEntry[]`; policy id `PromptRouter`.

- [ ] **Step 1: Write the failing tests** — append to `src/data/settings.test.ts` (add `visibleCatalog` to its import from `./settings`; `base()` is the file's existing helper):

```ts
describe('PromptRouter policy', () => {
  it('defaults to ask', () => {
    expect(toolPolicy(base(), 'PromptRouter')).toBe('ask')
  })

  it('is in its own beta group, so setting Navigation to always cannot opt it in', () => {
    const next = setGroupPolicy(base(), 'navigation', 'always')
    expect(toolPolicy(next, 'NavigateTab')).toBe('always')
    expect(toolPolicy(next, 'PromptRouter')).toBe('ask')
  })

  it('is only listed when System-1 is switched on', () => {
    expect(visibleCatalog(base()).some((t) => t.name === 'PromptRouter')).toBe(false)
    expect(visibleCatalog(base({ experimental: { system1: true } })).some((t) => t.name === 'PromptRouter')).toBe(true)
    expect(visibleCatalog(base()).some((t) => t.name === 'NavigateTab')).toBe(true)
  })
})
```

(If `base({ experimental: { system1: true } })` does not type-check because `experimental` has other required members, spread the file's default: check `Settings['experimental']` and pass a complete object.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/data/settings.test.ts`
Expected: FAIL — `visibleCatalog` not exported.

- [ ] **Step 3: Implement** in `src/data/settings.ts`:

```ts
export type ToolGroup = 'reading' | 'control' | 'navigation' | 'memory' | 'insights' | 'skills' | 'mcp' | 'beta'
```

Add to `ToolCatalogEntry`:

```ts
  /** Listed in the permission UI only when this feature is available (it has no effect on the policy itself). */
  requires?: 'system1'
```

Append to `TOOL_CATALOG` (after the MCP entries):

```ts
  // Not an agent tool: the Prompt Router's own gate (src/router/). Its own
  // group so no group-level setter can silently opt it into `always`.
  { name: 'PromptRouter', group: 'beta', label: 'Prompt Router — Von quick actions (beta)', requires: 'system1' },
```

Append `'beta'` to `GROUP_ORDER`, and `beta: 'Beta'` to `GROUP_LABELS`. Add below `system1Enabled`:

```ts
/** The catalog rows the permission UI should show for these settings. */
export function visibleCatalog(s: Settings): ToolCatalogEntry[] {
  return TOOL_CATALOG.filter((t) => t.requires !== 'system1' || system1Enabled(s))
}
```

In `src/ui/settings/PermissionsTab.tsx` (line ~126) and `src/ui/Chat.tsx` (line ~656) replace `TOOL_CATALOG.filter((t) => t.group === group)` with `visibleCatalog(settings).filter((t) => t.group === group)` and import `visibleCatalog` from `../../data/settings` / `../data/settings` (drop the `TOOL_CATALOG` import if it becomes unused).

In `manifest.json` add `"search"` to `optional_permissions`.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npx vitest run src/data/settings.test.ts && npm run build`
Expected: PASS; build succeeds; `grep -c '"search"' dist/manifest.json` → `1`.

- [ ] **Step 5: Commit**

```bash
git add src/data/settings.ts src/data/settings.test.ts src/ui/settings/PermissionsTab.tsx src/ui/Chat.tsx manifest.json
git commit -m "feat(settings): Prompt Router (beta) policy in its own group, shown only with System-1; optional search permission" -- src/data/settings.ts src/data/settings.test.ts src/ui/settings/PermissionsTab.tsx src/ui/Chat.tsx manifest.json
```

---

### Task 7: Wire the router into `startFreshTurn`, the Von card and the Von bubble

**Files:**
- Modify: `src/agent/agent.ts` (`UIMessage`: `handledBy`, `vonTiming`)
- Modify: `src/ui/Chat.tsx` (state/refs, `tryRouter`, `startFreshTurn`, `submit`/`handleComposerAction`/flush effect busy check, `stop`, Stop-button visibility, composer focus warm, `ApprovalCard`, `MessageView` → `VonBubble`)
- Modify: `src/ui/styles.css` (Von bubble + card ring + shimmer + reduced motion)

**Interfaces:**
- Consumes: `runRouter`, `routeBubbleText`, `routeHistoryLine`, `RouterOutcome` (Task 5); `executeRoute`, `searchPermitted` (Task 5); `createVonRoutePolicy` (Task 4); `resolveSystem1` + `isWarm()` (Task 1); `toolPolicy(settings, 'PromptRouter')` (Task 6).
- Produces: `UIMessage.handledBy?: 'von'`, `UIMessage.vonTiming?: { decideMs: number; actMs: number; top: number }`.

- [ ] **Step 1: Extend `UIMessage`** in `src/agent/agent.ts` (inside the interface, after `autoContinue`):

```ts
  /** Set on an assistant bubble the Prompt Router handled itself (src/router/) — no chat turn ran. */
  handledBy?: 'von'
  /** The router's decide + execute time (card wait excluded) and its confidence. Present iff `handledBy`. */
  vonTiming?: { decideMs: number; actMs: number; top: number }
```

- [ ] **Step 2: Add state and refs** in `Chat` next to `const [turnSeq, setTurnSeq] = useState(0)`:

```ts
  // The Prompt Router phase of a fresh turn (src/router/): deciding, or a
  // router card waiting on the user. Not `streaming` — runTurnChain bails when
  // streamingRef is set, and the router runs before it — but just as busy: a
  // submit during it queues, and Stop is shown.
  const [routing, setRouting] = useState(false)
  const routerAbortRef = useRef<AbortController | null>(null)
  // Von bubbles created in this panel session — only these play the arrival
  // shimmer, so a reloaded transcript renders them static.
  const freshVonIds = useRef(new Set<string>())
```

- [ ] **Step 3: Treat `routing` as busy.** In `submit()` and `handleComposerAction()` replace `if (streaming) setQueued(` with `if (streaming || routing) setQueued(`. In the flush effect (`if (streaming || !queued) return`) use `if (streaming || routing || !queued) return` and add `routing` to its deps array (`[streaming, routing, queued]`). Change the Stop button's guard `{streaming && (` to `{(streaming || routing) && (` and the send button's `title={streaming ? …` to `title={streaming || routing ? …`. In `stop()`, add as its last line:

```ts
    routerAbortRef.current?.abort()
```

(`drainAll(false)` already runs first, resolving a router card's `approve` with `false`; `runRouter` then sees the aborted signal and returns `stopped`.)

- [ ] **Step 4: Add `tryRouter` and `finishVonTurn`** inside `Chat`, directly above `async function startFreshTurn`:

```ts
  /**
   * The Prompt Router (src/router/, spec 2026-10-02-von-prompt-router-design.md).
   * Never throws; any failure is a fall-through and the caller continues to the
   * chat model exactly as before. A cold engine falls through (and warms) rather
   * than paying the boot inside a 300 ms budget.
   */
  async function tryRouter(text: string): Promise<RouterOutcome> {
    const settings = settingsRef.current
    const policy = toolPolicy(settings, 'PromptRouter')
    if (policy === 'never') return { kind: 'fallthrough', reason: 'never' }
    const system1 = await resolveSystem1(settings)
    if (!system1) return { kind: 'fallthrough', reason: 'engine-error' }
    if (!system1.isWarm()) {
      system1.warm()
      return { kind: 'fallthrough', reason: 'cold' }
    }
    const ctrl = new AbortController()
    routerAbortRef.current = ctrl
    setRouting(true)
    try {
      const tabs = await chrome.tabs.query({})
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      return await runRouter(
        {
          message: text,
          tabs: tabs.flatMap((t) => (t.id === undefined ? [] : [{ id: t.id, title: t.title ?? '', url: t.url ?? '', lastAccessed: t.lastAccessed }])),
          currentTabId: boundTabId ?? active?.id,
        },
        {
          policy: createVonRoutePolicy((req) => system1.decide(req)),
          toolPolicy: policy,
          searchPermitted,
          approve: requestApproval,
          execute: executeRoute,
          signal: ctrl.signal,
        },
      )
    } catch {
      return { kind: 'fallthrough', reason: 'engine-error' }
    } finally {
      routerAbortRef.current = null
      setRouting(false)
    }
  }

  /** A handled quick action: the Von bubble, the past-tense history pair, and a persist. */
  function finishVonTurn(text: string, outcome: Extract<RouterOutcome, { kind: 'handled' }>) {
    const id = uid()
    freshVonIds.current.add(id)
    setMessages((m) => [
      ...m,
      { id, role: 'assistant', parts: [{ type: 'text', text: routeBubbleText(outcome.route) }], handledBy: 'von', vonTiming: outcome.timing },
    ])
    historyRef.current.push({ role: 'user', content: text }, { role: 'assistant', content: routeHistoryLine(outcome.route) })
    setTurnSeq((n) => n + 1)
  }
```

Imports to add at the top of `Chat.tsx`:

```ts
import { runRouter, routeBubbleText, routeHistoryLine, type RouterOutcome } from '../router/run'
import { executeRoute, searchPermitted } from '../router/execute'
import { createVonRoutePolicy } from '../router/vonRoutePolicy'
```

- [ ] **Step 5: Call it from `startFreshTurn`.** Directly after `void clearAllHighlights()` and before `let built: …`, insert:

```ts
    // The Prompt Router only sees a plain message: no attachments, mentions,
    // @memory/@all or /skill — each of those is the user addressing the
    // assistant. (No page-control check is needed: a session never outlives
    // its chain — runTurnChain's outer finally ends it — so none is open here.)
    const routerEligible =
      !slashMatch && spec.attachments.length === 0 && spec.activeMentions.length === 0 && !spec.useMemory && !spec.useAll
    if (routerEligible) {
      const outcome = await tryRouter(text)
      if (outcome.kind === 'stopped') return
      if (outcome.kind === 'handled') {
        finishVonTurn(text, outcome)
        return
      }
    }
```

- [ ] **Step 6: Warm on composer focus.** On the composer `<textarea>` add (merging with any existing `onFocus`):

```tsx
onFocus={() => {
  if (toolPolicy(settingsRef.current, 'PromptRouter') !== 'never') void resolveSystem1(settingsRef.current).then((s) => s?.warm())
}}
```

- [ ] **Step 7: Von card.** In `ApprovalCard`: replace `const viaAct = approval.via === 'Act'` with

```ts
  const viaAct = approval.via === 'Act'
  const viaVon = approval.via === 'Von'
```

add `${viaVon ? 'von' : ''}` to the root `className`, render beside the Act badge

```tsx
        {viaVon && (
          <span className="von-badge" title="Proposed by the local Von model (Prompt Router), not the chat model">⚡ Von</span>
        )}
```

and use the labels: `{approval.denyLabel ?? 'Deny'}` in the deny button and `{approval.allowLabel ?? 'Allow'}` in the allow button.

- [ ] **Step 8: Von bubble.** Add a component near `MessageView`:

```tsx
function VonBubble({ message, fresh }: { message: UIMessage; fresh: boolean }) {
  const t = message.vonTiming
  const text = message.parts.find((p) => p.type === 'text')
  return (
    <div className={`msg-assistant von-bubble ${fresh ? 'von-arrive' : ''}`}>
      <div className="von-head">
        <span className="von-badge">⚡ Von</span>
        {t && (
          <span className="von-time" title={`decide ${t.decideMs} ms · act ${t.actMs} ms · confidence ${t.top.toFixed(2)}`}>
            {t.decideMs + t.actMs} ms
          </span>
        )}
      </div>
      <div className="von-text">{text && 'text' in text ? text.text : ''}</div>
    </div>
  )
}
```

Render it from the transcript, not from inside `MessageView` (whose hooks must not be skipped by an early return). In the transcript's `messages.map(…)` where `<MessageView` is rendered, branch on the message:

```tsx
m.handledBy === 'von' ? (
  <VonBubble key={m.id} message={m} fresh={freshVonIds.current.has(m.id)} />
) : (
  <MessageView /* …the existing element and props, unchanged… */ />
)
```

- [ ] **Step 9: CSS** — append to `src/ui/styles.css`:

```css
/* Prompt Router: a bubble Von handled itself (no chat turn ran). One shimmer
   sweep on arrival, then a static accent edge; reloaded transcripts are static. */
.von-bubble {
  position: relative;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 12px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  overflow: hidden;
}
.von-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.von-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.von-time { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.von-bubble.von-arrive::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, color-mix(in srgb, var(--accent) 28%, transparent) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: von-sweep 900ms ease-out 1 forwards;
  pointer-events: none;
}
.von-bubble.von-arrive .von-badge { animation: von-glow 900ms ease-out 1; }
@keyframes von-sweep { to { transform: translateX(100%); } }
@keyframes von-glow {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
  40% { box-shadow: 0 0 10px 2px color-mix(in srgb, var(--accent) 45%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
}
.approval-card.von { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .von-bubble.von-arrive::after,
  .von-bubble.von-arrive .von-badge { animation: none; }
  .von-bubble.von-arrive::after { display: none; }
}
```

- [ ] **Step 10: Typecheck, tests, build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all PASS / succeed (`src/ui/cssTokens.test.ts` must still pass — if it rejects a raw colour, the CSS above uses only tokens).

- [ ] **Step 11: Browser verification (fall-through + UI).** Use the `verify-extension` skill. With LM Studio seeded per CLAUDE.md and System-1 **off**: send "search for rust lifetimes" → a normal chat reply streams (router never ran; Permissions shows no Beta group). Then, if Von weights are available locally (`system1State` Ready), switch System-1 on, set Prompt Router to `ask`, focus the composer, send "search for rust lifetimes" → a Von card *Search the web for "rust lifetimes"* with **[Ask Lychee instead] [Search]** and no "Allow this chat"; press Stop on it → no chat reply, no new tab; send again and click **Search** → Chrome's permission prompt (first time), a new search tab, and a ⚡ Von bubble with a millisecond time that shimmers once; reload the panel → the bubble is static. While a router card is up, type and send another message → it parks as queued (not a second concurrent turn). Send "go to my <other tab> tab" with another tab open → that tab is focused (and its window, if different), the panel follows to that tab's chat; switch back → the original chat shows the ⚡ Von bubble, and it survives a panel reload (it was persisted, not lost with the switch). If no weights are available, record that the Von path was verified by unit tests only and that Task 9's eval covers it.

- [ ] **Step 12: Commit**

```bash
git add src/agent/agent.ts src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat(router): Prompt Router in startFreshTurn — Von card (one-shot), shiny timed Von bubble, past-tense history, Stop/queue while routing" -- src/agent/agent.ts src/ui/Chat.tsx src/ui/styles.css
```

---

### Task 8: Eval dataset, metrics, and the heuristic baseline

**Files:**
- Create: `scripts/router-eval/messages.jsonl`, `scripts/router-eval/tabs.json`, `scripts/router-eval/lib.ts`, `scripts/router-eval/metrics.mjs`, `scripts/router-eval/metrics.test.mjs`, `scripts/router-eval/heuristic.mjs`, `scripts/router-eval/README.md`
- Modify: `.gitignore` (`scripts/router-eval/out/`)

**Interfaces:**
- Consumes: `buildRouteCandidates`, `routeRequest`, `heuristicRoute` (Tasks 2, 4).
- Produces:
  - `lib.ts` (bundled by esbuild to `out/lib.mjs`): `export { buildRouteCandidates, routeRequest, heuristicRoute, extractSearchQuery }`
  - `metrics.mjs`: `scoreRows(rows, threshold) → { n, actionLabelled, covered, coverage, wrongAction, wrongActionRate }`, `fitThreshold(rows, maxWrongRate) → number | null`, `split(rows) → { dev, test }`
  - Row shape: `{ id, label, choice, top }` where `label`/`choice` are route keys (`chat`, `search`, `tab:<id>`).

- [ ] **Step 1: The tab fixture** — `scripts/router-eval/tabs.json` (ids are stable; `current` is excluded from candidates):

```json
{
  "current": 1,
  "tabs": [
    { "id": 1, "title": "Rust Lifetimes Explained – blog", "url": "https://blog.example.dev/rust-lifetimes" },
    { "id": 2, "title": "Inbox (3) – Gmail", "url": "https://mail.google.com/mail/u/0/" },
    { "id": 3, "title": "rust tutorial - YouTube", "url": "https://www.youtube.com/results?search_query=rust" },
    { "id": 4, "title": "Pull requests · AngKS/lychee", "url": "https://github.com/pulls" },
    { "id": 5, "title": "Google Calendar - Week of Oct 2", "url": "https://calendar.google.com/calendar/u/0/r" },
    { "id": 6, "title": "SUTD Library – Opening Hours", "url": "https://library.sutd.edu.sg/hours" },
    { "id": 7, "title": "Notion – Project notes", "url": "https://www.notion.so/project-notes" },
    { "id": 8, "title": "Amazon.sg: wireless mouse", "url": "https://www.amazon.sg/s?k=wireless+mouse" }
  ]
}
```

- [ ] **Step 2: The labelled set** — `scripts/router-eval/messages.jsonl`, one JSON object per line: `{"id":"s001","text":"…","label":"search"|"tab:<id>"|"chat","class":"<class>"}`. Write **at least 300 lines**, hand-authored, with these minimum counts per `class` (the hard negatives are the point):

| class | label | min | examples |
|---|---|---|---|
| `search-cmd` | `search` | 60 | "search for rust lifetimes", "look up sutd fees 2026", "google best mechanical keyboard", "can you search the web for wasm threads" |
| `switch-cmd` | `tab:<id>` | 50 | "go to my gmail tab" → `tab:2`, "switch to youtube" → `tab:3`, "take me back to the calendar" → `tab:5`, "open my notion tab" → `tab:7` |
| `question` | `chat` | 50 | "what are rust lifetimes", "who won the f1 race yesterday", "how do I center a div" |
| `in-page` | `chat` | 40 | "search this page for pricing", "find the refund section", "look up the author on this page" |
| `tab-talk` | `chat` | 40 | "summarize my gmail tab", "close the youtube tab", "what's in my notion tab", "compare the amazon tab with this one" |
| `absent-tab` | `chat` | 25 | "go to my twitter tab", "switch to spotify" |
| `chitchat` | `chat` | 20 | "thanks!", "hello lychee", "that was wrong" |
| `ambiguous` | `chat` | 15 | "go to my google tab" (calendar *and* gmail), "search" |

Optionally draft extra candidates with LM Studio (`google/gemma-4-26b-a4b`, CLAUDE.md's endpoint) — but every line must be read and labelled by hand before it is committed; a model-labelled line is not a label.

- [ ] **Step 3: The bundle entry** — `scripts/router-eval/lib.ts`:

```ts
// Node-side entry for the router eval: the SHIPPED candidate builder, request
// renderer and baseline, bundled by esbuild so the eval cannot drift from src/.
export { buildRouteCandidates } from '../../src/router/candidates'
export { extractSearchQuery } from '../../src/router/query'
export { routeRequest } from '../../src/router/vonRoutePolicy'
export { heuristicRoute } from '../../src/router/heuristicPolicy'
```

- [ ] **Step 4: Write the failing metrics test** — `scripts/router-eval/metrics.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { scoreRows, fitThreshold, split } from './metrics.mjs'

const rows = [
  { id: 'a', label: 'search', choice: 'search', top: 0.9 },
  { id: 'b', label: 'tab:2', choice: 'tab:2', top: 0.7 },
  { id: 'c', label: 'chat', choice: 'search', top: 0.8 }, // wrong action
  { id: 'd', label: 'chat', choice: 'chat', top: 0.99 },
  { id: 'e', label: 'search', choice: 'chat', top: 0.6 },
]

describe('scoreRows', () => {
  it('counts coverage over action-labelled rows and wrong actions over all rows, at a threshold', () => {
    expect(scoreRows(rows, 0.5)).toEqual({ n: 5, actionLabelled: 3, covered: 2, coverage: 2 / 3, wrongAction: 1, wrongActionRate: 1 / 5 })
    expect(scoreRows(rows, 0.85)).toEqual({ n: 5, actionLabelled: 3, covered: 1, coverage: 1 / 3, wrongAction: 0, wrongActionRate: 0 })
  })
})

describe('fitThreshold', () => {
  it('returns the lowest threshold whose wrong-action rate is within the cap', () => {
    expect(fitThreshold(rows, 0)).toBeCloseTo(0.8 + 1e-9, 6)
    expect(fitThreshold(rows, 0.2)).toBe(0)
  })
  it('returns null when no threshold meets the cap with any coverage', () => {
    expect(fitThreshold([{ id: 'x', label: 'chat', choice: 'search', top: 1 }], 0)).toBeNull()
  })
})

describe('split', () => {
  it('is deterministic and stratified by label', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, label: i % 2 ? 'chat' : 'search' }))
    const a = split(many), b = split(many)
    expect(a).toEqual(b)
    expect(a.dev.filter((r) => r.label === 'chat').length).toBe(10)
    expect(a.test.filter((r) => r.label === 'search').length).toBe(10)
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run scripts/router-eval/metrics.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement** `scripts/router-eval/metrics.mjs`:

```js
// Pure scoring for the router eval (spec §7.3). A row is one message's
// decision: { id, label, choice, top }. An "action" is any non-chat route.
// - covered: action-labelled rows routed to exactly their label at >= threshold
// - wrongAction: rows routed to a non-chat key at >= threshold that is not their label

const isAction = (k) => k !== 'chat'

export function scoreRows(rows, threshold) {
  let actionLabelled = 0, covered = 0, wrongAction = 0
  for (const r of rows) {
    if (isAction(r.label)) actionLabelled++
    const acts = isAction(r.choice) && r.top >= threshold
    if (acts && r.choice === r.label) covered++
    if (acts && r.choice !== r.label) wrongAction++
  }
  return {
    n: rows.length,
    actionLabelled,
    covered,
    coverage: actionLabelled ? covered / actionLabelled : 0,
    wrongAction,
    wrongActionRate: rows.length ? wrongAction / rows.length : 0,
  }
}

/** Lowest threshold (0, or just above an observed `top`) whose wrong-action rate is <= maxWrongRate and coverage > 0. */
export function fitThreshold(rows, maxWrongRate) {
  const candidates = [0, ...[...new Set(rows.map((r) => r.top))].sort((a, b) => a - b).map((t) => t + 1e-9)]
  for (const t of candidates) {
    const s = scoreRows(rows, t)
    if (s.wrongActionRate <= maxWrongRate && s.covered > 0) return t
  }
  return null
}

/** Deterministic 50/50 split stratified by label (alternate within each label, by id order). */
export function split(rows) {
  const byLabel = new Map()
  for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const k = r.label.startsWith('tab:') ? 'tab' : r.label
    if (!byLabel.has(k)) byLabel.set(k, [])
    byLabel.get(k).push(r)
  }
  const dev = [], test = []
  for (const list of byLabel.values()) list.forEach((r, i) => (i % 2 ? test : dev).push(r))
  return { dev, test }
}
```

Note the `fitThreshold` test's first case: with cap 0 the lowest passing threshold is just above 0.8 (row `c`), leaving `a` (0.9) covered. Adjust nothing else.

- [ ] **Step 7: Run the metrics tests**

Run: `npx vitest run scripts/router-eval/metrics.test.mjs`
Expected: PASS.

- [ ] **Step 8: Heuristic runner** — `scripts/router-eval/heuristic.mjs`:

```js
// Scores the regex baseline on the labelled set in Node (no browser needed).
// Usage: node scripts/router-eval/heuristic.mjs  → writes out/heuristic.json
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreRows, split } from './metrics.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
execFileSync(path.join(repo, 'node_modules/.bin/esbuild'), [
  path.join(here, 'lib.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${path.join(out, 'lib.mjs')}`,
])
const { buildRouteCandidates, heuristicRoute } = await import(path.join(out, 'lib.mjs'))
const { current, tabs } = JSON.parse(fs.readFileSync(path.join(here, 'tabs.json'), 'utf8'))
const messages = fs.readFileSync(path.join(here, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const rows = messages.map((m) => ({ id: m.id, class: m.class, label: m.label, choice: heuristicRoute(m.text, buildRouteCandidates(m.text, tabs, current)), top: 1 }))
const { dev, test } = split(rows)
const report = { dev: scoreRows(dev, 1), test: scoreRows(test, 1), errors: rows.filter((r) => r.choice !== r.label) }
fs.writeFileSync(path.join(out, 'heuristic.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ dev: report.dev, test: report.test, errorCount: report.errors.length }, null, 2))
```

- [ ] **Step 9: Run it**

Run: `echo 'scripts/router-eval/out/' >> .gitignore && node scripts/router-eval/heuristic.mjs`
Expected: prints dev/test coverage and wrong-action rate. Sanity check: test coverage should be well above 0 (the `search-cmd` class is regex-shaped); if it is 0, the bundle or label format is wrong — fix before continuing.

- [ ] **Step 10: README** — `scripts/router-eval/README.md`: what the set is (classes + counts table from Step 2, the tab fixture), how to run the heuristic (`node scripts/router-eval/heuristic.mjs`) and Von (Task 9), the metrics definitions from `metrics.mjs`'s header, the kill criterion copied from spec §7.4, and a **Results** section with the heuristic's dev/test numbers from Step 9 and today's date.

- [ ] **Step 11: Commit**

```bash
git add scripts/router-eval/ .gitignore
git commit -m "eval(router): labelled message set with hard negatives, pure metrics, regex baseline numbers" -- scripts/router-eval/ .gitignore
```

---

### Task 9: Von's numbers, fitted thresholds, the kill-criterion verdict

**Files:**
- Modify: `scripts/system1-eval/run.mjs` (new `route` phase), `scripts/router-eval/README.md`, `src/router/plan.ts` (constants), `src/router/plan.test.ts` (unchanged — it reads the constants)

**Interfaces:**
- Consumes: `globalThis.__s1eval.boot/decide` (the existing lab harness), `out/lib.mjs` (Task 8), `scoreRows`/`fitThreshold`/`split` (Task 8).

- [ ] **Step 1: Add the phase.** In `scripts/system1-eval/run.mjs`:
  1. Add `route` to the documented phase list in the header comment.
  2. Change `const needLab = PHASES.has('parity') || PHASES.has('grounding')` to also include `|| PHASES.has('route')`.
  3. After the `grounding` phase block, add:

```js
    if (PHASES.has('route')) report.route = await phaseRoute(lab)
```

  4. Add the phase function next to `phaseParity`:

```js
// ---------------------------------------------------------------------------
// The Prompt Router zero-shot (scripts/router-eval/). Requests are rendered in
// Node by the SHIPPED builders (bundled from src/router/) and decided by the
// real worker on WebGPU — the same split as `parity`.
async function phaseRoute(lab) {
  const routerDir = path.join(repo, 'scripts/router-eval')
  const outDir = path.join(routerDir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  execFileSync(path.join(repo, 'node_modules/.bin/esbuild'), [
    path.join(routerDir, 'lib.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${path.join(outDir, 'lib.mjs')}`,
  ])
  const { buildRouteCandidates, routeRequest } = await import(path.join(outDir, 'lib.mjs'))
  const { scoreRows, fitThreshold, split } = await import(path.join(routerDir, 'metrics.mjs'))
  const { current, tabs } = JSON.parse(fs.readFileSync(path.join(routerDir, 'tabs.json'), 'utf8'))
  const messages = fs.readFileSync(path.join(routerDir, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // Warm-up decides so p50 measures a warm engine, matching the product's cold-engine fall-through.
  for (let i = 0; i < 3; i++) await lab.evaluate((req) => globalThis.__s1eval.decide(req), routeRequest('warm up', buildRouteCandidates('warm up', tabs, current)))
  const rows = []
  for (const m of messages) {
    const req = routeRequest(m.text, buildRouteCandidates(m.text, tabs, current))
    const r = await lab.evaluate((q) => globalThis.__s1eval.decide(q), req)
    const a = r.answers.route
    rows.push({ id: m.id, class: m.class, label: m.label, choice: a.choice, top: a.top, ms: r.ms })
  }
  const { dev, test } = split(rows)
  const hi = fitThreshold(dev, 0.01)
  const lo = fitThreshold(dev, 0.1)
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]
  const result = {
    thresholds: { ROUTE_CONFIDENCE: hi, ROUTE_TRY_CONFIDENCE: lo },
    test: { atHigh: hi === null ? null : scoreRows(test, hi), atLow: lo === null ? null : scoreRows(test, lo) },
    latency: { p50: pct(0.5), p95: pct(0.95) },
    byClass: Object.fromEntries([...new Set(rows.map((r) => r.class))].map((c) => [c, scoreRows(rows.filter((r) => r.class === c), hi ?? 1)])),
  }
  fs.writeFileSync(path.join(outDir, 'von.json'), JSON.stringify({ ...result, rows }, null, 2))
  log('route:', JSON.stringify(result))
  return result
}
```

  (`execFileSync`, `fs`, `path`, `repo`, `log` already exist in `run.mjs`; verify with `grep -n "^import\|const repo\|function log" scripts/system1-eval/run.mjs` and add any that do not.)

- [ ] **Step 2: Run it.** Per `scripts/system1-eval/README.md` (weights served from `scripts/export-von/out/`; LM Studio is not needed for this phase):

Run: `EVAL_PHASES=download,route node scripts/system1-eval/run.mjs`
Expected: `route:` log line with thresholds, test scores at both bands, and latency. If the weights export is missing locally, regenerate per the README before running — do not skip this task's measurement.

- [ ] **Step 3: Apply the fitted thresholds.** In `src/router/plan.ts` set `ROUTE_CONFIDENCE` / `ROUTE_TRY_CONFIDENCE` to the fitted values rounded **up** to 2 decimals (rounding up only makes a band stricter), never below the floors `ROUTE_CONFIDENCE >= 0.6` and `ROUTE_TRY_CONFIDENCE >= 0.3` (Act's own bands — a fit of 0 would otherwise let every decision act), and never above `1` (a `null` fit for the high band means set it to `1` and record in the README that the no-card band effectively never fires; a `null` fit for the card band means the feature fails the kill criterion). Keep `ROUTE_TRY_CONFIDENCE <= ROUTE_CONFIDENCE`. Then run `npx vitest run src/router/` — `run.test.ts`'s low-confidence case uses `top: 0.1`, which stays below the 0.3 floor. Run `npx vitest run src/router/plan.test.ts` — expected PASS (the table is written against the constants).

- [ ] **Step 4: Verdict.** Add to `scripts/router-eval/README.md`'s **Results**: a table of heuristic vs Von on test (coverage, wrong-action rate at the high band), Von latency p50/p95, per-class wrong actions, the fitted thresholds, and the spec §7.4 verdict stated plainly — **ship (beta, default ask)** or **do not ship → approach B with gap X**. If the verdict is "do not ship", also set the catalog entry's visibility so the Beta row stays hidden: change `requires: 'system1'` to a stricter gate only if the user agrees — otherwise record the verdict and stop; do not delete code.

- [ ] **Step 5: Commit**

```bash
git add scripts/system1-eval/run.mjs scripts/router-eval/README.md src/router/plan.ts
git commit -m "eval(router): zero-shot Von routing on WebGPU — fitted bands, latency, verdict vs the regex baseline" -- scripts/system1-eval/run.mjs scripts/router-eval/README.md src/router/plan.ts
```

---

### Task 10: Document the invariant

**Files:**
- Modify: `CLAUDE.md` (Source layout + Architecture invariants), `README.md` (feature tour, one paragraph)

- [ ] **Step 1: Source layout** — in CLAUDE.md's "Source layout" list, after the `src/system1/` entry add:

```markdown
- `src/router/` — the experimental **Prompt Router** (beta): before a plain composer message reaches the chat model, Von picks once from a closed set — `chat`, `search` (query cut from the user's words by `query.ts`), or `switch-tab:<id>` — built by `candidates.ts` (pure), validated by `validate.ts`, banded by `plan.ts` (pure), orchestrated by `run.ts` (`runRouter`, injected deps), executed by `execute.ts`. `heuristicPolicy.ts` is the eval-only regex baseline; `scripts/router-eval/` holds the labelled set and its numbers.
```

- [ ] **Step 2: Invariant** — append to "Architecture invariants":

```markdown
- **The Prompt Router chooses from a closed set, gates under its own one-shot policy, and fails to absence.** `runRouter` (`src/router/run.ts`) runs in `startFreshTurn` only for a plain fresh message (no attachments, mentions, `@memory`/`@all`, `/skill`), only on a warm engine (cold → fall through and `warm()`), under a `DECIDE_BUDGET_MS` (300) budget. Von never produces text: the search query is `extractSearchQuery`'s cut of the user's own words and a tab option carries only title + host. The policy is `PromptRouter` in its own `beta` group — so no group-level setter can opt it in — listed only with System-1 on: `never` skips the engine entirely; `ask` cards every action; only `always` runs the high band (`ROUTE_CONFIDENCE`, fitted in `scripts/router-eval/README.md`) without a card, and never a `search` before Chrome's optional `search` permission is granted (the card's Allow is the only gesture that can request it). Router cards are always `once: true` — "Allow this chat" never applies. Every failure (cold, timeout, engine error, non-member key, declined card, tab gone, search failed) returns `fallthrough` and `startFreshTurn` continues exactly as if the router did not exist; Stop on a router card is the one deliberate exception (nothing runs). A handled action never rewrites the user's message: history gets the message plus a past-tense `[Quick action by Lychee: …]` line, and the transcript a `handledBy: 'von'` bubble whose time excludes the card wait.
```

- [ ] **Step 3: README** — in the feature tour, one short paragraph: Prompt Router (beta), what it does, that it needs System-1, the policy semantics, and a pointer to `scripts/router-eval/README.md` for its measured numbers.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: Prompt Router invariant and feature note" -- CLAUDE.md README.md
```
