import { test, expect, vi, beforeAll, afterEach } from 'vitest'

// background.ts pulls in a long chain of Chrome-coupled modules; mocking each
// DIRECT import (rather than only stubbing chrome.*) means none of THEIR own
// module-scope code ever runs on import, so this file only has to model what
// background.ts itself actually does — at import time, and inside the specific
// listeners under test below. This file intentionally does not attempt to cover
// every listener background.ts registers (dream scheduling, the research
// watchdog, offscreen dispatch, …) — only the lines this hardening pass changed,
// plus enough non-regression coverage that a change to the dispatch shape would
// be caught. background.ts had zero test coverage before this file.
vi.mock('./agent/dream', () => ({
  dreamIfDue: vi.fn(async () => ({ status: 'skipped', reason: 'not exercised' })),
}))
vi.mock('./platform/composerActions', () => ({
  COMPOSER_ACTION_MSG: 'lychee-composer-action',
  setComposerAction: vi.fn(async () => {}),
}))
vi.mock('./platform/contextMenus', () => ({
  registerContextMenus: vi.fn(async () => {}),
  CONTEXT_MENU_IDS: { selection: 'lychee-ask-selection', link: 'lychee-ask-link', image: 'lychee-ask-image', page: 'lychee-ask-page' },
}))
vi.mock('./platform/highlight', () => ({
  sweepHighlightsForWindow: vi.fn(async () => {}),
}))
vi.mock('./data/settings', () => ({
  loadSettings: vi.fn(async () => ({})),
  getSelectedProvider: vi.fn(() => undefined),
  observabilityConfig: vi.fn(() => undefined),
  // A light real implementation (mirrors settings.ts's own passthrough-with-
  // default), not a fixed constant — dreamAlarmPeriodMinutes's own test below
  // needs this to actually vary with its input to be meaningful.
  resolveDreamIntervalMs: vi.fn((settings: { dreamIntervalMs?: number }) =>
    typeof settings?.dreamIntervalMs === 'number' && settings.dreamIntervalMs > 0
      ? settings.dreamIntervalMs
      : 24 * 60 * 60 * 1000,
  ),
}))
vi.mock('./platform/webFetch', () => ({
  isFetchableUrl: vi.fn(() => ({ ok: false, reason: 'not exercised' })),
}))
vi.mock('./platform/researchRender', () => ({
  renderPage: vi.fn(async () => ({ error: 'not exercised' })),
}))
vi.mock('./platform/researchBrowse', () => ({
  closeSessionsForTask: vi.fn(),
  handleBrowseOp: vi.fn(async () => ({ ok: false, message: 'not exercised' })),
}))
vi.mock('./platform/researchSearch', () => ({
  searchInTab: vi.fn(async () => ({ results: [] })),
}))
vi.mock('./platform/researchTab', () => ({
  sweepOrphanWindow: vi.fn(async () => {}),
}))
// researchTasks keeps its real PURE helpers (resumableTasks/isActiveStatus/
// taskDeadline/capSteps/MAX_RESEARCH_DURATION_MS) — only the storage-touching
// functions are replaced, so assertions below can spy on exactly what the SW is
// expected to call without a real chrome.storage.local.
vi.mock('./data/researchTasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data/researchTasks')>()
  return {
    ...actual,
    saveTask: vi.fn(async () => {}),
    applyUpdate: vi.fn(async () => undefined),
    getTask: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    heartbeat: vi.fn(async () => {}),
    postResearchMsg: vi.fn(),
    clearTasksNow: vi.fn(async () => {}),
  }
})

/** A fake chrome covering exactly the namespaces/methods background.ts touches
 *  at module scope or inside the listeners exercised below. `on(bucket)` mimics
 *  addListener while recording every registered callback into `listeners`, so a
 *  test can invoke exactly what background.ts registered instead of guessing. */
function fakeChrome() {
  const listeners: Record<string, Array<(...args: any[]) => unknown>> = {}
  const on = (bucket: string) => ({
    addListener: vi.fn((fn: (...args: any[]) => unknown) => {
      ;(listeners[bucket] ??= []).push(fn)
    }),
  })
  return {
    listeners,
    chrome: {
      sidePanel: {
        setPanelBehavior: vi.fn(async () => {}),
        open: vi.fn(async () => {}),
      },
      runtime: {
        onInstalled: on('onInstalled'),
        onStartup: on('onStartup'),
        onConnect: on('onConnect'),
        onMessage: on('onMessage'),
        getURL: vi.fn((p: string) => `chrome-extension://ext/${p}`),
        sendMessage: vi.fn(async () => {}),
      },
      storage: {
        onChanged: on('storageChanged'),
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      },
      alarms: {
        onAlarm: on('onAlarm'),
        create: vi.fn(),
        get: vi.fn(async () => undefined),
      },
      commands: { onCommand: on('onCommand') },
      notifications: {
        onClicked: on('onClicked'),
        create: vi.fn(async () => 'id'),
        clear: vi.fn(async () => true),
      },
      contextMenus: { onClicked: on('contextMenuClicked') },
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 7 })),
        update: vi.fn(async () => ({})),
      },
      windows: {
        update: vi.fn(async () => ({})),
        getLastFocused: vi.fn(async () => ({ id: 9 })),
      },
      offscreen: {
        hasDocument: vi.fn(async () => false),
        createDocument: vi.fn(async () => {}),
        Reason: { DOM_PARSER: 'DOM_PARSER' },
      },
    },
  }
}

let env: ReturnType<typeof fakeChrome>
let bg: typeof import('./background')
let researchTasks: typeof import('./data/researchTasks')
let settingsMod: typeof import('./data/settings')

beforeAll(async () => {
  env = fakeChrome()
  vi.stubGlobal('chrome', env.chrome)
  bg = await import('./background')
  researchTasks = await import('./data/researchTasks')
  settingsMod = await import('./data/settings')
})

afterEach(() => {
  vi.clearAllMocks()
})

/** Invoke every listener registered in `bucket` (there is exactly one per bucket
 *  in background.ts today) with the given args. Does NOT wait for async work
 *  inside the listener — most of these fire an internal async IIFE and return
 *  synchronously, so callers use vi.waitFor()/an awaited signal to observe the
 *  work finishing. */
function fire(bucket: string, ...args: unknown[]): void {
  for (const fn of env.listeners[bucket] ?? []) fn(...args)
}

// ---------------------------------------------------------------------------
// background.ts IS the MV3 service worker's entry point: if MODULE EVALUATION
// itself throws — not a listener misbehaving once called, but the top-level
// code that runs synchronously during `import` — the whole worker dies on
// load and every listener this file registers is dead with it, along with
// dreaming, the research watchdog, and every chrome.runtime message route.
// That happened for real: a `let resumeChain` binding was referenced (inside
// resumeStrandedResearch(), called unconditionally at module scope) before
// the `let` statement that initializes it had executed, throwing
// "ReferenceError: Cannot access 'resumeChain' before initialization" — a
// classic temporal-dead-zone bug. `beforeAll`'s `await import('./background')`
// above already propagates that as a hook failure (every test in this file
// reports "skipped" rather than running), which IS a real, unambiguous
// signal — but it reads as "something is wrong with the test file", not "the
// service worker cannot start". This test exists to give that failure mode
// its own name in the test list: if it ever goes red, module evaluation threw.
// ---------------------------------------------------------------------------

test('background.ts module evaluation completes without throwing (the module actually loaded)', () => {
  // If beforeAll's import had thrown, THIS test would show as skipped too —
  // there is no way to assert "import succeeded" from inside a test that only
  // runs once it already has. What this buys is a dedicated, clearly-named
  // entry in the test list rather than relying on a reader noticing that
  // every OTHER test in the file also went missing.
  expect(bg).toBeDefined()
  expect(typeof bg.notifyDone).toBe('function')
  expect(typeof bg.dreamAlarmPeriodMinutes).toBe('function')
})

// ---------------------------------------------------------------------------
// research.clearTasks message routing (the carry-over clearTasks() race fix).
// ---------------------------------------------------------------------------

test('a research.clearTasks message calls clearTasksNow() and acks the sender', async () => {
  let resolveAck: () => void
  const acked = new Promise<void>((resolve) => {
    resolveAck = resolve
  })
  const sendResponse = vi.fn(() => resolveAck())

  fire('onMessage', { type: 'research.clearTasks' }, {}, sendResponse)
  await acked

  expect(researchTasks.clearTasksNow).toHaveBeenCalledTimes(1)
})

// ---------------------------------------------------------------------------
// F1 (downgraded CRITICAL -> HIGH): sidePanel.open() must fire in the SAME
// continuation as the first (unavoidable) await, before any FURTHER await —
// not after tabs.update/windows.update as it used to.
// ---------------------------------------------------------------------------

test('a chat: notification click opens the side panel before the second await (tabs.update), not after three awaits', async () => {
  const order: string[] = []
  env.chrome.tabs.get = vi.fn(async (id: number) => ({ id, windowId: 7 }))
  env.chrome.tabs.update = vi.fn(async () => {
    order.push('tabs.update')
    return {}
  })
  env.chrome.windows.update = vi.fn(async () => {
    order.push('windows.update')
    return {}
  })
  env.chrome.sidePanel.open = vi.fn(async () => {
    order.push('sidePanel.open')
  })

  fire('onClicked', 'chat:42')

  await vi.waitFor(() => expect(order).toContain('windows.update'))
  expect(order).toEqual(['sidePanel.open', 'tabs.update', 'windows.update'])
})

test('a chat: notification click logs when sidePanel.open fails, instead of silently swallowing it', async () => {
  const err = new Error('gesture window lapsed')
  env.chrome.sidePanel.open = vi.fn(async () => {
    throw err
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  fire('onClicked', 'chat:42')

  await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith('sidePanel.open failed', err))
})

test('a chat: notification click with a non-numeric tab id is ignored', () => {
  fire('onClicked', 'chat:not-a-number')
  expect(env.chrome.notifications.clear).not.toHaveBeenCalled()
  expect(env.chrome.sidePanel.open).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// F9: clicking a "Research complete" notification used to do nothing at all —
// no branch handled its research-<taskId> id shape.
// ---------------------------------------------------------------------------

test('a research-<id> notification click clears it and opens the panel in the last-focused normal window', async () => {
  fire('onClicked', 'research-abc123')

  await vi.waitFor(() => expect(env.chrome.sidePanel.open).toHaveBeenCalled())
  expect(env.chrome.notifications.clear).toHaveBeenCalledWith('research-abc123')
  expect(env.chrome.windows.getLastFocused).toHaveBeenCalledWith({ windowTypes: ['normal'] })
  expect(env.chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 })
})

test('a research-<id> click logs (rather than swallows) a getLastFocused failure', async () => {
  const err = new Error('no windows')
  env.chrome.windows.getLastFocused = vi.fn(async () => {
    throw err
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  fire('onClicked', 'research-xyz')

  await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith('[research] notification click failed', err))
})

test('a notification id matching neither known prefix is ignored', () => {
  fire('onClicked', 'something-else')
  expect(env.chrome.notifications.clear).not.toHaveBeenCalled()
  expect(env.chrome.sidePanel.open).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// notifyDone(): used to fire chrome.notifications.create() without awaiting or
// returning it, so a rejection floated free as an unhandled rejection instead
// of reaching the try/catch every caller (below) wraps this in.
// ---------------------------------------------------------------------------

test('notifyDone() propagates a notifications.create failure instead of swallowing it', async () => {
  const err = new Error('notification failed')
  env.chrome.notifications.create = vi.fn(async () => {
    throw err
  })

  await expect(bg.notifyDone('t1', 'question')).rejects.toThrow('notification failed')
})

test('notifyDone() resolves once notifications.create succeeds', async () => {
  env.chrome.notifications.create = vi.fn(async () => 'research-t1')
  await expect(bg.notifyDone('t1', 'question')).resolves.toBeUndefined()
  expect(env.chrome.notifications.create).toHaveBeenCalledWith(
    'research-t1',
    expect.objectContaining({ title: 'Research complete' }),
  )
})

// ---------------------------------------------------------------------------
// dreamAlarmPeriodMinutes(): pure, exported for direct testing (bonus coverage
// picked up while this file was already being built — no behavior change).
// ---------------------------------------------------------------------------

test('dreamAlarmPeriodMinutes floors at 1 and caps at 60', () => {
  expect(bg.dreamAlarmPeriodMinutes({ dreamIntervalMs: 10_000 } as any)).toBe(1) // < 1 minute floors to 1
  expect(bg.dreamAlarmPeriodMinutes({ dreamIntervalMs: 24 * 60 * 60 * 1000 } as any)).toBe(60) // 24h caps at 60
  expect(bg.dreamAlarmPeriodMinutes({ dreamIntervalMs: 30 * 60 * 1000 } as any)).toBe(30) // 30 min passes through
})

// ---------------------------------------------------------------------------
// resumeStrandedResearch's select-then-claim race: two overlapping invocations
// (e.g. two watchdog ticks, or the module-load call racing the first tick)
// used to both read listTasks() and see the same task as stale before either's
// claim (applyUpdate) had committed, producing a redundant research.start
// dispatch. resumeStrandedResearch is now serialized against itself.
// ---------------------------------------------------------------------------

test('two racing watchdog ticks claim and dispatch a stranded task only once', async () => {
  const now = Date.now()
  const task = {
    id: 'strand-1',
    question: 'q',
    status: 'running' as const,
    steps: [],
    startedAt: now - 10 * 60_000,
    updatedAt: now - 10 * 60_000, // well past STALE_MS (3 min)
    // Task 8 review finding: startResearchTask reads sites off the PERSISTED
    // task (not a fresh message), so a watchdog resume — this exact path —
    // must keep the scope the user approved, not just the initial dispatch.
    // Riding along on this test since it already exercises that dispatch.
    sites: ['aftershockpc.com'],
  }
  let claimed = false

  vi.mocked(researchTasks.listTasks).mockImplementation(async () => (claimed ? [] : [task as any]))
  vi.mocked(researchTasks.applyUpdate).mockImplementation(async () => {
    claimed = true
    return { ...task, updatedAt: Date.now() } as any
  })
  vi.mocked(researchTasks.getTask).mockImplementation(async () => ({ ...task, updatedAt: Date.now() }) as any)
  vi.mocked(settingsMod.getSelectedProvider).mockReturnValue({ provider: {}, modelId: 'm' } as any)

  try {
    // Two racing ticks, fired back-to-back with no await between them — the
    // exact shape of two watchdog alarms (or the module-load call and the
    // first tick) landing close together.
    fire('onAlarm', { name: 'research-watchdog' })
    fire('onAlarm', { name: 'research-watchdog' })

    await vi.waitFor(() => {
      const starts = vi.mocked(researchTasks.postResearchMsg).mock.calls.filter(([m]) => (m as any).type === 'research.start')
      if (starts.length === 0) throw new Error('not dispatched yet')
    })
    // Give the second (now-serialized) call a chance to run its own
    // read-claim-dispatch, if it were going to — it should see the task
    // already claimed and dispatch nothing.
    await new Promise((r) => setTimeout(r, 0))

    const starts = vi.mocked(researchTasks.postResearchMsg).mock.calls.filter(([m]) => (m as any).type === 'research.start')
    expect(starts).toHaveLength(1)
    expect(researchTasks.applyUpdate).toHaveBeenCalledTimes(1)
    // The dispatched research.start message must carry the persisted task's
    // scope — not silently drop it, which would revert an in-flight resumed
    // task to unrestricted with nothing failing (sites is optional throughout).
    expect((starts[0][0] as any).sites).toEqual(['aftershockpc.com'])
  } finally {
    vi.mocked(researchTasks.listTasks).mockImplementation(async () => [])
    vi.mocked(researchTasks.applyUpdate).mockImplementation(async () => undefined)
    vi.mocked(researchTasks.getTask).mockImplementation(async () => undefined)
    vi.mocked(settingsMod.getSelectedProvider).mockReturnValue(undefined as any)
  }
})

// ---------------------------------------------------------------------------
// Task 8 review finding: research.ensureAndStart's handler must persist the
// launch card's sites onto the saved ResearchTask (background.ts, the
// saveTask({...}) call). This was previously unguarded — sites is optional
// throughout the ResearchMsg/ResearchTask types, so a future refactor
// dropping the field is type-valid and would silently revert all research to
// unrestricted with nothing failing. Paired with the sites assertion added to
// the racing-watchdog test above, which covers the other half: a later
// dispatch (initial launch OR a watchdog resume) reading it back off the
// persisted task.
// ---------------------------------------------------------------------------

test('a research.ensureAndStart message persists the launch card sites onto the saved task', async () => {
  // getTask is irrelevant to what this test asserts (it only isolates
  // startResearchTask's own dispatch, covered separately above) — undefined
  // makes it a no-op so this test exercises exactly the saveTask call.
  vi.mocked(researchTasks.getTask).mockImplementation(async () => undefined)
  let resolveAck: () => void
  const acked = new Promise<void>((resolve) => {
    resolveAck = resolve
  })
  const sendResponse = vi.fn(() => resolveAck())

  fire(
    'onMessage',
    { type: 'research.ensureAndStart', taskId: 't-scoped', question: 'q', conversationId: 'c1', sites: ['aftershockpc.com'] },
    {},
    sendResponse,
  )
  await acked

  expect(researchTasks.saveTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't-scoped', sites: ['aftershockpc.com'] }))
})
