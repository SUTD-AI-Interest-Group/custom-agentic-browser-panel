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
 * The `_meta` key MCP Apps use to point a tool at its ui:// output template.
 * (The registered form per SEP-1865; openai/outputTemplate is the interop alias
 * some servers still ship.)
 */
function uiTemplateOf(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.['ui'] ?? meta?.['openai/outputTemplate']
  if (typeof ui === 'string' && ui.startsWith('ui://')) return ui
  if (typeof ui === 'object' && ui !== null) {
    const uri = (ui as Record<string, unknown>).uri ?? (ui as Record<string, unknown>).resourceUri
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
      const key = mcpToolName(server.name, t.name, taken)
      taken.add(key)
      tools[key] = makeTool(key, server.name, t)
    }
  }
  return tools

  function makeTool(key: string, serverName: string, info: McpToolInfo) {
    const appTemplate = uiTemplateOf(info.meta)
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
          result = await manager.callTool(serverName, info.name, args, {
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
          }
          try {
            const res = await manager.readResource(serverName, appTemplate, { signal: abortSignal })
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
      },
    })
  }
}
