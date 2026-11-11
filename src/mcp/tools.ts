// MCP tools as AI-SDK dynamic tools. Built per continuation chain and handed
// to createAgentTools as `extraTools`, so they enter the SAME ToolSet as the
// built-ins — which is what buys the two architecture invariants for free:
// the progressive-disclosure catalog is derived from that ToolSet (a 40-tool
// server costs nothing per step until the model GetTool-loads one, and the
// unloaded-call repair path can load it), and every execute() below routes
// through requestApproval before touching the network.
//
// Policy is the two-level MCP scheme (per-tool override → server default →
// ask, src/mcp/config.ts); `never` at either level means the tool is simply
// not built, so it can never be disclosed or repaired back in.

import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import type { JSONSchema7 } from '@ai-sdk/provider'
import type { Settings } from '../data/settings'
import type { ApprovalGate } from '../tools/tools'
import type { QueuedImage } from '../agent/agent'
import { saveMcpArtifact } from '../data/mcpArtifacts'
import { mcpSettings, mcpToolName, mcpToolPolicy, serverEnabled } from './config'
import { mapCallResult } from './content'
import type { McpManager, McpToolInfo } from './manager'

/** Per-call ceiling; generous because remote MCP tools can be slow (LLM-backed). */
const CALL_TIMEOUT_MS = 60_000

const DENIED = {
  denied: true,
  message: 'The user denied permission for this tool call.',
}

/**
 * The `_meta` keys MCP Apps use to point a tool at its ui:// output template:
 * the registered extension id (io.modelcontextprotocol/ui) per SEP-1865, the
 * short `ui` form, and openai/outputTemplate — the interop alias some servers
 * still ship.
 */
function uiTemplateOf(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.['io.modelcontextprotocol/ui'] ?? meta?.['ui'] ?? meta?.['openai/outputTemplate']
  if (typeof ui === 'string' && ui.startsWith('ui://')) return ui
  if (typeof ui === 'object' && ui !== null) {
    const u = ui as Record<string, unknown>
    const uri = u.uri ?? u.resourceUri ?? u.template
    if (typeof uri === 'string' && uri.startsWith('ui://')) return uri
  }
  return undefined
}

/**
 * Build one dynamic tool per cataloged MCP tool of every enabled server.
 * `taken` collects the sanitized names so collisions dedupe deterministically.
 */
export function buildMcpTools(opts: {
  manager: McpManager
  settings: Settings
  requestApproval: ApprovalGate
  imageQueue: QueuedImage[]
  conversationId: string
  visionCapable: boolean
}): ToolSet {
  const { manager, settings, requestApproval, imageQueue, conversationId, visionCapable } = opts
  const mcp = mcpSettings(settings)
  const tools: ToolSet = {}
  const taken = new Set<string>()

  for (const server of manager.runtime()) {
    if (server.status === 'unsupported' || server.status === 'disabled') continue
    if (!(server.name in mcp.servers) || !serverEnabled(mcp, server.name)) continue
    for (const t of server.tools) {
      if (mcpToolPolicy(mcp, server.name, t.name) === 'never') continue
      const ui = t.meta?.ui as { visibility?: string[] } | undefined
      if (Array.isArray(ui?.visibility) && !ui.visibility.includes('model')) continue
      const key = mcpToolName(server.name, t.name, taken)
      taken.add(key)
      tools[key] = makeTool(key, server.name, t)
      if (t.taskSupport === 'required' || t.taskSupport === 'optional') {
        const taskKey = mcpToolName(server.name, `${t.name}_task`, taken)
        taken.add(taskKey)
        tools[taskKey] = dynamicTool({
          description: `[MCP · ${server.name}] Check, retrieve, or cancel a task started by ${key}. Respect pollInterval between checks; do other work while it runs. Tasks persist across panel restarts. Completion automatically resumes this chat when open.`,
          inputSchema: jsonSchema({ type: 'object', properties: {
            taskId: { type: 'string' }, action: { type: 'string', enum: ['status', 'result', 'cancel'] },
          }, required: ['taskId', 'action'], additionalProperties: false }),
          execute: async (input, { abortSignal }) => {
            const args = input as { taskId: string; action: 'status' | 'result' | 'cancel' }
            if (mcpToolPolicy(mcp, server.name, t.name) !== 'always' && !await requestApproval({
              toolName: taskKey, summary: `${args.action} task on ${server.name}`,
              reason: `Manage the task started by ${t.name}.`,
            })) return DENIED
            try {
              const response = await manager.taskOperation(server.name, t.name, conversationId, args.taskId, args.action, abortSignal)
              if (response.result) return renderResult(response.result, server.name, t, response.args ?? {}, abortSignal)
              return { task: response.task, note: 'Use the task tool to check later or retrieve the final result. Do not resubmit the original tool call.' }
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) }
            }
          },
        })
      }
    }
  }
  return tools

  function makeTool(key: string, serverName: string, info: McpToolInfo) {
    return dynamicTool({
      // The provenance prefix keeps ToolSearch results honest about where a
      // capability comes from (and whose approval card will appear).
      description: `[MCP · ${serverName}] ${info.description || info.name}`,
      inputSchema: jsonSchema((info.inputSchema ?? { type: 'object' }) as JSONSchema7),
      execute: async (input, { abortSignal }) => {
        const args = (input ?? {}) as Record<string, unknown>
        if (mcpToolPolicy(mcp, serverName, info.name) !== 'always') {
          const approved = await requestApproval({
            toolName: key,
            summary: `Call “${info.name}” on the ${serverName} MCP server`,
            reason: info.description || 'No description provided by the server.',
          })
          if (!approved) return DENIED
        }
        let result
        try {
          if (info.taskSupport === 'required' || info.taskSupport === 'optional') {
            const started = await manager.startTool(serverName, info.name, args, conversationId, abortSignal)
            if ('task' in started) return { task: started.task, note: `Task started. Use the task management tool for ${info.name} to check status, retrieve the result, or cancel. Respect pollInterval; do not resubmit this call.` }
            result = started.result
          } else result = await manager.callTool(serverName, info.name, args, {
            signal: abortSignal,
            timeoutMs: CALL_TIMEOUT_MS,
          })
          // No blanket retry here on a dropped connection: the call may have
          // mutated remote state before dying, and a silent second attempt is a
          // double-submit. ensureConnected inside callTool already covers the
          // connect-on-demand case; a mid-call drop surfaces as an error the
          // model can reason about.
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/unauthorized|401/i.test(msg)) {
            return {
              error: `The ${serverName} server requires authorization. Ask the user to click Authorize on this card or in Settings → General → MCP servers, then try again.`,
              needsAuth: true,
              server: serverName,
            }
          }
          return { error: `MCP call failed (${msg}).` }
        }

        return renderResult(result, serverName, info, args, abortSignal)
      },
    })
  }

  async function renderResult(result: unknown, serverName: string, info: McpToolInfo, args: Record<string, unknown>, signal?: AbortSignal) {
    const appTemplate = uiTemplateOf(info.meta)
    const mapped = mapCallResult(
      result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean },
      { server: serverName, tool: info.name },
    )

    // Persist rich payloads as user-facing cards; only ids ride the return.
    const artifactIds: string[] = []
    for (const a of mapped.artifacts) {
      try {
        artifactIds.push(
          await saveMcpArtifact({ ...a, conversationId, server: serverName, tool: info.name }),
        )
      } catch {
        /* a full disk must not fail the call */
      }
    }

    // The image invariant: pictures reach the model via imageQueue only —
    // and only when the model can actually see (a blind model told an
    // image "follows" would loop waiting for it).
    const value = { ...mapped.modelValue }
    if (mapped.images.length > 0) {
      if (visionCapable) {
        imageQueue.push(...mapped.images)
      } else {
        value.note = [
          value.note,
          'You cannot view images, so the image was shown to the user only.',
        ]
          .filter(Boolean)
          .join(' ')
      }
    }
    if (artifactIds.length > 0) value.artifactIds = artifactIds

    // MCP Apps: a tool with a ui:// output template gets an interactive
    // card (McpAppCard → the manifest-sandboxed page). The template is
    // fetched here and cached as an HTML artifact so the card survives
    // reload and disconnection; a text/uri-list template becomes a direct
    // external-URL iframe instead. The model just learns the app was shown.
    if (appTemplate) {
      const app: Record<string, unknown> = {
        server: serverName,
        tool: info.name,
        template: appTemplate,
        toolInput: args,
      }
      try {
        // Preserve the full result, including app-only _meta, outside model history.
        app.resultArtifactId = await saveMcpArtifact({
          kind: 'blob', mimeType: 'application/json', text: JSON.stringify(result),
          title: `${info.name} app result`, conversationId, server: serverName, tool: info.name,
        })
      } catch { /* storage failure leaves the budgeted result fallback */ }
      try {
        const res = await manager.readResource(serverName, appTemplate, { signal })
        const c = ((res as { contents?: unknown[] }).contents?.[0] ?? {}) as Record<string, unknown>
        const mime = typeof c.mimeType === 'string' ? c.mimeType : 'text/html'
        const text = typeof c.text === 'string' ? c.text : undefined
        if (mime.startsWith('text/uri-list') && text) {
          const url = text
            .split('\n')
            .map((l) => l.trim())
            .find((l) => /^https?:\/\//i.test(l))
          if (url) app.externalUrl = url
        } else if (text) {
          app.artifactId = await saveMcpArtifact({
            kind: 'html',
            mimeType: mime,
            text,
            title: `${info.name} app`,
            conversationId,
            server: serverName,
            tool: info.name,
          })
        }
      } catch {
        // Card falls back to a live template read on mount.
      }
      value.app = app
      value.note = [value.note, 'An interactive app card was shown to the user for this result.']
        .filter(Boolean)
        .join(' ')
    }
    return value
  }
}
