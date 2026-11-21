import type { ShadowRecord } from './shadowStore'

export interface DeciderStats {
  n: number
  agreement: number
  byKind: Record<'next' | 'fill' | 'drive', { n: number; agreement: number }>
  calibration: { lo: number; hi: number; n: number; agreement: number }[]
  coverage: number
  p50: number
  p95: number
  coldP50: number | null
  skipped: number
}

function agreementOf(rs: ShadowRecord[]): number {
  const judged = rs.filter((r) => r.agree !== null)
  return judged.length ? judged.filter((r) => r.agree === true).length / judged.length : 0
}

/** Nearest-rank percentile over unsorted values; 0 when empty. */
function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

export function summarize(records: ShadowRecord[], threshold: number): DeciderStats {
  const skipped = records.filter((r) => r.skipped).length
  const live = records.filter((r) => !r.skipped)
  const top = (r: ShadowRecord) => r.top3[0]?.p ?? 0

  const byKind = {
    next: { n: 0, agreement: 0 },
    fill: { n: 0, agreement: 0 },
    drive: { n: 0, agreement: 0 },
  }
  for (const k of ['next', 'fill', 'drive'] as const) {
    const rs = live.filter((r) => r.kind === k)
    byKind[k] = { n: rs.length, agreement: agreementOf(rs) }
  }

  const calibration = Array.from({ length: 10 }, (_, i) => {
    const lo = i / 10
    const hi = (i + 1) / 10
    const rs = live.filter((r) => {
      const p = top(r)
      const b = Math.min(9, Math.floor(p * 10))
      return b === i
    })
    return { lo, hi, n: rs.length, agreement: agreementOf(rs) }
  })

  const warm = live.filter((r) => !r.cold).map((r) => r.ms)
  const cold = live.filter((r) => r.cold).map((r) => r.ms)

  return {
    n: live.length,
    agreement: agreementOf(live),
    byKind,
    calibration,
    coverage: live.length ? live.filter((r) => top(r) >= threshold).length / live.length : 0,
    p50: percentile(warm, 0.5),
    p95: percentile(warm, 0.95),
    coldP50: cold.length ? percentile(cold, 0.5) : null,
    skipped,
  }
}
