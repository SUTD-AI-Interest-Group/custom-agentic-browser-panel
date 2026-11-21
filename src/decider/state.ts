// Builders that turn a page snapshot into decision-model requests (next action, form fill).

import { serializeRegistry, type IndexedElement } from '../platform/domIndex'
import { PREVIOUS_ACTIONS_WINDOW } from './config'
import type { DecisionRequest, DecisionQuestion } from './request'

export interface StepFacts {
  goal: string
  plan: string
  url: string
  title: string
  previousActions: string[]
  pageText?: string
  elements: IndexedElement[]
}

export type OptionAction = { op: 'click' | 'type' | 'select'; index: number } | { op: 'scroll' } | { op: 'done' }

const TYPEABLE_INPUT = new Set(['', 'text', 'email', 'search', 'password', 'tel', 'url', 'number'])
const DESC_CAP = 120

function line(e: IndexedElement): string {
  return serializeRegistry([e])
}

function describe(e: IndexedElement): string {
  const d = line(e).replace(/^\[\d+\]/, '').trim()
  return d.length > DESC_CAP ? d.slice(0, DESC_CAP - 1) + '…' : d
}

function isTypeable(e: IndexedElement): boolean {
  if (e.tag === 'textarea') return true
  return e.tag === 'input' && TYPEABLE_INPUT.has((e.type ?? '').toLowerCase())
}

export function nextActionRequest(f: StepFacts): { request: DecisionRequest; actions: OptionAction[] } {
  const criteria: Record<string, string | null> = {}
  const actions: OptionAction[] = []
  for (const e of f.elements) {
    let op: 'click' | 'type' | 'select'
    let name: string
    if (e.tag === 'select') {
      op = 'select'
      name = `select in [${e.index}]`
    } else if (isTypeable(e)) {
      op = 'type'
      name = `type into [${e.index}]`
    } else {
      op = 'click'
      name = `click [${e.index}]`
    }
    criteria[name] = describe(e)
    actions.push({ op, index: e.index })
  }
  criteria['scroll down'] = 'reveal more of the page'
  actions.push({ op: 'scroll' })
  criteria['done'] = 'the goal is complete, or the answer is now visible on the page'
  actions.push({ op: 'done' })

  const state: Record<string, unknown> = {
    goal: f.goal,
    plan: f.plan,
    url: f.url,
    title: f.title,
    previous_actions: f.previousActions.slice(-PREVIOUS_ACTIONS_WINDOW),
  }
  if (f.pageText) state.page_text = f.pageText
  return {
    request: {
      state,
      questions: {
        next: {
          type: 'choice',
          instructions: 'What is the single next browser action that makes progress toward the goal?',
          criteria,
        },
      },
    },
    actions,
  }
}

export interface FormField {
  index: number
  kind: 'text' | 'select' | 'checkbox'
  label: string
  checked?: boolean
  options?: string[]
}

export type Lookup = { profile: Record<string, string>; request: Record<string, string> }

export interface FillQuestion {
  name: string
  field: FormField
  options: string[]
}

export function formFields(elements: IndexedElement[], selectOptions: Record<number, string[]>): FormField[] {
  const out: FormField[] = []
  for (const e of elements) {
    if (e.sensitive) continue
    const t = (e.type ?? '').toLowerCase()
    if (e.tag === 'select') {
      out.push({ index: e.index, kind: 'select', label: line(e), options: selectOptions[e.index] ?? [] })
    } else if (e.tag === 'input' && t === 'checkbox') {
      out.push({ index: e.index, kind: 'checkbox', label: line(e), checked: e.checked === true })
    } else if (isTypeable(e)) {
      out.push({ index: e.index, kind: 'text', label: line(e) })
    }
  }
  return out
}

export function fillRequest(f: {
  goal: string
  url: string
  title: string
  lookup: Lookup
  fields: FormField[]
}): { request: DecisionRequest; questions: FillQuestion[] } {
  const keys = [
    ...Object.keys(f.lookup.profile).map((k) => `profile.${k}`),
    ...Object.keys(f.lookup.request).map((k) => `request.${k}`),
    'leave_empty',
  ]
  const questions: FillQuestion[] = []
  const qs: Record<string, DecisionQuestion> = {}
  for (const field of f.fields) {
    const name = `f${field.index}`
    if (field.kind === 'text') {
      qs[name] = {
        type: 'choice',
        instructions: `Which value from info should fill the form field ${field.label}?`,
        criteria: Object.fromEntries(keys.map((k) => [k, null])),
      }
      questions.push({ name, field, options: keys })
    } else if (field.kind === 'select') {
      const options = field.options ?? []
      qs[name] = {
        type: 'choice',
        instructions: `Which option should be selected in ${field.label}?`,
        criteria: Object.fromEntries(options.map((o) => [o, null])),
      }
      questions.push({ name, field, options })
    } else {
      qs[name] = {
        type: 'noul',
        instructions: `Should the checkbox ${field.label} be ticked for this request?`,
      }
      questions.push({ name, field, options: ['true', 'false'] })
    }
  }
  return {
    request: {
      state: { goal: f.goal, page: `${f.title} (${f.url})`, info: f.lookup },
      questions: qs,
    },
    questions,
  }
}
