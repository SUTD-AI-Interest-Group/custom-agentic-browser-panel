import { describe, it, expect, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

// office.ts now hands parsing to officeEngine.ts, which spawns a real browser
// Worker — unavailable under Vitest (no chrome.runtime, no Worker). Mock the
// engine to delegate straight to officeParse.ts's parseOfficeBytes instead of
// a canned fixture: unlike pdfVerbosity.test.ts's pdfEngine mock (that path is
// a 4.8 MB WASM module, too heavy to run in tests at all), officeParser is
// plain, lightweight JS — running it for real here is what keeps these tests
// meaningful end-to-end coverage of the actual parse output, not just proof
// that a mock was called. The worker/queue/timeout plumbing itself is covered
// separately in officeEngine.test.ts against a fake Worker.
vi.mock('./officeEngine', () => ({
  getOfficeEngine: () => ({
    parse: async (bytes: Uint8Array, name: string, mimeType: string) => {
      const { parseOfficeBytes } = await import('./officeParse')
      return parseOfficeBytes(bytes, name, mimeType)
    },
  }),
}))

const { parseOfficeDocument, OfficeError, countImageNodes } = await import('./office')

// A real, minimal, valid PNG (1x1 transparent pixel) — small enough to inline,
// large enough to be a real decodable image so a fixture using it is a real
// embedded-image document, not a placeholder.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
function pngBytes(): Uint8Array {
  return Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))
}

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function makeDocx(): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew 12% in APAC.</w:t></w:r></w:p>
</w:body></w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_DOCX),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(doc),
  })
}

/**
 * A docx with one inline `w:drawing` embedding a real image part. This is the
 * exact shape a hand-authored fixture needs to catch officeParser's own
 * source gating: `image` content nodes for docx are built ONLY when
 * `extractAttachments: true` is passed to `parseOffice` — without it, the
 * paragraph holding the drawing parses as completely empty (confirmed against
 * the real library, not assumed). This fixture is what actually exercises
 * that path end to end.
 */
function makeDocxWithImage(): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:r><w:t>Before the image.</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>After the image.</w:t></w:r></w:p>
</w:body></w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(doc),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`),
    'word/media/image1.png': pngBytes(),
  })
}

/** `rows` is a list of [ref, value] pairs so a row can deliberately skip a column. */
function makeXlsx(sheets: { name: string; rows: [string, string][][] }[]): Uint8Array {
  const cell = ([ref, v]: [string, string]) => `<c r="${ref}" t="str"><v>${v}</v></c>`
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`),
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map(cell).join('')}</row>`).join('\n')}
</sheetData></worksheet>`)
  })
  return zipSync(files)
}

/**
 * A minimal-but-real pptx: presentation.xml + two slides, each wired through
 * its own rels to a shared slideLayout/slideMaster/theme. officeParser needs
 * the full relationship chain to resolve slide part names — a bare
 * `ppt/slides/slideN.xml` with no layout/master is rejected as malformed.
 */
function makePptx(titles: [string, string][]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${titles.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${titles.length + 1}"/></p:sldMasterIdLst>
<p:sldIdLst>${titles.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${titles.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${titles.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>`),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`),
    'ppt/theme/theme1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Theme">
<a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements>
</a:theme>`),
  }
  titles.forEach(([title, bodyText], i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${bodyText}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`)
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`)
  })
  return zipSync(files)
}

/** A minimal EPUB: a nav file plus two chapter XHTML files, each opening with an H1. */
function makeEpub(chapters: [string, string][]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:test</dc:identifier>
<dc:title>Test Book</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
${chapters.map((_, i) => `<item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest>
<spine>
${chapters.map((_, i) => `<itemref idref="chapter${i + 1}"/>`).join('\n')}
</spine>
</package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body><nav epub:type="toc"><ol>
${chapters.map(([title], i) => `<li><a href="chapter${i + 1}.xhtml">${title}</a></li>`).join('\n')}
</ol></nav></body>
</html>`),
  }
  chapters.forEach(([title, text], i) => {
    files[`OEBPS/chapter${i + 1}.xhtml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body><h1>${title}</h1><p>${text}</p></body>
</html>`)
  })
  return zipSync(files, { level: 0 })
}

describe('parseOfficeDocument', () => {
  it('maps a docx to prose segments', async () => {
    const doc = await parseOfficeDocument(makeDocx(), 'id-docx', 'report.docx', '')
    expect(doc.shape).toBe('prose')
    if (doc.shape !== 'prose') throw new Error('unreachable')
    expect(doc.format).toBe('docx')
    const all = doc.segments.map((s) => s.text).join('\n')
    expect(all).toContain('Quarterly Report')
    expect(all).toContain('Revenue grew 12% in APAC.')
    expect(doc.imageCount).toBe(0)
  })

  // Regression: a docx's `image` content nodes are built by officeParser ONLY
  // when `extractAttachments: true` is passed — without it, the paragraph
  // holding a `w:drawing` parses as completely empty, and imageCount silently
  // stayed 0 for every docx/pptx/etc regardless of how many images it held.
  it('counts an embedded image in a real docx', async () => {
    const doc = await parseOfficeDocument(makeDocxWithImage(), 'id-docx-image', 'deck.docx', '')
    expect(doc.shape).toBe('prose')
    if (doc.shape !== 'prose') throw new Error('unreachable')
    const all = doc.segments.map((s) => s.text).join('\n')
    expect(all).toContain('Before the image.')
    expect(all).toContain('After the image.')
    expect(doc.imageCount).toBe(1)
  })

  it('maps an xlsx to named sheets', async () => {
    const bytes = makeXlsx([
      { name: 'Q1', rows: [[['A1', 'Date'], ['B1', 'Region']], [['A2', '2026-01-03'], ['B2', 'APAC']]] },
      { name: 'Notes', rows: [[['A1', 'Topic']]] },
    ])
    const doc = await parseOfficeDocument(bytes, 'id-xlsx', 'sales.xlsx', '')
    expect(doc.shape).toBe('workbook')
    if (doc.shape !== 'workbook') throw new Error('unreachable')
    expect(doc.sheets.map((s) => s.name)).toEqual(['Q1', 'Notes'])
    expect(doc.sheets[0].rows[0]).toEqual(['Date', 'Region'])
    expect(doc.sheets[0].rowCount).toBe(2)
  })

  it('rebuilds a sparse row by column index, not array position', async () => {
    // B2 is absent. Placing C2 at index 1 would silently shift every later
    // column left and misalign the whole sheet against its headers.
    const bytes = makeXlsx([
      { name: 'S', rows: [
        [['A1', 'a'], ['B1', 'b'], ['C1', 'c']],
        [['A2', 'x'], ['C2', 'z']],
      ] },
    ])
    const doc = await parseOfficeDocument(bytes, 'id-sparse', 'sparse.xlsx', '')
    if (doc.shape !== 'workbook') throw new Error('unreachable')
    expect(doc.sheets[0].rows[1]).toEqual(['x', '', 'z'])
    expect(doc.sheets[0].colCount).toBe(3)
  })

  it('rejects an unsupported file with an OfficeError', async () => {
    await expect(
      parseOfficeDocument(new Uint8Array([1, 2, 3, 4]), 'id-bad', 'broken.docx', ''),
    ).rejects.toBeInstanceOf(OfficeError)
  })

  it('rejects a file over the size cap before parsing', async () => {
    const huge = new Uint8Array(26 * 1024 * 1024)
    await expect(parseOfficeDocument(huge, 'id-huge', 'huge.docx', '')).rejects.toThrow(/25 MB/)
  })

  // officeParser's real AST groups an entire pptx slide under one top-level
  // `slide` node (confirmed against the actual library — see office.ts's
  // toProse comment); each becomes its own segment, titled by position since
  // SlideMetadata carries no title field to read.
  it('maps a pptx to one segment per slide', async () => {
    const bytes = makePptx([
      ['Welcome', 'First slide body text.'],
      ['Agenda', 'Second slide body text.'],
    ])
    const doc = await parseOfficeDocument(bytes, 'id-pptx', 'deck.pptx', '')
    expect(doc.shape).toBe('prose')
    if (doc.shape !== 'prose') throw new Error('unreachable')
    expect(doc.format).toBe('pptx')
    expect(doc.segments.map((s) => s.label)).toEqual(['Slide 1', 'Slide 2'])
    expect(doc.segments[0].text).toContain('Welcome')
    expect(doc.segments[0].text).toContain('First slide body text.')
    expect(doc.segments[1].text).toContain('Agenda')
  })

  // officeParser's real AST has no `chapter`/`section` node for epub at all —
  // every spine XHTML file flattens into the same heading/paragraph stream a
  // docx gets. toProse's fallback heuristic keys off level-1 headings instead.
  it('splits an epub into segments at each level-1 heading', async () => {
    const bytes = makeEpub([
      ['Chapter One', 'The beginning of the story.'],
      ['Chapter Two', 'The middle of the story.'],
    ])
    const doc = await parseOfficeDocument(bytes, 'id-epub', 'book.epub', '')
    expect(doc.shape).toBe('prose')
    if (doc.shape !== 'prose') throw new Error('unreachable')
    expect(doc.format).toBe('epub')
    expect(doc.segments.map((s) => s.label)).toEqual(['Chapter One', 'Chapter Two'])
    expect(doc.segments[0].text).toContain('The beginning of the story.')
    expect(doc.segments[1].text).toContain('The middle of the story.')
  })
})

describe('countImageNodes', () => {
  it('counts zero for a tree with no image nodes', () => {
    const content = [
      { type: 'heading', children: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'Body' }] },
    ]
    expect(countImageNodes(content)).toBe(0)
  })

  it('counts two top-level image nodes among other content', () => {
    const content = [
      { type: 'paragraph', children: [{ type: 'text', text: 'Before' }] },
      { type: 'image', metadata: { attachmentName: 'a.png' } },
      { type: 'paragraph', children: [{ type: 'text', text: 'Between' }] },
      { type: 'image', metadata: { attachmentName: 'b.png' } },
    ]
    expect(countImageNodes(content)).toBe(2)
  })

  it('recurses into children — an image nested inside a slide still counts', () => {
    // Mirrors the real pptx shape: a top-level `slide` node whose children
    // hold the title heading and, when the slide has a picture, an `image`.
    const content = [
      {
        type: 'slide',
        metadata: { slideNumber: 1 },
        children: [
          { type: 'heading', children: [{ type: 'text', text: 'Welcome' }] },
          { type: 'image', metadata: { attachmentName: 'photo.jpg' } },
        ],
      },
    ]
    expect(countImageNodes(content)).toBe(1)
  })

  it('does not count chart nodes as images', () => {
    const content = [{ type: 'chart', metadata: {} }]
    expect(countImageNodes(content)).toBe(0)
  })
})
