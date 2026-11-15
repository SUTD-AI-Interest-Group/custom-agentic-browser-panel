import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ describe: vi.fn(), classify: vi.fn(), dispose: vi.fn() }))
vi.mock('./mirageEngine', () => ({ describeMirage: runtime.describe, classifyMirage: runtime.classify, disposeMirage: runtime.dispose }))
import { mirageMode, normalizeMirage, observeExpectedText, perceiveApprovedScreenshot } from './miragePerception'

const raw = { text: [{ string: 'Payment complete', score: 0.9, bbox: [10, 20, 90, 80] as [number, number, number, number] }], objects: [{ name: 'button', score: 0.8 }], reasoning: 'SECRET TRACE', form: { decision: 'click' } }
const output = () => ({ result: raw, timing: { loadMs: 1, inferenceMs: 2, totalMs: 3 }, heapBytes: 1024 })
let storage: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  storage = vi.fn().mockResolvedValue({ settings: { mirageMode: 'assist' } })
  vi.stubGlobal('chrome', { storage: { local: { get: storage } } })
  runtime.describe.mockResolvedValue(output())
})
afterEach(() => vi.unstubAllGlobals())

describe('local perception permission and privacy modes', () => {
  it.each([undefined, null, false, 'enabled', {}, 'off'])('unknown/off mode %j never starts inference', async (mode) => {
    storage.mockResolvedValue({ settings: { mirageMode: mode } })
    expect(mirageMode(mode)).toBe('off')
    expect(await perceiveApprovedScreenshot('image')).toBeUndefined()
    expect(runtime.describe).not.toHaveBeenCalled()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
  it('shadow mode returns timings without recognized text, boxes, forms or verification', async () => {
    storage.mockResolvedValue({ settings: { mirageMode: 'shadow' } })
    const result = await perceiveApprovedScreenshot('image', 'Payment complete')
    expect(result).toEqual({ mode: 'shadow', status: 'completed-locally', timing: output().timing, heapBytes: 1024 })
    expect(JSON.stringify(result)).not.toContain('Payment')
    expect(runtime.describe).toHaveBeenCalledWith('image')
  })
  it.each(['shadow', 'off'])('discards results when mode changes to %s during inference', async (mode) => {
    storage.mockResolvedValueOnce({ settings: { mirageMode: 'assist' } }).mockResolvedValueOnce({ settings: { mirageMode: mode } })
    expect(await perceiveApprovedScreenshot('image', 'Payment complete')).toBeUndefined()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
  it('assist exposes only bounded observations, with uncertainty and no generated reasoning', async () => {
    const result = await perceiveApprovedScreenshot('image', 'Payment complete')
    expect(result).toMatchObject({ mode: 'assist', status: 'observed', verification: { status: 'text-observed' } })
    expect(JSON.stringify(result)).not.toContain('SECRET TRACE')
    expect(result).not.toHaveProperty('form')
    expect(result).not.toHaveProperty('ok')
    expect(result?.warning).toContain('Untrusted')
  })
  it('contains model errors without leaking source text to the planner', async () => {
    runtime.describe.mockRejectedValue(new Error('SECRET PAGE CONTENT'))
    const result = await perceiveApprovedScreenshot('image')
    expect(result).toMatchObject({ status: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('SECRET PAGE CONTENT')
  })
  it('fails closed if settings cannot be read', async () => {
    storage.mockRejectedValue(new Error('Storage unavailable'))
    expect(await perceiveApprovedScreenshot('image')).toMatchObject({ status: 'unavailable' })
    expect(runtime.describe).not.toHaveBeenCalled()
  })
})

describe('untrusted visual output normalization', () => {
  it('reads the real Mirage string field and preserves valid xyxy boxes', () => {
    const result = normalizeMirage({ text: [{ string: 'Confirm changes', bbox: [50, 75, 425, 139], score: 0.696 }] })
    expect(result.text).toEqual([{ text: 'Confirm changes', bbox: [50, 75, 425, 139], score: 0.696 }])
    expect(normalizeMirage({ text: [{ text: 'invented schema', score: 0.9 }] }).text).toEqual([])
  })
  it.each([null, undefined, [], 'text', { text: {}, objects: false }])('handles malformed output %j', (raw) => {
    expect(normalizeMirage(raw)).toMatchObject({ text: [], objects: [] })
  })
  it('rejects missing/nonfinite/out-of-range/low confidences and invalid labels', () => {
    const text = [undefined, '0.9', NaN, Infinity, -1, 1.01, 0.49].map(score => ({ string: 'bad', score }))
    text.push({ string: '', score: 0.9 })
    expect(normalizeMirage({ text }).text).toEqual([])
  })
  it('drops invalid boxes without converting them into action indices', () => {
    const input = [[10, 20, 5, 30], [10, 20, 20, 15], [10, 20, 10, 30], [10, 20, 20, 20], [-1, 0, 10, 20], [0, 0, 1001, 20], [0, 0, NaN, 20], [1, 2], ['1', 2, 3, 4]]
    const result = normalizeMirage({ text: input.map(bbox => ({ string: 'okay', score: 0.8, bbox, index: 12 })) })
    expect(result.text.every(r => r.bbox === undefined)).toBe(true)
    expect(result.text.every(r => !('index' in r))).toBe(true)
  })
  it('caps output counts and label lengths, removes control characters', () => {
    const result = normalizeMirage({
      text: Array.from({ length: 100 }, () => ({ string: '\u0000' + 'a'.repeat(300), score: 0.9 })),
      objects: Array.from({ length: 100 }, () => ({ name: 'b'.repeat(300), score: 0.9 })),
    })
    expect(result.text).toHaveLength(32)
    expect(result.objects).toHaveLength(16)
    expect(result.text.every(r => r.text.length === 160 && !r.text.includes('\u0000'))).toBe(true)
    expect(result.objects.every(r => r.name.length === 160)).toBe(true)
  })
})

describe('post-action OCR observation is not success verification', () => {
  it('matches a whole OCR line with case/whitespace normalization', () => {
    expect(observeExpectedText([{ text: '  Payment   complete  ', score: 0.9 }], 'payment complete')).toMatchObject({ status: 'text-observed' })
  })
  it.each(['complete', '', 'Payment complete!', 'x'.repeat(161)])('does not turn an ambiguous expectation %j into success', (expected) => {
    expect(observeExpectedText(normalizeMirage(raw).text, expected).status).toBe('inconclusive')
  })
  it('never confirms a prefix truncated from longer OCR output', () => {
    const result = normalizeMirage({ text: [{ string: 'x'.repeat(161), score: 0.9 }] })
    expect(observeExpectedText(result.text, 'x'.repeat(160)).status).toBe('inconclusive')
  })
  it('does not infer failure from absent text or authorize a retry', () => {
    const result = observeExpectedText([], 'Payment complete')
    expect(result.status).toBe('inconclusive')
    expect(result.note).toContain('never repeat a committing action')
    expect(result).not.toHaveProperty('ok')
  })
})

describe('optional visual classification privacy and fallback', () => {
  const classifiedOutput = () => ({ result: { form: { screen_type: { value: 'dialog', probabilities: { dialog: 0.9, form: 0.04, document: 0.04, other: 0.02 } } } }, timing: { loadMs: 0, inferenceMs: 4, totalMs: 4 }, heapBytes: 1024 })
  const settings = (perception = 'assist', decision = 'assist') => ({ settings: { mirageMode: perception, mirageDecisionMode: decision } })
  beforeEach(() => { runtime.classify.mockResolvedValue(classifiedOutput()) })
  it('does not classify by default or when perception is off', async () => {
    await perceiveApprovedScreenshot('image')
    expect(runtime.classify).not.toHaveBeenCalled()
    storage.mockResolvedValue(settings('off', 'assist'))
    await perceiveApprovedScreenshot('image')
    expect(runtime.classify).not.toHaveBeenCalled()
  })
  it('runs a fixed second pass on the same approved image only after describe', async () => {
    storage.mockResolvedValue(settings())
    const result = await perceiveApprovedScreenshot('same-image', 'Payment complete')
    expect(runtime.describe).toHaveBeenCalledWith('same-image')
    expect(runtime.classify).toHaveBeenCalledWith('same-image')
    expect(runtime.describe.mock.invocationCallOrder[0]).toBeLessThan(runtime.classify.mock.invocationCallOrder[0])
    expect(result).toMatchObject({ decisionExperiment: { status: 'advisory', routingHint: { tool: 'ReadPage', mode: 'elements' } }, verification: { status: 'text-observed' } })
  })
  it.each([['shadow', 'assist'], ['assist', 'shadow'], ['shadow', 'shadow']])('does not reveal classification when perception=%s and decision=%s', async (perception, decision) => {
    storage.mockResolvedValue(settings(perception, decision))
    const result = await perceiveApprovedScreenshot('image')
    expect(result?.decisionExperiment).toEqual({ status: 'evaluated-locally', timing: classifiedOutput().timing, heapBytes: classifiedOutput().heapBytes })
    expect(JSON.stringify(result)).not.toContain('visualClass')
    expect(JSON.stringify(result)).not.toContain('routingHint')
    expect(JSON.stringify(result)).not.toContain('mirage-tuples')
    if (perception === 'shadow') expect(JSON.stringify(result)).not.toContain('Payment complete')
    else expect(result).toMatchObject({ observations: { text: [{ text: 'Payment complete' }] } })
  })
  it('preserves OCR and verification when classification fails, without leaking error text', async () => {
    storage.mockResolvedValue(settings())
    runtime.classify.mockRejectedValue(new Error('SECRET classifier input'))
    const result = await perceiveApprovedScreenshot('image', 'Payment complete')
    expect(result).toMatchObject({ status: 'observed', observations: { text: [{ text: 'Payment complete' }] }, verification: { status: 'text-observed' }, decisionExperiment: { status: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
  it('does not start classification after either setting changes during describe', async () => {
    storage.mockResolvedValueOnce(settings()).mockResolvedValue(settings('assist', 'off'))
    expect(await perceiveApprovedScreenshot('image')).toBeUndefined()
    expect(runtime.classify).not.toHaveBeenCalled()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
  it.each([false, true])('discards late classifier results after revocation (failure=%s)', async failure => {
    storage.mockResolvedValueOnce(settings()).mockResolvedValueOnce(settings()).mockResolvedValue(settings('assist', 'shadow'))
    if (failure) runtime.classify.mockRejectedValue(new Error('stopped'))
    expect(await perceiveApprovedScreenshot('image')).toBeUndefined()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
})
