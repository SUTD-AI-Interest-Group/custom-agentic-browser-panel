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
})
