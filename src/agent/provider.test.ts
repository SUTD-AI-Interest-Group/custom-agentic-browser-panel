import { test, expect, afterEach, vi } from 'vitest'
import { generateText, type Instructions } from 'ai'
import { reasoningBodyTransform, createModel } from './provider'
import { LYCHEE_PROVIDER_OPTIONS_NS } from './agent'
import { profileFor } from '../data/providerProfiles'
import type { ProviderConfig } from '../data/settings'

test('leaves a non-reasoning model with no effort untouched (same ref)', () => {
  const transform = reasoningBodyTransform(profileFor('custom'), undefined, false)
  const body = { model: 'gpt-4o', messages: [] }
  expect(transform(body)).toBe(body)
})

test('a reasoning model with unset effort sends nothing extra', () => {
  const transform = reasoningBodyTransform(profileFor('ollama'), undefined, true)
  expect(transform({ model: 'qwen3', tools: [{}] })).toEqual({ model: 'qwen3', tools: [{}] })
})

test('injects a set reasoning_effort for a compatible reasoning model', () => {
  const transform = reasoningBodyTransform(profileFor('ollama'), 'low', true)
  expect(transform({ model: 'qwen3', tools: [{}] })).toEqual({
    model: 'qwen3',
    tools: [{}],
    reasoning_effort: 'low',
  })
})

test('Groq gets reasoning_format:parsed when tools ride along, even with no effort', () => {
  const transform = reasoningBodyTransform(profileFor('groq'), undefined, true)
  expect(transform({ model: 'deepseek-r1-distill-qwen-32b', tools: [{}] })).toEqual({
    model: 'deepseek-r1-distill-qwen-32b',
    tools: [{}],
    reasoning_format: 'parsed',
  })
})

test('Groq omits reasoning_format when the turn carries no tools', () => {
  const transform = reasoningBodyTransform(profileFor('groq'), 'high', true)
  expect(transform({ model: 'deepseek-r1-distill-qwen-32b' })).toEqual({
    model: 'deepseek-r1-distill-qwen-32b',
    reasoning_effort: 'high',
  })
})

test('OpenRouter sends the reasoning object, never a bare reasoning_effort', () => {
  const transform = reasoningBodyTransform(profileFor('openrouter'), 'high', true)
  const out = transform({ model: 'openai/gpt-5', tools: [{}] })
  expect(out).toMatchObject({ reasoning: { effort: 'high' } })
  expect(out).not.toHaveProperty('reasoning_effort')
})

// d01 F1: `effort` resolves from a provider-wide default independently of
// whether the CURRENT model is a reasoning model — a user who sets the
// Providers tab's "Reasoning effort" dropdown while on a reasoning model, then
// switches to (or titleModel/dreamModel independently resolves to) a plain
// model on the SAME provider, leaves `effort` defined even though `reasoning`
// is correctly false for the new model. The gate must not let that stale
// effort inject reasoning fields into a request for a model explicitly
// classified non-reasoning — Groq 400s outright on an unsupported field.
for (const kind of ['groq', 'ollama', 'openrouter', 'lmstudio', 'custom'] as const) {
  test(`a non-reasoning model on ${kind} with a stale/leftover effort is left untouched`, () => {
    const transform = reasoningBodyTransform(profileFor(kind), 'high', false)
    const body = { model: 'plain-non-reasoning-model', tools: [{}] }
    expect(transform(body)).toEqual(body)
  })
}

// ---------------------------------------------------------------------------
// Prompt caching: assert the ACTUAL WIRE SHAPE `createModel` produces, by
// intercepting the real global `fetch` the AI SDK provider factories fall
// back to when no override is given (createOpenAI/createAnthropic/
// createOpenAICompatible all read `fetch ?? globalThis.fetch`). This is one
// level below MockLanguageModelV3 (used elsewhere in this repo, e.g.
// toolNames.test.ts): that mock stands in for the whole LanguageModel and
// never touches the adapter's own request-serialization code at all, so it
// cannot prove anything about what actually reaches the wire — only this
// fetch-boundary intercept can. The stubbed response never needs to satisfy
// the adapter's own response schema: the request body is captured before
// generateText gets a chance to (possibly unsuccessfully) parse it.
afterEach(() => {
  vi.unstubAllGlobals()
})

const DEFAULT_TEST_SYSTEM = 'You are a helpful test assistant with a long, mostly-stable system prompt.'

/** Builds the SAME `instructions` shape runAgentTurn's `toInstructions`
 *  produces for a {stable, volatile} AgentSystemPrompt — one combined
 *  SystemModelMessage tagged with the lychee length hint. Kept independent of
 *  agent.ts's own function (imports only the shared namespace constant) so
 *  this test proves the WIRE outcome against the documented CONTRACT, not
 *  against whatever agent.ts happens to currently do internally.
 */
function splitSystemInstructions(stable: string, volatile: string): Instructions {
  return {
    role: 'system',
    content: stable + volatile,
    providerOptions: volatile ? { [LYCHEE_PROVIDER_OPTIONS_NS]: { volatileSystemLength: volatile.length } } : undefined,
  }
}

async function captureRequestBody(
  config: ProviderConfig,
  modelId: string,
  system: Instructions = DEFAULT_TEST_SYSTEM,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    await generateText({
      model: createModel(config, modelId),
      instructions: system,
      prompt: 'Say hi.',
    })
  } catch {
    // Expected — the stub response above is not a valid provider response, so
    // the adapter throws parsing it. `captured` was already set beforehand.
  }
  if (!captured) throw new Error('fetch was never called — createModel/generateText did not reach the wire')
  return captured
}

const ANTHROPIC_CONFIG: ProviderConfig = {
  id: 'p', name: 'Anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-test', kind: 'anthropic', models: [],
}
const OPENAI_CONFIG: ProviderConfig = {
  id: 'p', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', kind: 'openai', models: [],
}
const CUSTOM_CONFIG: ProviderConfig = {
  id: 'p', name: 'Custom', baseURL: 'https://example.test/v1', apiKey: 'sk-test', kind: 'custom', models: [],
}

test('Anthropic, plain-string system (research.ts\'s shape): the whole thing is one cache_control breakpoint', async () => {
  const body = await captureRequestBody(ANTHROPIC_CONFIG, 'claude-opus-5')
  const system = body.system as Array<{ type: string; text: string; cache_control?: unknown }>
  expect(Array.isArray(system)).toBe(true)
  expect(system).toHaveLength(1)
  expect(system[0].text).toBe(DEFAULT_TEST_SYSTEM)
  expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
})

// The property the split exists for: Anthropic's cache is a byte-for-byte
// match with no partial credit inside a marked block, so before this split
// (or on a plain-string call) ANY change anywhere — including in content
// that changes every turn — misses the WHOLE marked unit. This asserts the
// wire actually reflects the split: two separate system blocks, marker on
// the first (stable) one only, second (volatile) one unmarked.
test('Anthropic, structured {stable, volatile} system: TWO wire blocks, marker on the stable one only', async () => {
  const stable = 'STABLE PREFIX (systemPrompt + disclosure + skills catalog)'
  const volatile = '\n\nVOLATILE SUFFIX (recalled memories this turn)'
  const body = await captureRequestBody(ANTHROPIC_CONFIG, 'claude-opus-5', splitSystemInstructions(stable, volatile))
  const system = body.system as Array<{ type: string; text: string; cache_control?: unknown }>
  expect(Array.isArray(system)).toBe(true)
  expect(system).toHaveLength(2)
  expect(system[0].text).toBe(stable)
  expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(system[1].text).toBe(volatile)
  expect(system[1].cache_control).toBeUndefined()
  // The app-internal hint must never reach the wire — it's read and consumed
  // by withCacheControl, not forwarded.
  expect(JSON.stringify(body)).not.toContain('volatileSystemLength')
  expect(JSON.stringify(body)).not.toContain(LYCHEE_PROVIDER_OPTIONS_NS)
})

// The property that makes the split actually pay off: the marked (stable)
// block is BYTE-IDENTICAL across two calls whose volatile half differs —
// verified at the wire level, not on assembleSystemPrompt's/splitSystemPrompt's
// own return value (a helper returning the right object proves nothing about
// what a provider adapter does with it).
test('Anthropic: the stable wire block is byte-identical across two calls with different volatile content', async () => {
  const stable = 'STABLE PREFIX — identical both times'
  const bodyA = await captureRequestBody(ANTHROPIC_CONFIG, 'claude-opus-5', splitSystemInstructions(stable, '\n\nTURN 1 MEMORY'))
  const bodyB = await captureRequestBody(ANTHROPIC_CONFIG, 'claude-opus-5', splitSystemInstructions(stable, '\n\nTURN 2 COMPLETELY DIFFERENT MEMORY AND SKILL'))
  const systemA = bodyA.system as Array<{ text: string; cache_control?: unknown }>
  const systemB = bodyB.system as Array<{ text: string; cache_control?: unknown }>
  expect(systemA[0]).toEqual(systemB[0]) // same text AND same cache_control marker
  expect(systemA[1].text).not.toBe(systemB[1].text) // sanity: the volatile halves actually differed
})

test('OpenAI native (Responses API): a structured system collapses to ONE combined string — no split, no cache_control, no lychee leak', async () => {
  const stable = 'STABLE PART'
  const volatile = '\n\nVOLATILE PART'
  const body = await captureRequestBody(OPENAI_CONFIG, 'gpt-5.1', splitSystemInstructions(stable, volatile))
  expect(JSON.stringify(body)).not.toContain('cache_control')
  expect(JSON.stringify(body)).not.toContain('volatileSystemLength')
  expect(JSON.stringify(body)).not.toContain(LYCHEE_PROVIDER_OPTIONS_NS)
  // The combined text must still reach the model, unsplit — same content as
  // before the split existed, just via the Responses API's own field names
  // (`input`, `role: 'developer'` for the system turn).
  const input = body.input as Array<{ role: string; content: string }>
  const devMsgs = input.filter((m) => m.role === 'developer')
  expect(devMsgs).toHaveLength(1)
  expect(devMsgs[0].content).toBe(stable + volatile)
})

test('OpenAI-compatible (custom endpoint): a structured system collapses to ONE combined string — no split, no cache_control, no lychee leak', async () => {
  const stable = 'STABLE PART'
  const volatile = '\n\nVOLATILE PART'
  const body = await captureRequestBody(CUSTOM_CONFIG, 'some-custom-model', splitSystemInstructions(stable, volatile))
  expect(JSON.stringify(body)).not.toContain('cache_control')
  expect(JSON.stringify(body)).not.toContain('volatileSystemLength')
  expect(JSON.stringify(body)).not.toContain(LYCHEE_PROVIDER_OPTIONS_NS)
  const messages = body.messages as Array<{ role: string; content: string }>
  const systemMsgs = messages.filter((m) => m.role === 'system')
  expect(systemMsgs).toHaveLength(1)
  expect(systemMsgs[0].content).toBe(stable + volatile)
})

// A reasoning-off, non-Anthropic-kind call still shares createModel's
// `withReasoningOptions` middleware plumbing — confirm wrapping that path
// doesn't accidentally also wrap in withCacheControl (i.e. the gate really is
// `profile.supportsPromptCaching`, not "any wrapped model").
test('Groq (compatible, reasoning model): no cache_control even though reasoning fields ARE on the wire', async () => {
  const config: ProviderConfig = {
    id: 'p', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: 'sk-test', kind: 'groq', models: [],
    reasoningEffort: 'high',
  }
  const body = await captureRequestBody(config, 'deepseek-r1-distill-qwen-32b')
  // Sanity: this call DOES carry provider-specific injection (proves the fetch
  // intercept is exercising a real request, not silently short-circuiting).
  // reasoning_format specifically needs `tools` on the call (see
  // reasoningBodyTransform) — this call has none, so reasoning_effort is the
  // field that's unconditionally present for a detected reasoning model.
  expect(body.reasoning_effort).toBe('high')
  expect(JSON.stringify(body)).not.toContain('cache_control')
})
