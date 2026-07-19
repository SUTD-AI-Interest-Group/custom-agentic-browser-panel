// User settings persisted in chrome.storage.local.
// A "provider" is any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq,
// Ollama, Anthropic's /v1 compat layer, LM Studio, vLLM, ...).

/**
 * Which provider a config talks to. Selects its *capability profile* — reasoning
 * wire format, model-list endpoint, and whether it goes through a native adapter
 * (`openai` → Responses API, `anthropic` → Messages) or the OpenAI-compatible one
 * (everything else). See `src/data/providerProfiles.ts`. Absent on installs saved
 * before profiles existed → `inferKind` derives it from the base URL.
 */
export type ProviderKind =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'groq'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

/**
 * How hard a reasoning model should think. The capability profile translates it
 * into each provider's own dialect — OpenAI/Groq `reasoning_effort`, OpenRouter's
 * `reasoning` object, Ollama's mapped effort, or Anthropic's native thinking
 * budget (see `src/data/providerProfiles.ts`). The wider `xhigh`/`max` rungs exist
 * only for models that expose them (OpenAI gpt-5.6, OpenRouter); a model's slider
 * offers just the subset its profile declares.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Per-model settings that override provider-level defaults. Sparse and keyed by
 * model id, so old installs and newly-added models need no migration.
 */
export interface ModelConfig {
  /** Reasoning effort for this model; overrides the provider's `reasoningEffort`. */
  reasoningEffort?: ReasoningEffort
  /**
   * Manual reasoning-capability override for when auto-detection (id patterns /
   * provider API flags) guesses wrong: `true` forces the effort slider on, `false`
   * hides it, `undefined` leaves it to auto-detection.
   */
  reasoning?: boolean
}

export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  /** Which provider this is; selects its capability profile. Inferred for old installs. */
  kind?: ProviderKind
  /** Model ids offered by this provider, one per entry. */
  models: string[]
  /**
   * Default reasoning effort for this provider's models — a per-model override in
   * `modelConfigs` beats it (resolution: `resolveReasoningEffort`). Unset preserves
   * the endpoint's own default and sends nothing for non-reasoning models.
   */
  reasoningEffort?: ReasoningEffort
  /** Sparse per-model overrides (effort, manual reasoning flag), keyed by model id. */
  modelConfigs?: Record<string, ModelConfig>
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

/**
 * Beta: opt-in Langfuse observability. When `enabled` is false, nothing is
 * tracked and no network request is made. Keys are the user's own Langfuse
 * project keys, stored locally like provider API keys. See
 * `src/agent/observability/`.
 */
export interface ObservabilityConfig {
  /** Master beta toggle. Off by default — no tracking, no overhead. */
  enabled: boolean
  /** Langfuse public key (pk-lf-…). */
  publicKey: string
  /** Langfuse secret key (sk-lf-…). */
  secretKey: string
  /** Ingestion host. Default EU cloud; editable for US / self-hosted. */
  host: string
  /** Send prompt/response/tool text (not just token/timing metadata). */
  captureContent: boolean
  /** Also attach marked/set-of-marks screenshots to generations. Heavy. */
  captureScreenshots: boolean
}

export interface Settings {
  providers: ProviderConfig[]
  selected: SelectedModel | null
  /**
   * Optional model for naming chats. Unset (the default) means "same as the chat
   * model". Worth pointing at a small non-reasoning model: a reasoning model
   * spends ~2k tokens of chain-of-thought and 12–25s writing four words, whereas
   * a small one answers in about a second. Read via `getTitleProvider()`.
   */
  titleModel?: SelectedModel | null
  /**
   * Optional model for the "dreaming" memory-consolidation cycle. Unset (the
   * default) means "same as the chat model". Like `titleModel`, a small, cheap
   * model is often the better pick here — dreaming is a single background
   * generation the user never watches. Resolved via `getDreamProvider()`.
   */
  dreamModel?: SelectedModel | null
  /**
   * Minimum gap between automatic dream cycles, in ms. Unset → 24h
   * (`DEFAULT_DREAM_INTERVAL_MS`). The background alarm honours short values by
   * firing more often (see `src/background.ts`); manual "Dream now" ignores it.
   * Resolved via `resolveDreamIntervalMs()`.
   */
  dreamIntervalMs?: number
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
  /** Beta Langfuse observability. Absent on old installs → treated as disabled. */
  observability?: ObservabilityConfig
}

/** Default (disabled) observability config; also the shape onboarding starts from. */
export const DEFAULT_OBSERVABILITY: ObservabilityConfig = {
  enabled: false,
  publicKey: '',
  secretKey: '',
  host: 'https://cloud.langfuse.com',
  captureContent: true,
  captureScreenshots: false,
}

/** Resolve the effective observability config, filling defaults for old installs. */
export function observabilityConfig(settings: Settings): ObservabilityConfig {
  return { ...DEFAULT_OBSERVABILITY, ...settings.observability }
}

/** Resolve a tool's effective policy: user override → catalog default → `ask`. */
export function toolPolicy(settings: Settings, name: string): ToolPolicy {
  return settings.toolPolicies?.[name] ?? DEFAULT_TOOL_POLICIES[name] ?? 'ask'
}

/**
 * The policy shared by every tool in a group, or `'mixed'` when they disagree.
 * Drives the collapsed group row in the permissions accordion: a uniform group
 * shows a segmented control, a mixed one shows a "Mixed" pill. Resolved through
 * `toolPolicy`, so catalog defaults count — the `skills` group reads as mixed on
 * a fresh install because its tools ship with different defaults.
 */
export function groupPolicy(settings: Settings, group: ToolGroup): ToolPolicy | 'mixed' {
  const tools = TOOL_CATALOG.filter((t) => t.group === group)
  if (tools.length === 0) return 'ask'
  const first = toolPolicy(settings, tools[0].name)
  return tools.every((t) => toolPolicy(settings, t.name) === first) ? first : 'mixed'
}

/** Set every tool in a group to one policy. Returns a new Settings; never mutates. */
export function setGroupPolicy(settings: Settings, group: ToolGroup, policy: ToolPolicy): Settings {
  const toolPolicies = { ...settings.toolPolicies }
  for (const t of TOOL_CATALOG) {
    if (t.group === group) toolPolicies[t.name] = policy
  }
  return { ...settings, toolPolicies }
}

/** A pristine config — what a brand-new install starts from. */
export function defaultSettings(): Settings {
  return structuredClone(EMPTY)
}

/**
 * Factory-reset everything *except* the provider list and selected model.
 * Deliberate: "Reset settings" sits one tap away from a user's only copy of their
 * API keys, and a reset that silently destroyed them would lock the user out of
 * their own endpoint. Erasing keys is what "Erase all data" is for.
 */
export function resetSettingsKeepingProviders(settings: Settings): Settings {
  return {
    ...structuredClone(EMPTY),
    providers: structuredClone(settings.providers),
    selected: settings.selected ? { ...settings.selected } : null,
    // EMPTY is un-onboarded, but a user with providers has plainly onboarded.
    onboarded: true,
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are Lychee, a helpful AI agent living in the user's browser side panel.

You cannot see any webpage by default — use your tools (they are described to you separately) to read a page the user refers to, and never fabricate page content: if you were denied access or could not read a page, say so and answer from general knowledge.

The user can @mention tabs in their message; when they do, the tab's content arrives inside <tab> blocks appended to their message — treat it as up-to-date page content they chose to share (no tool call needed for it). They may also type @memory to ask you to consult your long-term memory before answering.

You also have a long-term memory stored locally in the browser. The most relevant memories appear in a "Long-term memory" section of this prompt when any exist; while you sleep, a consolidation process ("dreaming") distills each day's conversations into new memories.

Be concise and direct.`

/**
 * Defaults that shipped as `systemPrompt` before the Lychee rename, frozen
 * verbatim. `systemPrompt` is *persisted* — every install that has ever saved
 * settings carries its own copy of the default it onboarded with — so bumping
 * `DEFAULT_SYSTEM_PROMPT` alone would never reach an existing user. `loadSettings`
 * swaps a stored copy that byte-matches one of these for the current default; a
 * prompt the user actually edited matches nothing here and is left untouched.
 *
 * Append, never edit: an entry rewritten to match a newer default would start
 * silently overwriting prompts that users had deliberately customised.
 */
const SUPERSEDED_SYSTEM_PROMPTS: readonly string[] = [
  `You are a helpful AI agent living in the user's browser side panel.

You cannot see any webpage by default — use your tools (they are described to you separately) to read a page the user refers to, and never fabricate page content: if you were denied access or could not read a page, say so and answer from general knowledge.

The user can @mention tabs in their message; when they do, the tab's content arrives inside <tab> blocks appended to their message — treat it as up-to-date page content they chose to share (no tool call needed for it). They may also type @memory to ask you to consult your long-term memory before answering.

You also have a long-term memory stored locally in the browser. The most relevant memories appear in a "Long-term memory" section of this prompt when any exist; while you sleep, a consolidation process ("dreaming") distills each day's conversations into new memories.

Be concise and direct.`,
]

const STORAGE_KEY = 'settings'

const EMPTY: Settings = {
  providers: [],
  selected: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  tabAccess: 'active-tab',
  onboarded: false,
  fetchLinkPreviews: true,
  observability: DEFAULT_OBSERVABILITY,
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
  // Migration: an unedited pre-rename prompt is refreshed so the agent learns
  // its name. A customised prompt is never touched.
  if (stored?.systemPrompt && SUPERSEDED_SYSTEM_PROMPTS.includes(stored.systemPrompt)) {
    settings.systemPrompt = DEFAULT_SYSTEM_PROMPT
  }
  // Migration: providers saved before `kind` existed get one inferred from their
  // base URL, so the capability-profile layer and model picker have a key to work
  // from. Use sites also fall back via `providerKind`, so this only persists it.
  settings.providers = settings.providers.map((p) => (p.kind ? p : { ...p, kind: inferKind(p.baseURL) }))
  return settings
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

/**
 * Best-effort provider kind from a base URL, for configs saved before `kind`
 * existed (and as a defensive fallback at use sites). Unrecognised hosts →
 * `custom`, the generic OpenAI-compatible profile.
 */
export function inferKind(baseURL: string): ProviderKind {
  const u = baseURL.toLowerCase()
  if (u.includes('api.openai.com')) return 'openai'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.groq.com')) return 'groq'
  if (u.includes(':11434')) return 'ollama'
  if (u.includes(':1234')) return 'lmstudio'
  return 'custom'
}

/** A provider's kind, falling back to inference for configs that predate the field. */
export function providerKind(provider: ProviderConfig): ProviderKind {
  return provider.kind ?? inferKind(provider.baseURL)
}

/**
 * A model's effective reasoning effort: its per-model override, else the provider
 * default, else unset. The one place that resolves the two-level scheme.
 */
export function resolveReasoningEffort(
  provider: ProviderConfig,
  modelId: string,
): ReasoningEffort | undefined {
  return provider.modelConfigs?.[modelId]?.reasoningEffort ?? provider.reasoningEffort
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

/**
 * The model that names chats: the user's `titleModel` if set, else the chat
 * model. Falls back the same way when the chosen provider has since been
 * deleted, so a stale pick degrades to a working namer rather than none.
 */
export function getTitleProvider(
  settings: Settings,
): { provider: ProviderConfig; modelId: string } | null {
  if (settings.titleModel) {
    const provider = settings.providers.find((p) => p.id === settings.titleModel!.providerId)
    if (provider) return { provider, modelId: settings.titleModel.modelId }
  }
  return getSelectedProvider(settings)
}

/** Default minimum gap between automatic dream cycles — once a day. */
export const DEFAULT_DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The interval choices offered by the Dreaming panel's picker, in display order. */
export const DREAM_INTERVAL_OPTIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '30 minutes', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: '12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: '24 hours', ms: DEFAULT_DREAM_INTERVAL_MS },
]

/**
 * The effective minimum gap between automatic dreams: the user's `dreamIntervalMs`
 * if it is a positive number, else the 24h default. Old installs (field absent)
 * keep the once-a-day cadence they always had.
 */
export function resolveDreamIntervalMs(settings: Settings): number {
  const v = settings.dreamIntervalMs
  return typeof v === 'number' && v > 0 ? v : DEFAULT_DREAM_INTERVAL_MS
}

/**
 * The model that dreams: the user's `dreamModel` if set (and its provider still
 * exists), else the chat model. Falls back the same way `getTitleProvider` does,
 * so a stale pick degrades to a working model rather than none.
 */
export function getDreamProvider(
  settings: Settings,
): { provider: ProviderConfig; modelId: string } | null {
  if (settings.dreamModel) {
    const provider = settings.providers.find((p) => p.id === settings.dreamModel!.providerId)
    if (provider) return { provider, modelId: settings.dreamModel.modelId }
  }
  return getSelectedProvider(settings)
}
