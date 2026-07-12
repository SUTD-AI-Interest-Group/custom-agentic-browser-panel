// The browse sub-agent: given a URL and an objective, it drives the isolated
// research tab itself — clicking through, expanding sections, paginating, using a
// site's own search — until it has what it was sent for.
//
// It runs in its OWN context, nested inside one BrowseSite tool call of the gather
// agent. That is the whole point: a page walk is a dozen observations of a dozen
// element registries, and threading those through the gather agent's history would
// blow the round's context (the notebook exists precisely to keep it bounded). The
// gather agent asks a question and gets an answer; the clicking stays down here.
//
// Findings go STRAIGHT into the shared notebook (with the real source URL and a
// verbatim quote), so nothing is lost through the digest this returns.
//
// Every action is policy-checked in the service worker before the page is touched
// (src/tools/browsePolicy.ts) — a refusal comes back as a normal tool result with
// its reason, so the model re-routes instead of dead-ending.

import { tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { runAgentTurn, type UIPart } from './agent'
import type { Trace } from './observability'
import { instrumentToolset } from './observability'
import type { NotebookHandle } from './notebook'
import type { BrowseObservation, BrowseOp, BrowseResult } from '../data/researchTasks'

/** The offscreen→SW channel that actually drives the tab (see background/offscreen.ts). */
export interface BrowseBroker {
  step(sessionId: string, op: BrowseOp): Promise<BrowseResult>
}

/** How many actions one page-walk may take before it must report back. */
const MAX_BROWSE_STEPS = 12
/** Hard wall-clock ceiling — a hung page must never hold the research tab. */
const MAX_BROWSE_MS = 120_000

export interface BrowseOutcome {
  /** Every distinct URL the session landed on, in order. */
  visited: string[]
  /** The sub-agent's own summary of what it found (its final text). */
  digest: string
  findingsAdded: number
  stoppedBecause: 'done' | 'budget' | 'timeout' | 'error'
}

const BROWSE_SYSTEM = `You are a research browser. You have a real browser tab open on a page, and ONE objective. Work the page until you have met it, then stop.

How to work:
- You see the page as its readable-text excerpt plus a numbered list of interactive elements. Act on an element by its number.
- Call ReadPage when you need the FULL text of the page you are on — the excerpt is only the beginning of it.
- Click links, tabs, "show more"/expand controls, and pagination to reach the content. If a site has its own search box, type your query into it and press Enter — that is often far better than guessing URLs.
- After every action you get a fresh observation. Element numbers are re-assigned each time: always act on the numbers from the LATEST observation.
- Record what you learn with Notebook.write as you go — claim, the exact URL you read it on, and a short verbatim quote. Text you merely type is NOT saved; only Notebook.write persists.

Boundaries (enforced — do not fight them):
- You may not log in, sign up, buy, subscribe, or submit any form other than a search. If an action is refused you will be told why; take a different route or accept that the content is unreachable and say so.
- You are in a fresh, logged-out browser. Anything behind an account is out of reach. Do not waste steps trying.

You have a small step budget. When you have met the objective — or established that the page cannot meet it — stop calling tools and reply with a short summary of what you found and where. That reply is your report back to the research agent.`

/**
 * Walk one page (and wherever it leads) against `objective`. Always closes its
 * session — the browse session holds an exclusive lease on the shared research
 * tab, so leaking one would stall every later fetch in the task.
 */
export async function runBrowseSession(opts: {
  sessionId: string
  url: string
  objective: string
  broker: BrowseBroker
  model: LanguageModel
  notebook: NotebookHandle
  signal: AbortSignal
  trace?: Trace
  /** Streams the sub-agent's steps up to the research sheet, so the user can watch. */
  onStep?: (parts: UIPart[]) => void
}): Promise<BrowseOutcome> {
  const { broker, sessionId, notebook } = opts
  const visited: string[] = []
  let findingsAdded = 0

  const note = (obs?: BrowseObservation) => {
    if (obs?.url && visited[visited.length - 1] !== obs.url) visited.push(obs.url)
  }

  // Open first: if the page won't even load there is nothing to run an agent over.
  const opened = await broker.step(sessionId, { kind: 'open', url: opts.url })
  if (!opened.ok || !opened.observation) {
    await broker.step(sessionId, { kind: 'close' }).catch(() => {})
    return {
      visited,
      digest: `Could not open ${opts.url}: ${opened.error ?? opened.message}`,
      findingsAdded: 0,
      stoppedBecause: 'error',
    }
  }
  note(opened.observation)

  // One step of the walk: hand the action to the SW, fold the new observation back
  // into the model's view. A policy refusal arrives here as ok:false + a reason.
  const act = async (op: BrowseOp) => {
    const r = await broker.step(sessionId, op)
    note(r.observation)
    return r.observation ? `${r.message}\n\n${renderObservation(r.observation)}` : r.message
  }

  const tools: ToolSet = {
    ClickElement: tool({
      description: 'Click the numbered element (a link, tab, expander, or pagination control) from the latest observation.',
      inputSchema: z.object({ index: z.number().describe('Element number from the latest observation') }),
      execute: ({ index }) => act({ kind: 'act', action: { kind: 'click', index } }),
    }),
    TypeText: tool({
      description:
        "Type into a numbered SEARCH or filter box (only those are permitted). Replaces what's there. Follow with PressEnter to run the search.",
      inputSchema: z.object({
        index: z.number().describe('Element number of the search/filter input'),
        text: z.string().describe('What to search for'),
      }),
      execute: ({ index, text }) => act({ kind: 'act', action: { kind: 'type', index, text } }),
    }),
    PressEnter: tool({
      description: 'Press Enter in the numbered search box to run the search.',
      inputSchema: z.object({ index: z.number().describe('Element number of the search box you typed into') }),
      execute: ({ index }) => act({ kind: 'act', action: { kind: 'press', keys: 'Enter', index } }),
    }),
    ScrollPage: tool({
      description: 'Scroll the page down or up — use it to reach content or trigger lazy loading.',
      inputSchema: z.object({ direction: z.enum(['down', 'up']) }),
      execute: ({ direction }) => act({ kind: 'act', action: { kind: 'scroll', direction } }),
    }),
    GoBack: tool({
      description: 'Go back to the previous page when a link turned out to be a dead end.',
      inputSchema: z.object({}),
      execute: () => act({ kind: 'act', action: { kind: 'back' } }),
    }),
    GoToUrl: tool({
      description: 'Navigate the tab directly to a URL (e.g. a link you saw in the page text).',
      inputSchema: z.object({ url: z.string().describe('http(s) URL') }),
      execute: ({ url }) => act({ kind: 'act', action: { kind: 'navigate', url } }),
    }),
    ReadPage: tool({
      description: 'Read the FULL readable text of the page you are currently on. The observation excerpt is only its beginning.',
      inputSchema: z.object({}),
      execute: async () => {
        const r = await broker.step(sessionId, { kind: 'read' })
        if (!r.ok) return { error: r.message }
        // A page the sub-agent actually read is a source the report can cite.
        if (r.url) notebook.addSource({ url: r.url, title: r.title, fetchedVia: 'tab' })
        return { url: r.url, title: r.title, text: r.text }
      },
    }),
    'Notebook.write': tool({
      description:
        'Record what you found. THIS is how a fact is saved — it needs the claim, the exact URL you read it on, and a short verbatim quote from the page.',
      inputSchema: z.object({
        findings: z
          .array(
            z.object({
              claim: z.string().describe('A single factual claim, in your own words'),
              sourceUrl: z.string().describe('The exact URL you read this on'),
              quote: z.string().optional().describe('A short verbatim quote supporting the claim'),
              confidence: z.enum(['high', 'med', 'low']).optional(),
            }),
          )
          .describe('The findings to record'),
      }),
      execute: async ({ findings }) => {
        for (const f of findings) {
          notebook.addFinding({ claim: f.claim, sourceUrl: f.sourceUrl, quote: f.quote, confidence: f.confidence })
          findingsAdded++
        }
        return { recorded: findings.length }
      },
    }),
  }
  if (opts.trace) instrumentToolset(tools, opts.trace)

  // The page walk gets its own wall clock on top of the task's signal: a page that
  // hangs must not hold the shared research tab hostage.
  const deadline = AbortSignal.timeout(MAX_BROWSE_MS)
  const signal = AbortSignal.any([opts.signal, deadline])

  try {
    const result = await runAgentTurn({
      model: opts.model,
      system: BROWSE_SYSTEM,
      history: [
        {
          role: 'user',
          content:
            `Objective: ${opts.objective}\n\n` +
            `You are on this page now:\n\n${renderObservation(opened.observation)}`,
        },
      ],
      tools,
      abortSignal: signal,
      maxSteps: MAX_BROWSE_STEPS,
      // The sub-agent has nowhere to hand off TO — a checkpoint here would just be
      // an empty turn. It reports back in prose instead.
      wrapUpNudge:
        'You are almost out of steps. Stop acting now and reply with what you found (make sure anything worth keeping is already recorded with Notebook.write).',
      onUpdate: opts.onStep ?? (() => {}),
      trace: opts.trace,
    })
    return {
      visited,
      digest: finalText(result.parts) || 'The page walk ended without a summary.',
      findingsAdded,
      stoppedBecause: result.stop.reason === 'budget' ? 'budget' : 'done',
    }
  } catch (err) {
    // A timeout aborts the turn mid-flight; anything already written to the
    // notebook still counts, so report partial progress rather than nothing.
    const timedOut = deadline.aborted
    return {
      visited,
      digest: timedOut
        ? `The page walk timed out after ${Math.round(MAX_BROWSE_MS / 1000)}s. Visited: ${visited.join(', ') || opts.url}.`
        : `The page walk failed: ${err instanceof Error ? err.message : String(err)}`,
      findingsAdded,
      stoppedBecause: timedOut ? 'timeout' : 'error',
    }
  } finally {
    // Releases the tab lease. Without this the next FetchUrl in the task blocks
    // until the session's TTL expires in the service worker.
    await broker.step(sessionId, { kind: 'close' }).catch(() => {})
  }
}

/** The sub-agent's report back: everything it said outside of a tool call. */
function finalText(parts: UIPart[]): string {
  return parts
    .filter((p): p is Extract<UIPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/** The model's view of the page: where it is, what it says, what it can act on. */
function renderObservation(obs: BrowseObservation): string {
  return [
    `URL: ${obs.url}`,
    `Title: ${obs.title}`,
    '',
    `Page text${obs.more ? ' (excerpt — call ReadPage for all of it)' : ''}:`,
    obs.excerpt || '(no readable text)',
    '',
    'Interactive elements:',
    obs.elements,
  ].join('\n')
}
