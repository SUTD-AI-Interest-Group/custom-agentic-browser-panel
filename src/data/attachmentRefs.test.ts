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
})

describe('hydrateHistory', () => {
  it('round-trips: resolve restores the original data', async () => {
    const original = [msg([filePart('data:application/pdf;base64,AAAA', 'a1')])]
    const out = await hydrateHistory(dehydrateHistory(original), async () => 'data:application/pdf;base64,AAAA')
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
      return 'd'
    })
    expect(seen).toEqual([{ id: 'a2', page: 7 }])
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
})
