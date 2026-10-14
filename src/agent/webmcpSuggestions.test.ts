import { expect, it, vi } from 'vitest'
import { parseWebMcpSuggestions, generateWebMcpSuggestions } from './webmcpSuggestions'
vi.mock('ai', () => ({ generateText: vi.fn() }))
import { generateText } from 'ai'
it('keeps only bounded examples referring to known actions, deduplicated', () => {
  expect(parseWebMcpSuggestions(JSON.stringify([
    { prompt: 'Find tea', toolNames: ['search'] },
    { prompt: 'Find tea', toolNames: ['search'] },
    { prompt: 'Pay for tea', toolNames: ['pay'] },
    { prompt: 'x'.repeat(241), toolNames: ['search'] },
    { prompt: 'No tool', toolNames: [] }, null,
  ]), ['search'])).toEqual([{ prompt: 'Find tea', toolNames: ['search'] }])
})
it('sends only origin and action descriptions to the selected model, with cancellation and no tools', async () => {
  vi.mocked(generateText).mockResolvedValue({ text: '[]' } as any)
  const model = {} as any
  await generateWebMcpSuggestions(model, { url: 'https://example.com/private?token=secret', tools: [{ name: 'find', description: 'Find items', inputSchema: { secret: 'hidden' } }] }, new AbortController().signal)
  const call = vi.mocked(generateText).mock.calls[0][0]
  expect(call.model).toBe(model)
  expect(call.prompt).not.toContain('secret')
  expect(call.prompt).not.toContain('private')
  expect(call.tools).toBeUndefined()
  expect(call.abortSignal).toBeInstanceOf(AbortSignal)
})
