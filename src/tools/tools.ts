import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { saveMemory, searchMemories } from '../data/memory'
import type { TabAccess } from '../data/settings'
import { getActiveTab, listOpenTabs, readTabContent } from '../platform/tabs'

// ---------------------------------------------------------------------------
// Human-in-the-loop approval gate
//
// Every agent tool asks the user for permission before it runs: the tool's
// execute() suspends on requestApproval() until the user clicks Allow/Deny
// on an inline card in the chat. The AI SDK's multi-step loop is unaware of
// the pause — from the model's perspective the tool just returned.
//
// Future tools (form autofill, page control, memory, skills) plug into the
// same gate: add an entry to createAgentTools and the approval UI, streaming
// and rendering all come for free.
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  toolName: string
  /** One-line, human-readable description of what will happen. */
  summary: string
  /** The model's stated reason, shown to the user. */
  reason: string
}

export type ApprovalGate = (request: ApprovalRequest) => Promise<boolean>

const DENIED = {
  denied: true,
  message: 'The user denied permission for this tool call.',
}

export function createAgentTools(requestApproval: ApprovalGate, tabAccess: TabAccess): ToolSet {
  const tools: ToolSet = {
    ViewCurrentTab: tool({
      description:
        'Read the webpage in the tab the user is currently viewing: title, URL, selected text and full visible text. Asks the user for permission first. Use when the user refers to "this page/tab" or content they are looking at.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To summarize this article"'),
      }),
      execute: async ({ reason }) => {
        const approved = await requestApproval({
          toolName: 'ViewCurrentTab',
          summary: 'View the tab you are currently on',
          reason,
        })
        if (!approved) return DENIED
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        return await readTabContent(tab.id)
      },
    }),

    ViewOpenedTabs: tool({
      description:
        'List all tabs the user has open (titles, URLs, tab ids). Optionally pass tabIds to also read the full content of specific tabs. Asks the user for permission first. Use to find or read a tab other than the current one.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find your open documentation tabs"'),
        tabIds: z
          .array(z.number())
          .optional()
          .describe(
            'Tab ids (from a previous ViewOpenedTabs listing) whose full content should be read. Omit to only list tabs.',
          ),
      }),
      execute: async ({ reason, tabIds }) => {
        const reading = tabIds && tabIds.length > 0
        const approved = await requestApproval({
          toolName: 'ViewOpenedTabs',
          summary: reading
            ? `Read the content of ${tabIds.length} open tab${tabIds.length > 1 ? 's' : ''}`
            : 'See the list of your open tabs',
          reason,
        })
        if (!approved) return DENIED
        const tabs = await listOpenTabs()
        if (!reading) return { tabs }
        const contents = await Promise.all(tabIds.map((id) => readTabContent(id)))
        return { tabs, contents }
      },
    }),

    SaveMemory: tool({
      description:
        'Save a durable memory about the user to local long-term storage (the browser\'s IndexedDB). Use when the user shares something worth remembering across conversations — who they are, preferences, ongoing projects — or explicitly asks you to remember something. Asks the user for permission first. Do not store secrets like passwords or API keys.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "So I remember your preferred format"'),
        kind: z
          .enum(['fact', 'preference', 'project'])
          .describe('fact: stable info about the user; preference: how they want you to behave; project: ongoing work or goals'),
        content: z
          .string()
          .describe('The memory as one self-contained sentence, understandable without this conversation'),
        tags: z.array(z.string()).optional().describe('A few lowercase keywords to help future recall'),
      }),
      execute: async ({ reason, kind, content, tags }) => {
        const approved = await requestApproval({
          toolName: 'SaveMemory',
          summary: `Remember: “${content}”`,
          reason,
        })
        if (!approved) return DENIED
        const record = await saveMemory({ kind, content, tags, source: 'agent' })
        return { saved: true, id: record.id, content: record.content }
      },
    }),

    SearchMemory: tool({
      description:
        'Search your long-term memories from past conversations (saved explicitly or distilled during nightly memory consolidation). The most relevant memories are already in your system prompt — use this to dig deeper when the user references past context you cannot see. Asks the user for permission first.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To recall what we discussed about your thesis"'),
        query: z.string().describe('Keywords to search memory contents and tags'),
      }),
      execute: async ({ reason, query }) => {
        const approved = await requestApproval({
          toolName: 'SearchMemory',
          summary: `Search saved memories for “${query}”`,
          reason,
        })
        if (!approved) return DENIED
        const memories = await searchMemories(query)
        if (memories.length === 0) return { memories: [], note: 'No matching memories found.' }
        return {
          memories: memories.map((m) => ({
            id: m.id,
            kind: m.kind,
            content: m.content,
            updatedAt: new Date(m.updatedAt).toISOString().slice(0, 10),
          })),
        }
      },
    }),
  }

  // Honor the tab-visibility preference chosen in onboarding: in active-tab
  // mode the model never even sees a tool that could enumerate other tabs.
  if (tabAccess !== 'all-tabs') delete tools.ViewOpenedTabs

  return tools
}
