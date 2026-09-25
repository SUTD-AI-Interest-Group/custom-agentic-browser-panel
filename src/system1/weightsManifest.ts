/// <reference types="vite/client" />
// The ONE place the downloaded model is pinned. `revision` is an HF commit sha
// and `manifestSha256` the hash scripts/export-von/export.py printed; the
// manifest is verified against it before any file listed in it is trusted, so
// a moved branch or a swapped file on the Hub cannot change what runs here.
// Empty values fail closed: downloadWeights refuses to start.
//
// VITE_SYSTEM1_PIN is a build-time-only escape hatch for the real-browser eval
// harness: Task 1's model isn't published yet, so the committed pin below is
// empty and every ordinary build stays fail-closed. An eval build that needs to
// exercise downloadWeights end-to-end sets this env var to the JSON pin instead
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

const EMPTY_PIN: WeightsPin = { repo: '', revision: '', manifestSha256: '' }

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
export const WEIGHTS_PIN: WeightsPin = override ? parsePinOverride(override) : EMPTY_PIN
