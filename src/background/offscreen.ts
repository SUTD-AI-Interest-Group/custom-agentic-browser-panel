// Offscreen document: the headless host for work that outlives — or simply
// cannot run in — the service worker. Two tenants today: the research pipeline
// and the dream cycle's generation. Only chrome.runtime messaging + Web APIs are
// available here — NO chrome.storage/tabs/notifications.
import { postResearchMsg, type BrowseOp, type BrowseResult, type ResearchMsg } from '../data/researchTasks'
import { postDreamMsg, type DreamMsg } from '../data/dreamMessages'
import { runResearch } from '../agent/research'
import { runDreamCycle } from '../agent/dream'
import type { BrowseBroker, RenderBroker, SearchBroker } from '../tools/research'

const running = new Map<string, AbortController>()

// Whether a dream cycle is running here right now. Unlike research's map there
// is no id to key on — the dream lock already makes a cycle globally exclusive,
// so this only guards the pathological case that lock cannot: a cycle so slow
// that its lock went stale and the worker dispatched a second one on top of it.
// Running both would consolidate the same episodes twice.
let dreaming = false

// While a task runs, bump its `updatedAt` on this cadence so the SW watchdog can
// distinguish a live worker from a dead one even across a long, quiet model call.
const HEARTBEAT_MS = 20_000

// Tab brokers (offscreen side): the offscreen host cannot touch tabs, so both the
// one-shot render and the interactive browse session are round-trips to the SW —
// send a request, resolve on the matching result by requestId.
const RENDER_TIMEOUT_MS = 45_000
// A browse op includes a navigation + settle + snapshot, so it gets more runway.
const BROWSE_TIMEOUT_MS = 60_000
// A tab search is one navigation + settle + scrape.
const SEARCH_TIMEOUT_MS = 45_000
let requestSeq = 0
const pendingRenders = new Map<string, (r: Extract<ResearchMsg, { type: 'research.renderResult' }>) => void>()
const pendingBrowses = new Map<string, (r: BrowseResult) => void>()
const pendingSearches = new Map<string, (r: Extract<ResearchMsg, { type: 'research.searchTabResult' }>) => void>()

/**
 * Shared request/response plumbing for both brokers: correlate on a fresh
 * requestId, resolve with `onTimeout`'s value if the SW never answers, and settle
 * immediately on abort so a cancelled task doesn't hang on a dead tab.
 */
function roundTrip<T>(
  pending: Map<string, (r: any) => void>,
  taskId: string,
  signal: AbortSignal,
  timeoutMs: number,
  send: (requestId: string) => void,
  timedOut: T,
  aborted: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const requestId = `${taskId}:${++requestSeq}`
    const cleanup = () => {
      pending.delete(requestId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(timedOut)
    }, timeoutMs)
    const onAbort = () => {
      cleanup()
      resolve(aborted)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(requestId, (r) => {
      cleanup()
      resolve(r)
    })
    send(requestId)
  })
}

function makeRenderBroker(taskId: string, signal: AbortSignal): RenderBroker {
  return {
    render(url) {
      return roundTrip(
        pendingRenders,
        taskId,
        signal,
        RENDER_TIMEOUT_MS,
        (requestId) =>
          postResearchMsg({ type: 'research.renderPage', taskId, requestId, url }),
        { error: 'render timed out' },
        { error: 'aborted' },
      ).then((r: any) =>
        r.error !== undefined && r.text === undefined
          ? { error: r.error }
          : { text: r.text, title: r.title, finalUrl: r.finalUrl, error: r.error },
      )
    },
  }
}

function makeBrowseBroker(taskId: string, signal: AbortSignal): BrowseBroker {
  return {
    step(sessionId: string, op: BrowseOp) {
      return roundTrip<BrowseResult>(
        pendingBrowses,
        taskId,
        signal,
        BROWSE_TIMEOUT_MS,
        (requestId) =>
          postResearchMsg({ type: 'research.browse', taskId, requestId, sessionId, op }),
        { ok: false, message: 'the browser did not respond in time' },
        { ok: false, message: 'the research task was cancelled' },
      )
    },
  }
}

function makeSearchBroker(taskId: string, signal: AbortSignal): SearchBroker {
  return {
    search(query: string, maxResults: number) {
      return roundTrip(
        pendingSearches,
        taskId,
        signal,
        SEARCH_TIMEOUT_MS,
        (requestId) =>
          postResearchMsg({ type: 'research.searchTab', taskId, requestId, query, maxResults }),
        { error: 'tab search timed out' },
        { error: 'aborted' },
      ).then((r: any) => (r.error !== undefined ? { error: r.error } : { results: r.results ?? [] }))
    },
  }
}

chrome.runtime.onMessage.addListener((msg: ResearchMsg | DreamMsg) => {
  if (msg?.type === 'dream.run') {
    if (dreaming) {
      // Decline rather than double-consolidate — and say so, so the worker drops
      // the lock it took for this cycle instead of waiting out its whole TTL.
      postDreamMsg({ type: 'dream.failed', token: msg.token, error: 'a dream cycle is already running' })
      return
    }
    dreaming = true
    // The worker holds the lock for this cycle and settles whichever message
    // comes back, so both paths must post exactly one — a silent throw here
    // would strand that lock until it expired.
    runDreamCycle(msg.job)
      .then((result) => postDreamMsg({ type: 'dream.result', token: msg.token, result }))
      .catch((err) =>
        postDreamMsg({
          type: 'dream.failed',
          token: msg.token,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        dreaming = false
      })
    return
  }
  if (msg?.type === 'research.start') {
    // Double-run guard: the SW watchdog re-dispatches stranded tasks, but a task
    // already running here (including one merely paused-and-sleeping between retries,
    // whose promise is still pending so it stays in `running`) must never be run
    // twice. A redundant dispatch for a live task is simply ignored.
    if (running.has(msg.taskId)) return
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    const heartbeat = setInterval(() => {
      if (ctrl.signal.aborted) return
      postResearchMsg({ type: 'research.heartbeat', taskId: msg.taskId })
    }, HEARTBEAT_MS)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig,
      modelId: msg.modelId,
      conversationId: msg.conversationId,
      observability: msg.observability,
      signal: ctrl.signal,
      deadlineAt: msg.deadlineAt,
      resumeNotebook: msg.notebook,
      sites: msg.sites,
      renderBroker: makeRenderBroker(msg.taskId, ctrl.signal),
      browseBroker: makeBrowseBroker(msg.taskId, ctrl.signal),
      searchBroker: makeSearchBroker(msg.taskId, ctrl.signal),
      onUpdate: (steps, notebook) =>
        postResearchMsg({ type: 'research.update', taskId: msg.taskId, steps, notebook }),
      // Transient-failure transitions drive the UI's paused/waiting state.
      onPause: ({ reason, nextRetryAt }) =>
        postResearchMsg({ type: 'research.paused', taskId: msg.taskId, reason, nextRetryAt }),
      onResume: () =>
        postResearchMsg({ type: 'research.resumed', taskId: msg.taskId }),
    })
      .then(({ report, sources, notebook, verification, partial }) => {
        // The SW already persisted status:'cancelled' when research.cancel fired;
        // a late resolve/reject here must not overwrite that with done/error.
        if (ctrl.signal.aborted) return
        postResearchMsg({
          type: 'research.done',
          taskId: msg.taskId,
          report,
          sources,
          notebook,
          verification,
          partial,
        })
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        postResearchMsg({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        clearInterval(heartbeat)
        running.delete(msg.taskId)
      })
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  } else if (msg?.type === 'research.renderResult') {
    pendingRenders.get(msg.requestId)?.(msg)
  } else if (msg?.type === 'research.browseResult') {
    pendingBrowses.get(msg.requestId)?.(msg.result)
  } else if (msg?.type === 'research.searchTabResult') {
    pendingSearches.get(msg.requestId)?.(msg)
  }
})
console.info('[offscreen] research + dream host loaded')
