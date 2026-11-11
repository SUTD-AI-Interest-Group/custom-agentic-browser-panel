import { durableDatabase } from './durableDatabase'
import { z } from 'zod'

export const watchInput = z.object({
  description: z.string().trim().min(1).max(500),
  selector: z.string().trim().min(1).max(1000).describe('Stable CSS selector for exactly one component, verified using ReadPage. Never use temporary data-agent-region/index attributes.'),
  condition: z.enum(['text_contains', 'text_equals', 'text_changed', 'enabled', 'disabled']),
  text: z.string().trim().min(1).max(1000).optional(),
  intervalSeconds: z.number().int().min(60).max(86400).describe('REQUIRED from user; never invent. Minimum 60 seconds.'),
  deadline: z.string().datetime({ offset: true }).describe('REQUIRED from user; ISO timestamp with explicit timezone. Ask if missing.'),
  screenshotId: z.string().optional().describe('Optional shotId from GetElementScreenshot in this conversation, used as setup context.'),
})
export type WatchInput = z.infer<typeof watchInput>
export interface Observation { text: string; enabled: boolean; tag: string }
export interface PageWatch extends WatchInput {
  id: string; conversationId: string; url: string; createdAt: number; deadlineAt: number; nextCheckAt: number
  status: 'active' | 'matched' | 'expired' | 'cancelled' | 'needs_attention'
  baseline: Observation; lastObservation?: Observation; lastCheckedAt?: number; error?: string
  leaseUntil?: number; notified?: boolean
}
export function validateWatch(input: WatchInput, now = Date.now()) {
  watchInput.parse(input)
  const deadline = Date.parse(input.deadline)
  if (deadline <= now) throw new Error('Deadline must be in the future.')
  if (deadline < now + input.intervalSeconds * 1000) throw new Error('Deadline must allow at least one checking interval.')
  if (input.condition.startsWith('text_') && input.condition !== 'text_changed' && !input.text?.trim()) throw new Error('This condition requires comparison text.')
  if (/data-agent-|:nth-child|:nth-of-type/.test(input.selector)) throw new Error('Use a stable selector, not a temporary or positional component index.')
}
export function matchesWatch(watch: Pick<PageWatch, 'condition' | 'text' | 'baseline'>, observed: Observation) {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const text = normalize(observed.text), expected = normalize(watch.text ?? '')
  switch (watch.condition) {
    case 'text_contains': return text.includes(expected)
    case 'text_equals': return text === expected
    case 'text_changed': return text !== normalize(watch.baseline.text)
    case 'enabled': return observed.enabled
    case 'disabled': return !observed.enabled
  }
}
const transaction = durableDatabase('lychee-page-watches', 'watches', 'id')
export async function listPageWatches(): Promise<PageWatch[]> {
  const tx = await transaction()
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('watches').getAll()
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    tx.onabort = () => reject(tx.error)
  })
}
export async function updatePageWatch(id: string, update: (old: PageWatch | undefined) => PageWatch | undefined): Promise<PageWatch | undefined> {
  const tx = await transaction('readwrite')
  return new Promise((resolve, reject) => {
    const store = tx.objectStore('watches')
    let result: PageWatch | undefined, failure: unknown, changed = false
    const req = store.get(id)
    req.onsuccess = () => {
      try {
        result = update(req.result)
        if (result === req.result) return
        changed = true
        if (result) store.put(result); else store.delete(id)
      } catch (error) { failure = error; tx.abort() }
    }
    tx.oncomplete = () => {
      if (changed) {
        try { void chrome.runtime.sendMessage({ type: 'page-watches.changed' }).catch(() => {}) } catch { /* closing context */ }
      }
      resolve(result)
    }
    tx.onerror = () => reject(failure ?? tx.error); tx.onabort = () => reject(failure ?? tx.error)
  })
}
export async function clearPageWatches(conversationId?: string) {
  for (const watch of await listPageWatches()) {
    if (!conversationId || watch.conversationId === conversationId) await updatePageWatch(watch.id, () => undefined)
  }
}
