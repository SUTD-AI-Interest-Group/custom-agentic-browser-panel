// Is the imported decision model usable? Answered from its status record alone (chrome.storage.local
// under MODEL_STATUS_KEY, which importModel/deleteModel in storage.ts keep), never from OPFS — so
// this module is SERVICE-WORKER SAFE and is the readiness probe the worker's forwarding hooks use
// (relay.ts's `forwardDeciderHooks`, wired in src/background/toolHost.ts). storage.ts carries the
// OPFS code and must stay out of the worker's bundle; relay.test.ts walks both import closures.

import { MODEL_ID, MODEL_STATUS_KEY } from './config'

/** A stored status that means "usable": state `ready`, for the model this build expects. Pure. */
export function isReadyStatus(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const s = raw as { state?: unknown; modelId?: unknown }
  return s.state === 'ready' && s.modelId === MODEL_ID
}

/** One chrome.storage.local read. `false` on any failure; never rejects. */
export async function readModelReady(): Promise<boolean> {
  try {
    const got = await chrome.storage.local.get(MODEL_STATUS_KEY)
    return isReadyStatus(got?.[MODEL_STATUS_KEY])
  } catch {
    return false
  }
}
