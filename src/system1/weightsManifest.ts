/// <reference types="vite/client" />
// The ONE place the downloaded model is pinned. `revision` is an HF commit sha
// and `manifestSha256` the hash scripts/export-von/export.py printed; the
// manifest is verified against it before any file listed in it is trusted, so
// a moved branch or a swapped file on the Hub cannot change what runs here.
// Empty values fail closed: downloadWeights refuses to start (the pin was empty
// until the first published weights on 2026-09-30).
//
// VITE_SYSTEM1_PIN is a build-time-only escape hatch for the real-browser eval
// harness: an eval build that needs to exercise downloadWeights against a local,
// not-yet-published export sets this env var to that export's JSON pin instead
// of weakening (or temporarily editing) the committed constant. A malformed
// override throws at module load — a broken eval build must fail loudly, not
// silently fall back to the empty pin and look like it's testing something it
// isn't. The override is honoured ONLY in a `--mode system1-eval` build, so a
// VITE_SYSTEM1_PIN that happens to be set in a release builder's environment
// (a shell profile, a stray .env) cannot put an unreviewed pin in a shipped
// build.
export interface WeightsPin {
  repo: string
  revision: string
  manifestSha256: string
}

// The published act-head fine-tune (https://huggingface.co/ks-ang/von-browser-act):
// Von 1.2 continue-trained on the single-pass act rows (2026-09-30), exported
// as the FAST graph (2026-10-02, scripts/export-von/fast.py): fp16 activations,
// RoPE tables and option masks as inputs, fused attention — decision p50 98 ms
// (q8 was 400), and it runs requests past T≈2,048 the q8 graph could not; it
// requires shader-f16 (the manifest says so; Settings refuses to download it
// on an adapter without the feature). CPU gate max|Δp| 0.0035, WebGPU 0.0264.
// The previous q8 pin was 7a0aeb2b… / fb63645a…. Pinned by commit, never
// `main`; the manifest hash is what the download verifies before trusting any
// file it lists.
const PUBLISHED_PIN: WeightsPin = {
  repo: 'ks-ang/von-browser-act',
  revision: '6f1783b63a4ec4049206496998bfc2f88a5a062a',
  manifestSha256: '7d5ff043d9674ce8cca4b8b96e507d09a324f381edacb51144e7374ccecefc1e',
}

function parsePinOverride(raw: string): WeightsPin {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('VITE_SYSTEM1_PIN is not valid JSON')
  }
  const p = parsed as Partial<WeightsPin> | null
  if (
    !p ||
    typeof p.repo !== 'string' ||
    !p.repo ||
    typeof p.revision !== 'string' ||
    !p.revision ||
    typeof p.manifestSha256 !== 'string' ||
    !p.manifestSha256
  ) {
    throw new Error('VITE_SYSTEM1_PIN must be JSON {repo, revision, manifestSha256} of non-empty strings')
  }
  return { repo: p.repo, revision: p.revision, manifestSha256: p.manifestSha256 }
}

export const EVAL_MODE = 'system1-eval'
const override = import.meta.env.MODE === EVAL_MODE ? import.meta.env.VITE_SYSTEM1_PIN : undefined
export const WEIGHTS_PIN: WeightsPin = override ? parsePinOverride(override) : PUBLISHED_PIN
