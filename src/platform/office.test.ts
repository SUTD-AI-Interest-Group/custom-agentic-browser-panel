import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseOfficeDocument, OfficeError } from './office'

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
