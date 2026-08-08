// The XLSX cell-count decompression-bomb guard. No officeParser import, no
// Chrome — only fflate (already a project dependency, used the same way
// office.test.ts's fixtures build test archives) — so this is unit-testable
// exactly like officeText.ts, and runs equally well on the worker side
// (officeParse.ts, its real caller) or in a Vitest process.
//
// THE BUG THIS GUARDS: officeParser's ExcelParser.js has no cell budget of its
// own. Confirmed against the vendored source (node_modules/officeparser/dist/
// parsers/ExcelParser.js) — unlike OpenOfficeParser.js's `CellBudget` class,
// which bounds ODF's row/column repeat-attribute expansion, ExcelParser.js has
// zero references to `maxTableCells` or any cell cap. Its cell loop runs, for
// every `<c t="s">` (shared-string) cell whose shared string is "rich text"
// (multiple formatting runs, i.e. an array rather than a plain string):
//
//     cellNodes = JSON.parse(JSON.stringify(content))   // content = sharedStrings[idx]
//
// — a full deep copy of that shared array, unconditionally, once per matching
// cell. A shared string is stored ONCE in xl/sharedStrings.xml and referenced
// by index from as many cells as the sheet likes, so a small number of decompressed
// bytes can be deep-copied an enormous number of times.
//
// WHY A CELL-COUNT CAP ALONE DOES NOT WORK: the existing DECOMPRESSION_LIMITS
// (below) already bound total *decompressed bytes* to 64 MB, and one might
// expect "cap total cell count too" (mirroring CellBudget) to finish the job.
// It does not, because the attack is a PRODUCT, not a count: cost scales with
// (cells referencing a rich shared string) x (that shared string's size), and
// both factors are freely tradeable against the same 64 MB decompressed-byte
// budget — a bigger shared string means fewer cells fit, but each of those
// fewer cells is proportionally more expensive to copy. Solving the trade-off
// (see officeCellBudget.test.ts's "worst case" comment) shows the adversarial
// optimum is on the order of tens of GB of transient allocation EVEN WITH a
// cell-count cap in the 100Ks–1M range, because a single ~30 MB rich shared
// string referenced by a few hundred thousand cells already blows past any
// sane heap. The only bound that actually tracks the real cost is the product
// itself: estimate SUM(references-to-a-rich-string x that string's size)
// directly, and reject once the running total crosses a budget — the same
// "track the ACTUAL output, not a declared/nominal size" principle
// zipUtils.js's own `extractFiles` already uses for the byte cap below (see
// its comment: "The declared size is attacker-controlled ... counting real
// output bytes ... is the only reliable guard").
//
// `decompressionLimits.maxTableCells` is still passed through to `parseOffice`
// in officeParse.ts, for forward compatibility if a future officeparser
// version starts honoring it for XLSX — but it is a documented no-op today,
// which is exactly why this module exists.
//
// SELECTION IS BY CONTENT, NEVER BY PATH. An earlier version of this file
// selected candidate entries with `/^xl\/(sharedStrings\.xml|worksheets\/...)$/`
// — an ANCHORED path match. That was a real bypass: ExcelParser.js itself
// locates its parts with UNANCHORED regexes run via `.match()`
// (`/xl\/worksheets\/sheet\d+.xml/g`, `.test()`/`.match()` against the WHOLE
// entry name, no `^`/`$`), so it treats `zzz/xl/worksheets/sheet1.xml` (extra
// PREFIX) or `xl/worksheets/sheet1.xml.png` (extra SUFFIX — `.` in that regex
// is unescaped, so it isn't even end-anchored on the real dot) as real
// worksheet content, while an anchored guard regex sees neither. Any
// name-based heuristic is incomplete by construction against an unanchored
// substring match, since an attacker can pad either side arbitrarily. The fix
// is to stop trying to predict which path officeParser will accept — and
// instead classify every entry by what its OWN content actually is: does it
// parse as `<sst>` (a shared-strings table) or does it contain `<sheetData`
// (worksheet row/cell data)? A renamed part cannot hide its own tag soup.
// Over-inclusion (scanning a decoy `<sst>`-shaped entry officeParser would
// never actually read) only costs a slightly more conservative estimate;
// under-inclusion is a total bypass — so this deliberately errs wide.

import { unzipSync, type UnzipFileInfo } from 'fflate'

/**
 * Untrusted archives: well under officeParser's 512 MB / 10k defaults. Shared
 * with officeParse.ts (passed straight to `parseOffice`) and used here as the
 * ceiling for our own pre-scan unzip's cumulative decompressed total (see
 * `unzipBounded`), so neither step can be made to allocate more than this
 * regardless of what any entry's header claims.
 */
export const DECOMPRESSION_LIMITS = { maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 2000 }

/**
 * Budget for the ESTIMATED total bytes of rich-text content a malicious XLSX
 * would force ExcelParser.js to deep-copy (see module comment). 128 MB of
 * *estimated* referenced content comfortably covers any real spreadsheet —
 * genuine rich-text (bold/italic/colored run) cells are a small minority of a
 * real workbook's cells, so their total referenced size is nowhere near this —
 * while keeping actual worst-case transient allocation (JSON.stringify output
 * + JSON.parse'd object graph + per-object overhead, roughly 2-4x the raw byte
 * estimate) in the several-hundred-MB range: bounded, single, and short-lived,
 * not the multi-GB/TB blowup an unbounded parse would otherwise produce.
 */
export const XLSX_DEEP_COPY_BUDGET_BYTES = 128 * 1024 * 1024

/**
 * A generous, currently-inert cell-count ceiling passed through as
 * `decompressionLimits.maxTableCells` (see module comment on why this alone
 * cannot be the real guard). Matches OpenOfficeParser's own CellBudget
 * default order of magnitude.
 */
export const XLSX_MAX_TABLE_CELLS = 2_000_000

export interface XlsxCostEstimate {
  exceeded: boolean
  /** Estimated bytes of rich-text content that would be deep-copied. */
  estimatedBytes: number
}

/**
 * Decompresses every entry in the archive — no name filtering; see the module
 * comment on why filename-based selection cannot be trusted — subject only to
 * a running CUMULATIVE total against `maxTotalBytes`, so many just-under-cap
 * entries can never sum past it (previously this only checked one entry's
 * declared size in isolation, which a handful of large-but-individually-legal
 * entries could sail past).
 *
 * `file.originalSize` is read from the ZIP *central directory* (the
 * authoritative trailer, written last from the real inflate output) rather
 * than a local-file-header field a streaming reader would see, and
 * `unzipSync`'s own decompression allocates an output buffer of EXACTLY that
 * declared size (`new u8(su)`, see fflate's source) — so tracking declared
 * central-directory size here really does bound actual allocation, the same
 * property zipUtils.js's `extractFiles` gets by tracking real streamed output
 * instead (a different mechanism, same guarantee).
 *
 * Exported for direct unit testing of the cumulative-cap behavior itself
 * (officeCellBudget.test.ts) — the effect is otherwise hard to observe from
 * `estimateXlsxDeepCopyCost` alone.
 */
export function unzipBounded(bytes: Uint8Array, maxTotalBytes: number): Record<string, string> {
  const decoder = new TextDecoder()
  let remaining = maxTotalBytes
  const raw = unzipSync(bytes, {
    filter: (file: UnzipFileInfo) => {
      if (file.originalSize > remaining) return false
      remaining -= file.originalSize
      return true
    },
  })
  const out: Record<string, string> = {}
  for (const name of Object.keys(raw)) out[name] = decoder.decode(raw[name])
  return out
}

// A shared-strings table's root element is `<sst ...>`/`<sst>`/`<sst/>`.
// A worksheet's cell data lives inside `<sheetData ...>`/`<sheetData/>`.
// Content, not path — see the module comment.
const SST_ROOT_RE = /<sst[\s/>]/i
const SHEET_DATA_RE = /<sheetData[\s/>]/i

/**
 * Parses one xl/sharedStrings.xml-shaped body's `<si>` entries in document
 * order, returning the byte length of each RICH (multi-run, i.e. containing
 * at least one `<r>` run child) entry, or 0 for a plain `<t>`-only entry.
 * Array index matches the shared-string index cells reference via
 * `<c t="s"><v>INDEX</v></c>` — exactly the lookup ExcelParser.js itself
 * performs (`sharedStrings[idx]`).
 *
 * Exported for direct unit testing against hand-written sharedStrings.xml
 * bodies, without needing a full zip fixture for every case.
 */
export function richSharedStringSizes(sharedStringsXml: string): number[] {
  const out: number[] = []
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sharedStringsXml))) {
    const body = m[1]
    // A run (<r>...</r>) is what makes a shared string "rich" — ExcelParser.js
    // only takes the expensive deep-copy branch when `sharedStrings[idx]` is an
    // array, which is exactly what a run-bearing <si> parses into. A plain
    // <t>text</t> entry parses into a bare string, hitting the cheap branch —
    // scored 0 here, matching that real cost of exactly zero.
    out.push(body !== undefined && /<r[\s>]/.test(body) ? m[0].length : 0)
  }
  return out
}

/**
 * Merges richSharedStringSizes() across every entry that content-sniffs as a
 * shared-strings table, taking the MAX at each index. A real archive has
 * exactly one such entry; more than one is already an adversarial signal, and
 * taking the max — rather than picking "the" entry by some path guess — means
 * this can never underestimate whichever one officeParser's own (unanchored,
 * exact-path-for-sharedStrings-specifically) matching ends up reading.
 */
function mergeRichSizesPessimistically(sharedStringsTexts: string[]): number[] {
  const merged: number[] = []
  for (const xml of sharedStringsTexts) {
    const sizes = richSharedStringSizes(xml)
    for (let i = 0; i < sizes.length; i++) merged[i] = Math.max(merged[i] ?? 0, sizes[i])
  }
  return merged
}

/**
 * Sums, across every worksheet-shaped entry, the size of every RICH shared
 * string a `t="s"` cell references — the exact quantity ExcelParser.js
 * deep-copies. Bails the moment the running total crosses `budget`, so a
 * genuine bomb is caught early rather than after a full scan of millions of
 * cell tags.
 *
 * The cell-matching regex mirrors ExcelParser.js's own `cRegex` pattern
 * (`<c ...>...</c>` with a non-greedy body match) deliberately: that pattern
 * is already exercised in production against large real spreadsheets, so
 * reusing its shape is evidence this scan won't itself pathologically
 * backtrack on adversarial input.
 */
export function richTextReferenceCost(sheetXmls: string[], richSizes: number[], budget: number): number {
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let total = 0
  for (const xml of sheetXmls) {
    cellRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = cellRe.exec(xml))) {
      if (!/\bt="s"/.test(m[1])) continue
      const vm = /<v>(\d+)<\/v>/.exec(m[2] ?? '')
      if (!vm) continue
      const size = richSizes[Number(vm[1])] ?? 0
      if (size === 0) continue
      total += size
      if (total > budget) return total
    }
  }
  return total
}

/**
 * The public guard: estimate whether parsing `bytes` as XLSX would force
 * ExcelParser.js past `XLSX_DEEP_COPY_BUDGET_BYTES` of deep-copied rich-text
 * content, without ever calling the real (unbounded) parser.
 *
 * Fails OPEN (returns `exceeded: false`) if the scan itself cannot complete
 * (malformed zip, unexpected shape, etc.) rather than blocking a legitimate
 * file on a bug in this pre-scan — this is a SECOND layer of defense on top
 * of the worker + wall-clock timeout (officeEngine.ts) and the pre-existing,
 * already-trusted DECOMPRESSION_LIMITS byte cap `parseOffice` itself enforces
 * downstream. If this scan is ever bypassed, the worst case is exactly
 * today's un-guarded behavior, now at least contained to a worker and capped
 * by a wall-clock timeout instead of freezing the panel indefinitely.
 */
export function estimateXlsxDeepCopyCost(bytes: Uint8Array): XlsxCostEstimate {
  try {
    const files = unzipBounded(bytes, DECOMPRESSION_LIMITS.maxUncompressedBytes)
    const texts = Object.values(files)
    const sharedStringsTexts = texts.filter((t) => SST_ROOT_RE.test(t))
    if (sharedStringsTexts.length === 0) return { exceeded: false, estimatedBytes: 0 }
    const richSizes = mergeRichSizesPessimistically(sharedStringsTexts)
    // No rich text anywhere in the document: the deep-copy branch can never be
    // hit, so skip scanning (potentially millions of) worksheet cells entirely.
    if (richSizes.every((s) => s === 0)) return { exceeded: false, estimatedBytes: 0 }
    const sheetTexts = texts.filter((t) => SHEET_DATA_RE.test(t))
    const estimatedBytes = richTextReferenceCost(sheetTexts, richSizes, XLSX_DEEP_COPY_BUDGET_BYTES)
    return { exceeded: estimatedBytes > XLSX_DEEP_COPY_BUDGET_BYTES, estimatedBytes }
  } catch {
    return { exceeded: false, estimatedBytes: 0 }
  }
}
