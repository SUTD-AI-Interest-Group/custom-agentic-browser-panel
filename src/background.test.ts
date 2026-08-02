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

beforeAll(async () => {
  env = fakeChrome()
  vi.stubGlobal('chrome', env.chrome)
  bg = await import('./background')
  researchTasks = await import('./data/researchTasks')
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
