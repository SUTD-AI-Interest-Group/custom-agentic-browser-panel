/// <reference types="vite/client" />
// Which Von policy the Act tool runs: the single-pass act head (default —
// one question over every (control, action) pair plus the moves, jev-
// ultrafast's "one request per decision") or the lazy multi-head policy
// (operation → target_<OP> → value) it replaced. The two are trained on
// different row formats, so this must match the weights that are pinned; an
// eval build may override it (same rule as weightsManifest.ts's pin
// override: honoured only under `--mode system1-eval`) to A/B the two heads
// against their own fine-tunes on one harness.
export type ActHead = 'single' | 'lazy'

const override = import.meta.env.MODE === 'system1-eval' ? import.meta.env.VITE_SYSTEM1_HEAD : undefined
export const ACT_HEAD: ActHead = override === 'lazy' ? 'lazy' : 'single'
