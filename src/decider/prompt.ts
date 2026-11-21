// Port of the strands-chat prompt (strands_decider 0.3.1.dev108 core/prompt.py + codes.py).
// Pure: no Chrome or tokenizer imports. Control tokens are inserted by id; every text run is
// encoded on its own as plain text.

import type { Content, DecisionQuestion, DecisionRequest } from './request'

export type EncodeText = (text: string) => number[]

export interface RenderedQuestion {
  name: string
  kind: 'choice' | 'noul' | 'score'
  ids: number[]
  /** Answer values in code order (options[k] is the value bound to the k-th code). */
  options: string[]
}
export interface Rendered {
  stateIds: number[]
  questions: RenderedQuestion[]
}

const HEADERS = {
  noul: 'Decide whether the statement is true of the state.',
  choice: 'Select exactly one option.',
  score: 'Rate the state against the ordered levels below (lowest first).',
} as const
const ANSWER_LINE = 'Answer with the code of one option.'
const DESCRIPTION_SEPARATOR = ' — '
const NOUL_DEFAULTS = {
  false: 'the statement does not hold for this state',
  true: 'the statement holds for this state',
} as const

/** Spreadsheet-column codes A..Z, AA..AZ, ... without GZ (two tokens in Gemma 4's vocabulary). */
const CODES: string[] = (() => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const names = [...letters, ...letters.flatMap((a) => letters.map((b) => a + b))]
  return names.slice(0, 256).filter((c) => c !== 'GZ')
})()

export function renderContent(c: Content | null | undefined): string {
  if (c === null || c === undefined) return ''
  if (typeof c === 'string') return c.trim()
  return JSON.stringify(c, null, 2)
}

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(' ')

function questionKind(q: DecisionQuestion): DecisionQuestion['type'] {
  if (q.type) return q.type
  // v1 lets `type` be omitted: infer from criteria shape.
  const c = (q as { criteria?: unknown }).criteria
  if (Array.isArray(c)) return 'score'
  if (c && typeof c === 'object' && !Object.keys(c).every((k) => k === 'true' || k === 'false')) return 'choice'
  return 'noul'
}

function normalise(q: DecisionQuestion): { kind: RenderedQuestion['kind']; options: string[]; descs: (Content | null)[] } {
  const kind = questionKind(q)
  if (kind === 'noul') {
    const given = (q.criteria ?? {}) as Partial<Record<'true' | 'false', Content | null>>
    const pick = (k: 'false' | 'true') => (k in given ? (given[k] ?? null) : NOUL_DEFAULTS[k])
    return { kind, options: ['false', 'true'], descs: [pick('false'), pick('true')] }
  }
  if (kind === 'choice') {
    const crit = q.criteria as Record<string, Content | null>
    return { kind, options: Object.keys(crit), descs: Object.values(crit) }
  }
  const levels = q.criteria as string[]
  return { kind, options: levels.map((_, i) => String(i)), descs: levels }
}

export function renderRequest(
  req: DecisionRequest,
  encode: EncodeText,
  controlTokenIds: Record<string, number>,
): Rendered {
  const ctl = (name: string): number => {
    const id = controlTokenIds[name]
    if (id === undefined) throw new Error(`missing control token ${name}`)
    return id
  }
  const text = renderContent(req.state)
  const stateBlock = text ? `<state>\n${text}\n</state>\n` : '<state>\n</state>\n'
  const stateIds = [ctl('<bos>'), ctl('<|turn>'), ...encode('user\n' + stateBlock)]

  const questions: RenderedQuestion[] = Object.entries(req.questions).map(([name, q]) => {
    const { kind, options, descs } = normalise(q)
    if (options.length > CODES.length) throw new Error(`question ${name}: too many options`)
    const lines = options.map((opt, i) => {
      const n = oneLine(opt)
      const d = oneLine(renderContent(descs[i]))
      return `${CODES[i]}.` + (n ? ` ${n}` : '') + (d ? `${DESCRIPTION_SEPARATOR}${d}` : '')
    })
    const parts = [`<question type="${kind}">`, HEADERS[kind]]
    const instructions = renderContent(q.instructions)
    if (instructions) parts.push(instructions)
    parts.push('<options>', ...lines, '</options>', ANSWER_LINE, '</question>')
    const ids = [
      ...encode(parts.join('\n')),
      ctl('<turn|>'),
      ...encode('\n'),
      ctl('<|turn>'),
      ...encode('model\n'),
    ]
    return { name, kind, ids, options }
  })
  return { stateIds, questions }
}
