import { describe, expect, it } from 'vitest'
import { mapCallResult, mapResourceResult } from './content'

const ctx = { server: 'linear', tool: 'get_chart' }
const png = 'iVBORw0KGgoAAAANSUhEUg=='

describe('mapCallResult', () => {
  it('concatenates text parts into the model value', () => {
    const r = mapCallResult(
      { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
      ctx,
    )
    expect(r.modelValue.text).toBe('hello\n\nworld')
    expect(r.images).toEqual([])
    expect(r.artifacts).toEqual([])
  })

  it('truncates text over the budget with an explicit note', () => {
    const r = mapCallResult({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] }, { ...ctx, maxChars: 1000 })
    expect((r.modelValue.text as string).length).toBeLessThanOrEqual(1000)
    expect(r.modelValue.note).toMatch(/truncated/i)
  })

  it('passes structuredContent through as structured JSON', () => {
    const r = mapCallResult({ content: [], structuredContent: { a: 1 } }, ctx)
    expect(r.modelValue.structured).toEqual({ a: 1 })
  })

  it('budgets an oversized structuredContent instead of passing it through unbounded (F4)', () => {
    const big = { items: Array.from({ length: 5_000 }, (_, i) => ({ id: i, name: 'x'.repeat(20) })) }
    const r = mapCallResult({ content: [], structuredContent: big }, { ...ctx, maxChars: 1000 })
    expect(typeof r.modelValue.structured).toBe('string')
    expect((r.modelValue.structured as string).length).toBeLessThanOrEqual(1000)
    expect(r.modelValue.note).toMatch(/structured/i)
  })

  it('caps an unbounded resourceLinks array with a "+more" note instead of passing all of it (F4)', () => {
    const links = Array.from({ length: 10_000 }, (_, i) => ({ type: 'resource_link', uri: `file:///${i}` }))
    const r = mapCallResult({ content: links }, ctx)
    const shown = r.modelValue.resourceLinks as unknown[]
    expect(shown.length).toBeLessThan(10_000)
    expect(r.modelValue.note).toMatch(/resource/i)
  })

  it('routes an image to the queue AND an artifact, with a no-marks caption', () => {
    const r = mapCallResult({ content: [{ type: 'image', data: png, mimeType: 'image/png' }] }, ctx)
    expect(r.images).toHaveLength(1)
    expect(r.images[0].dataUrl).toBe(`data:image/png;base64,${png}`)
    expect(r.images[0].caption).toContain('linear')
    expect(r.images[0].caption).toContain('get_chart')
    expect(r.images[0].caption).toMatch(/no numbered/i)
    expect(r.artifacts).toHaveLength(1)
    expect(r.artifacts[0].kind).toBe('image')
    expect(r.modelValue.note).toMatch(/image/i)
  })

  it('routes audio to an artifact only, with a model note', () => {
    const r = mapCallResult({ content: [{ type: 'audio', data: png, mimeType: 'audio/mpeg' }] }, ctx)
    expect(r.images).toEqual([])
    expect(r.artifacts).toHaveLength(1)
    expect(r.artifacts[0].kind).toBe('audio')
    expect(r.artifacts[0].dataUrl).toBe(`data:audio/mpeg;base64,${png}`)
    expect(r.modelValue.note).toMatch(/audio/i)
  })

  it('folds embedded text resources into the text budget', () => {
    const r = mapCallResult(
      {
        content: [
          { type: 'resource', resource: { uri: 'file:///a.md', mimeType: 'text/markdown', text: 'doc body' } },
        ],
      },
      ctx,
    )
    expect(r.modelValue.text).toContain('doc body')
    expect(r.modelValue.text).toContain('file:///a.md')
  })

  it('classifies embedded blob resources by mime type', () => {
    const mk = (mimeType: string) =>
      mapCallResult({ content: [{ type: 'resource', resource: { uri: 'u', mimeType, blob: png } }] }, ctx)
    expect(mk('video/mp4').artifacts[0].kind).toBe('video')
    expect(mk('audio/wav').artifacts[0].kind).toBe('audio')
    expect(mk('image/jpeg').artifacts[0].kind).toBe('image')
    expect(mk('text/html').artifacts[0].kind).toBe('html')
    expect(mk('application/octet-stream').artifacts[0].kind).toBe('blob')
  })

  it('decodes an embedded html blob into html text', () => {
    const html = '<h1>hi</h1>'
    const b64 = btoa(html)
    const r = mapCallResult(
      { content: [{ type: 'resource', resource: { uri: 'u', mimeType: 'text/html', blob: b64 } }] },
      ctx,
    )
    expect(r.artifacts[0].kind).toBe('html')
    expect(r.artifacts[0].text).toBe(html)
  })

  it('lists resource_link parts for the model', () => {
    const r = mapCallResult(
      { content: [{ type: 'resource_link', uri: 'https://x/y', name: 'Y', mimeType: 'text/plain' }] },
      ctx,
    )
    expect(JSON.stringify(r.modelValue.resourceLinks)).toContain('https://x/y')
  })

  it('surfaces isError as an error the model can self-correct on', () => {
    const r = mapCallResult({ content: [{ type: 'text', text: 'boom' }], isError: true }, ctx)
    expect(r.modelValue.error).toContain('boom')
    expect(r.modelValue.text).toBeUndefined()
  })

  it('handles empty content gracefully', () => {
    const r = mapCallResult({ content: [] }, ctx)
    expect(r.modelValue.note).toMatch(/no content/i)
  })

  it('does not split a UTF-16 surrogate pair at the truncation boundary (F5)', () => {
    // Mirrors content.ts's own note-length math so the emoji's high surrogate
    // lands exactly on the cut boundary — the shape that leaves a lone
    // surrogate in modelValue.text (src/agent/attachmentPlan.ts has the same
    // class of bug, fixed the same way).
    const maxChars = 100
    const totalLen = maxChars + 50
    const note = ` [truncated: ${totalLen - maxChars} more characters]`
    const cutIndex = maxChars - note.length
    const fillerBefore = 'a'.repeat(cutIndex - 1)
    const emoji = '\u{1F600}'
    const fillerAfter = 'b'.repeat(totalLen - fillerBefore.length - emoji.length)
    const text = fillerBefore + emoji + fillerAfter
    const r = mapCallResult({ content: [{ type: 'text', text }] }, { ...ctx, maxChars })
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.modelValue.text as string)).toBe(false)
  })

  it('notes an unrecognized content-part type instead of claiming no content (F6)', () => {
    const r = mapCallResult({ content: [{ type: 'some_future_type', foo: 1 }] }, ctx)
    expect(r.modelValue.note).not.toMatch(/no content/i)
    expect(r.modelValue.note).toMatch(/unsupported|unrecognized/i)
  })

  it('still reports no content when there truly is none (no unrecognized parts to explain it)', () => {
    const r = mapCallResult({ content: [] }, ctx)
    expect(r.modelValue.note).toMatch(/no content/i)
  })
})

describe('mapResourceResult', () => {
  it('maps text contents into model text', () => {
    const r = mapResourceResult(
      { contents: [{ uri: 'file:///a.md', mimeType: 'text/markdown', text: 'body' }] },
      { server: 's' },
    )
    expect(r.modelValue.text).toContain('body')
    expect(r.artifacts).toEqual([])
  })

  it('maps binary contents by mime, images also to the queue', () => {
    const r = mapResourceResult(
      { contents: [{ uri: 'u', mimeType: 'image/png', blob: png }] },
      { server: 's' },
    )
    expect(r.images).toHaveLength(1)
    expect(r.artifacts[0].kind).toBe('image')
  })

  it('does not split a UTF-16 surrogate pair at the truncation boundary (F5)', () => {
    const maxChars = 100
    const totalLen = maxChars + 50
    const note = ` [truncated: ${totalLen - maxChars} more characters]`
    const cutIndex = maxChars - note.length
    const fillerBefore = 'a'.repeat(cutIndex - 1)
    const emoji = '\u{1F600}'
    const fillerAfter = 'b'.repeat(totalLen - fillerBefore.length - emoji.length)
    const text = fillerBefore + emoji + fillerAfter
    // uri left empty: a non-empty uri prefixes `[uri]\n` onto the text, which
    // would shift the emoji off the cut boundary this test deliberately targets.
    const r = mapResourceResult({ contents: [{ uri: '', text }] }, { server: 's', maxChars })
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.modelValue.text as string)).toBe(false)
  })
})
