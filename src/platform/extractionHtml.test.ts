// @vitest-environment node
import { expect, test } from 'vitest'
import {
  extractReadableText,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
} from './webFetch'
import { parseImgTags } from './researchSources'
import { parseOpenGraph } from './linkPreview'

test('all fetched-HTML extraction works without a browser DOM', () => {
  expect(typeof DOMParser).toBe('undefined')
  const html = `<title>A &amp; B</title><meta property="og:title" content="Preview &amp; title"><body ONLOAD="throw new Error('handler')"><main><h1>Heading</h1><p>First &amp; second.</p><p>Next.</p><img src="/hero.jpg?a=1&amp;b=2" onerror="throw new Error('handler')" width="640" height="480" alt="A > B"><script>throw new Error('script')</script></main></body>`
  expect(extractReadableText(html)).toEqual({
    title: 'A & B',
    text: 'Heading\nFirst & second.\nNext.',
  })
  expect(parseImgTags(html, 'https://example.com')[0]).toMatchObject({
    url: 'https://example.com/hero.jpg?a=1&b=2',
    caption: 'A > B',
    dims: { w: 640, h: 480 },
  })
  expect(parseOpenGraph(html, 'https://example.com')?.title).toBe(
    'Preview & title',
  )
  expect(
    parseDuckDuckGoLite(
      '<table><tr><td><a class="result-link" onclick="x()" href="https://example.com">Result</a></td></tr><tr><td class="result-snippet">Snippet</td></tr></table>',
    )[0],
  ).toMatchObject({ title: 'Result', snippet: 'Snippet' })
  expect(
    parseDuckDuckGoHtml(
      '<div class="result"><a class="result__a" onfocus="x()" href="https://example.com">Result</a></div>',
    )[0].url,
  ).toBe('https://example.com')
})

test('excluded navigation cannot supply the preferred readable root', () => {
  expect(
    extractReadableText(
      '<nav><main>Navigation</main></nav><article><p>Article.</p></article>',
    ).text,
  ).toBe('Article.')
})

test('deeply nested readable text does not recurse through the JavaScript call stack', () => {
  const html =
    '<main>' +
    '<div>'.repeat(3000) +
    '<p>Deep content.</p>' +
    '</div>'.repeat(3000) +
    '</main>'
  expect(extractReadableText(html).text).toBe('Deep content.')
})
