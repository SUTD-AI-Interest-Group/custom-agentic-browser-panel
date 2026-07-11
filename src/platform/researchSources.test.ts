import { test, expect } from 'vitest'
import {
  reconstructAbstract,
  parseOpenAlexWork,
  parseCommonsImages,
  parseOpenverse,
  parseImgTags,
} from './researchSources'

test('reconstructAbstract rebuilds plain text from the inverted index', () => {
  expect(reconstructAbstract({ The: [0], quick: [1], brown: [2], fox: [3, 5], jumps: [4] })).toBe(
    'The quick brown fox jumps fox',
  )
  expect(reconstructAbstract(null)).toBe('')
})

test('parseOpenAlexWork maps title/abstract/authors/url', () => {
  const r = parseOpenAlexWork({
    title: 'On Widgets',
    abstract_inverted_index: { Widgets: [0], matter: [1] },
    authorships: [{ author: { display_name: 'A. Smith' } }, { author: { display_name: 'B. Lee' } }],
    publication_year: 2023,
    primary_location: { landing_page_url: 'https://ex.com/w' },
    open_access: { oa_url: 'https://ex.com/w.pdf' },
  })
  expect(r.title).toBe('On Widgets')
  expect(r.abstract).toBe('Widgets matter')
  expect(r.authors).toEqual(['A. Smith', 'B. Lee'])
  expect(r.year).toBe(2023)
  expect(r.url).toBe('https://ex.com/w')
  expect(r.pdfUrl).toBe('https://ex.com/w.pdf')
})

test('parseCommonsImages extracts url + license + author, skips non-images', () => {
  const out = parseCommonsImages({
    query: {
      pages: {
        '1': {
          title: 'File:Cat.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/cat.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.jpg',
              mime: 'image/jpeg',
              width: 800,
              height: 600,
              extmetadata: {
                LicenseShortName: { value: 'CC BY-SA 4.0' },
                Artist: { value: '<a href="x">Jane</a>' },
                ImageDescription: { value: 'A <b>cat</b>' },
              },
            },
          ],
        },
        '2': { title: 'File:Song.ogg', imageinfo: [{ url: 'https://x/song.ogg', mime: 'audio/ogg' }] },
      },
    },
  })
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({
    url: 'https://upload.wikimedia.org/cat.jpg',
    title: 'Cat.jpg',
    license: 'CC BY-SA 4.0',
    author: 'Jane',
    caption: 'A cat',
    dims: { w: 800, h: 600 },
  })
})

test('parseOpenverse maps results and license', () => {
  const out = parseOpenverse({
    results: [
      { url: 'https://ex.com/i.jpg', title: 'Thing', foreign_landing_url: 'https://ex.com/p', license: 'by', license_version: '4.0', creator: 'Ada', width: 400, height: 300 },
      { title: 'no url' },
    ],
  })
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ url: 'https://ex.com/i.jpg', license: 'BY 4.0', author: 'Ada' })
})

test('parseImgTags resolves relative URLs, uses figcaption, skips sprites/tiny', () => {
  const html = `
    <figure><img src="/photos/graph.png" width="600" height="400"><figcaption>Fig 1. A graph</figcaption></figure>
    <img src="https://cdn.x/sprite.png" width="600" height="400">
    <img src="/icons/tiny.png" width="16" height="16">
    <img data-src="//cdn.x/lazy.jpg" width="500" height="500" alt="lazy pic">
  `
  const out = parseImgTags(html, 'https://site.com/article')
  const urls = out.map((r) => r.url)
  expect(urls).toContain('https://site.com/photos/graph.png')
  expect(urls).toContain('https://cdn.x/lazy.jpg')
  expect(urls).not.toContain('https://cdn.x/sprite.png') // sprite skipped
  expect(urls.some((u) => u.includes('tiny'))).toBe(false) // too small
  const graph = out.find((r) => r.url.endsWith('graph.png'))
  expect(graph?.caption).toBe('Fig 1. A graph')
})
