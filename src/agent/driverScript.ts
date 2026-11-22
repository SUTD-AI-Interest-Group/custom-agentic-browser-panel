// The "model" behind a `@driver` turn: a scripted LanguageModelV3 that never calls a network. It
// stands where the chat model stands in the offscreen chat host (src/background/chatHost.ts picks it
// when the run carries `driver`), so the whole durable-chat path — the approval cards, Stop, the
// transcript, saving, presence teardown, history — runs unchanged. Only the next step is decided
// differently: from the tool results already in its prompt.
//
//   1. no tool call yet this turn       → RequestPageControl({ plan: goal })  — the "Control <host>" card
//   2. RequestPageControl granted       → FastSteps({ goal, values })         — every point-of-no-return card inside
//      denied / error                   → a short final text, and stop
//   3. FastSteps handed back at max steps → FastSteps again, at most MAX_FAST_STEPS_RUNS runs in all
//      anything else                    → a short final text, and stop
//
// A PARKED result (the tab was not in front) never appears mid-cycle — parkPending stops the cycle
// on it — so seeing one as the newest result means the chain is resuming after the user came back:
// the same call is made again. The token grants nothing: the session and every card are FastSteps'
// and RequestPageControl's own, exactly as for the chat model.
//
// PURE. No Chrome, no fetch, no engine, nothing from `ai/test`. The final text is deterministic and
// short; it names element LABELS (the name part of a registry line, never its `= "value"`), lookup
// KEY names and reason enums — never a typed value. FastSteps' result already omits typed values;
// the registry line's value is skipped by construction (elementLabel).

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { DriverSpec } from '../decider/driverPrompt'

export const DRIVER_SCRIPT_MODEL_ID = 'lychee-driver-script'
/** FastSteps runs per turn, the first included: two re-runs after a `max steps` hand-back. */
export const MAX_FAST_STEPS_RUNS = 3
/** Tool calls per turn, whatever they are — a backstop so no prompt shape can loop the script. */
export const MAX_SCRIPT_CALLS = 8

const RPC = 'RequestPageControl'
const FAST = 'FastSteps'

type Outcome = { kind: 'value'; value: unknown } | { kind: 'error'; text: string } | { kind: 'denied' }
interface SeenCall {
  name: string
  input: unknown
  outcome?: Outcome
}

export type DriverAction = { tool: typeof RPC | typeof FAST; input: Record<string, unknown> } | { text: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const valueOf = (o: Outcome | undefined): Record<string, unknown> | undefined => (o?.kind === 'value' && isObj(o.value) ? o.value : undefined)
const isParked = (o: Outcome | undefined) => valueOf(o)?.parked === true

function outcomeOf(output: unknown): Outcome | undefined {
  if (!isObj(output)) return undefined
  switch (output.type) {
    case 'json':
    case 'text':
      return { kind: 'value', value: output.value }
    case 'error-text':
      return { kind: 'error', text: String(output.value ?? '') }
    case 'error-json':
      return { kind: 'error', text: JSON.stringify(output.value ?? '') }
    case 'execution-denied':
      return { kind: 'denied' }
    default:
      return undefined
  }
}

const collapse = (t: string) => t.replace(/\s+/g, ' ').trim()
const userText = (m: LanguageModelV3Prompt[number]): string =>
  m.role === 'user' ? m.content.map((p) => (p.type === 'text' ? p.text : ' ')).join(' ') : ''

/**
 * Where this turn starts: just after the newest user message that IS the driver message — its text
 * begins with the goal (the panel's model-facing copy is the message minus the token, then its
 * context blocks; parseDriverPrompt's goal is that same text, whitespace collapsed). Roles alone
 * cannot say it: the messages prepareStep injects at the tail (the agent-state block, queued
 * images, the wrap-up nudge) are `user` messages too, and a fresh turn can follow an earlier one
 * that ended on a tool result. Without a goal to match (never sent: the panel refuses an empty
 * one), the fallback is the user message before the newest run of assistant/tool messages.
 */
function turnStart(prompt: LanguageModelV3Prompt, goal: string): number {
  const want = collapse(goal)
  if (want) {
    for (let i = prompt.length - 1; i >= 0; i--) if (prompt[i].role === 'user' && collapse(userText(prompt[i])).startsWith(want)) return i + 1
  }
  let end = prompt.length
  while (end > 0 && (prompt[end - 1].role === 'user' || prompt[end - 1].role === 'system')) end--
  let start = end
  while (start > 0 && prompt[start - 1].role !== 'user' && prompt[start - 1].role !== 'system') start--
  return start
}

/** This turn's tool calls, oldest first, each with its result (turnStart says where it begins). */
export function turnCalls(prompt: LanguageModelV3Prompt, goal: string): SeenCall[] {
  const calls: SeenCall[] = []
  const byId = new Map<string, SeenCall>()
  for (const msg of prompt.slice(turnStart(prompt, goal))) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type !== 'tool-call') continue
        const call: SeenCall = { name: part.toolName, input: part.input }
        calls.push(call)
        byId.set(part.toolCallId, call)
      }
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const call = byId.get(part.toolCallId)
        if (call) call.outcome = outcomeOf(part.output)
      }
    }
  }
  return calls
}

// ---------------------------------------------------------------------------
// The final text
// ---------------------------------------------------------------------------

const LABEL_CAP = 60

/**
 * The NAME of element `[index]` in a registry (domIndex.ts serializeRegistry:
 * `[3]<input> email "Email" = "ada@example.com" (sensitive)`) — the first quoted token after the
 * optional type, never the `= "…"` value, which may be something the user's profile filled in.
 */
export function elementLabel(registry: string | undefined, index: number | undefined): string | undefined {
  if (typeof registry !== 'string' || index === undefined) return undefined
  for (const line of registry.split('\n')) {
    const m = /^\[(\d+)\]<[^>]*>\s?(.*)$/.exec(line)
    if (!m || Number(m[1]) !== index) continue
    const name = /^(?:[a-z][a-z0-9-]*\s+)?"(.*?)"(?=\s|$)/.exec(m[2])
    const label = name?.[1].replace(/[`\r\n]+/g, ' ').trim()
    if (!label) return undefined
    return label.length > LABEL_CAP ? `${label.slice(0, LABEL_CAP - 1)}…` : label
  }
  return undefined
}

const stepsOf = (v: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  Array.isArray(v?.steps) ? (v!.steps as unknown[]).filter(isObj) : []

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Why a FastSteps run ended, as the second half of "Stopped after N steps — …". */
function whyStopped(v: Record<string, unknown>): string {
  const reason = typeof v.reason === 'string' ? v.reason : ''
  const best = Array.isArray(v.lastDecision) && isObj(v.lastDecision[0]) ? v.lastDecision[0] : undefined
  const index = typeof best?.index === 'number' ? best.index : undefined
  const op = typeof best?.op === 'string' ? best.op : undefined
  const p = typeof best?.p === 'number' && Number.isFinite(best.p) ? best.p.toFixed(2) : undefined
  const label = elementLabel(typeof v.elements === 'string' ? v.elements : undefined, index)
  const at = label ? ` at "${label}"` : index !== undefined ? ` at element [${index}]` : ''
  switch (reason) {
    case 'unsure':
      if (op === 'done') return `the decision model wasn't sure the task was done${p ? ` (p=${p})` : ''}`
      return `the decision model wasn't sure${p ? ` (p=${p})` : ''}${at || (op === 'scroll' ? ' whether to scroll' : '')}`
    case 'needs value':
      return op === 'select'
        ? `the decision model couldn't choose an option${label ? ` in "${label}"` : ''}`
        : `the decision model had no value to type${label ? ` into "${label}"` : ''} — put the text in double quotes`
    case 'denied':
      return `you declined the step${at}`
    case 'repeat':
      return `it would have repeated the same step${at}`
    case 'failed actions':
      return 'the page refused its actions'
    case 'no progress':
      return 'its last actions changed nothing on the page'
    case 'dense page':
      return 'the page is too dense for the decision model'
    case 'max steps':
      return 'it ran out of steps before finishing'
    case 'page moved':
      return 'the page moved to another site'
    case 'page changed':
      return 'the page changed before it could act'
    case 'unreadable page':
      return "it couldn't read the page"
    case 'decider error':
      return `the decision model failed${typeof v.message === 'string' && v.message ? ` (${v.message.slice(0, 160)})` : ''}`
    case 'session ended':
      return 'page control ended'
    case 'steer':
      return 'you sent a new instruction'
    case 'stopped':
      return 'the turn was stopped'
    case 'another FastSteps run is in progress':
      return 'another run was already in progress'
    case 'parked':
      return 'the tab is no longer in front'
    default:
      return reason ? `it stopped (${reason})` : 'it stopped'
  }
}

/** The text a driver turn ends on, from every FastSteps result of the turn (oldest first). */
export function finalTextFor(fastSteps: (Outcome | undefined)[]): string {
  const values = fastSteps.map(valueOf)
  const steps = values.flatMap(stepsOf)
  const n = steps.length
  const keys = [...new Set(steps.map((s) => s.key).filter((k): k is string => typeof k === 'string' && /^(request|profile)\./.test(k)))]
  const typed = keys.length ? ` Typed values: ${keys.join(', ')}.` : ''
  const last = fastSteps[fastSteps.length - 1]
  const lead = n === 0 ? 'Stopped before taking a step' : `Stopped after ${plural(n, 'step')}`
  if (last?.kind === 'error') return `${lead} — the decision model couldn't run (${last.text.slice(0, 160)}).${typed}`
  if (last?.kind === 'denied') return `${lead} — the step was not allowed.${typed}`
  const v = valueOf(last)
  if (!v) return `${lead}.${typed}`
  if (typeof v.error === 'string') return `${lead} — the decision model couldn't run (${v.error.slice(0, 160)}).${typed}`
  if (v.status === 'done') return `Done in ${plural(n, 'step')}.${typed}`
  return `${lead} — ${whyStopped(v)}.${typed}`
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the script does next, from the prompt it was handed and the tools on offer (null = assume
 * every tool is offered). Pure.
 */
export function nextDriverAction(spec: DriverSpec, prompt: LanguageModelV3Prompt, offered: ReadonlySet<string> | null): DriverAction {
  const has = (name: string) => offered === null || offered.has(name)
  const calls = turnCalls(prompt, spec.goal)
  const relevant = calls.filter((c) => c.name === RPC || c.name === FAST)
  const fast = relevant.filter((c) => c.name === FAST)
  const fastText = () => finalTextFor(fast.filter((c) => !isParked(c.outcome)).map((c) => c.outcome))
  if (calls.length >= MAX_SCRIPT_CALLS) return { text: fast.length ? fastText() : 'Stopped: page control could not be started.' }

  // What the decider is told (the framed goal when the values are goal phrases); the turn itself is
  // still found by the user's own words (turnCalls, above).
  const target = spec.deciderGoal ?? spec.goal
  const requestControl = (): DriverAction =>
    has(RPC) ? { tool: RPC, input: { plan: target } } : { text: "Page control isn't available in this chat (Settings → Permissions)." }
  const fastSteps = (): DriverAction =>
    has(FAST)
      ? { tool: FAST, input: { goal: target, values: { ...spec.values } } }
      : { text: "Page control was granted, but the decision model isn't available — check Settings → Experimental." }

  const last = relevant[relevant.length - 1]
  if (!last) return requestControl()
  // Resuming after a park: make the same call again.
  if (isParked(last.outcome)) return last.name === RPC ? requestControl() : fastSteps()

  if (last.name === RPC) {
    const v = valueOf(last.outcome)
    if (v?.started === true) return fastSteps()
    if (v?.denied === true || last.outcome?.kind === 'denied') return { text: 'You declined page control.' }
    const why = last.outcome?.kind === 'error' ? last.outcome.text : typeof v?.error === 'string' ? v.error : ''
    return { text: `Couldn't take control of the page${why ? ` (${why.slice(0, 160)})` : ''}.` }
  }

  const v = valueOf(last.outcome)
  const runs = fast.filter((c) => !isParked(c.outcome)).length
  if (v?.status === 'handback' && v.reason === 'max steps' && runs < MAX_FAST_STEPS_RUNS && has(FAST)) return fastSteps()
  return { text: fastText() }
}

// ---------------------------------------------------------------------------
// The LanguageModelV3
// ---------------------------------------------------------------------------

const ZERO_USAGE = (): LanguageModelV3Usage => ({
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
})
const finish = (unified: LanguageModelV3FinishReason['unified']): LanguageModelV3FinishReason => ({ unified, raw: undefined })

let seq = 0
const defaultId = () => `driver_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/**
 * The scripted model for one `@driver` run. `newId` makes tool-call ids deterministic in tests; by
 * default they are unique across the conversation (a later chat-model turn replays them).
 */
export function createDriverScript(spec: DriverSpec, o: { newId?: () => string } = {}): LanguageModelV3 {
  const newId = o.newId ?? defaultId
  const decide = (options: LanguageModelV3CallOptions) =>
    nextDriverAction(spec, options.prompt, options.tools ? new Set(options.tools.map((t) => t.name)) : null)
  return {
    specificationVersion: 'v3',
    provider: 'lychee',
    modelId: DRIVER_SCRIPT_MODEL_ID,
    supportedUrls: {},
    async doGenerate(options) {
      const action = decide(options)
      const content: LanguageModelV3Content[] =
        'tool' in action
          ? [{ type: 'tool-call', toolCallId: newId(), toolName: action.tool, input: JSON.stringify(action.input) }]
          : [{ type: 'text', text: action.text }]
      return { content, finishReason: finish('tool' in action ? 'tool-calls' : 'stop'), usage: ZERO_USAGE(), warnings: [] }
    },
    async doStream(options) {
      const action = decide(options)
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      if ('tool' in action) {
        parts.push({ type: 'tool-call', toolCallId: newId(), toolName: action.tool, input: JSON.stringify(action.input) })
      } else {
        const id = newId()
        parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: action.text }, { type: 'text-end', id })
      }
      parts.push({ type: 'finish', usage: ZERO_USAGE(), finishReason: finish('tool' in action ? 'tool-calls' : 'stop') })
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p)
            controller.close()
          },
        }),
      }
    },
  }
}
