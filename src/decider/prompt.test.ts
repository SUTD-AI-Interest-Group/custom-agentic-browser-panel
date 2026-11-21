// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderContent, renderRequest } from './prompt'
import type { DecisionRequest } from './request'
import { createEncoder } from './tokenizer'

// strands_decider/core/tokenizer.py CONTROL_TOKEN_IDS, verbatim.
const CONTROL: Record<string, number> = {
  '<bos>': 2,
  '<|turn>': 105,
  '<turn|>': 106,
  '<|image>': 255999,
  '<|image|>': 258880,
  '<image|>': 258882,
}

// Deterministic stand-in encoder: one id (>106) per UTF-16 unit.
const fake = (t: string) => Array.from(t, (c) => c.charCodeAt(0) + 1000)
const text = (ids: number[]) => String.fromCharCode(...ids.filter((i) => i > 1000).map((i) => i - 1000))

describe('renderContent', () => {
  it('strips strings and indents structured data without escaping non-ASCII', () => {
    expect(renderContent('  x  ')).toBe('x')
    expect(renderContent({ a: [1, 'é'] })).toBe('{\n  "a": [\n    1,\n    "é"\n  ]\n}')
    expect(renderContent(null)).toBe('')
  })
})

describe('renderRequest structure', () => {
  const req: DecisionRequest = {
    state: 'hello',
    questions: {
      route: { type: 'choice', instructions: 'Who?', criteria: { returns: 'refunds  and\nswaps', fraud: null } },
      urgent: { type: 'noul', instructions: 'Today?' },
      mood: { type: 'score', instructions: 'How?', criteria: ['calm', 'angry', 'furious'] },
    },
  }
  const out = renderRequest(req, fake, CONTROL)

  it('renders choice option lines with and without descriptions', () => {
    const q = out.questions[0]
    expect(q.name).toBe('route')
    expect(q.kind).toBe('choice')
    expect(q.options).toEqual(['returns', 'fraud'])
    expect(text(q.ids)).toContain('A. returns — refunds and swaps\nB. fraud\n')
  })

  it('noul options are false/true with default descriptions', () => {
    const q = out.questions[1]
    expect(q.options).toEqual(['false', 'true'])
    const t = text(q.ids)
    expect(t).toContain('A. false — the statement does not hold for this state\n')
    expect(t).toContain('B. true — the statement holds for this state\n')
  })

  it('score options are 0..L-1', () => {
    expect(out.questions[2].options).toEqual(['0', '1', '2'])
  })

  it('frames state and question with control tokens', () => {
    expect(out.stateIds.slice(0, 2)).toEqual([2, 105])
    const ids = out.questions[0].ids
    const tail = [106, ...fake('\n'), 105, ...fake('model\n')]
    expect(ids.slice(-tail.length)).toEqual(tail)
  })
})

const CKPT = process.env.DECIDER_CHECKPOINT
describe.skipIf(!CKPT)('golden id parity', () => {
  it('matches every text-only golden row (0/430 mismatches)', () => {
    const tj = JSON.parse(readFileSync(join(CKPT!, 'tokenizer.json'), 'utf8'))
    const tc = JSON.parse(readFileSync(join(CKPT!, 'tokenizer_config.json'), 'utf8'))
    const encode = createEncoder(tj, tc)
    const rows = readFileSync(join(CKPT!, 'golden_vectors.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.images.length === 0)
    let bad = 0
    let first = ''
    for (const row of rows) {
      const r = renderRequest(row.request, encode, CONTROL)
      let ok = JSON.stringify(r.stateIds) === JSON.stringify(row.state_ids)
      for (const q of r.questions) {
        if (JSON.stringify(q.ids) !== JSON.stringify(row.questions[q.name].question_ids)) ok = false
      }
      if (!ok) {
        bad++
        if (!first) first = JSON.stringify(row.request).slice(0, 300)
      }
    }
    console.log(`golden mismatches: ${bad}/${rows.length}`, first)
    expect(rows.length).toBe(430)
    expect(bad).toBe(0)
  }, 120_000)
})
