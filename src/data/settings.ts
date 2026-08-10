// User settings persisted in chrome.storage.local.
// A "provider" is any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq,
// Ollama, Anthropic's /v1 compat layer, LM Studio, vLLM, ...).

import type { ModelPrice } from '../agent/pricing'
import type { McpSettings } from '../mcp/config'
import { clearAuth } from '../mcp/auth'
import { openSettings, sealSettings, secretValues } from './settingsVault'
import { isSealed } from './vaultFormat'

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
  /**
   * What this model costs, in dollars per **million** tokens — the unit every
   * provider publishes, so a figure can be copied off a pricing page without
   * arithmetic. User-supplied and per-model rather than shipped as a table,
   * because this app talks to arbitrary OpenAI-compatible endpoints: a bundled
   * price list would be wrong for a custom endpoint immediately and silently
   * stale for the rest within a quarter, and a confidently wrong cost is worse
   * than no cost at all. Applied by `estimateCost` (src/agent/pricing.ts).
   */
  price?: ModelPrice
  /**
   * This model's context window in tokens, overriding the provider profile's
   * conservative `defaultContextLimit`. Read by proactive compaction
   * (`resolveContextLimit`), which folds the old half of a conversation once
   * the last turn's reported input tokens pass a fraction of this.
   *
   * Worth setting when the profile default is well below what the model
   * actually offers — the default errs low on purpose, so an unset value only
   * ever compacts earlier than necessary, never later.
   */
  contextLimit?: number
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
export type ToolGroup = 'reading' | 'control' | 'navigation' | 'memory' | 'insights' | 'skills' | 'mcp'

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
  { name: 'ReadPdf', group: 'reading', label: 'Read / search the open PDF' },
  { name: 'HighlightContent', group: 'reading', label: 'Highlight a passage on the page' },
  { name: 'ReadTabs', group: 'reading', label: 'List / read other open tabs (text / DOM)' },
  { name: 'ExtractData', group: 'reading', label: 'Extract structured data from this page' },
  { name: 'ProposeResearch', group: 'reading', label: 'Propose background web research' },
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
  // MCP server tools themselves are NOT here — their policies are per-server
  // (Settings.mcp.policies, resolved by mcpToolPolicy). These two built-ins
  // read MCP resources across servers, so they ride the ordinary matrix.
  { name: 'ListMcpResources', group: 'mcp', label: 'List MCP server resources', defaultPolicy: 'always' },
  { name: 'ReadMcpResource', group: 'mcp', label: 'Read an MCP server resource' },
]

/** Display order of tool groups in the permission matrix and quick menu. */
export const GROUP_ORDER: ToolGroup[] = [
  'reading',
  'control',
  'navigation',
  'memory',
  'insights',
  'skills',
  'mcp',
]

/** Human labels for each tool group. */
export const GROUP_LABELS: Record<ToolGroup, string> = {
  reading: 'Page reading',
  control: 'Page control',
  navigation: 'Navigation',
  memory: 'Long-term memory',
  insights: 'Browsing insights',
  skills: 'Skills',
  mcp: 'MCP',
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
  /**
   * Record a local, redacted step-by-step trace of each turn (src/data/traces.ts),
   * shown as a collapsible drawer under a reply. Off by default and absent on old
   * installs — it is a debugging surface, not something every user needs, and it
   * costs a store write per turn.
   *
   * Independent of `observability`: that ships content to Langfuse, this never
   * leaves the browser. A user may reasonably want either, both, or neither.
   */
  turnTrace?: boolean
  /**
   * MCP servers: `servers` is byte-for-byte the standard `mcpServers` JSON
   * object (upload/edit/copy are pure serialization); enabled flags and
   * per-server tool policies ride in sidecar maps that never export. Sparse —
   * absent on installs that configured nothing. See `src/mcp/config.ts`.
   */
  mcp?: McpSettings
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
  // The MCP server list is dropped below, but each server's OAuth tokens live
  // in a SEPARATE mcpAuth:<server> sidecar key (src/mcp/auth.ts) that this
  // reset would otherwise never touch — they'd sit sealed in storage
  // indefinitely, orphaned and unmanageable from the UI the moment their
  // server disappears from Settings. Best-effort and fire-and-forget, like
  // every other cleanup in this codebase (saveShot's pruneShots, etc.): a
  // transient storage failure must never block the reset the user is waiting
  // on, and this function stays synchronous so its one call site need not
  // change to await it.
  for (const name of Object.keys(settings.mcp?.servers ?? {})) {
    void clearAuth(name).catch(() => {})
  }
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

/**
 * Migration: `StartResearch` was renamed `ProposeResearch` when the model lost
 * the ability to launch research (2026-08-10). Carry the user's policy across so
 * someone who set `never` keeps meaning it; an explicitly-set new key always wins.
 * Pure and exported so it can be unit-tested without chrome.storage.
 */
export function migrateResearchToolPolicy(
  policies: Record<string, ToolPolicy> | undefined,
): Record<string, ToolPolicy> | undefined {
  if (!policies || !('StartResearch' in policies)) return policies
  const { StartResearch, ...rest } = policies
  return 'ProposeResearch' in rest ? rest : { ...rest, ProposeResearch: StartResearch }
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
  settings.toolPolicies = migrateResearchToolPolicy(settings.toolPolicies)
  // Secrets are sealed at rest (see src/data/vault.ts). Open them here so every
  // consumer of Settings sees plaintext; a pre-vault install is migrated in
  // place on first load.
  const { settings: opened, hadPlaintext, hadUnavailable } = await openSettings(settings)
  if (hadUnavailable) warnVaultUnavailable()
  if (hadPlaintext) await migrateSecretsToSealed(stored, opened)
  return opened
}

let warnedVaultUnavailable = false

/**
 * One-time warning that some secrets came back from `loadSettings` still
 * sealed because the vault was transiently unreachable (mirrors the
 * once-flag pattern in `src/data/vault.ts`). The values themselves are left
 * alone — see `openSettings`'s doc for why that passthrough is deliberate.
 */
function warnVaultUnavailable(): void {
  if (warnedVaultUnavailable) return
  warnedVaultUnavailable = true
  console.warn(
    '[vault] some secrets could not be decrypted this load — the vault is temporarily unavailable; sealed values are preserved and will decrypt on a later load',
  )
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: await sealSettings(settings) })
}

/**
 * One-way plaintext→sealed migration: seal, verify the round-trip in memory,
 * re-read the stored blob to confirm nothing else wrote in the meantime, and
 * only then overwrite it — a failed vault, or a genuine concurrent save (e.g.
 * the user editing their key while this runs), never destroys or clobbers the
 * user's keys. Skipped when nothing sealed (vault down) or when the re-read
 * shows a newer write landed in the meantime; the next load re-migrates
 * whatever is still plaintext. Concurrent migrations of the SAME plaintext
 * both write valid ciphertext of it, so last-writer-wins between those two is
 * safe — this guard exists only for a *different* concurrent write racing in.
 * A residual TOCTOU window remains between the re-read and the `set` just
 * below it: `chrome.storage` has no compare-and-swap, so a write landing in
 * that single microtask gap is still clobbered. Accepted — the window is one
 * microtask wide, and the next load's re-check self-heals whatever it missed.
 */
async function migrateSecretsToSealed(before: Partial<Settings> | undefined, opened: Settings): Promise<void> {
  try {
    const sealed = await sealSettings(opened)
    if (!secretValues(sealed).some(isSealed)) return
    const roundTrip = await openSettings(sealed)
    if (JSON.stringify(secretValues(roundTrip.settings)) !== JSON.stringify(secretValues(opened))) return
    const current = await chrome.storage.local.get(STORAGE_KEY)
    if (JSON.stringify(current[STORAGE_KEY]) !== JSON.stringify(before)) return
    await chrome.storage.local.set({ [STORAGE_KEY]: sealed })
  } catch {
    // Migration must never break loading.
  }
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

/**
 * A model's configured rates, or an empty price when it has none. Returns `{}`
 * rather than `undefined` so callers can pass the result straight to
 * `estimateCost` without a null check — an empty price already means "nothing
 * is priced", which is exactly what `estimateCost` reports as `undefined`.
 *
 * Deliberately has no provider-level fallback, unlike `resolveReasoningEffort`:
 * effort is a preference that sensibly applies across a provider's models,
 * whereas price is a property of one specific model. Inheriting a sibling's
 * rate would quietly bill a cheap model at an expensive one's price.
 */
export function resolveModelPrice(provider: ProviderConfig, modelId: string): ModelPrice {
  return provider.modelConfigs?.[modelId]?.price ?? {}
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
