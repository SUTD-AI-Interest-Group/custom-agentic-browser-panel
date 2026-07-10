import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { saveMemory, searchMemories } from '../data/memory'
import { getSkill, listSkillMetas, saveSkill } from '../data/skills'
import type { TabAccess } from '../data/settings'
import { getActiveTab, listOpenTabs, readTabContent } from '../platform/tabs'
import { getBrowsingHistory, getBookmarks, getTopSites, getDownloads } from '../platform/browsingData'
import type { BrowsingCapability } from '../platform/permissions'

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

export function createAgentTools(
  requestApproval: ApprovalGate,
  tabAccess: TabAccess,
  granted: Set<BrowsingCapability>,
): ToolSet {
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

    GetBrowsingHistory: tool({
      description:
        "Search the user's own browser history for pages they visited. Asks the user for permission first. Use to enrich a request when the user refers to something they read or visited earlier but did not share — e.g. \"that article I read last week\".",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the article you read about X"'),
        query: z
          .string()
          .optional()
          .describe('Free-text terms to match page title/URL. Omit to list recent history.'),
        sinceDays: z.number().optional().describe('How many days back to search (default 7).'),
        maxResults: z.number().optional().describe('Max entries to return (default 50, max 200).'),
      }),
      execute: async ({ reason, query, sinceDays, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetBrowsingHistory',
          summary: query
            ? `Search your browsing history for “${query}”`
            : 'Look through your recent browsing history',
          reason,
        })
        if (!approved) return DENIED
        const history = await getBrowsingHistory({ query, sinceDays, maxResults })
        return { history }
      },
    }),

    GetBookmarks: tool({
      description:
        "Search or list the user's bookmarks. Asks the user for permission first. Use when the user refers to a page they bookmarked or saved, or asks what they have bookmarked.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the docs you bookmarked"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match bookmark title/URL. Omit to list recent bookmarks.'),
        maxResults: z.number().optional().describe('Max bookmarks to return (default 50, max 200).'),
      }),
      execute: async ({ reason, query, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetBookmarks',
          summary: query ? `Search your bookmarks for “${query}”` : 'List your recent bookmarks',
          reason,
        })
        if (!approved) return DENIED
        const bookmarks = await getBookmarks({ query, maxResults })
        return { bookmarks }
      },
    }),

    GetTopSites: tool({
      description:
        "List the user's most-visited sites (their new-tab top sites). Asks the user for permission first. Use when the user asks about the sites they use most, or you need their frequent destinations to tailor an answer.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To see which sites you use most"'),
      }),
      execute: async ({ reason }) => {
        const approved = await requestApproval({
          toolName: 'GetTopSites',
          summary: 'See your most-visited sites',
          reason,
        })
        if (!approved) return DENIED
        const sites = await getTopSites()
        return { sites }
      },
    }),

    GetDownloads: tool({
      description:
        "Search the user's download history. Asks the user for permission first. Use when the user refers to a file they downloaded — e.g. \"the PDF I downloaded yesterday\" — or asks what they have downloaded.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the file you downloaded"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match filename or URL. Omit to list recent downloads.'),
        state: z
          .enum(['complete', 'in_progress', 'interrupted'])
          .optional()
          .describe('Filter by download state.'),
        maxResults: z.number().optional().describe('Max downloads to return (default 25, max 100).'),
      }),
      execute: async ({ reason, query, state, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetDownloads',
          summary: 'Look through your downloads',
          reason,
        })
        if (!approved) return DENIED
        const downloads = await getDownloads({ query, state, maxResults })
        return { downloads }
      },
    }),

    ListAllSkills: tool({
      description:
        'List all skills available to you (name + description). The most relevant skills are already summarized in your system prompt; use this to see the full current list before loading one with ReadSkill.',
      inputSchema: z.object({}),
      execute: async () => {
        const approved = await requestApproval({
          toolName: 'ListAllSkills',
          summary: 'List your saved skills',
          reason: 'To see which skills are available',
        })
        if (!approved) return DENIED
        const skills = await listSkillMetas({ modelInvocableOnly: true })
        return { skills }
      },
    }),

    ReadSkill: tool({
      description:
        "Load the full instructions for a skill by name, then follow them for the current task. Use when the user invokes a skill or when a request matches a skill listed in your system prompt. Returns the skill's instruction body.",
      inputSchema: z.object({
        name: z.string().describe('The exact skill name to load, e.g. "summarizing-pages"'),
      }),
      execute: async ({ name }) => {
        const approved = await requestApproval({
          toolName: 'ReadSkill',
          summary: `Load the “${name}” skill`,
          reason: "To follow this skill's instructions",
        })
        if (!approved) return DENIED
        const skill = await getSkill(name)
        if (!skill) return { error: `No skill named "${name}". Use ListAllSkills to see valid names.` }
        if (!skill.modelInvocable)
          return { error: `The "${name}" skill can only be run when the user types /${name}; it cannot be auto-loaded.` }
        return { name: skill.name, description: skill.description, body: skill.body }
      },
    }),

    SaveSkill: tool({
      description:
        "Create or update a skill in the user's local Skills Library. Use when the user has agreed on a skill to save (for example during /create-skill). Upserts by name; an existing custom skill with the same name is overwritten. Asks the user for permission first. Built-in skills cannot be overwritten.",
      inputSchema: z.object({
        name: z
          .string()
          .describe('Skill slug: lowercase letters, numbers and single hyphens, ≤64 chars (e.g. "drafting-replies")'),
        description: z
          .string()
          .describe('Third-person sentence stating what the skill does and when to use it, with trigger keywords'),
        body: z.string().describe('The Markdown instruction body the assistant follows when the skill runs'),
        icon: z.string().optional().describe('A single emoji to represent the skill in the Library'),
        userInvocable: z
          .boolean()
          .optional()
          .describe('Whether the user can run it by typing /name (default true)'),
        modelInvocable: z
          .boolean()
          .optional()
          .describe('Whether you may auto-load it via ReadSkill when relevant (default true). Set false for user-only actions.'),
      }),
      execute: async ({ name, description, body, icon, userInvocable, modelInvocable }) => {
        const approved = await requestApproval({
          toolName: 'SaveSkill',
          summary: `Save skill “${name}”`,
          reason: description,
        })
        if (!approved) return DENIED
        try {
          const saved = await saveSkill({ name, description, body, icon, userInvocable, modelInvocable })
          return { saved: true, name: saved.name }
        } catch (err) {
          // Validation / built-in-overwrite failures come back as text so the
          // model can correct the name and retry rather than treating it as denial.
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
  }

  // Honor the tab-visibility preference chosen in onboarding: in active-tab
  // mode the model never even sees a tool that could enumerate other tabs.
  if (tabAccess !== 'all-tabs') delete tools.ViewOpenedTabs

  // Browsing-data tools are hidden unless the user has granted the matching
  // optional permission — the model never sees a capability that is off.
  if (!granted.has('history')) delete tools.GetBrowsingHistory
  if (!granted.has('bookmarks')) delete tools.GetBookmarks
  if (!granted.has('topSites')) delete tools.GetTopSites
  if (!granted.has('downloads')) delete tools.GetDownloads

  return tools
}
