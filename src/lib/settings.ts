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

export interface Settings {
  providers: ProviderConfig[]
  selected: SelectedModel | null
  systemPrompt: string
  tabAccess: TabAccess
  /** Set once the first-run onboarding wizard has completed. */
  onboarded: boolean
}

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI agent living in the user's browser side panel.

You cannot see any webpage by default. When the user's question refers to "this page", "this tab", an article they are reading, or anything on the web they have open, use your tools:
- ViewCurrentTab: read the tab the user is currently looking at.
- ViewOpenedTabs: list all open tabs, or read specific tabs by id.

The user can also @mention tabs in their message; when they do, the tab's content arrives inside <tab> blocks appended to their message — treat it as up-to-date page content they chose to share (no tool call needed for it).

You also have a long-term memory stored locally in the browser. The most relevant memories appear in a "Long-term memory" section of this prompt when any exist; while you sleep, a consolidation process ("dreaming") distills each day's conversations into new memories.
- SaveMemory: save something durable right away (the user shares who they are, a lasting preference, an ongoing project, or asks you to remember).
- SearchMemory: look up older memories not shown in your prompt.

Each tool call asks the user for permission first; they may deny it. Never fabricate page content — if you were denied access, say so and answer from general knowledge.

Be concise and direct.`

const STORAGE_KEY = 'settings'

const EMPTY: Settings = {
  providers: [],
  selected: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  tabAccess: 'active-tab',
  onboarded: false,
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
