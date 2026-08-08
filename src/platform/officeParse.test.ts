// Tests the C1 WIRING in officeParse.ts — that a "cost exceeded" verdict from
// officeCellBudget.ts actually stops the parse before the real (unbounded)
// officeParser ever runs. `estimateXlsxDeepCopyCost` is mocked here rather
// than fed a real bomb: officeCellBudget.test.ts already proves the detector
// itself catches a real bomb (safely, thanks to its early exit), but a
// genuinely bomb-sized fixture run through the REAL, unguarded parser would
// deep-copy gigabytes in this same Node process — exactly the crash this
// guard exists to prevent, and not something to risk even in a test. Mocking
// the verdict keeps this file fast and safe while still proving the call
// site actually wires the guard's answer into a rejection (or a pass-through).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const estimateXlsxDeepCopyCost = vi.fn()
vi.mock('./officeCellBudget', () => ({
  DECOMPRESSION_LIMITS: { maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 2000 },
  XLSX_MAX_TABLE_CELLS: 2_000_000,
  estimateXlsxDeepCopyCost: (...args: unknown[]) => estimateXlsxDeepCopyCost(...args),
}))

const { parseOfficeBytes } = await import('./officeParse')
const { OfficeError } = await import('./officeText')

// A tiny, syntactically-valid (if minimal) xlsx — big enough to reach the
// guard, never big enough to matter if the guard is bypassed by a bug.
function tinyXlsxBytes(): Uint8Array {
  // Not a real zip — parseOfficeBytes's own dynamic parseOffice() call would
  // reject this anyway, but the guard must run and reject FIRST, before that
  // call ever happens, so the exact bytes here don't matter for this test.
  return new TextEncoder().encode('PK\x03\x04not-a-real-zip')
}

describe('parseOfficeBytes — C1 cell-budget wiring', () => {
  beforeEach(() => {
    estimateXlsxDeepCopyCost.mockClear()
  })

  it('rejects before calling the real parser when the guard reports the budget exceeded', async () => {
    estimateXlsxDeepCopyCost.mockReturnValue({ exceeded: true, estimatedBytes: 999_999_999 })
    await expect(parseOfficeBytes(tinyXlsxBytes(), 'bomb.xlsx', '')).rejects.toBeInstanceOf(OfficeError)
    await expect(parseOfficeBytes(tinyXlsxBytes(), 'bomb.xlsx', '')).rejects.toThrow(/precaution/)
  })

  it('only runs the guard for xlsx, not other formats', async () => {
    await parseOfficeBytes(new TextEncoder().encode('not a real docx'), 'a.docx', '').catch(() => {})
    expect(estimateXlsxDeepCopyCost).not.toHaveBeenCalled()
  })

  it('proceeds to the real parser when the guard reports the budget is fine', async () => {
    estimateXlsxDeepCopyCost.mockReturnValue({ exceeded: false, estimatedBytes: 0 })
    // The bytes aren't a real zip, so the REAL parseOffice call will still
    // reject — but with a "could not read" message, not the guard's
    // "precaution" message, proving the guard's verdict was consulted and
    // then correctly let execution continue past it.
    await expect(parseOfficeBytes(tinyXlsxBytes(), 'ok.xlsx', '')).rejects.toThrow(/Could not read/)
  })
})
