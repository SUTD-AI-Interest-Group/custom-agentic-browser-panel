import { describe, expect, it } from 'vitest'
import { renderAgentState, type AgentStateFacts } from './agentState'

/** The minimum a caller can supply: step mechanics and nothing else. */
const facts = (over: Partial<AgentStateFacts> = {}): AgentStateFacts => ({
  step: 1,
  maxSteps: 24,
  ...over,
})

const page = (title: string, url: string) => ({ title, url })

describe('renderAgentState', () => {
  it('renders nothing on the first step of an unremarkable turn', () => {
    // Step 1 with no session, no compaction, no checkpoint and no drift has
    // nothing to say that the user message above it did not already say.
    expect(renderAgentState(facts())).toBeNull()
  })

  it('reports step position once the turn is under way', () => {
    expect(renderAgentState(facts({ step: 7 }))).toContain('step 7 of 24')
  })

  it('wraps what it renders in an agent-state tag', () => {
    const out = renderAgentState(facts({ step: 7 })) as string
    expect(out.startsWith('<agent-state>')).toBe(true)
    expect(out.trimEnd().endsWith('</agent-state>')).toBe(true)
  })
})

describe('renderAgentState — on-screen drift', () => {
  it('stays silent while on-screen matches what the user message already said', () => {
    // Chat.tsx stamps an "[Open on screen right now: …]" line onto every user
    // message. Repeating it every step would be two channels asserting the same
    // fact, and they would contradict each other the moment one went stale.
    const out = renderAgentState(
      facts({
        step: 4,
        onScreen: [page('Acme', 'https://acme.com/orders')],
        onScreenAtSend: [page('Acme', 'https://acme.com/orders')],
      }),
    )
    expect(out).toBeNull()
  })

  it('reports on-screen tabs once they differ from send time', () => {
    // This is the case the user-message line structurally cannot cover: a long
    // tool-using turn has ONE user message at the top, so its on-screen line is
    // frozen for all 24 steps while the user keeps switching tabs.
    const out = renderAgentState(
      facts({
        step: 4,
        onScreen: [page('Gmail', 'https://mail.google.com')],
        onScreenAtSend: [page('Acme', 'https://acme.com/orders')],
      }),
    ) as string
    expect(out).toContain('now on screen')
    expect(out).toContain('mail.google.com')
  })

  it('treats a closed split pane as drift', () => {
    const out = renderAgentState(
      facts({
        step: 4,
        onScreen: [page('Acme', 'https://acme.com/orders')],
        onScreenAtSend: [page('Acme', 'https://acme.com/orders'), page('Gmail', 'https://mail.google.com')],
      }),
    ) as string
    expect(out).toContain('now on screen')
    expect(out).not.toContain('mail.google.com')
  })

  it('ignores tab order when deciding whether on-screen drifted', () => {
    // Which pane is focused reorders the array without changing what is visible.
    const out = renderAgentState(
      facts({
        step: 4,
        onScreen: [page('Gmail', 'https://mail.google.com'), page('Acme', 'https://acme.com')],
        onScreenAtSend: [page('Acme', 'https://acme.com'), page('Gmail', 'https://mail.google.com')],
      }),
    )
    expect(out).toBeNull()
  })
})

describe('renderAgentState — the acting surface', () => {
  it('names the bound tab when it is no longer on screen', () => {
    // Page tools are pinned to the bound tab, so a turn can be acting on a page
    // the user has walked away from. That divergence is invisible everywhere else.
    const out = renderAgentState(
      facts({
        step: 5,
        boundTab: page('Order history — Acme', 'https://acme.com/orders'),
        boundTabOnScreen: false,
      }),
    ) as string
    expect(out).toContain('acting on')
    expect(out).toContain('acme.com')
    expect(out).toContain('not currently on screen')
  })

  it('stays silent about the bound tab while the user is looking at it', () => {
    // Step 18 so the block definitely renders on its budget line — this asserts
    // the "acting on" line is absent from a block that exists, which is stricter
    // than the block simply being null.
    const out = renderAgentState(
      facts({ step: 18, boundTab: page('Acme', 'https://acme.com'), boundTabOnScreen: true }),
    ) as string
    expect(out).toContain('step 18 of 24')
    expect(out).not.toContain('acting on')
  })
})

describe('renderAgentState — session and continuity', () => {
  it('reports an open page-control session with its granted plan', () => {
    const out = renderAgentState(
      facts({ step: 3, control: { plan: 'check my order status', actions: 4 } }),
    ) as string
    expect(out).toContain('page control')
    expect(out).toContain('check my order status')
    expect(out).toContain('4 actions')
  })

  it('says a session has taken no actions yet rather than printing "0 actions"', () => {
    const out = renderAgentState(facts({ step: 3, control: { plan: 'book a table', actions: 0 } })) as string
    expect(out).toContain('no actions yet')
  })

  it('reports that history was compacted', () => {
    // The single fact most worth carrying: after a fold the model's own record of
    // what it already tried is whatever the cheap summariser preserved in prose.
    const out = renderAgentState(facts({ step: 9, compactedTurns: 12 })) as string
    expect(out).toContain('12 earlier turns')
  })

  it("carries the last checkpoint's next action", () => {
    const out = renderAgentState(
      facts({ step: 2, checkpoint: { nextAction: 'open the order detail for #4471' } }),
    ) as string
    expect(out).toContain('open the order detail for #4471')
  })

  it('reports auto-continue position only once the chain has continued at least once', () => {
    expect(renderAgentState(facts({ step: 2, autoContinue: { used: 0, max: 3 } }))).toBeNull()
    const out = renderAgentState(facts({ step: 2, autoContinue: { used: 1, max: 3 } })) as string
    expect(out).toContain('auto-continue 1 of 3')
  })
})

describe('renderAgentState — safety and cost', () => {
  it('never carries page content, only identity', () => {
    // Identity only, matching the on-screen line's own rule. A block that quoted
    // the page would be a second, ungated content channel.
    const out = renderAgentState(
      facts({
        step: 4,
        onScreen: [page('Inbox (3) — secret@example.com', 'https://mail.google.com/u/0')],
        onScreenAtSend: [],
        control: { plan: 'read the latest email', actions: 1 },
      }),
    ) as string
    expect(out).toContain('mail.google.com')
    // The title is rendered verbatim; nothing beyond title+url is ever added.
    const body = out.replace('<agent-state>', '').replace('</agent-state>', '')
    expect(body).not.toMatch(/content|snippet|text:/i)
  })

  it('stays small even when every fact is present', () => {
    // Injected on every step of a 24-step turn, so the ceiling matters.
    const out = renderAgentState({
      step: 18,
      maxSteps: 24,
      autoContinue: { used: 2, max: 3 },
      onScreen: [page('Gmail', 'https://mail.google.com')],
      onScreenAtSend: [page('Acme', 'https://acme.com')],
      boundTab: page('Order history — Acme', 'https://acme.com/orders'),
      boundTabOnScreen: false,
      control: { plan: 'check my order status', actions: 4 },
      compactedTurns: 12,
      checkpoint: { nextAction: 'open the order detail for #4471' },
    }) as string
    expect(out.length).toBeLessThan(600)
  })

  it('truncates a runaway checkpoint action rather than letting it grow unbounded', () => {
    const out = renderAgentState(
      facts({ step: 4, checkpoint: { nextAction: 'x'.repeat(1000) } }),
    ) as string
    expect(out.length).toBeLessThan(400)
  })

  it('truncates a runaway control plan', () => {
    const out = renderAgentState(
      facts({ step: 4, control: { plan: 'y'.repeat(1000), actions: 2 } }),
    ) as string
    expect(out.length).toBeLessThan(400)
  })
})
