import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  richSharedStringSizes,
  richTextReferenceCost,
  estimateXlsxDeepCopyCost,
  unzipBounded,
  XLSX_DEEP_COPY_BUDGET_BYTES,
  DECOMPRESSION_LIMITS,
} from './officeCellBudget'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

/**
 * Builds a real, minimal-but-valid malicious XLSX: ONE rich-text shared string
 * (an <si> with multiple <r> runs, so ExcelParser.js's array branch fires) and
 * `cellCount` cells all referencing shared-string index 0. This is the exact
 * shape the audit describes: small compressed size (the row is one repeated
 * pattern, which deflate compresses extremely well), well under both the
 * attachment size cap and DECOMPRESSION_LIMITS, yet capable of forcing an
 * enormous number of deep copies of the rich-text run array.
 *
 * `worksheetPath` defaults to the canonical location but is overridable so
 * tests can prove the guard survives officeParser's own UNANCHORED matching
 * (`x.match(/xl\/worksheets\/sheet\d+.xml/g)`, no `^`/`$`) — a worksheet at
 * any path CONTAINING that substring is real content to the real parser, so
 * the guard must see it too regardless of what comes before or after it.
 */
function makeBombXlsx(cellCount: number, runsPerSharedString = 20, worksheetPath = 'xl/worksheets/sheet1.xml'): Uint8Array {
  const runs = Array.from({ length: runsPerSharedString }, (_, i) => `<r><rPr><b/></rPr><t>run${i}</t></r>`).join('')
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
<si>${runs}</si>
</sst>`
  // colToLetter keeps every cell reference well-formed (A1, B1, ... AAA1, ...)
  // without needing a real column cap — officeParser's own regex only cares
  // about the ref's shape, not Excel's real 16384-column limit.
  const colToLetter = (n: number): string => {
    let s = ''
    let x = n
    do {
      s = String.fromCharCode(65 + (x % 26)) + s
      x = Math.floor(x / 26) - 1
    } while (x >= 0)
    return s
  }
  const cells = Array.from({ length: cellCount }, (_, i) => `<c r="${colToLetter(i)}1" t="s"><v>0</v></c>`).join('')
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${cells}</row>
</sheetData></worksheet>`
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(WORKBOOK_XML),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    [worksheetPath]: strToU8(sheet1),
  })
}

describe('richSharedStringSizes', () => {
  it('scores a plain <t>-only entry as 0', () => {
    expect(richSharedStringSizes('<sst><si><t>hello</t></si></sst>')).toEqual([0])
  })

  it('scores a rich (multi-run) entry as its full block size', () => {
    const xml = '<sst><si><r><t>a</t></r><r><t>b</t></r></si></sst>'
    const sizes = richSharedStringSizes(xml)
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toBeGreaterThan(0)
  })

  it('keeps index alignment across a mix of plain and rich entries', () => {
    const xml = '<sst><si><t>plain</t></si><si><r><t>rich</t></r></si><si><t>plain2</t></si></sst>'
    const sizes = richSharedStringSizes(xml)
    expect(sizes).toEqual([0, expect.any(Number), 0])
    expect(sizes[1]).toBeGreaterThan(0)
  })
})

describe('richTextReferenceCost', () => {
  it('sums referenced rich-string size once per referencing cell', () => {
    const sheet = '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c>'
    const total = richTextReferenceCost([sheet], [100], 1_000_000)
    expect(total).toBe(200)
  })

  it('ignores cells referencing a plain (size-0) shared string', () => {
    const sheet = '<c r="A1" t="s"><v>0</v></c>'
    expect(richTextReferenceCost([sheet], [0], 1_000_000)).toBe(0)
  })

  it('ignores non-shared-string cells entirely', () => {
    const sheet = '<c r="A1" t="n"><v>42</v></c>'
    expect(richTextReferenceCost([sheet], [999], 1_000_000)).toBe(0)
  })

  it('bails as soon as the running total crosses budget, not after a full scan', () => {
    // 1000 cells each worth 10 bytes; budget crosses after cell 5 (50 > 40).
    const sheet = Array.from({ length: 1000 }, () => '<c r="A1" t="s"><v>0</v></c>').join('')
    const total = richTextReferenceCost([sheet], [10], 45)
    expect(total).toBeLessThan(1000 * 10)
    expect(total).toBeGreaterThan(45)
  })
})

describe('estimateXlsxDeepCopyCost', () => {
  it('reports no cost for a workbook with no shared strings at all', () => {
    const bytes = makeBombXlsx(0)
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(false)
  })

  it('does not flag an ordinary small workbook with a handful of rich cells', () => {
    const bytes = makeBombXlsx(20)
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(false)
  })

  // THE REAL BOMB REPRO. A small, valid XLSX (one rich-text shared string,
  // many cells referencing it) that, unguarded, would force ExcelParser.js
  // into millions of JSON.parse(JSON.stringify(...)) deep copies. This proves
  // the guard actually catches the audited attack shape, not just a
  // synthetic unit-test number.
  it('rejects a real decompression-bomb-shaped xlsx', () => {
    const cellCount = 300_000 // runsPerSharedString=20 -> ~700 bytes/reference
    const bytes = makeBombXlsx(cellCount, 20)
    // Sanity: this is genuinely small on the wire relative to both the 25 MB
    // attachment cap and the 64 MB decompression cap, like the audit
    // describes — varying cell refs (A1, B1, ... AAA1) keep the compression
    // ratio well short of "pure repetition", so this is a generous bound, not
    // a tight one.
    expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024)
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(true)
    expect(result.estimatedBytes).toBeGreaterThan(XLSX_DEEP_COPY_BUDGET_BYTES)
  })

  it('rejects even a single huge rich shared string referenced by comparatively few cells', () => {
    // The "big S, small C" corner of the trade-off a naive cell-count cap
    // would miss entirely (see officeCellBudget.ts's module comment).
    const bytes = makeBombXlsx(2000, 5000) // ~5000 runs -> a genuinely large <si> block
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(true)
  })

  // REGRESSION for the anchored-path bypass a code-review PoC confirmed
  // against an earlier version of this guard: a worksheet entry named with an
  // extra PREFIX (`zzz/xl/worksheets/sheet1.xml`) is real content to
  // officeParser's own unanchored `.match(/xl\/worksheets\/sheet\d+.xml/g)`,
  // but was invisible to a path-anchored `^xl\/...` guard regex — the guard
  // reported `exceeded:false` while the real parser ran the full deep copy.
  // Content-based classification (this file, current version) must catch it.
  it('rejects a bomb whose worksheet path carries an extra prefix (officeParser matches it unanchored)', () => {
    const bytes = makeBombXlsx(300_000, 20, 'zzz/xl/worksheets/sheet1.xml')
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(true)
  })

  // Same bypass class, other side: officeParser's regex has an unescaped dot
  // before "xml" and is not end-anchored either, so a worksheet path with an
  // extra SUFFIX (`xl/worksheets/sheet1.xml.png`) still contains the matched
  // substring and is still real content to the real parser.
  it('rejects a bomb whose worksheet path carries an extra suffix', () => {
    const bytes = makeBombXlsx(300_000, 20, 'xl/worksheets/sheet1.xml.png')
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(true)
  })

  // A renamed sharedStrings.xml is caught the same way — the guard no longer
  // requires the exact path `xl/sharedStrings.xml`, only the `<sst>` root.
  it('rejects a bomb whose sharedStrings entry is not at the canonical path', () => {
    const runs = Array.from({ length: 20 }, (_, i) => `<r><rPr><b/></rPr><t>run${i}</t></r>`).join('')
    const sharedStrings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si>${runs}</si></sst>`
    const cells = Array.from({ length: 300_000 }, (_, i) => `<c r="A${i + 1}" t="s"><v>0</v></c>`).join('')
    const sheet1 = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`
    const bytes = zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(ROOT_RELS),
      'xl/workbook.xml': strToU8(WORKBOOK_XML),
      'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
      'somewhere/else/sharedStrings.xml': strToU8(sharedStrings),
      'xl/worksheets/sheet1.xml': strToU8(sheet1),
    })
    const result = estimateXlsxDeepCopyCost(bytes)
    expect(result.exceeded).toBe(true)
  })

  // Lighter end-to-end companion to the precise unzipBounded tests below:
  // many worksheet-shaped entries whose declared sizes sum well past the 64
  // MB cap must not make the scan itself slow or fail, since real work is
  // capped by unzipBounded's running total regardless of how many entries
  // the archive claims to have.
  it('stays fast against many worksheet-shaped entries whose sizes sum past the decompression cap', () => {
    const filler = (n: number) => {
      let rows = ''
      for (let r = 0; r < n; r++) rows += `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c></row>`
      return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
    }
    // ~1.3 MB of worksheet-shaped XML per entry; 80 entries ~= 100 MB total,
    // comfortably past the 64 MB cap while each entry alone is well under it.
    const oneSheet = filler(20_000)
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(ROOT_RELS),
      'xl/workbook.xml': strToU8(WORKBOOK_XML),
      'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    }
    for (let i = 0; i < 80; i++) files[`xl/worksheets/sheet${i}.xml`] = strToU8(oneSheet)
    const bytes = zipSync(files, { level: 6 })
    const start = performance.now()
    const result = estimateXlsxDeepCopyCost(bytes)
    const elapsed = performance.now() - start
    expect(result.exceeded).toBe(false)
    expect(elapsed).toBeLessThan(5000)
  }, 30_000)
})

describe('unzipBounded — cross-entry cumulative budget', () => {
  // REGRESSION for the missing cross-entry budget a code-review PoC
  // confirmed: an earlier version gated only one entry's declared size in
  // isolation (`file.originalSize <= maxUncompressedBytes`), so many entries
  // each individually under the cap could all be decompressed and held
  // simultaneously with no running total, letting the guard's own pre-scan
  // become an unbounded-decompression bomb.
  // `level: 0` (store, no compression) rather than the default — this test
  // is about decompressed-byte accounting, not compression ratio, and
  // compressing 80 MB is real CPU work that has flaked this test's default
  // 5s Vitest timeout under a contended machine; storing is fast and
  // deterministic regardless of load. The explicit `it` timeout is a
  // generous backstop on top of that.
  it('never returns more decompressed bytes than the budget, even when every entry alone would fit', () => {
    // 80 entries x 1 MB declared size = 80 MB total, comfortably over a 64 MB
    // budget, while EVERY individual entry is comfortably under it — the
    // exact shape a per-entry-only check cannot catch.
    const oneMb = new Uint8Array(1024 * 1024).fill(65)
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 80; i++) files[`entry${i}.xml`] = oneMb
    const bytes = zipSync(files, { level: 0 })

    const result = unzipBounded(bytes, DECOMPRESSION_LIMITS.maxUncompressedBytes)
    const totalDecompressed = Object.values(result).reduce((sum, text) => sum + text.length, 0)

    expect(totalDecompressed).toBeLessThanOrEqual(DECOMPRESSION_LIMITS.maxUncompressedBytes)
    // It must have actually stopped ACCEPTING further entries once the
    // running total was spent, not silently truncated content within ones it
    // did accept — 80 x 1 MB entries cannot all fit under a 64 MB budget.
    expect(Object.keys(result).length).toBeLessThan(80)
  }, 30_000)

  it('still accepts every entry when their sum fits comfortably under the budget', () => {
    const oneMb = new Uint8Array(1024 * 1024).fill(66)
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 5; i++) files[`entry${i}.xml`] = oneMb
    const bytes = zipSync(files, { level: 6 })

    const result = unzipBounded(bytes, DECOMPRESSION_LIMITS.maxUncompressedBytes)
    expect(Object.keys(result)).toHaveLength(5)
  })
})

describe('estimateXlsxDeepCopyCost — scan performance', () => {
  // Building the 2M-cell fixture itself (string concatenation + zip
  // compression) is real CPU work unrelated to what this test measures, and
  // can be slow under a contended machine — so only the SCAN is timed, and
  // the `it` timeout (3rd arg) is padded well past the fixture-build cost.
  // The `elapsed` bound stays tight: the point is "milliseconds, thanks to
  // the early exit in richTextReferenceCost", not "some generous CI ceiling."
  it('runs the scan itself quickly even against the bomb shape', () => {
    const bytes = makeBombXlsx(2_000_000, 20)
    const start = performance.now()
    const result = estimateXlsxDeepCopyCost(bytes)
    const elapsed = performance.now() - start
    expect(result.exceeded).toBe(true)
    expect(elapsed).toBeLessThan(5000)
  }, 30_000)
})
