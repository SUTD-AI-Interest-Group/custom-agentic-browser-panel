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
// Von 1.2 continue-trained on the single-pass act rows (2026-09-30), q8 export
// gated on parity (max|Δp| 0.0098). Pinned by commit, never `main`; the
// manifest hash is what the download verifies before trusting any file it lists.
const PUBLISHED_PIN: WeightsPin = {
  repo: 'ks-ang/von-browser-act',
  revision: '7a0aeb2b98b3904147c1febebbc85f6c882d3e84',
  manifestSha256: 'fb63645a22d39308ad7ed9bcf3fce4c02057be158415a372348e8c3363b23e51',
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
