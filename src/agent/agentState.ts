// The per-step agent-state snapshot: a small, DERIVED, fixed-size block telling
// the model where it currently stands — how far into its step budget it is, what
// is on screen right now, which page its tools are actually pinned to, whether a
// page-control session is open, and whether its own earlier history has been
// folded away beneath it.
//
// Pure and Chrome-free so it can be unit-tested on its own, the same reason
// systemPrompt.ts was extracted out of runTurnChain. `runAgentTurn` injects the
// rendered string in `prepareStep`, which rebuilds its message base every step —
// so this never stacks, and it sits at the message TAIL where it leaves the
// cacheable prefix untouched.
//
// **It is a snapshot, never a log.** An append-only state history shown to the
// model costs tokens on every step, duplicates the transcript, and goes
// contradictory the moment a compaction, steer or regenerate rewrites one copy
// and not the other. Everything here is recomputed from live state each step.
//
// **Every line must be a fact no other channel already carries**, which is what
// most of the rules below are about:
//
//   - Chat.tsx stamps an "[Open on screen right now: …]" line onto every USER
//     message. That covers the ordinary case, so repeating it here would be two
//     channels asserting one fact — and they would disagree as soon as one went
//     stale. But that line is frozen into history at send time, and a long
//     tool-using turn has exactly ONE user message at the top, so it says
//     nothing for the remaining 23 steps. This block therefore speaks up only
//     when what is on screen has DRIFTED from what that line claimed.
//   - The tools the model has loaded are deliberately absent: the AI SDK sends
//     their full schemas as `activeTools` on the very same request, so a list of
//     their names would be pure duplication.
//   - Page CONTENT is never here, only identity (title + url) — matching the
//     on-screen line's own rule. A block that quoted the page would be a second
//     content channel with no approval gate in front of it.

/** Identity of one tab. Title and url only — never content. */
export interface TabIdentity {
  title: string
  url: string
}

/**
 * Everything the block can report. `step`/`maxSteps` come from `prepareStep`
 * (the only place that knows them); the rest is supplied by the caller through
 * `runAgentTurn`'s `agentState` thunk, read synchronously from refs so no step
 * ever pays for a `chrome.tabs` round-trip.
 *
 * Every optional field absent = "nothing to say about this", which is why an
 * unremarkable early step renders nothing at all.
 */
export interface AgentStateFacts {
  /** 1-based position in this cycle's step budget. */
  step: number
  /** The cycle's step ceiling (MAX_STEPS, or a sub-agent's shorter leash). */
  maxSteps: number
  /** Auto-continue position within the chain. Silent until the chain has
   *  actually continued at least once. */
  autoContinue?: { used: number; max: number }
  /** What is on screen right now — every pane, live. */
  onScreen?: TabIdentity[]
  /** What the turn's own user message claimed was on screen when it was sent.
   *  The block reports `onScreen` only when the two differ. */
  onScreenAtSend?: TabIdentity[]
  /** The tab this chat's page tools are pinned to. */
  boundTab?: TabIdentity
  /** Whether the bound tab is among the panes currently on screen. */
  boundTabOnScreen?: boolean
  /** An open page-control session: the plan the user granted, and how many
   *  actions it has taken so far. */
  control?: { plan: string; actions: number }
  /** How many earlier turns compaction has folded into a summary. */
  compactedTurns?: number
  /** The hand-off the model itself wrote at the last checkpoint. */
  checkpoint?: { nextAction: string }
}

/**
 * Below this fraction of the step budget, the step line is noise: the model has
 * plenty of room and `wrapUpNudge` already owns the other end. At MAX_STEPS=24
 * this starts reporting from step 7.
 */
const STEP_LINE_AFTER_FRACTION = 0.25

/** Caps on the two free-form strings that reach this block. Both originate as
 *  model or user text and would otherwise grow the block without bound. */
const MAX_PLAN = 120
const MAX_NEXT_ACTION = 160
const MAX_URL = 100

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** `"Title" (url)`, matching the shape Chat.tsx's on-screen line already uses. */
function identity(tab: TabIdentity): string {
  return `${JSON.stringify(clip(tab.title || '(untitled)', 80))} (${clip(tab.url, MAX_URL)})`
}

/**
 * Did what is on screen change since the user message was sent?
 *
 * Compared as a SET of urls: which pane holds focus reorders the array on every
 * click without changing a thing about what the user can see, and reporting that
 * as drift would fire the line on almost every step.
 */
function onScreenDrifted(now: TabIdentity[], atSend: TabIdentity[]): boolean {
  if (now.length !== atSend.length) return true
  const before = new Set(atSend.map((t) => t.url))
  return now.some((t) => !before.has(t.url))
}

/**
 * Render the block, or `null` when nothing is worth saying.
 *
 * Returning null is load-bearing rather than an optimisation: this runs on every
 * step of every turn, including the one-step "what's 2+2" turns that make up
 * most of a conversation, and a block that always rendered would tax all of them
 * to serve the few that need it.
 */
export function renderAgentState(facts: AgentStateFacts): string | null {
  const lines: string[] = []

  // Budget position, once far enough in to matter.
  if (facts.step > facts.maxSteps * STEP_LINE_AFTER_FRACTION) {
    const cont =
      facts.autoContinue && facts.autoContinue.used > 0
        ? ` · auto-continue ${facts.autoContinue.used} of ${facts.autoContinue.max}`
        : ''
    lines.push(`step ${facts.step} of ${facts.maxSteps}${cont}`)
  } else if (facts.autoContinue && facts.autoContinue.used > 0) {
    // Early in a continued cycle the step number is uninteresting but the fact
    // that this is a continuation is not — it tells the model the transcript
    // above it is its own previous cycle, not a fresh request.
    lines.push(`auto-continue ${facts.autoContinue.used} of ${facts.autoContinue.max}`)
  }

  // On screen — only when it no longer matches what the user message said.
  if (facts.onScreen && facts.onScreenAtSend && onScreenDrifted(facts.onScreen, facts.onScreenAtSend)) {
    const list = facts.onScreen.map(identity).join(', ')
    const how = facts.onScreen.length > 1 ? ', side by side in a split view' : ''
    lines.push(
      facts.onScreen.length === 0
        ? 'now on screen: nothing this panel can read'
        : `now on screen: ${list}${how} — changed since this message was sent`,
    )
  }

  // The acting surface, when it has diverged from the viewing surface. Page tools
  // stay pinned to the bound tab so a turn the user walked away from keeps acting
  // on the page they asked about — which means the model can be working on a page
  // nobody is looking at, and nothing else in the request would tell it so.
  if (facts.boundTab && facts.boundTabOnScreen === false) {
    lines.push(`acting on ${identity(facts.boundTab)} — not currently on screen`)
  }

  if (facts.control) {
    const taken =
      facts.control.actions === 0
        ? 'no actions yet'
        : `${facts.control.actions} action${facts.control.actions === 1 ? '' : 's'} taken`
    lines.push(`page control: active for ${JSON.stringify(clip(facts.control.plan, MAX_PLAN))} · ${taken}`)
  }

  // The fact most worth carrying. After a fold, the model's record of what it
  // already tried is only whatever the cheap summariser happened to keep in
  // prose — so it should know to distrust the apparent start of its own history.
  if (facts.compactedTurns && facts.compactedTurns > 0) {
    lines.push(
      `history: ${facts.compactedTurns} earlier turns folded into a summary — detail above this point is lossy`,
    )
  }

  if (facts.checkpoint) {
    lines.push(`continuing from checkpoint · next: ${JSON.stringify(clip(facts.checkpoint.nextAction, MAX_NEXT_ACTION))}`)
  }

  if (lines.length === 0) return null
  return `<agent-state>\n${lines.join('\n')}\n</agent-state>`
}
