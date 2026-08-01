// Pure decision logic behind ProvidersTab's "Refresh from endpoint" action.
// Split out of the component so the merge step and the concurrency guard
// (the HIGH finding this file fixes) are directly unit-testable.

import type { FetchedModel } from '../../platform/modelList'
import type { ModelConfig, ProviderConfig } from '../../data/settings'

/**
 * Fold a fetched model list into a provider's `models`/`modelConfigs`: sorted,
 * de-duplicated ids (fetchModelList already dedupes; sorting here is what's
 * new), plus a manual reasoning-capability seed where the API reports one
 * that the id heuristic would miss. Never stomps a heuristic that already
 * agrees, and never touches unrelated existing `modelConfigs` entries (e.g. a
 * user's manual `reasoningEffort` override survives a refresh).
 */
export function mergeFetchedModels(
  existingConfigs: Record<string, ModelConfig> | undefined,
  fetched: FetchedModel[],
  detectReasoning: (id: string) => boolean,
): { models: string[]; modelConfigs: Record<string, ModelConfig> } {
  const models = fetched.map((f) => f.id).sort((a, b) => a.localeCompare(b))
  const modelConfigs: Record<string, ModelConfig> = { ...existingConfigs }
  for (const f of fetched) {
    if (f.reasoning === true && !detectReasoning(f.id)) {
      modelConfigs[f.id] = { ...modelConfigs[f.id], reasoning: true }
    }
  }
  return { models, modelConfigs }
}

export interface ModelRefreshResult {
  /** True when the draft changed underneath this fetch — nothing was applied. */
  stale: boolean
  providers: ProviderConfig[]
  message: string
}

/**
 * Decide what a "Refresh from endpoint" fetch should do once it resolves.
 *
 * `baseline` is the provider list captured the instant the fetch was kicked
 * off; `current` is the live draft's provider list read again at the moment
 * the fetch resolves. Settings.tsx's `commit`/`normalizeSettings` rebuilds the
 * whole `providers` array on every single commit (any field, not just
 * providers), so a reference mismatch here means *some* settings change
 * landed while this fetch was outstanding — another provider added/removed, a
 * field blurred elsewhere, even a second concurrent refresh. Applying this
 * fetch's merge on top of the stale `baseline` would silently revert whatever
 * that intervening change was (the HIGH finding this fixes), so a mismatch
 * returns `stale: true` and hands back `current` completely untouched — the
 * caller must not commit anything in that case.
 */
export function resolveModelRefresh(
  providerId: string,
  baseline: ProviderConfig[],
  current: ProviderConfig[],
  fetched: FetchedModel[],
  detectReasoning: (id: string) => boolean,
): ModelRefreshResult {
  if (baseline !== current) {
    return { stale: true, providers: current, message: 'Settings changed while refreshing — try again.' }
  }
  const target = current.find((p) => p.id === providerId)
  const { models, modelConfigs } = mergeFetchedModels(target?.modelConfigs, fetched, detectReasoning)
  return {
    stale: false,
    providers: current.map((q) => (q.id === providerId ? { ...q, models, modelConfigs } : q)),
    message: `Loaded ${models.length} model${models.length === 1 ? '' : 's'}.`,
  }
}
