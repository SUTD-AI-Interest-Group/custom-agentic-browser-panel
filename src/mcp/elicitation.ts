import { Validator } from '@cfworker/json-schema'
import type { Schema } from '@cfworker/json-schema'

export type ElicitReply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
export type Field = { type: string; title?: string; description?: string; default?: unknown; enum?: string[]; oneOf?: { const: string; title?: string }[]; items?: { type?: string; enum?: string[]; anyOf?: { const: string; title?: string }[] }; [key: string]: unknown }
export type ElicitForm = { type: 'object'; properties: Record<string, Field>; required?: string[] }
export type Elicitation = { message: string; mode: 'form'; requestedSchema: ElicitForm } | { message: string; mode: 'url'; url: string }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseElicitation(value: unknown): Elicitation {
  if (!object(value) || typeof value.message !== 'string' || value.message.length > 8000) throw Error('Invalid clarification request.')
  if (value.mode === 'url') {
    const url = new URL(String(value.url))
    if (url.protocol !== 'https:' || url.username || url.password) throw Error('Clarification links must use HTTPS without embedded credentials.')
    return { mode: 'url', message: value.message, url: url.href }
  }
  if (value.mode !== undefined && value.mode !== 'form') throw Error('Unsupported clarification mode.')
  const s = value.requestedSchema
  if (!object(s) || s.type !== 'object' || !object(s.properties) || Object.keys(s.properties).length > 32 || JSON.stringify(s).length > 32_000) throw Error('Unsupported clarification schema.')
  const allowed = new Set(['type', 'title', 'description', 'default', 'enum', 'oneOf', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'format', 'minItems', 'maxItems'])
  for (const [key, f] of Object.entries(s.properties)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !object(f) || !['string', 'number', 'integer', 'boolean', 'array'].includes(String(f.type))) throw Error('Unsupported clarification field.')
    if (/password|passphrase|api.?key|access.?token|refresh.?token|client.?secret|credit.?card|card.?number|\bcvv\b/i.test(`${value.message} ${key} ${f.title ?? ''} ${f.description ?? ''}`)) throw Error('Credentials must be requested through a secure URL, not a form.')
    if (Object.keys(f).some(k => !allowed.has(k))) throw Error('Unsupported clarification constraint.')
    for (const label of ['title', 'description']) if (f[label] !== undefined && typeof f[label] !== 'string') throw Error('Invalid field label.')
    for (const n of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) if (f[n] !== undefined && (typeof f[n] !== 'number' || !Number.isFinite(f[n]))) throw Error('Invalid field constraint.')
    if (f.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(f.format))) throw Error('Unsupported field format.')
    const choices = f.type === 'array' ? f.items : f
    if (f.type === 'array' && (!object(choices) || Object.keys(choices).some(k => !['type', 'enum', 'anyOf'].includes(k)))) throw Error('Only selection arrays are supported.')
    if (object(choices)) {
      if (choices.enum !== undefined && (!Array.isArray(choices.enum) || choices.enum.length > 100 || choices.enum.some(x => typeof x !== 'string'))) throw Error('Invalid choices.')
      const variants = choices.oneOf ?? choices.anyOf
      if (variants !== undefined && (!Array.isArray(variants) || variants.length > 100 || variants.some(x => !object(x) || typeof x.const !== 'string' || (x.title !== undefined && typeof x.title !== 'string') || Object.keys(x).some(k => !['const', 'title'].includes(k))))) throw Error('Invalid titled choices.')
      if (f.type === 'array' && !choices.enum && !variants) throw Error('Array choices are required.')
    }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties as object, k)))) throw Error('Invalid required fields.')
  return { mode: 'form', message: value.message, requestedSchema: { type: 'object', properties: s.properties as Record<string, Field>, required: s.required as string[] | undefined } }
}
export function validateReply(request: Elicitation, reply: ElicitReply): void {
  if (!['accept', 'decline', 'cancel'].includes(reply.action)) throw Error('Invalid response.')
  if (reply.action !== 'accept' || request.mode === 'url') { if (reply.content !== undefined) throw Error('Unexpected form data.'); return }
  if (!object(reply.content) || JSON.stringify(reply.content).length > 64_000 || !new Validator({ ...request.requestedSchema, additionalProperties: false } as Schema).validate(reply.content).valid) throw Error('Please complete the requested fields with valid values.')
}

export interface PendingElicitation { id: string; server: string; request: Elicitation }
class ElicitationQueue {
  private entries: (PendingElicitation & { settle: (r: ElicitReply) => void })[] = []
  private listeners = new Set<() => void>()
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f) } }
  snapshot = (): PendingElicitation[] => this.entries
  private notify() { for (const f of this.listeners) f() }
  ask(server: string, raw: unknown, signal: AbortSignal): Promise<ElicitReply> {
    signal.throwIfAborted()
    const request = parseElicitation(raw)
    if (this.entries.length >= 16) throw Error('Too many pending clarification requests.')
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.entries = this.entries.filter(x => x.id !== id); this.notify() }
      const abort = () => { cleanup(); reject(signal.reason ?? new Error('Clarification cancelled.')) }
      const timer = setTimeout(() => { cleanup(); resolve({ action: 'cancel' }) }, 15 * 60_000)
      this.entries = [...this.entries, { id, server, request, settle: reply => { cleanup(); resolve(reply) } }]
      signal.addEventListener('abort', abort, { once: true }); this.notify()
      if (signal.aborted) abort()
    })
  }
  respond(id: string, reply: ElicitReply) {
    const entry = this.entries.find(x => x.id === id)
    if (!entry) return
    validateReply(entry.request, reply); entry.settle(reply)
  }
}
export const elicitationQueue = new ElicitationQueue()

export async function collectInputs(raw: unknown, ask: (params: unknown, signal: AbortSignal) => Promise<ElicitReply>, signal: AbortSignal): Promise<Record<string, ElicitReply>> {
  if (!object(raw) || !Object.keys(raw).length || Object.keys(raw).length > 16) throw Error('Invalid input requests.')
  // Validate the whole batch before displaying anything or disclosing data.
  for (const value of Object.values(raw)) {
    if (!object(value) || value.method !== 'elicitation/create') throw Error('Unsupported MCP input request; sampling and roots are disabled.')
    parseElicitation(value.params)
  }
  const replies: Record<string, ElicitReply> = Object.create(null)
  for (const [key, value] of Object.entries(raw)) {
    signal.throwIfAborted()
    const request = (value as Record<string, unknown>).params
    const reply = await ask(request, signal); validateReply(parseElicitation(request), reply)
    replies[key] = reply
  }
  signal.throwIfAborted()
  return replies
}

export function elicitationFieldErrors(request: Elicitation, values: Record<string,unknown>): Record<string,string> {
  if(request.mode !== 'form') return {}
  return Object.fromEntries(Object.entries(request.requestedSchema.properties).flatMap(([name, field]) => {
    if(values[name] === undefined) return request.requestedSchema.required?.includes(name) ? [[name,'This field is required.']] : []
    return new Validator(field as Schema).validate(values[name]).valid ? [] : [[name,'Check this value against the listed requirements.']]
  }))
}
