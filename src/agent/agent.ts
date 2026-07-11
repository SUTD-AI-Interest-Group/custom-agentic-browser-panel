import {
  streamText,
  generateText,
  isStepCount,
  NoSuchToolError,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'

// UI-facing representation of one assistant turn. A turn is an ordered list
// of parts: streamed text interleaved with tool invocations.

export type UIPart =
  | { type: 'text'; text: string }
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
}

export interface AgentTurnResult {
  parts: UIPart[]
  /** Messages to append to the model-facing history. */
  responseMessages: ModelMessage[]
}

const MAX_STEPS = 24

/**
 * Drop `undefined`-valued keys from model messages via a JSON round-trip.
 *
 * Tool executors can return objects with optional fields left `undefined`
 * (e.g. ControlPage's `urlChanged` on a non-navigation action). The AI SDK
 * stores that object inside a tool result's `{ type: 'json', value }` output
 * but only strips *top-level* undefined — a nested `undefined` survives. On
 * the NEXT turn the SDK re-validates the whole history against its message
 * schema, where `undefined` is not a valid JSON value, and rejects the entire
 * prompt with "The messages must be a ModelMessage[]". Round-tripping through
 * JSON removes undefined recursively, keeping every turn valid — and repairs
 * conversations already persisted with the bad shape. Falls back to the
 * original message if it somehow isn't JSON-serializable.
 */
function toValidModelMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    try {
      return JSON.parse(JSON.stringify(m)) as ModelMessage
    } catch {
      return m
    }
  })
}

export async function runAgentTurn(options: {
  model: LanguageModel
  system: string
  history: ModelMessage[]
  tools: ToolSet
  abortSignal: AbortSignal
  onUpdate: (parts: UIPart[]) => void
  /**
   * Data URLs of marked screenshots awaiting delivery to the model. The
   * OpenAI-compatible adapter serializes a tool result's `media` part to
   * plain text, so images never reach the model that way — perception
   * tools (InspectPage, RequestPageControl) stash their set-of-marks
   * screenshot here instead, and prepareStep injects it as a `user` image
   * message right before the next step, the one channel the adapter
   * actually turns into an `image_url`.
   */
  imageQueue?: string[]
}): Promise<AgentTurnResult> {
  const { model, system, history, tools, abortSignal, onUpdate } = options

  const parts: UIPart[] = []
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
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal,
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
      // A hallucinated tool name can't be fixed by re-generating arguments.
      if (NoSuchToolError.isInstance(error)) return null
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
    prepareStep: ({ initialMessages, responseMessages }) => {
      // v7 changed prepareStep semantics: a `messages` override now carries
      // forward as the base for all later steps (v6 applied it to one step
      // only). Rebuild the base from initialMessages + responseMessages every
      // step so an injected set-of-marks screenshot is shown only to the step
      // that acts on the element list it matches, and stale shots don't stack
      // across a control session (their [index] marks go wrong after an action).
      const base = [...initialMessages, ...responseMessages]
      const queue = options.imageQueue
      if (!queue || queue.length === 0) return { messages: base }
      const imgs = queue.splice(0, queue.length)
      const injected: ModelMessage[] = imgs.map((dataUrl) => ({
        role: 'user',
        content: [
          // v7 deprecated the `{ type: 'image', image }` part in favor of a
          // `file` part with an image mediaType (the data URL's own image/png
          // type is extracted and takes precedence over this top-level 'image').
          { type: 'file' as const, mediaType: 'image', data: dataUrl },
          {
            type: 'text' as const,
            text: 'Set-of-marks screenshot of the current page — the numbered boxes correspond to the [index] values in the element list you just read.',
          },
        ],
      }))
      return { messages: [...base, ...injected] }
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
      case 'tool-call': {
        parts.push({
          type: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? part.args,
          state: 'running',
        })
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

  // v7: top-level `result.response` is now final-step-only metadata (a
  // deprecated alias for finalStep.response), and step messages no longer
  // accumulate — so `result.response.messages` would drop this turn's earlier
  // tool calls/results. `result.responseMessages` is the accumulated
  // assistant/tool history across every step, which is what the next turn needs.
  // Keep it valid for the next turn: strip any nested undefined a tool result
  // carried before it lands in the conversation.
  const responseMessages = await result.responseMessages
  return { parts, responseMessages: toValidModelMessages(responseMessages) }
}
