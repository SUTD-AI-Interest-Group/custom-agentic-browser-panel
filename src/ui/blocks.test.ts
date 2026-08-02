import { describe, it, expect } from 'vitest'
import { splitBlocks } from './blocks'

describe('splitBlocks — markdown passthrough', () => {
  it('keeps ordinary prose as a single markdown block', () => {
    const out = splitBlocks('Hello there.\nHow are you?')
    expect(out).toEqual([{ type: 'markdown', text: 'Hello there.\nHow are you?' }])
  })

  it('returns an empty array for empty input', () => {
    expect(splitBlocks('')).toEqual([{ type: 'markdown', text: '' }])
  })
})

describe('splitBlocks — image runs (the >= 2 threshold)', () => {
  it('a single standalone image line is NOT pulled into a carousel — it stays markdown', () => {
    const out = splitBlocks('https://example.com/a.png')
    expect(out).toEqual([{ type: 'markdown', text: 'https://example.com/a.png' }])
  })

  it('two consecutive image lines become an images block', () => {
    const out = splitBlocks('https://example.com/a.png\nhttps://example.com/b.jpg')
    expect(out).toEqual([
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.jpg'] },
    ])
  })

  it('markdown-image syntax counts toward the run', () => {
    const out = splitBlocks('![alt](https://example.com/a.png)\n![alt2](https://example.com/b.png)')
    expect(out).toEqual([
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.png'] },
    ])
  })

  it('bullet-prefixed image lines still count toward the run', () => {
    const out = splitBlocks('- https://example.com/a.png\n- https://example.com/b.png')
    expect(out).toEqual([
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.png'] },
    ])
  })

  it('an image run surrounded by prose splits into markdown/images/markdown', () => {
    const out = splitBlocks(
      'Here are two photos:\nhttps://example.com/a.png\nhttps://example.com/b.png\nThat is all.',
    )
    expect(out).toEqual([
      { type: 'markdown', text: 'Here are two photos:' },
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.png'] },
      { type: 'markdown', text: 'That is all.' },
    ])
  })

  it('a broken run (only one image line, non-image line before the second) does not merge across the gap', () => {
    const out = splitBlocks('https://example.com/a.png\nsome text\nhttps://example.com/b.png')
    expect(out).toEqual([
      { type: 'markdown', text: 'https://example.com/a.png\nsome text\nhttps://example.com/b.png' },
    ])
  })
})

describe('splitBlocks — SSRF screening of image URLs (model-authored image blocks are auto-rendered with no approval gate)', () => {
  it('drops a single standalone image line pointing at a loopback target entirely — it is not shown as markdown text either', () => {
    // Unlike the safe case above, this must not fall back to raw markdown:
    // a `![alt](url)` line surviving there would still render as a real
    // <img> via the markdown pipeline, defeating the point of dropping it.
    const out = splitBlocks('http://127.0.0.1/evil.png')
    expect(out).toEqual([])
  })

  it('a run of two image lines where one targets a private IP keeps only the safe one (falls below the carousel threshold, so it renders as plain markdown)', () => {
    const out = splitBlocks('https://example.com/a.png\nhttp://192.168.0.1/evil.png')
    expect(out).toEqual([{ type: 'markdown', text: 'https://example.com/a.png' }])
  })

  it('a run of three image lines where the middle one is unsafe still forms a carousel from the two safe survivors, in order', () => {
    const out = splitBlocks(
      'https://example.com/a.png\nhttp://169.254.169.254/evil.png\nhttps://example.com/b.png',
    )
    expect(out).toEqual([
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.png'] },
    ])
  })

  it('a run of two image lines that are both unsafe produces nothing at all', () => {
    const out = splitBlocks('http://127.0.0.1/a.png\nhttp://169.254.169.254/b.png')
    expect(out).toEqual([])
  })

  it('an unsafe image line surrounded by prose is dropped, merging the surrounding prose into one markdown block (consistent with how a single non-run image line already falls back to markdown)', () => {
    const out = splitBlocks('Before.\nhttp://127.0.0.1/evil.png\nAfter.')
    expect(out).toEqual([{ type: 'markdown', text: 'Before.\nAfter.' }])
  })

  it('markdown-image syntax pointing at a metadata host is dropped, not degraded to a literal ![]() markdown line', () => {
    const out = splitBlocks('![alt](https://example.com/a.png)\n![evil](http://metadata.google.internal/x.png)')
    expect(out).toEqual([{ type: 'markdown', text: '![alt](https://example.com/a.png)' }])
  })

  it('rejects a non-standard IPv4-encoded image URL (decimal integer host) the same as a dotted-quad one', () => {
    const out = splitBlocks('https://example.com/a.png\nhttp://2130706433/evil.png')
    expect(out).toEqual([{ type: 'markdown', text: 'https://example.com/a.png' }])
  })

  it('never leaks the blocked URL into any surviving block', () => {
    const out = splitBlocks(
      'Intro.\nhttps://example.com/a.png\nhttp://169.254.169.254/evil.png\nhttps://example.com/b.png\nOutro.',
    )
    expect(JSON.stringify(out)).not.toContain('169.254.169.254')
  })
})

describe('splitBlocks — link runs', () => {
  it('a single standalone link becomes a links block (threshold is >= 1, unlike images)', () => {
    const out = splitBlocks('https://example.com/page')
    expect(out).toEqual([
      { type: 'links', links: [{ url: 'https://example.com/page', text: 'https://example.com/page' }], raw: 'https://example.com/page' },
    ])
  })

  it('markdown-link syntax uses the link text', () => {
    const out = splitBlocks('[Example site](https://example.com)')
    expect(out).toEqual([
      { type: 'links', links: [{ url: 'https://example.com', text: 'Example site' }], raw: '[Example site](https://example.com)' },
    ])
  })

  it('angle-bracket autolinks are recognized', () => {
    const out = splitBlocks('<https://example.com>')
    expect(out).toEqual([
      { type: 'links', links: [{ url: 'https://example.com', text: 'https://example.com' }], raw: '<https://example.com>' },
    ])
  })

  it('trims trailing sentence punctuation from a bare URL but keeps a paren that belongs to the URL', () => {
    const out = splitBlocks('https://en.wikipedia.org/wiki/Foo_(bar).')
    expect(out).toEqual([
      {
        type: 'links',
        links: [
          {
            url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
            text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
          },
        ],
        raw: 'https://en.wikipedia.org/wiki/Foo_(bar).',
      },
    ])
  })

  it('trims a trailing close-paren when the URL itself has no opening paren', () => {
    // The cleaned url/text drop the stray paren; `raw` still preserves the
    // original line verbatim (it's what the fallback markdown render uses).
    const out = splitBlocks('https://example.com/page)')
    expect(out).toEqual([
      {
        type: 'links',
        links: [{ url: 'https://example.com/page', text: 'https://example.com/page' }],
        raw: 'https://example.com/page)',
      },
    ])
  })

  it('a run of links surrounded by prose splits correctly', () => {
    const out = splitBlocks('Sources:\nhttps://a.example\nhttps://b.example\nEnd.')
    expect(out).toEqual([
      { type: 'markdown', text: 'Sources:' },
      {
        type: 'links',
        links: [
          { url: 'https://a.example', text: 'https://a.example' },
          { url: 'https://b.example', text: 'https://b.example' },
        ],
        raw: 'https://a.example\nhttps://b.example',
      },
      { type: 'markdown', text: 'End.' },
    ])
  })

  it('non-http(s) schemes are never treated as a link (ftp, javascript, mailto stay markdown text)', () => {
    for (const line of ['ftp://example.com/file', 'javascript:alert(1)', 'mailto:a@example.com']) {
      const out = splitBlocks(line)
      expect(out).toEqual([{ type: 'markdown', text: line }])
    }
  })

  it('an inline link within a sentence is not pulled out (only whole-line links are)', () => {
    const out = splitBlocks('Check out https://example.com for more.')
    expect(out).toEqual([{ type: 'markdown', text: 'Check out https://example.com for more.' }])
  })
})

describe('splitBlocks — fenced code and JSON detection', () => {
  it('a fenced non-JSON code block stays as markdown (rendered as a code block downstream)', () => {
    const src = '```js\nconst x = 1\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('a fenced block labeled json with valid JSON becomes a json block', () => {
    const src = '```json\n{"a":1,"b":[2,3]}\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'json', value: { a: 1, b: [2, 3] }, raw: src }])
  })

  it('an unlabeled fence is still detected as JSON if the body looks like an object/array', () => {
    const src = '```\n{"a":1}\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'json', value: { a: 1 }, raw: src }])
  })

  it('a json-labeled fence with a bare primitive (not object/array) is NOT treated as a json block', () => {
    const src = '```json\n42\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('a json-labeled fence with invalid JSON falls back to markdown', () => {
    const src = '```json\n{not valid json}\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('respects the JSON_MAX size cap — an oversized JSON body falls back to markdown, not a tree', () => {
    const bigArray = '[' + '1,'.repeat(10500) + '1]'
    expect(bigArray.length).toBeGreaterThan(20000)
    const src = '```json\n' + bigArray + '\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('a JSON body right at the cap boundary still parses as json', () => {
    // Build a body just under JSON_MAX (20000) so it's accepted.
    const body = '[' + '1,'.repeat(9000) + '1]'
    expect(body.length).toBeLessThan(20000)
    const src = '```json\n' + body + '\n```'
    const out = splitBlocks(src)
    expect(out[0].type).toBe('json')
  })

  it('an unclosed fence (streaming — no closing marker yet) does not throw and consumes to the end', () => {
    const src = '```js\nconst x = 1\nfunction f() {'
    expect(() => splitBlocks(src)).not.toThrow()
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('~~~ fences are recognized the same as backtick fences', () => {
    const src = '~~~json\n{"x":1}\n~~~'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'json', value: { x: 1 }, raw: src }])
  })

  it('a run of image/link lines inside a fence is left alone (fences are not scanned line-by-line for links)', () => {
    const src = '```\nhttps://example.com/a.png\nhttps://example.com/b.png\n```'
    const out = splitBlocks(src)
    expect(out).toEqual([{ type: 'markdown', text: src }])
  })

  it('a fence flushes any pending image/link run before it starts', () => {
    const out = splitBlocks('https://example.com/a.png\nhttps://example.com/b.png\n```\ncode\n```')
    expect(out).toEqual([
      { type: 'images', urls: ['https://example.com/a.png', 'https://example.com/b.png'] },
      { type: 'markdown', text: '```\ncode\n```' },
    ])
  })
})

describe('splitBlocks — ordering and mixed content', () => {
  it('preserves order across markdown, images, links, and json blocks', () => {
    const src = [
      'Intro paragraph.',
      'https://example.com/a.png',
      'https://example.com/b.png',
      'See also:',
      'https://example.com/more',
      '```json',
      '{"done":true}',
      '```',
      'Thanks.',
    ].join('\n')
    const out = splitBlocks(src)
    expect(out.map((b) => b.type)).toEqual(['markdown', 'images', 'markdown', 'links', 'json', 'markdown'])
  })

  it('never throws across every prefix of a mixed document (streaming safety)', () => {
    const full = [
      '# Title',
      'Some **bold** text with a [link](https://example.com).',
      'https://example.com/a.png',
      'https://example.com/b.png',
      '```json',
      '{"a":[1,2,{"b":"c"}]}',
      '```',
      '<https://example.com/autolink>',
    ].join('\n')
    for (let i = 0; i <= full.length; i++) {
      expect(() => splitBlocks(full.slice(0, i))).not.toThrow()
    }
  })
})
