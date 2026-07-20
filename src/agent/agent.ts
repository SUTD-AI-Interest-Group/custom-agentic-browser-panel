import {
  streamText,
  generateText,
  isStepCount,
  hasToolCall,
  tool,
  NoSuchToolError,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { z } from 'zod'
import { resolveActiveTools } from '../tools/toolDiscovery'
import type { ModelUsage, Trace } from './observability'
import type { ResearchVerification } from '../data/researchTasks'

// UI-facing representation of one assistant turn. A turn is an ordered list
// of parts: streamed text interleaved with tool invocations.

export type UIPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool'
      toolCallId: string
      toolName: string
      input: unknown
      output?: unknown
      state: 'running' | 'done' | 'error'
      errorText?: string
    }

/**
 * A webpage the assistant drew on for a reply, shown as a favicon source.
 * Tool-read pages are derived from an assistant message's tool parts at render
 * time; pages attached to the preceding user turn (synced tabs) are stored on
 * the assistant message's `sources` because they live only in model-facing text.
 */
export interface MessageSource {
  title: string
  url: string
}

// One rendered message in the transcript: a role plus ordered parts (streamed
// text interleaved with tool invocations), and any attached screenshots.
export interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  parts: UIPart[]
  /** Screenshot data URLs attached to a user message. */
  images?: string[]
  /**
   * Pages attached to the preceding user turn (auto current tab, @mentions,
   * @all) that this reply drew on. Merged with tool-read pages for the source
   * bar. Absent on user messages and turns with no attached tabs.
   */
  sources?: MessageSource[]
  /** True while the silent LaTeX self-correction pass is re-asking the model to
   *  fix math this bubble contains; drives the "fixing math…" indicator. */
  fixingMath?: boolean
  /**
   * When set, this assistant bubble is an auto-continuation of a long task
   * (the Nth cycle), rendered with a "↻ Continued automatically" divider above
   * it. Absent on the first cycle and on normal turns.
   */
  autoContinue?: number
  /**
   * Marks a background-research report injected into the transcript: it renders
   * as a research report card (titled header + report body) instead of a plain
   * reply, so it scrolls with the chat and later turns follow it. The report
   * text lives in `parts`; `sources` carries the fetched pages.
   */
  research?: { question: string; error?: string; verification?: ResearchVerification }
  /**
   * Tokens this assistant turn cost, summed across every step (and every cycle of
   * a continuation chain). Rendered as a subtle line under the reply. Absent on
   * user messages and when the endpoint reports no usage.
   */
  usage?: ModelUsage
}

/**
 * Why a turn's loop ended — the *successful* completion path only. Aborts (Stop)
 * and provider errors are thrown to the caller instead (its catch distinguishes
 * them), so they are not represented here.
 *  - `completed`  — the model finished (emitted a final answer with no tool call).
 *  - `checkpoint` — the model called `Checkpoint` to hand off an unfinished task
 *                   because it was running out of step budget (rich reflection).
 *  - `budget`     — the model hit the hard step ceiling mid-tool-call without
 *                   checkpointing (a cut-off, no reflection).
 */
export type TurnStopReason = 'completed' | 'checkpoint' | 'budget'

/**
 * An image waiting to be shown to the model, with the words that explain it.
 *
 * The caption is not decoration. It rides WITH the image because the queue now
 * carries two very different things — `ReadPage`'s set-of-marks shot, whose
 * numbered boxes map to the click registry's `[index]` values, and `Screenshot`'s
 * plain crops and tiles, which have no boxes on them at all. A single hardcoded
 * caption would tell the model to look for numbered boxes on an unmarked photo of
 * a bar chart, and it would duly hallucinate them.
 */
export interface QueuedImage {
  /** PNG data URL. */
  dataUrl: string
  /** What this image is, in the model's own reading order. */
  caption: string
}

/**
 * The model's structured hand-off when it runs out of step budget before
 * finishing, captured from a `Checkpoint` tool call. It rides in the message
 * history (so a continuation re-reads the model's own reflection) and is shown
 * in the Continue card.
 */
export interface Checkpoint {
  /** What has been accomplished so far. */
  done: string[]
  /** Concrete steps still to do. */
  remaining: string[]
  /** Dead-ends / wrong approaches found this cycle, so the next cycle skips them. */
  avoid: string[]
  /** The single next action to take on resume. */
  nextAction: string
}

export interface AgentTurnResult {
  parts: UIPart[]
  /** Messages to append to the model-facing history. */
  responseMessages: ModelMessage[]
  /** How/why the loop ended, so the caller can auto-continue or prompt the user. */
  stop: { reason: TurnStopReason; checkpoint?: Checkpoint; stepsUsed: number }
  /**
   * Tokens used across every step of this turn. Absent when the endpoint reports
   * no usage (see `includeUsage` in createModel). A continuation chain sums this
   * across its cycles.
   */
  usage?: ModelUsage
}

// The single budget bounding ALL agent activity in one turn (page control
// included — the old per-session action budget was removed in favor of this).
const MAX_STEPS = 24
// Steps of runway before the ceiling at which we nudge the model to wrap up and
// checkpoint, rather than get cut off mid-action. Fires at step MAX_STEPS−LEAD.
const NUDGE_LEAD = 3
// The injected control-signal tool's name (see checkpointTool).
const CHECKPOINT_TOOL = 'Checkpoint'

// Default budget-awareness nudge, injected once per turn near the step ceiling.
// A caller can override it (research passes a "final cycle — write the report
// now" variant) or disable it with an empty string.
const DEFAULT_WRAP_UP_NUDGE =
  "You are close to this turn's step limit. If the task is NOT finished, stop taking actions now and call the Checkpoint tool to hand off: what you've completed (done), what remains (remaining), any dead-ends or wrong paths to avoid next time (avoid), and the single next action (nextAction). Do NOT start a new sub-task or a fresh page-control flow — just checkpoint. If you are essentially done, finish your answer normally instead."

/**
 * Ungated control-signal tool injected into every turn's toolset (never listed
 * in createAgentTools, so it never appears in the tool-permission UI). Calling
 * it ends the turn (see the `hasToolCall` stop condition) and hands off
 * structured state for continuation. It touches no page/network/user data, so
 * it is deliberately exempt from the requestApproval gate — the human
 * checkpoint is the Continue card the caller shows, not this call itself.
 */
const checkpointTool = tool({
  description:
    "Hand off an unfinished task when you are about to run out of step budget. Call this INSTEAD of continuing when you cannot finish in the remaining steps: record what's done, what remains, any wrong paths to avoid, and the exact next action. Calling it ends the current turn cleanly so the work resumes with a fresh budget. Do not call it if you can finish now.",
  inputSchema: z.object({
    done: z.array(z.string()).describe('What you have accomplished so far'),
    remaining: z.array(z.string()).describe('Concrete steps still to do'),
    avoid: z
      .array(z.string())
      .describe('Dead-ends / wrong approaches found this cycle, so the next cycle skips them'),
    nextAction: z.string().describe('The single next action to take on resume'),
  }),
  execute: async () => ({ acknowledged: true }),
})

/**
 * Sanitise model messages before they are sent to the model or persisted. Two jobs:
 *
 * 1. **Drop `undefined`-valued keys** via a JSON round-trip. Tool executors can
 *    return objects with optional fields left `undefined` (e.g. ControlPage's
 *    `urlChanged` on a non-navigation action). The AI SDK stores that inside a
 *    tool result's `{ type: 'json', value }` output but only strips *top-level*
 *    undefined — a nested one survives. On the NEXT turn the SDK re-validates the
 *    whole history, where `undefined` is not valid JSON, and rejects the entire
 *    prompt with "The messages must be a ModelMessage[]". Round-tripping removes
 *    undefined recursively, keeping every turn valid — and repairs conversations
 *    already persisted with the bad shape.
 *
 * 2. **Strip assistant `reasoning` parts.** The app never renders them (the stream
 *    loop ignores reasoning chunks), and once persisted they lose the OpenAI
 *    Responses adapter's provider metadata — so replaying them only triggers a
 *    "Non-OpenAI reasoning parts are not supported. Skipping reasoning part"
 *    warning (the SDK drops them anyway; the request already succeeds without
 *    them). The final text and tool calls carry all the state the next turn needs.
 *    An assistant message left with no content is dropped whole.
 *
 * Falls back to the original message if it somehow isn't JSON-serializable.
 */
export function toValidModelMessages(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of messages) {
    let msg = m
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const content = m.content.filter((p) => p.type !== 'reasoning')
      if (content.length === 0) continue
      if (content.length !== m.content.length) msg = { ...m, content } as ModelMessage
    }
    try {
      out.push(JSON.parse(JSON.stringify(msg)) as ModelMessage)
    } catch {
      out.push(msg)
    }
  }
  return out
}

export async function runAgentTurn(options: {
  model: LanguageModel
  system: string
  history: ModelMessage[]
  tools: ToolSet
  abortSignal: AbortSignal
  onUpdate: (parts: UIPart[]) => void
  /**
   * Captioned images awaiting delivery to the model. The OpenAI-compatible
   * adapter serializes a tool result's `media` part to plain text, so images
   * never reach the model that way — perception tools (ReadPage modes
   * "elements"/"regions", RequestPageControl, Screenshot) stash their capture
   * here instead, and prepareStep injects it as a `user` image message right
   * before the next step, the one channel the adapter actually turns into an
   * `image_url`.
   */
  imageQueue?: QueuedImage[]
  /**
   * Per-turn set of tool names the model has loaded (via GetTool) or the app
   * has seeded from context. When present, each step's `activeTools` is the
   * always-on core plus this set, intersected with the turn's real tools — so
   * only those tool schemas are sent to the model. Absent = every tool active
   * (legacy behavior).
   */
  activeNames?: Set<string>
  /**
   * Overrides the near-the-ceiling wrap-up nudge (see DEFAULT_WRAP_UP_NUDGE).
   * Pass a custom string to change it (the research agent's final cycle says
   * "write the report now"), or '' to disable the nudge for this turn.
   */
  wrapUpNudge?: string
  /**
   * Overrides the turn's step ceiling (default MAX_STEPS). Nested sub-agents run
   * on a much shorter leash than a foreground turn — the browse sub-agent
   * (src/agent/browseAgent.ts) gets a dozen clicks, not two dozen.
   */
  maxSteps?: number
  /**
   * Agent steering: a predicate the caller sets to true when the user has queued a
   * mid-task steer. It is OR'd into `stopWhen`, so the loop halts at the NEXT step
   * boundary — after the current step's tool call has executed (nothing orphaned),
   * before the model's next action. The caller (runTurnChain) then splices the
   * queued steer into history and continues the chain with a fresh cycle. This
   * predicate only READS the flag; draining the queue is the caller's job, so the
   * queue survives for runTurnChain to consume after the cycle returns.
   */
  steerPending?: () => boolean
  /**
   * Optional Langfuse trace for this turn (created by the caller). When present,
   * each model step is recorded as a generation with token usage; when absent,
   * observability is off and nothing here runs. Tool spans are emitted separately
   * by the instrumented toolset — see `createAgentTools`.
   */
  trace?: Trace
}): Promise<AgentTurnResult> {
  const { model, system, history, tools, abortSignal, onUpdate } = options
  const wrapUpNudge = options.wrapUpNudge ?? DEFAULT_WRAP_UP_NUDGE
  const maxSteps = options.maxSteps ?? MAX_STEPS
  const trace = options.trace
  const modelId = (model as { modelId?: string }).modelId
  // Per-step latency: attribute the wall-clock between step boundaries to each
  // generation (model call + any tool execution in that step).
  let stepStart = new Date().toISOString()
  let stepIndex = 0

  const parts: UIPart[] = []
  // Captured if the model calls Checkpoint (its input IS the reflection payload).
  let checkpoint: Checkpoint | undefined
  const emit = () => onUpdate([...parts])

  const result = streamText({
    model,
    // v7 renamed the top-level `system` option to `instructions` (`system`
    // still works as a deprecated fallback). The app keeps its own `system`
    // field on runAgentTurn's options and maps it here.
    instructions: system,
    // Sanitize incoming history so a conversation already persisted with a
    // nested-undefined tool result (see toValidModelMessages) still runs.
    messages: toValidModelMessages(history),
    // Inject the ungated Checkpoint control tool so every turn can hand off. The
    // `as ToolSet` keeps streamText's TOOLS generic string-keyed — a literal
    // 'Checkpoint' key would otherwise narrow toolChoice.toolName elsewhere.
    tools: { ...tools, [CHECKPOINT_TOOL]: checkpointTool } as ToolSet,
    // Ways to stop (OR semantics — whichever fires first): the hard step ceiling
    // (v7's isStepCount), the model choosing to hand off via Checkpoint, or a
    // user steer queued mid-task (halt at the next step boundary so runTurnChain
    // can splice it into history and continue — see the steerPending option).
    stopWhen: [
      isStepCount(maxSteps),
      hasToolCall(CHECKPOINT_TOOL),
      () => options.steerPending?.() ?? false,
    ],
    abortSignal,
    // Observability: record one Langfuse generation per model step (tokens,
    // finish reason, tool calls) and roll the turn totals onto the trace. All
    // reads are defensive — a shape change or Langfuse hiccup never breaks a turn.
    onStepFinish: trace
      ? (step: any) => {
          const start = stepStart
          stepStart = new Date().toISOString()
          const idx = stepIndex++
          try {
            const toolNames = Array.isArray(step?.toolCalls)
              ? step.toolCalls.map((t: any) => t?.toolName).filter(Boolean)
              : undefined
            const gen = trace.generation({
              name: `step-${idx + 1}`,
              model: (step?.response?.modelId as string) || modelId,
              input: step?.request?.body,
              startTime: start,
              metadata: toolNames?.length ? { toolCalls: toolNames } : undefined,
            })
            gen.end({
              output: step?.content ?? { text: step?.text, toolCalls: step?.toolCalls },
              usage: step?.usage,
              finishReason: step?.finishReason,
            })
          } catch {
            /* best-effort */
          }
        }
      : undefined,
    onFinish: trace
      ? (final: any) => {
          try {
            trace.update({
              metadata: {
                totalUsage: final?.totalUsage,
                steps: Array.isArray(final?.steps) ? final.steps.length : undefined,
                finishReason: final?.finishReason,
              },
            })
          } catch {
            /* best-effort */
          }
        }
      : undefined,
    // Large tool inputs (a skill's Markdown body, a long typed string) make the
    // model occasionally emit malformed JSON arguments, which fail schema
    // validation and surface as a red "… failed" tool card before the model
    // retries on its own. Repair that first attempt silently: re-ask the same
    // model with its broken call and the validation error fed back, forcing it
    // to reissue the same tool with corrected arguments. We deliberately re-ask
    // (rather than generateObject) so this leans only on ordinary tool-calling
    // and works against any OpenAI-compatible endpoint, no JSON/structured
    // -output mode required. On ANY failure we return null: a thrown repair
    // function escalates to a ToolCallRepairError that would abort the whole
    // turn, so falling back to null preserves today's benign self-correction.
    repairToolCall: async ({ toolCall, tools: turnTools, error, messages: priorMessages, instructions: sys }) => {
      if (NoSuchToolError.isInstance(error)) {
        // Progressive disclosure: under `activeTools`, a tool the model has not
        // loaded yet is *unavailable*, and the SDK rejects the call BEFORE
        // execute() runs. For a gated tool that is fatal — its approval card
        // never appears and the model has no way back (after denying page
        // control it could never re-ask, because RequestPageControl is not in
        // the always-on core and is only re-seeded while a session is open).
        // The system prompt names these tools, so models routinely call them
        // directly instead of going through GetTool.
        //
        // So: if the model named a REAL tool that is merely unloaded, rewrite
        // the call into GetTool to load it. The model then calls it for real on
        // the next step and reaches execute() — and its permission card. Tools
        // removed by policy/permission/tab-access are absent from `tools`
        // entirely, so they can never be resurrected this way.
        // `Object.hasOwn`, not `in`: the latter also matches prototype keys, so a
        // hallucinated "toString"/"constructor" would look loadable.
        const name = toolCall.toolName
        const loadable =
          !!options.activeNames &&
          name !== 'GetTool' &&
          Object.hasOwn(tools, name) &&
          Object.hasOwn(tools, 'GetTool')
        if (loadable) {
          return { ...toolCall, toolName: 'GetTool', input: JSON.stringify({ names: [name] }) }
        }
        // A genuinely hallucinated name can't be fixed by re-generating arguments.
        return null
      }
      try {
        const repaired = await generateText({
          model,
          instructions: sys,
          messages: [
            ...priorMessages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: toolCall.input,
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  output: { type: 'error-text', value: error.message },
                },
              ],
            },
          ],
          tools: turnTools,
          toolChoice: { type: 'tool', toolName: toolCall.toolName },
          abortSignal,
        })
        const fixed = repaired.toolCalls.find((tc) => tc.toolName === toolCall.toolName)
        if (!fixed) return null
        return { ...toolCall, input: JSON.stringify(fixed.input) }
      } catch {
        return null
      }
    },
    prepareStep: ({ stepNumber, initialMessages, responseMessages }) => {
      // v7 changed prepareStep semantics: a `messages` override now carries
      // forward as the base for all later steps (v6 applied it to one step
      // only). Rebuild the base from initialMessages + responseMessages every
      // step so an injected set-of-marks screenshot is shown only to the step
      // that acts on the element list it matches (stale shots' [index] marks go
      // wrong after an action), and so the wrap-up nudge below never lingers.
      const base = [...initialMessages, ...responseMessages]
      const injected: ModelMessage[] = []
      // Drain any queued images (see imageQueue / QueuedImage docs). Each carries
      // its own caption — what the image IS differs per producer, and telling the
      // model the wrong thing about a picture is worse than showing it none.
      const queue = options.imageQueue
      if (queue && queue.length > 0) {
        const imgs = queue.splice(0, queue.length)
        injected.push(
          ...imgs.map((img): ModelMessage => ({
            role: 'user',
            content: [
              // v7 deprecated the `{ type: 'image', image }` part in favor of a
              // `file` part with an image mediaType (the data URL's own image/png
              // type is extracted and takes precedence over this top-level 'image').
              { type: 'file' as const, mediaType: 'image', data: img.dataUrl },
              { type: 'text' as const, text: img.caption },
            ],
          })),
        )
      }
      // Budget-awareness: once within NUDGE_LEAD steps of the ceiling, tell the
      // model to wrap up / checkpoint instead of getting cut off mid-action. base
      // is rebuilt each step (no stacking), so re-injecting per step keeps the
      // wrap-up pressure on across the final steps.
      if (wrapUpNudge && stepNumber >= maxSteps - NUDGE_LEAD) {
        injected.push({ role: 'user', content: wrapUpNudge })
      }
      // Progressive disclosure: expose only the always-on core plus whatever the
      // model has loaded (GetTool) or the app seeded this turn, intersected with
      // the turn's real tools. Absent activeNames = legacy "every tool active".
      const activeTools = options.activeNames
        ? resolveActiveTools(options.activeNames, Object.keys(tools))
        : undefined
      const messages = [...base, ...injected]
      return activeTools ? { messages, activeTools } : { messages }
    },
  })

  const findTool = (id: string) =>
    parts.find((p) => p.type === 'tool' && p.toolCallId === id) as
      | Extract<UIPart, { type: 'tool' }>
      | undefined

  // v7 renamed `fullStream` to `stream` (fullStream remains a deprecated
  // alias). Part shapes have varied across SDK versions (text vs textDelta,
  // input vs args, ...), so keep reading them defensively.
  for await (const part of result.stream as AsyncIterable<any>) {
    switch (part.type) {
      case 'text-delta': {
        const delta: string = part.text ?? part.textDelta ?? ''
        const last = parts[parts.length - 1]
        if (last?.type === 'text') last.text += delta
        else parts.push({ type: 'text', text: delta })
        emit()
        break
      }
      // The model's reasoning summary (reasoning models only). Display-only: it
      // accumulates into a `reasoning` UI part for the collapsible "Thinking"
      // block, but is stripped from the replay history (see toValidModelMessages).
      // Consecutive deltas merge into one part; a text/tool part between two
      // reasoning bursts starts a fresh block, mirroring text-delta.
      case 'reasoning-delta': {
        const delta: string = part.delta ?? part.text ?? part.textDelta ?? ''
        if (!delta) break
        const last = parts[parts.length - 1]
        if (last?.type === 'reasoning') last.text += delta
        else parts.push({ type: 'reasoning', text: delta })
        emit()
        break
      }
      case 'tool-call': {
        const input = part.input ?? part.args
        parts.push({
          type: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input,
          state: 'running',
        })
        // The Checkpoint call's input IS the structured hand-off; capture it so
        // the caller can auto-continue / render the Continue card.
        if (part.toolName === CHECKPOINT_TOOL) {
          const c = (input ?? {}) as Partial<Checkpoint>
          checkpoint = {
            done: c.done ?? [],
            remaining: c.remaining ?? [],
            avoid: c.avoid ?? [],
            nextAction: c.nextAction ?? '',
          }
        }
        emit()
        break
      }
      case 'tool-result': {
        const t = findTool(part.toolCallId)
        if (t) {
          t.output = part.output ?? part.result
          t.state = 'done'
          emit()
        }
        break
      }
      case 'tool-error': {
        const t = findTool(part.toolCallId)
        if (t) {
          t.state = 'error'
          t.errorText = String(part.error)
          emit()
        }
        break
      }
      case 'error': {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }
  }

  // Distinguish how the loop ended so the caller can auto-continue or prompt: an
  // explicit Checkpoint hand-off, a hard step-ceiling cut-off (the model still
  // wanted to act — finishReason 'tool-calls' at the ceiling), or a natural
  // finish. Aborts/provider errors throw out of the stream above instead, and
  // are distinguished by the caller's catch.
  const stepsUsed = (await result.steps).length
  const finishReason = await result.finishReason
  // The AI SDK resolves the TOP-LEVEL finishReason to 'other' when a `stopWhen`
  // condition halts the loop — the *step's* own reason was 'tool-calls', but that
  // is not what surfaces here. Testing for 'tool-calls' therefore never matched,
  // so a turn cut off at the ceiling was mislabelled 'completed' and runTurnChain
  // broke out of the continuation chain instead of auto-continuing. A turn the
  // model ended by itself reports 'stop'; anything else at the ceiling is a cut-off.
  const reason: TurnStopReason = checkpoint
    ? 'checkpoint'
    : stepsUsed >= maxSteps && finishReason !== 'stop'
      ? 'budget'
      : 'completed'
  // v7: use result.responseMessages (accumulated assistant/tool history across
  // every step) — result.response is now final-step-only and would drop earlier
  // tool calls/results. Keep it valid for the next turn: strip any nested
  // undefined a tool result carried before it lands in the conversation.
  const responseMessages = await result.responseMessages
  // Token usage summed across every step of this turn. A streaming endpoint only
  // reports this when the provider asks for it — see `includeUsage` in createModel.
  // `totalUsage` is a PromiseLike (no .catch), so guard it the long way.
  let usage: ModelUsage | undefined
  try {
    usage = await result.totalUsage
  } catch {
    usage = undefined
  }
  return {
    parts,
    responseMessages: toValidModelMessages(responseMessages),
    stop: { reason, checkpoint, stepsUsed },
    usage,
  }
}
