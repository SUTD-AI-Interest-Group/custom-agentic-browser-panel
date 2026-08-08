import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { dehydrateHistory, hydrateHistory, lycheeProviderOptions, type AttachmentRef } from './attachmentRefs'

const filePart = (data: string, id?: string, page?: number) => ({
  type: 'file' as const,
  mediaType: 'application/pdf',
  data,
  ...(id ? { providerOptions: lycheeProviderOptions({ id, page }) } : {}),
})
const msg = (parts: unknown[]): ModelMessage => ({ role: 'user', content: parts as never })
const partsOf = (m: ModelMessage) => m.content as never as { type: string; data?: string; text?: string }[]

describe('dehydrateHistory', () => {
  it('swaps tagged file-part data for a sentinel, leaves untagged parts alone', () => {
    const history = [
      msg([
        filePart('data:application/pdf;base64,AAAA', 'a1'),
        filePart('data:image/png;base64,BBBB'),
        { type: 'text', text: 'hi' },
      ]),
    ]
    const out = dehydrateHistory(history)
    const parts = partsOf(out[0])
    expect(parts[0].data).toBe('lychee-attachment:a1')
    expect(parts[1].data).toBe('data:image/png;base64,BBBB')
    expect(parts[2].text).toBe('hi')
    // the live history must not be mutated by a persistence pass
    expect(partsOf(history[0])[0].data).toContain('base64')
  })

  it('encodes a page ref', () => {
    const out = dehydrateHistory([msg([filePart('data:image/png;base64,CCCC', 'a2', 3)])])
    expect(partsOf(out[0])[0].data).toBe('lychee-attachment:a2#page=3')
  })

  it('passes string-content and assistant messages through untouched', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'reply' },
    ]
    expect(dehydrateHistory(history)).toEqual(history)
  })

  it('is idempotent — dehydrating an already-dehydrated history is a no-op', () => {
    // refOfPart keys off providerOptions.lychee, never off the current `data`
    // string, so a second pass must not try to re-sentinel the sentinel.
    const once = dehydrateHistory([msg([filePart('data:application/pdf;base64,AAAA', 'a1')])])
    const twice = dehydrateHistory(once)
    expect(partsOf(twice[0])[0].data).toBe('lychee-attachment:a1')
    expect(twice).toEqual(once)
  })
})

describe('hydrateHistory', () => {
  it('round-trips: resolve restores the original data', async () => {
    const original = [msg([filePart('data:application/pdf;base64,AAAA', 'a1')])]
    const out = await hydrateHistory(dehydrateHistory(original), async () => ({
      data: 'data:application/pdf;base64,AAAA',
    }))
    expect(partsOf(out[0])[0].data).toBe('data:application/pdf;base64,AAAA')
    expect(partsOf(out[0])[0].type).toBe('file')
  })

  it('replaces an unresolvable ref with an explanatory text part', async () => {
    const out = await hydrateHistory(
      dehydrateHistory([msg([filePart('data:application/pdf;base64,AAAA', 'gone')])]),
      async () => null,
    )
    const part = partsOf(out[0])[0]
    expect(part.type).toBe('text')
    expect(part.text).toContain('no longer available')
  })

  it('parses page refs back out for the resolver', async () => {
    const seen: AttachmentRef[] = []
    await hydrateHistory(dehydrateHistory([msg([filePart('d', 'a2', 7)])]), async (ref) => {
      seen.push(ref)
      return { data: 'd' }
    })
    expect(seen).toEqual([{ id: 'a2', page: 7 }])
  })

  it('passes the part\'s mediaType to the resolver, so it can tell a native-pdf part from an ordinary image', async () => {
    const seen: (string | undefined)[] = []
    const history = [
      msg([
        filePart('d', 'a1'),
        { ...filePart('d', 'a2'), mediaType: 'image' },
      ]),
    ]
    await hydrateHistory(dehydrateHistory(history), async (_ref, mediaType) => {
      seen.push(mediaType)
      return { data: 'd' }
    })
    expect(seen).toEqual(['application/pdf', 'image'])
  })

  it('leaves non-sentinel messages untouched without calling the resolver', async () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'plain' },
      msg([filePart('data:image/png;base64,BBBB'), { type: 'text', text: 'hi' }]),
    ]
    const out = await hydrateHistory(history, async () => {
      throw new Error('must not be called')
    })
    expect(out).toEqual(history)
  })

  it('resolves some refs and reports others missing within the same message', async () => {
    // The exact shape a pdf-pages-routed multi-page attachment produces: many
    // file parts in one message, tagged with different attachment ids.
    const history = [
      msg([
        filePart('d', 'ok', 1),
        filePart('d', 'gone', 2),
        filePart('d', 'ok', 3),
      ]),
    ]
    const out = await hydrateHistory(dehydrateHistory(history), async (ref) =>
      ref.id === 'ok' ? { data: `data:application/pdf;base64,PAGE${ref.page}` } : null,
    )
    const parts = partsOf(out[0])
    expect(parts[0]).toMatchObject({ type: 'file', data: 'data:application/pdf;base64,PAGE1' })
    expect(parts[1]).toMatchObject({ type: 'text' })
    expect(parts[1].text).toContain('no longer available')
    expect(parts[2]).toMatchObject({ type: 'file', data: 'data:application/pdf;base64,PAGE3' })
  })

  it('treats a sentinel with a non-numeric page suffix as a plain (pageless) ref', async () => {
    const seen: AttachmentRef[] = []
    const history: ModelMessage[] = [msg([{ type: 'file', mediaType: 'application/pdf', data: 'lychee-attachment:abc#page=xyz' }])]
    await hydrateHistory(history, async (ref) => {
      seen.push(ref)
      return { data: 'd' }
    })
    expect(seen).toEqual([{ id: 'abc' }])
  })

  it('splices a `replace` result\'s parts into the message in place of the original — one part becomes many', async () => {
    // The shape a re-planned native-pdf-turned-incompatible part produces: a
    // leading caption plus one file part per rendered page.
    const history = [msg([{ type: 'text', text: 'before' }, filePart('d', 'a1'), { type: 'text', text: 'after' }])]
    const out = await hydrateHistory(dehydrateHistory(history), async () => ({
      replace: [
        { type: 'text' as const, text: 'caption' },
        { type: 'file' as const, mediaType: 'image', data: 'data:image/png;base64,P1' },
        { type: 'file' as const, mediaType: 'image', data: 'data:image/png;base64,P2' },
      ],
    }))
    const parts = partsOf(out[0])
    expect(parts).toHaveLength(5)
    expect(parts[0]).toMatchObject({ type: 'text', text: 'before' })
    expect(parts[1]).toMatchObject({ type: 'text', text: 'caption' })
    expect(parts[2]).toMatchObject({ type: 'file', data: 'data:image/png;base64,P1' })
    expect(parts[3]).toMatchObject({ type: 'file', data: 'data:image/png;base64,P2' })
    expect(parts[4]).toMatchObject({ type: 'text', text: 'after' })
  })

  it('a `replace` result can also collapse a part down to a single text part', async () => {
    const history = [msg([filePart('d', 'a1')])]
    const out = await hydrateHistory(dehydrateHistory(history), async () => ({
      replace: [{ type: 'text' as const, text: 'extracted text instead' }],
    }))
    const parts = partsOf(out[0])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'text', text: 'extracted text instead' })
  })
})
