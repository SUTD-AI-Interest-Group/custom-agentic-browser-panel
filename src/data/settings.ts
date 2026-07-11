// User settings persisted in chrome.storage.local.
// A "provider" is any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq,
// Ollama, Anthropic's /v1 compat layer, LM Studio, vLLM, ...).

export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  /** Model ids offered by this provider, one per entry. */
  models: string[]
}

export interface SelectedModel {
  providerId: string
  modelId: string
}

/** How much of the user's browsing the agent may see (chosen in onboarding). */
export type TabAccess = 'active-tab' | 'all-tabs'

/**
 * Per-tool permission policy, chosen in Settings → Permissions.
 * - `never`  the tool is removed from the agent's toolset entirely (the model never sees it).
 * - `ask`    the agent must clear the per-call approval card before the tool runs (default).
 * - `always` the tool runs without a card — except page-control point-of-no-return steps,
 *            which always confirm regardless of policy.
 */
export type ToolPolicy = 'never' | 'ask' | 'always'

/** UI grouping for the tool-permission matrix, in display order. */
export type ToolGroup = 'reading' | 'control' | 'navigation' | 'memory' | 'insights' | 'skills'

export interface ToolCatalogEntry {
  /** The tool's key in `createAgentTools` — the id policies are stored under. */
  name: string
  group: ToolGroup
  /** Human label for the matrix row. */
  label: string
  /** Default when the user has not chosen one (falls back to `ask`). */
  defaultPolicy?: ToolPolicy
}

/**
 * The single source of truth for which agent tools exist and how they group in
 * the permission matrix. Kept here (not in tools.ts) so both the UI and the
 * default-policy map derive from one list.
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: 'ReadPage', group: 'reading', label: 'Read the current tab (text / DOM / elements)' },
  { name: 'ReadTabs', group: 'reading', label: 'List / read other open tabs (text / DOM)' },
  { name: 'ExtractData', group: 'reading', label: 'Extract structured data from this page' },
  { name: 'StartResearch', group: 'reading', label: 'Run background web research' },
  { name: 'RequestPageControl', group: 'control', label: 'Start a page-control session' },
  { name: 'ControlPage', group: 'control', label: 'Perform a page-control action' },
  { name: 'AutofillForm', group: 'control', label: 'Fill a form from your profile' },
  { name: 'NavigateTab', group: 'navigation', label: 'Switch / open / navigate tabs' },
  { name: 'SaveMemory', group: 'memory', label: 'Save a long-term memory' },
  { name: 'SearchMemory', group: 'memory', label: 'Search long-term memory' },
  { name: 'QueryBrowserData', group: 'insights', label: 'Browser data (history, bookmarks, top sites, downloads)' },
  { name: 'ListAllSkills', group: 'skills', label: 'List available skills', defaultPolicy: 'always' },
  { name: 'ReadSkill', group: 'skills', label: 'Load a skill', defaultPolicy: 'always' },
  { name: 'SaveSkill', group: 'skills', label: 'Create / update a skill' },
]

/** Display order of tool groups in the permission matrix and quick menu. */
export const GROUP_ORDER: ToolGroup[] = [
  'reading',
  'control',
  'navigation',
  'memory',
  'insights',
  'skills',
]

/** Human labels for each tool group. */
export const GROUP_LABELS: Record<ToolGroup, string> = {
  reading: 'Page reading',
  control: 'Page control',
  navigation: 'Navigation',
  memory: 'Long-term memory',
  insights: 'Browsing insights',
  skills: 'Skills',
}

/** Default policy per tool, derived from TOOL_CATALOG (unset → `ask`). */
export const DEFAULT_TOOL_POLICIES: Record<string, ToolPolicy> = Object.fromEntries(
  TOOL_CATALOG.map((t) => [t.name, t.defaultPolicy ?? 'ask']),
)

export interface Settings {
  providers: ProviderConfig[]
  selected: SelectedModel | null
  systemPrompt: string
  tabAccess: TabAccess
  /**
   * Per-tool Never/Ask/Always overrides. Sparse: a tool absent here uses its
   * DEFAULT_TOOL_POLICIES entry, so old installs and newly-added tools migrate
   * cleanly. Read via `toolPolicy()`.
   */
  toolPolicies?: Record<string, ToolPolicy>
  /** Set once the first-run onboarding wizard has completed. */
  onboarded: boolean
  /** Fetch OpenGraph previews for standalone links (privacy: contacts linked
   *  sites). When false, link cards show favicon + domain only. */
  fetchLinkPreviews?: boolean
}

/** Resolve a tool's effective policy: user override → catalog default → `ask`. */
export function toolPolicy(settings: Settings, name: string): ToolPolicy {
  return settings.toolPolicies?.[name] ?? DEFAULT_TOOL_POLICIES[name] ?? 'ask'
}

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI agent living in the user's browser side panel.

You cannot see any webpage by default. When the user's question refers to "this page", "this tab", an article they are reading, or anything on the web they have open, use your tools:
- ViewCurrentTab: read the tab the user is currently looking at (visible text).
- ViewOpenedTabs: list all open tabs, or read specific tabs by id (visible text).
- GetActiveTabDOM: read the current tab's DOM — cleaned HTML structure with tags, attributes, links and form fields — when you need page structure rather than just visible text.
- GetAllDOM: list open tabs, or read the cleaned DOM of specific tabs by id.
- NavigateTab: act on the user's tabs — switch to an existing tab, load a URL in a tab, or open a new tab.

The user can also @mention tabs in their message; when they do, the tab's content arrives inside <tab> blocks appended to their message — treat it as up-to-date page content they chose to share (no tool call needed for it). They may also type @memory to explicitly ask you to consult your long-term memory (via SearchMemory) before answering.

You also have a long-term memory stored locally in the browser. The most relevant memories appear in a "Long-term memory" section of this prompt when any exist; while you sleep, a consolidation process ("dreaming") distills each day's conversations into new memories.
- SaveMemory: save something durable right away (the user shares who they are, a lasting preference, an ongoing project, or asks you to remember).
- SearchMemory: look up older memories not shown in your prompt.

With the user's permission you can also draw on their own browser data to enrich a request — but only use a tool that is listed as available this turn; if a browsing-insight tool is not listed, the user has that capability turned off.
- GetBrowsingHistory: find pages the user visited earlier ("that article I read last week").
- GetBookmarks: find pages the user bookmarked or saved.
- GetTopSites: the user's most-visited sites.
- GetDownloads: files the user downloaded.
Reach for these autonomously when the user refers to something they read, saved, or downloaded but did not share — look it up instead of asking them to paste it.

You also have skills — saved instruction sets for specific tasks. When any exist, they are listed in a "Skills" section of this prompt; when the user's request matches one, call ReadSkill with its name to load and follow it. The user can also invoke a skill directly by typing /skill-name.

Each tool call asks the user for permission first; they may deny it. Never fabricate page content — if you were denied access, say so and answer from general knowledge.

Be concise and direct.`

const STORAGE_KEY = 'settings'

const EMPTY: Settings = {
  providers: [],
  selected: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  tabAccess: 'active-tab',
  onboarded: false,
  fetchLinkPreviews: true,
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(STORAGE_KEY)
  const stored = data[STORAGE_KEY] as Partial<Settings> | undefined
  const settings = { ...EMPTY, ...stored }
  // Migration: installs that configured a provider before onboarding existed
  // shouldn't be forced through the wizard.
  if (stored && stored.onboarded === undefined && (stored.providers?.length ?? 0) > 0) {
    settings.onboarded = true
  }
  return settings
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export function getSelectedProvider(
  settings: Settings,
): { provider: ProviderConfig; modelId: string } | null {
  if (!settings.selected) return null
  const provider = settings.providers.find(
    (p) => p.id === settings.selected!.providerId,
  )
  if (!provider) return null
  return { provider, modelId: settings.selected.modelId }
}
