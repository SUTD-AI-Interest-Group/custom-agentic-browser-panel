import { parse, type DefaultTreeAdapterMap } from 'parse5'

export type HtmlNode = DefaultTreeAdapterMap['node']
export type HtmlElement = DefaultTreeAdapterMap['element']
export const parseExtractionHtml = (html: string) => parse(html)
export const isHtmlElement = (node: HtmlNode): node is HtmlElement =>
  'tagName' in node
export const htmlAttr = (node: HtmlElement, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value ?? ''
export const hasHtmlClass = (node: HtmlElement, name: string) =>
  htmlAttr(node, 'class').split(/\s+/).includes(name)

/** Read-only HTML5 trees, never native DOM nodes. Parsing fetched markup must
 * not compile event attributes, execute code, or load embedded resources in an
 * extension document. Native DOMParser can emit CSP violations while parsing
 * handler attributes, before a caller has the opportunity to strip them.
 */
export function* htmlElements(
  root: HtmlNode,
  exclude: ReadonlySet<string> = new Set(),
): Generator<HtmlElement> {
  const stack: HtmlNode[] =
    'childNodes' in root ? [...root.childNodes].reverse() : []
  while (stack.length) {
    const node = stack.pop()!
    if (isHtmlElement(node)) {
      if (exclude.has(node.tagName)) continue
      yield node
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(node.childNodes[i])
  }
}
export function findHtml(
  root: HtmlNode,
  match: (node: HtmlElement) => boolean,
  exclude?: ReadonlySet<string>,
): HtmlElement | undefined {
  for (const node of htmlElements(root, exclude)) if (match(node)) return node
}
export function closestHtml(
  start: HtmlElement,
  tag: string,
): HtmlElement | undefined {
  for (
    let node: HtmlNode | null = start;
    node;
    node = 'parentNode' in node ? node.parentNode : null
  ) {
    if (isHtmlElement(node) && node.tagName === tag) return node
  }
}
export function nextHtmlSibling(node: HtmlElement): HtmlElement | undefined {
  const siblings = node.parentNode?.childNodes ?? []
  for (let i = siblings.indexOf(node) + 1; i < siblings.length; i++)
    if (isHtmlElement(siblings[i])) return siblings[i] as HtmlElement
}
export function htmlText(
  root: HtmlNode | undefined,
  exclude: ReadonlySet<string> = new Set(),
  blocks: ReadonlySet<string> = new Set(),
): string {
  if (!root) return ''
  const out: string[] = []
  const stack: (HtmlNode | '\n')[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node === '\n') {
      out.push(node)
      continue
    }
    if (isHtmlElement(node) && exclude.has(node.tagName)) continue
    if (node.nodeName === '#text')
      out.push((node as DefaultTreeAdapterMap['textNode']).value)
    if (isHtmlElement(node) && blocks.has(node.tagName)) stack.push('\n')
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(node.childNodes[i])
  }
  return out.join('')
}
