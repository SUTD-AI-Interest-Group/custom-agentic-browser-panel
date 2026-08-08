// The real parse: officeParser's slim bundle in, a normalized OfficeDoc out.
// Deliberately Chrome-free and Worker-free — a plain async function — so it is
// the single implementation BOTH sides share:
//
// - officeWorker.ts calls it for real, off the main thread.
// - office.test.ts calls it directly (via a mocked officeEngine.ts, see that
//   test file) so the existing end-to-end fixture tests keep exercising real
//   officeParser output instead of a canned mock — the worker/queue/timeout
//   plumbing around it is what's not practically testable under Vitest (no
//   browser Worker, no chrome.runtime), not this logic.
//
// Two hard rules carried over from the pre-worker office.ts:
//
// 1. The import is `officeparser/slim` and it is DYNAMIC. The default entry
//    resolves the pdf.js worker and Tesseract language data from jsDelivr at
//    runtime — remotely hosted code, which Manifest V3 forbids and which this
//    product forbids on principle. The slim bundle strips both.
// 2. decompressionLimits are set on every call. officeParser's defaults (512 MB
//    / 10k entries) are generous enough to let a zip bomb exhaust memory;
//    these files are untrusted user input.

import { officeFormatFor, OfficeError, toWorkbook, toProse, countImageNodes, type OfficeDoc } from './officeText'
import { DECOMPRESSION_LIMITS, XLSX_MAX_TABLE_CELLS, estimateXlsxDeepCopyCost } from './officeCellBudget'

let parserPromise: Promise<typeof import('officeparser/slim')> | null = null

/** Load the slim bundle once, lazily. Never make this a static import. */
function getOfficeParser(): Promise<typeof import('officeparser/slim')> {
  if (!parserPromise) {
    parserPromise = import('officeparser/slim').catch((err) => {
      // Let a failed load retry on the next attachment rather than poisoning
      // the module for the life of the worker.
      parserPromise = null
      throw new OfficeError(`Could not load the document parser: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return parserPromise
}

/**
 * Parse office document bytes into the normalized model. No caching, no size
 * gate (office.ts's MAX_OFFICE_BYTES already ran before bytes reach here) —
 * just format detection, the C1 cell-cost guard, the real parse, and the AST
 * mapping.
 */
export async function parseOfficeBytes(bytes: Uint8Array, name: string, mimeType: string): Promise<OfficeDoc> {
  const format = officeFormatFor(name, mimeType)
  if (!format) throw new OfficeError(`"${name}" is not a supported office document.`)

  // C1: ExcelParser.js has no cell budget of its own (see officeCellBudget.ts's
  // module comment) — estimate the deep-copy cost BEFORE calling the real
  // parser, since by the time parseOffice() returns (or hangs) the damage is
  // already done. ODS/ODT/ODP go through OpenOfficeParser.js, which already
  // guards this exact bomb class via its own CellBudget, so this check is
  // XLSX-specific.
  if (format === 'xlsx') {
    const cost = estimateXlsxDeepCopyCost(bytes)
    if (cost.exceeded) {
      throw new OfficeError(
        `"${name}" has cells referencing an unusually large amount of formatted text and was rejected as a precaution. Try re-saving with plain-text cells, or splitting the sheet.`,
      )
    }
  }

  const { parseOffice } = await getOfficeParser()
  let ast: any
  try {
    // extractAttachments is required for a correct imageCount, not optional:
    // verified against the library's own source that for docx and rtf
    // specifically, `image` content nodes are built ONLY when this flag is
    // set — without it, a docx paragraph holding a `w:drawing` parses as
    // completely empty, no `image` node anywhere in `content`. pptx/odp/odt
    // already emit `image` nodes unconditionally, so this flag is a no-op
    // for them; requesting it uniformly avoids a per-format branch that
    // would silently break again if officeParser's gating ever changes.
    // The resulting attachment payloads are discarded — only countImageNodes
    // (walking `content`, not `ast.attachments`) is read — but decoding them
    // is unavoidable to populate those `image` nodes at all. Cost is bounded
    // by DECOMPRESSION_LIMITS, the same cap already guarding this call.
    //
    // maxTableCells: currently a documented no-op for XLSX (ExcelParser.js
    // does not read it — confirmed against the vendored source; see
    // officeCellBudget.ts) but IS honored by OpenOfficeParser.js's CellBudget
    // for ODS/ODT/ODP, and passing it uniformly costs nothing and stays
    // forward-compatible if a future officeparser version wires it up for
    // XLSX too.
    ast = await parseOffice(bytes, {
      decompressionLimits: { ...DECOMPRESSION_LIMITS, maxTableCells: XLSX_MAX_TABLE_CELLS },
      extractAttachments: true,
    })
  } catch (err) {
    throw new OfficeError(
      `Could not read "${name}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const content: any[] = Array.isArray(ast?.content) ? ast.content : []
  const imageCount = countImageNodes(content)
  return format === 'xlsx' || format === 'ods'
    ? toWorkbook(content, format, imageCount)
    : toProse(content, format, imageCount)
}
