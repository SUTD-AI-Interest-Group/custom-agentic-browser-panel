import type { Settings } from '../../data/settings'

/**
 * Normalize providers on commit — the cleanup that used to run on the old Save
 * button: trim/drop empty model lines, de-dupe them (a pasted duplicate, or a
 * "Refresh from endpoint" combined with a manually-typed one, would otherwise
 * reach every consumer that keys a list off the model string — ModelPicker,
 * the "Chat naming" select, Memory's dreaming-model select — with duplicate
 * React keys), and keep `selected` pointing at a real provider+model
 * (auto-selecting the first available when it goes stale).
 */
export function normalizeSettings(s: Settings): Settings {
  const next = structuredClone(s)
  next.providers = next.providers.map((p) => ({
    ...p,
    models: [...new Set(p.models.map((m) => m.trim()).filter(Boolean))],
  }))
  const valid =
    next.selected &&
    next.providers.some(
      (p) => p.id === next.selected!.providerId && p.models.includes(next.selected!.modelId),
    )
  if (!valid) {
    const first = next.providers.find((p) => p.models.length > 0)
    next.selected = first ? { providerId: first.id, modelId: first.models[0] } : null
  }
  return next
}
