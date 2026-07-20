// Copy a rendered DOM element to the clipboard as a PNG, using only browser
// built-ins — no external dependency. The element is cloned, its computed
// styles are inlined (an SVG <foreignObject> does not inherit the page's
// stylesheets), serialized into an SVG, rasterized onto a <canvas>, and the
// resulting blob is written to the clipboard.
//
// Known limitation: cross-origin <img> or fonts inside the element taint the
// canvas and make toBlob throw. Assistant messages are text plus inline SVG,
// so this is rare; callers surface the error rather than crash.

const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'

// Copy every resolved property from a live element onto its clone. Both trees
// share structure (the clone is a deep clone), so children line up by index.
function inlineComputedStyles(source: Element, target: Element) {
  const computed = getComputedStyle(source)
  const style = (target as HTMLElement).style
  for (let i = 0; i < computed.length; i++) {
    const prop = computed.item(i)
    style.setProperty(prop, computed.getPropertyValue(prop), computed.getPropertyPriority(prop))
  }
  const sChildren = source.children
  const tChildren = target.children
  for (let i = 0; i < sChildren.length && i < tChildren.length; i++) {
    inlineComputedStyles(sChildren[i], tChildren[i])
  }
}

// The nearest opaque background up the ancestor chain, so the PNG is not
// transparent (which pastes as black/white in many apps).
function opaqueBackground(el: HTMLElement): string {
  let node: HTMLElement | null = el
  while (node) {
    const bg = getComputedStyle(node).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba?\(0, 0, 0, 0\)/.test(bg)) return bg
    node = node.parentElement
  }
  return getComputedStyle(document.body).backgroundColor || '#ffffff'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to render message image.'))
    img.src = src
  })
}

// Lay the trimmed clone out off-screen and read its real height. Needed because
// inlineComputedStyles pins an explicit `height` on every node, so after some
// children are removed the container would otherwise keep its original height.
function measureHeight(clone: HTMLElement, width: number): number {
  const measurer = document.createElement('div')
  measurer.style.cssText =
    `position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:${width}px`
  clone.style.height = 'auto'
  measurer.appendChild(clone)
  document.body.appendChild(measurer)
  const height = Math.max(1, Math.ceil(clone.getBoundingClientRect().height))
  document.body.removeChild(measurer)
  measurer.removeChild(clone)
  return height
}

// `exclude`, when given, is a CSS selector for descendants to drop from the
// picture — e.g. an assistant reply's reasoning blocks and tool-use pills, so
// the PNG shows only the response prose.
export async function copyElementAsPng(el: HTMLElement, exclude?: string): Promise<void> {
  const rect = el.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const background = opaqueBackground(el)

  const clone = el.cloneNode(true) as HTMLElement
  inlineComputedStyles(el, clone)

  // Drop excluded blocks after inlining styles (so the survivors keep their
  // resolved styles), then re-measure since the content is now shorter.
  let height = Math.ceil(rect.height)
  if (exclude) {
    clone.querySelectorAll(exclude).forEach((n) => n.remove())
    height = measureHeight(clone, width)
  }

  // Pin the clone to the element's border-box so foreignObject reproduces the
  // exact layout regardless of the inlined box-sizing/width.
  clone.setAttribute('xmlns', XHTML_NS)
  clone.style.boxSizing = 'border-box'
  clone.style.width = `${width}px`
  clone.style.height = `${height}px`
  clone.style.margin = '0'

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const foreignObject = document.createElementNS(SVG_NS, 'foreignObject')
  foreignObject.setAttribute('x', '0')
  foreignObject.setAttribute('y', '0')
  foreignObject.setAttribute('width', '100%')
  foreignObject.setAttribute('height', '100%')
  foreignObject.appendChild(clone)
  svg.appendChild(foreignObject)

  const svgString = new XMLSerializer().serializeToString(svg)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`
  const img = await loadImage(url)

  // Frame the screenshot with 8px of background padding on every side and a
  // 16px rounded outer edge. Clipping to the rounded rect leaves the four
  // corners outside the path transparent, so the card reads as rounded.
  const padding = 8
  const radius = 16
  const totalWidth = width + padding * 2
  const totalHeight = height + padding * 2

  const dpr = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(totalWidth * dpr))
  canvas.height = Math.max(1, Math.ceil(totalHeight * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable.')
  ctx.scale(dpr, dpr)
  ctx.beginPath()
  ctx.roundRect(0, 0, totalWidth, totalHeight, radius)
  ctx.clip()
  ctx.fillStyle = background
  ctx.fillRect(0, 0, totalWidth, totalHeight)
  ctx.drawImage(img, padding, padding)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Failed to encode image.')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
