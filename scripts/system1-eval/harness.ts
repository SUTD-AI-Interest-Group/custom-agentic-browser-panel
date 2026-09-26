// Browser-side half of the System-1 eval. run.mjs bundles this with esbuild
// and evaluates it inside an extension page of the built extension, so the
// ACTUAL source decides: `snapshotPage` is the real domIndex walker (injected
// through chrome.scripting exactly as ControlPage/Act do), `runActLoop` is the
// real candidate-action loop over the real Von adapter (so the state block,
// the per-operation target heads, the >TARGET_CHUNK tournament and the
// ACT_CONFIDENCE gate are the shipped ones, not a mirror), and inference runs
// in the real dist/system1Worker.js over the weights the Settings UI put in
// Cache Storage. The only thing not exercised is engine.ts's FIFO/timeout
// wrapper around that worker.
import { snapshotPage, type PageSnapshot } from '../../src/platform/domIndex'
import { runActLoop } from '../../src/system1/actLoop'
import { opFor } from '../../src/system1/observation'
import { createVonPolicy } from '../../src/system1/vonPolicy'
import type { ValidatedAction } from '../../src/system1/validate'
import { fileUrl, WEIGHTS_PIN } from '../../src/system1/weights'
import type { DecideRequest, DecideResult, System1WorkerReply } from '../../src/system1/protocol'

let worker: Worker | null = null
const pending = new Map<string, { resolve: (r: DecideResult) => void; reject: (e: Error) => void }>()

async function boot(wasmPath: string, modelPath: string): Promise<number> {
  const t0 = performance.now()
  worker = new Worker(chrome.runtime.getURL('system1Worker.js'), { type: 'module' })
  await new Promise<void>((resolve, reject) => {
    worker!.onmessage = (e: MessageEvent<System1WorkerReply>) => {
      const m = e.data
      if (m.type === 'ready') return resolve()
      if (m.type === 'boot-failed') return reject(new Error(m.message))
      if (m.type === 'result' || m.type === 'failed') {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (!p) return
        if (m.type === 'result') p.resolve(m.result)
        else p.reject(Object.assign(new Error(`${m.code ?? 'failed'}: ${m.message}`), { code: m.code }))
      }
    }
    worker!.onerror = (e) => reject(new Error(e.message || 'worker error'))
    worker!.postMessage({
      type: 'init',
      wasmUrl: chrome.runtime.getURL(wasmPath),
      modelUrl: fileUrl(WEIGHTS_PIN, modelPath),
      tokenizerUrl: fileUrl(WEIGHTS_PIN, 'tokenizer.json'),
      tokenizerConfigUrl: fileUrl(WEIGHTS_PIN, 'tokenizer_config.json'),
      configUrl: fileUrl(WEIGHTS_PIN, 'von.json'),
      requiresShaderF16: false,
    })
  })
  return Math.round(performance.now() - t0)
}

function decide(req: DecideRequest): Promise<DecideResult & { wallMs: number }> {
  const id = crypto.randomUUID()
  const t0 = performance.now()
  return new Promise<DecideResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ type: 'decide', id, req })
  }).then((r) => ({ ...r, wallMs: Math.round(performance.now() - t0) }))
}

type Kind = 'operation' | 'target' | 'value' | 'blocked_reason'
interface Call { kind: Kind; key: string; req: DecideRequest; res?: DecideResult & { wallMs: number }; error?: string }

const kindOf = (key: string): Kind =>
  key === 'operation' ? 'operation' : key.startsWith('target_') ? 'target' : key === 'value' ? 'value' : 'blocked_reason'

/**
 * The operation the expected element implies — what the operation head is
 * forced to, so the target head is measured in isolation (a wrong operation
 * can't hide a right target). Falls back to CLICK, which every case's page
 * offers; a field operation is forced only when values exist, since the
 * candidate space offers it only then.
 */
function forcedOperation(snap: PageSnapshot | null, expected: string[], values: Record<string, string>): 'CLICK' | 'TYPE_TEXT' | 'SELECT_OPTION' {
  const el = snap?.elements.find((e) => expected.includes(e.name))
  if (!el || Object.keys(values).length === 0) return 'CLICK'
  const op = opFor(el)
  return op === 'type' ? 'TYPE_TEXT' : op === 'select' ? 'SELECT_OPTION' : 'CLICK'
}

/**
 * One grounding case: the real loop, one step, with two interventions that
 * isolate the TARGET head — the operation answer is recorded but forced to the
 * expected element's operation, and execute() records the validated action and
 * reports `denied` so nothing on the page is touched.
 */
async function groundCase(tabId: number, goal: string, values: Record<string, string>, expected: string[]) {
  const calls: Call[] = []
  let snap: PageSnapshot | null = null
  let action: ValidatedAction | null = null
  let forced: string | null = null
  const result = await runActLoop({ goal, values, maxSteps: 1 }, {
    snapshot: async () => (snap = await snapshotPage(tabId)),
    aborted: () => false,
    execute: async (a) => { action = a; return { kind: 'denied' } },
    policy: createVonPolicy(async (req) => {
      const key = Object.keys(req.questions)[0]
      const call: Call = { kind: kindOf(key), key, req }
      calls.push(call)
      try { call.res = await decide(req) } catch (err) { call.error = String(err); throw err }
      if (call.kind === 'operation') {
        forced = forcedOperation(snap, expected, values)
        return { ...call.res, answers: { operation: { choice: forced, probabilities: { [forced]: 1 }, top: 1, confidence: 1 } } }
      }
      return call.res
    }),
  })
  const s = snap as PageSnapshot | null
  return {
    status: result.status,
    message: result.message,
    action,
    forced,
    transitions: result.transitions,
    elements: s ? s.elements.map((e) => ({ index: e.index, name: e.name, tag: e.tag, type: e.type, role: e.role, sensitive: e.sensitive, disabled: e.disabled, readonly: e.readonly })) : [],
    calls: calls.map((c) => ({ kind: c.kind, key: c.key, req: c.req, res: c.res, error: c.error })),
  }
}

;(globalThis as unknown as { __s1eval: unknown }).__s1eval = { boot, decide, groundCase, snapshotPage }
