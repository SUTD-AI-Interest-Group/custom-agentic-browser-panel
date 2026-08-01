import { expect, test } from 'vitest'
import { instrumentToolset } from './instrumentTools'
import type { Span, SpanEnd, SpanOptions, Trace } from './types'

// instrumentToolset wraps every tool's execute() as a Langfuse span. Two
// properties matter more than the mechanics: (1) ordering — a span must
// never carry argument content the user never approved (hardening audit
// d03 F5's second half: today's code calls trace.span({input}) BEFORE the
// wrapped tool's own requestApproval gate resolves, so a denied call's raw
// arguments are queued for transmission regardless), and (2) instrumentation
// can never affect the tool's real result, success or failure.

interface RecordedSpan {
  opts: SpanOptions
  ended?: SpanEnd
}

/** A fake Trace that records every span() call/end() instead of posting anywhere. */
function fakeTrace(): { trace: Trace; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  const trace: Trace = {
    id: 'trace-1',
    generation: () => {
      throw new Error('not used by instrumentToolset')
    },
    span: (opts: SpanOptions): Span => {
      const rec: RecordedSpan = { opts }
      spans.push(rec)
      return {
        id: `span-${spans.length}`,
        end: (o: SpanEnd = {}) => {
          rec.ended = o
        },
      }
    },
    event: () => {},
    update: () => {},
    end: () => {},
  }
  return { trace, spans }
}

/** A Trace whose span() always throws — simulates an observability-side bug. */
function throwingTrace(): Trace {
  return {
    id: 'trace-1',
    generation: () => {
      throw new Error('not used')
    },
    span: () => {
      throw new Error('observability boom')
    },
    event: () => {},
    update: () => {},
    end: () => {},
  }
}

const CARD = '4111111111111111'

// --- ordering: no span before the tool's own approval gate resolves --------

test('does not create the span until the wrapped tool call has resolved', async () => {
  const { trace, spans } = fakeTrace()
  let resolveExecute: (v: unknown) => void = () => {}
  const pending = new Promise((resolve) => {
    resolveExecute = resolve
  })
  const tools: any = { Slow: { execute: async () => pending } }
  instrumentToolset(tools, trace)

  const callPromise = tools.Slow.execute({ secret: 'x' }, {})
  // Let any queued microtasks run without resolving the tool's own promise —
  // if a span were created up front (the pre-fix behavior), it would exist
  // here already.
  await Promise.resolve()
  await Promise.resolve()
  expect(spans).toHaveLength(0)

  resolveExecute({ ok: true })
  await callPromise
  expect(spans).toHaveLength(1)
})

test('a denied call carries no argument content in the span input, even for AutofillForm-shaped args', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    AutofillForm: {
      execute: async () => ({ denied: true, message: 'The user denied permission for this tool call.' }),
    },
  }
  instrumentToolset(tools, trace)

  await tools.AutofillForm.execute(
    { fields: [{ index: 0, value: CARD, sensitive: true }] },
    {},
  )

  expect(spans).toHaveLength(1)
  expect(JSON.stringify(spans[0].opts.input)).not.toContain(CARD)
  expect(spans[0].ended?.metadata?.approved).toBe(false)
})

test('an approved call still redacts sensitive input/output fields (defense in depth against an incomplete deny check)', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    AutofillForm: {
      // AutofillForm's real execute() never returns a top-level `denied`
      // flag even when a per-field approval is declined (tools.ts just
      // `continue`s past that field) — redaction must not depend on the
      // denial marker being present to protect a card/password value.
      execute: async ({ fields }: any) => ({ filled: fields.map((f: any) => f.index), note: 'Filled 1 field(s) from profile.' }),
    },
  }
  instrumentToolset(tools, trace)

  await tools.AutofillForm.execute({ fields: [{ index: 0, value: CARD, sensitive: true }] }, {})

  expect(spans).toHaveLength(1)
  expect(JSON.stringify(spans[0].opts.input)).not.toContain(CARD)
})

test('redacts a secret an error message echoes back, without altering the real rethrown error', async () => {
  const { trace, spans } = fakeTrace()
  const originalMessage = 'Invalid card 4111 1111 1111 1111 — declined'
  const tools: any = {
    Boom: {
      execute: async () => {
        throw new Error(originalMessage)
      },
    },
  }
  instrumentToolset(tools, trace)

  // The AGENT LOOP needs the real, unmodified error — only the reported
  // statusMessage sent to observability should be scrubbed.
  await expect(tools.Boom.execute({}, {})).rejects.toThrow(originalMessage)

  expect(spans).toHaveLength(1)
  expect(spans[0].ended?.level).toBe('ERROR')
  expect(spans[0].ended?.statusMessage).not.toContain('4111')
  expect(spans[0].ended?.statusMessage).toContain('declined')
})

// --- never breaks a turn -----------------------------------------------------

test('never breaks a turn: a throwing trace.span() does not affect the tool real return value', async () => {
  const trace = throwingTrace()
  const tools: any = { Real: { execute: async () => ({ ok: true, value: 42 }) } }
  instrumentToolset(tools, trace)

  const result = await tools.Real.execute({}, {})
  expect(result).toEqual({ ok: true, value: 42 })
})

test('never breaks a turn: a throwing trace.span() still rethrows the tool\'s REAL error unmodified', async () => {
  const trace = throwingTrace()
  const tools: any = {
    Boom: {
      execute: async () => {
        throw new Error('real tool failure')
      },
    },
  }
  instrumentToolset(tools, trace)

  await expect(tools.Boom.execute({}, {})).rejects.toThrow('real tool failure')
})

// --- S6 (final security review): input redaction must not depend on the
// model's own `sensitive` claim -----------------------------------------
//
// AutofillForm/ControlPage's `sensitive` schema field is set by the MODEL,
// not cross-checked here against the DOM ground truth that actually gates
// their approval card (domIndex.ts's SENSITIVE_RE / pageControl.ts's
// isPointOfNoReturn). An omitted or falsely-`false` flag on a real
// password/card field must still redact — see redact.ts's
// redactKnownRiskyToolInput, which instrumentToolset now opts into by name.

test('S6: AutofillForm span input never carries the real value when the model OMITS the sensitive flag on a real password field', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    AutofillForm: {
      execute: async ({ fields }: any) => ({
        filled: fields.map((f: any) => f.index),
        note: 'Filled 1 field(s) from profile.',
      }),
    },
  }
  instrumentToolset(tools, trace)

  // No `sensitive` key at all — an ordinary model omission.
  await tools.AutofillForm.execute({ fields: [{ index: 0, value: 'hunter2hunter2' }] }, {})

  expect(spans).toHaveLength(1)
  expect(JSON.stringify(spans[0].opts.input)).not.toContain('hunter2hunter2')
})

test('S6: AutofillForm span input never carries the real value when the model FALSELY marks a real password field non-sensitive', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    AutofillForm: {
      execute: async ({ fields }: any) => ({
        filled: fields.map((f: any) => f.index),
        note: 'Filled 1 field(s) from profile.',
      }),
    },
  }
  instrumentToolset(tools, trace)

  await tools.AutofillForm.execute(
    { fields: [{ index: 2, value: 'hunter2hunter2', sensitive: false }] },
    {},
  )

  expect(spans).toHaveLength(1)
  expect(JSON.stringify(spans[0].opts.input)).not.toContain('hunter2hunter2')
})

test('S6: ControlPage span input never carries typed text when the model omits/falsifies sensitive', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    ControlPage: {
      execute: async () => ({ ok: true, message: 'Typed.', urlChanged: false, elements: '(registry)' }),
    },
  }
  instrumentToolset(tools, trace)

  await tools.ControlPage.execute(
    { action: 'type', index: 3, text: 'hunter2hunter2', clear: true, sensitive: false },
    {},
  )

  expect(spans).toHaveLength(1)
  expect(JSON.stringify(spans[0].opts.input)).not.toContain('hunter2hunter2')
})

test('S6: a tool NOT named AutofillForm/ControlPage is unaffected — generic nets only, no behavior change', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = {
    SomeOtherTool: { execute: async () => ({ ok: true }) },
  }
  instrumentToolset(tools, trace)

  await tools.SomeOtherTool.execute({ fields: [{ index: 0, value: 'John Smith', sensitive: false }] }, {})

  expect(spans).toHaveLength(1)
  // Not card-shaped, not high-entropy, no sensitive-key name, flag is false —
  // nothing about this shape is special to a tool the S6 fix doesn't name.
  expect(JSON.stringify(spans[0].opts.input)).toContain('John Smith')
})

// --- passthrough / structural -----------------------------------------------

test('leaves a tool with no execute function untouched', () => {
  const { trace } = fakeTrace()
  const tools: any = { NoExec: { description: 'x' } }
  const result = instrumentToolset(tools, trace)
  expect(result.NoExec.execute).toBeUndefined()
})

test('records a startTime on the span so duration is still meaningful despite the deferred creation', async () => {
  const { trace, spans } = fakeTrace()
  const tools: any = { Quick: { execute: async () => ({ ok: true }) } }
  instrumentToolset(tools, trace)
  await tools.Quick.execute({}, {})
  expect(typeof spans[0].opts.startTime).toBe('string')
  expect(Number.isNaN(Date.parse(spans[0].opts.startTime as string))).toBe(false)
})
