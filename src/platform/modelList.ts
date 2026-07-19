// Fetch a provider's available model ids from its list endpoint (the "Refresh
// models" action in Settings). The parsing is pure and unit-tested; the fetch is
// a thin network shell over it. Endpoints and auth style come from the provider
// profile (src/data/providerProfiles.ts), so this file only has to normalise the
// several response shapes the various providers return.

import { profileFor } from '../data/providerProfiles'
import { providerKind, type ProviderConfig, type ProviderKind } from '../data/settings'

export interface FetchedModel {
  id: string
  /**
   * Reasoning capability as reported by the API, when the endpoint exposes it
   * (OpenRouter's `supported_parameters`, Anthropic's `capabilities`). Undefined
   * means "the endpoint didn't say" — fall back to the profile's id heuristics.
   */
  reasoning?: boolean
}

/** Pull the model array out of whichever envelope the endpoint used. */
function modelArray(json: unknown): unknown[] {
  if (json && typeof json === 'object') {
    const j = json as Record<string, unknown>
    if (Array.isArray(j.data)) return j.data // OpenAI-shaped (OpenAI, Groq, OpenRouter, Anthropic, LM Studio /api/v0)
    if (Array.isArray(j.models)) return j.models // Ollama /api/tags
  }
  return []
}

/** Normalise a raw model-list response into de-duplicated ids + any reasoning flag. */
export function parseModelList(kind: ProviderKind, json: unknown): FetchedModel[] {
  const seen = new Set<string>()
  const out: FetchedModel[] = []
  for (const row of modelArray(json)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    // OpenAI-shaped uses `id`; Ollama /api/tags uses `name` (and `model`).
    const id = (r.id ?? r.name ?? r.model) as unknown
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)

    let reasoning: boolean | undefined
    if (kind === 'openrouter' && Array.isArray(r.supported_parameters)) {
      reasoning = (r.supported_parameters as unknown[]).includes('reasoning')
    } else if (kind === 'anthropic' && r.capabilities && typeof r.capabilities === 'object') {
      reasoning = Boolean((r.capabilities as Record<string, unknown>).thinking)
    }
    out.push(reasoning === undefined ? { id } : { id, reasoning })
  }
  return out
}

/**
 * GET a provider's model list. Auth style follows the profile: OpenAI-style bearer,
 * Anthropic's x-api-key (+ version + browser-access header), or none (OpenRouter's
 * public catalog). Extension host_permissions bypass CORS, so this runs straight
 * from the panel. Throws on network/HTTP/empty so the caller can surface it.
 */
export async function fetchModelList(provider: ProviderConfig): Promise<FetchedModel[]> {
  const kind = providerKind(provider)
  const endpoint = profileFor(kind).modelsEndpoint
  if (!endpoint) throw new Error('This provider does not support listing models.')

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (endpoint.auth === 'bearer' && provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  } else if (endpoint.auth === 'anthropic') {
    headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }

  const res = await fetch(endpoint.url(provider.baseURL), { headers })
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`)
  const models = parseModelList(kind, await res.json())
  if (models.length === 0) throw new Error('The endpoint returned no models.')
  return models
}
