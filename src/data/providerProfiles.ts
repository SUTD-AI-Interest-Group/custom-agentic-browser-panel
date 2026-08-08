// Per-provider capability profiles. Pure logic (no Chrome, no network, no AI SDK
// imports) so it is fully unit-testable — the reasoning-wire dialects, reasoning-
// model detection, slider level sets, and model-list endpoints that the hybrid
// `createModel` (src/agent/provider.ts), the effort slider (src/ui), and the
// "Refresh models" action (src/ui/settings) all key off.
//
// Every finding here is grounded in the provider API research: OpenAI reasoning +
// tools needs the Responses API (native adapter); Anthropic reasons through native
// thinking (native adapter); the rest ride the OpenAI-compatible adapter, each with
// its own reasoning body param — OpenRouter's `reasoning` object (never a bare
// `reasoning_effort`), Groq's `reasoning_effort` + a mandatory `reasoning_format`
// when tools are present, Ollama's compat `reasoning_effort` (mapped to `think`).

import { providerKind, type ProviderConfig, type ProviderKind, type ReasoningEffort } from './settings'

/** Which AI SDK adapter `createModel` instantiates for a kind. */
export type ProviderAdapter = 'openai' | 'anthropic' | 'compatible'

/** How the model-list GET authenticates. */
export type ModelsAuth = 'bearer' | 'anthropic' | 'none'

/** Descriptor for a provider's model-list endpoint, consumed by the Refresh action. */
export interface ModelsEndpoint {
  /** Absolute URL to GET, built from the provider's configured base URL. */
  url: (baseURL: string) => string
  auth: ModelsAuth
}

export interface ProviderProfile {
  kind: ProviderKind
  adapter: ProviderAdapter
  /** Auto-detection: does this model id look like a reasoning model? (overridable per model.) */
  detectReasoning: (modelId: string) => boolean
  /** Slider rungs for a reasoning model, ordered faster → smarter. */
  reasoningLevels: (modelId: string) => ReasoningEffort[]
  /**
   * COMPATIBLE adapters only: request-body fields to merge for a chosen effort
   * (`undefined` = the user has set none), given whether the turn carries tools.
   * Returns `{}` to send nothing.
   */
  reasoningBody?: (effort: ReasoningEffort | undefined, hasTools: boolean) => Record<string, unknown>
  /**
   * NATIVE adapters only: the `providerOptions[provider]` object for a chosen
   * effort. Returns `{}` to send nothing (endpoint's own default).
   */
  reasoningOptions?: (effort: ReasoningEffort | undefined) => Record<string, unknown>
  /** Model-list endpoint for Refresh, or null when the provider can't be enumerated. */
  modelsEndpoint: ModelsEndpoint | null
  /**
   * Whether this kind's adapter converts an application/pdf `file` part into a
   * native document block (Anthropic `document`, OpenAI Responses `input_file`).
   * The compatible adapter does NOT — it throws on non-image file parts, 400ing
   * the whole request — so the attachment planner must never route a raw PDF at
   * a compatible provider.
   */
  supportsNativeDocuments: boolean
  /** Raw-byte ceiling for a native PDF part (base64 inflates ~4/3 toward the provider's request cap). 0 when unsupported. */
  nativeDocMaxBytes: number
  /**
   * Whether this kind's native adapter should mark an ephemeral `cache_control`
   * breakpoint on the turn's system prompt (Anthropic-only). OpenAI's own
   * caching is automatic on a byte-identical prefix — no code marker needed,
   * and the Responses adapter has no such marker at all — and the generic
   * OpenAI-compatible adapter has no cache_control mechanism either; sending
   * an unrecognized field there risks 400ing an arbitrary compatible
   * endpoint's whole request. So this is Anthropic-only, and `createModel`
   * only ever calls the injection code from the `adapter === 'anthropic'`
   * branch — this flag exists so the capability is declared here (like
   * `supportsNativeDocuments`) rather than inlined as a bare kind check.
   */
  supportsPromptCaching: boolean
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '')
/** The scheme+host of a URL (for endpoints that live outside the `/v1` base, e.g. LM Studio's `/api/v0`). */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return trimSlash(url)
  }
}

const modelsPath = (auth: ModelsAuth = 'bearer'): ModelsEndpoint => ({
  url: (b) => `${trimSlash(b)}/models`,
  auth,
})

const FOUR: ReasoningEffort[] = ['none', 'low', 'medium', 'high']

const PROFILES: Record<ProviderKind, ProviderProfile> = {
  // OpenAI — native Responses API: the only path where reasoning coexists with
  // function tools (chat-completions 400s). reasoningEffort rides providerOptions.
  openai: {
    kind: 'openai',
    adapter: 'openai',
    // o-series (o1/o3/o4, not gpt-4o), the gpt-5 line, and open-weight gpt-oss.
    detectReasoning: (id) => /^o[134]($|[.\-])|gpt-5|gpt-oss/i.test(id),
    reasoningLevels: (id) => {
      if (/gpt-5\.6/i.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      if (/gpt-5/i.test(id)) return ['none', 'low', 'medium', 'high']
      if (/^o[134]/i.test(id)) return ['low', 'medium', 'high'] // o-series has no 'none'
      return FOUR
    },
    reasoningOptions: (effort) => (effort ? { reasoningEffort: effort } : {}),
    modelsEndpoint: modelsPath(),
    supportsNativeDocuments: true,
    // 50MB per-request cap on input_file → 35MB raw is ~47MB as base64.
    nativeDocMaxBytes: 35 * 1024 * 1024,
    supportsPromptCaching: false,
  },

  // Anthropic — native Messages API. This SDK models thinking as `adaptive`
  // (current models: on, no budget/effort knob) or `disabled`, so the slider is
  // honestly off/on here; graded effort waits on SDK + model support.
  anthropic: {
    kind: 'anthropic',
    adapter: 'anthropic',
    detectReasoning: (id) => /claude|sonnet|opus|haiku|fable|mythos/i.test(id),
    reasoningLevels: () => ['none', 'high'],
    reasoningOptions: (effort) => {
      if (effort === undefined) return {}
      return effort === 'none'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive', display: 'summarized' } }
    },
    modelsEndpoint: modelsPath('anthropic'),
    supportsNativeDocuments: true,
    // 32MB request cap on document blocks → 20MB raw is ~27MB as base64, with prompt headroom.
    nativeDocMaxBytes: 20 * 1024 * 1024,
    // NOT gated per model id, even though the minimum cacheable prefix is NOT
    // uniform across the Anthropic line — 512 tokens on Opus 5/Fable 5/Mythos
    // 5, 1024 on Opus 4.8/Sonnet 5/4.6/4.5/Opus 4.1/4/Sonnet 4, 2048 on Opus
    // 4.7/Mythos Preview/Haiku 3.5, and 4096 on Opus 4.6/4.5/Haiku 4.5 (see
    // the claude-api skill for the current table — it is not monotonic across
    // generations, so don't assume newer = lower). Below the minimum, the
    // `cache_control` marker in provider.ts's `withCacheControl` is a
    // documented, silent, free no-op server-side — NOT a cost bug, just no
    // benefit — so setting this `true` uniformly is always safe, only
    // sometimes ineffective. A per-model-id threshold table would need the
    // same upkeep as `detectReasoning`'s regexes but for a number that moves
    // with every model generation, which this codebase has no other
    // precedent for tracking that granularly. Instead, `runAgentTurn`
    // (agent.ts) logs actual cache_read/cache_write token counts whenever the
    // provider reports any — that's how to tell, per install and per model,
    // whether the marker is doing anything, rather than trying to predict it.
    supportsPromptCaching: true,
  },

  // OpenRouter — compatible, but reasoning is one unified `reasoning` object;
  // sending a bare `reasoning_effort` alongside it 400s, so we never do.
  openrouter: {
    kind: 'openrouter',
    adapter: 'compatible',
    detectReasoning: (id) =>
      /gpt-5|o[134]-|deepseek-r1|qwen3|qwq|gpt-oss|magistral|grok-4|thinking|reasoning/i.test(id),
    reasoningLevels: () => FOUR,
    reasoningBody: (effort) => {
      if (effort === undefined) return {}
      return effort === 'none' ? { reasoning: { enabled: false } } : { reasoning: { effort } }
    },
    modelsEndpoint: { url: () => 'https://openrouter.ai/api/v1/models', auth: 'none' },
    // OpenRouter's PDF support is a proprietary `plugins`/`file` extension the
    // generic compat adapter can't construct — deliberately not used (see spec).
    supportsNativeDocuments: false,
    nativeDocMaxBytes: 0,
    supportsPromptCaching: false,
  },

  // Groq — compatible. reasoning_effort controls depth; reasoning_format MUST be
  // 'parsed' (not the 'raw' default) whenever tools are present or the request 400s.
  groq: {
    kind: 'groq',
    adapter: 'compatible',
    detectReasoning: (id) => /deepseek-r1|qwen3|qwq|gpt-oss/i.test(id),
    reasoningLevels: (id) => (/gpt-oss/i.test(id) ? ['low', 'medium', 'high'] : FOUR),
    reasoningBody: (effort, hasTools) => ({
      ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}),
      ...(hasTools ? { reasoning_format: 'parsed' } : {}),
    }),
    modelsEndpoint: modelsPath(),
    supportsNativeDocuments: false,
    nativeDocMaxBytes: 0,
    supportsPromptCaching: false,
  },

  // Ollama — compatible. Its /v1 endpoint ignores the native `think` field but
  // accepts `reasoning_effort` (high/medium/low → think on, none → off).
  ollama: {
    kind: 'ollama',
    adapter: 'compatible',
    detectReasoning: (id) => /deepseek-r1|qwen3|gpt-oss|magistral|glm-4|deepseek-v3\.1/i.test(id),
    reasoningLevels: () => FOUR,
    reasoningBody: (effort) => (effort ? { reasoning_effort: effort } : {}),
    modelsEndpoint: modelsPath(),
    supportsNativeDocuments: false,
    nativeDocMaxBytes: 0,
    supportsPromptCaching: false,
  },

  // LM Studio — compatible chat over /v1; reasoning_effort passthrough is
  // best-effort (runtime-dependent). Model list uses the richer native /api/v0.
  lmstudio: {
    kind: 'lmstudio',
    adapter: 'compatible',
    detectReasoning: (id) => /deepseek-r1|qwen3|gpt-oss|magistral|glm-4/i.test(id),
    reasoningLevels: () => FOUR,
    reasoningBody: (effort) => (effort ? { reasoning_effort: effort } : {}),
    modelsEndpoint: { url: (b) => `${originOf(b)}/api/v0/models`, auth: 'bearer' },
    supportsNativeDocuments: false,
    nativeDocMaxBytes: 0,
    supportsPromptCaching: false,
  },

  // Custom / unknown OpenAI-compatible endpoint: the generic behaviour that
  // shipped first — pass a set reasoning_effort straight through.
  custom: {
    kind: 'custom',
    adapter: 'compatible',
    detectReasoning: (id) =>
      /gpt-5|o[134]-|deepseek-r1|qwen3|qwq|gpt-oss|magistral|reasoning|think|grok-4/i.test(id),
    reasoningLevels: () => FOUR,
    reasoningBody: (effort) => (effort ? { reasoning_effort: effort } : {}),
    modelsEndpoint: modelsPath(),
    // Unknowable in general — assume the compat lowest common denominator.
    supportsNativeDocuments: false,
    nativeDocMaxBytes: 0,
    supportsPromptCaching: false,
  },
}

/** The capability profile for a provider kind. */
export function profileFor(kind: ProviderKind): ProviderProfile {
  return PROFILES[kind]
}

/**
 * Whether a model should show the reasoning slider: the user's manual override
 * (`modelConfigs[id].reasoning`) wins; otherwise the profile's auto-detection.
 */
export function isReasoningModel(provider: ProviderConfig, modelId: string): boolean {
  const manual = provider.modelConfigs?.[modelId]?.reasoning
  if (manual !== undefined) return manual
  return profileFor(providerKind(provider)).detectReasoning(modelId)
}

/** The slider's effort rungs for a model (faster → smarter). */
export function reasoningLevelsFor(provider: ProviderConfig, modelId: string): ReasoningEffort[] {
  return profileFor(providerKind(provider)).reasoningLevels(modelId)
}
