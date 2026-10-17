import { classifyPageAccess } from '../platform/pageAccess'
/** Bound preparation only, never human approval or model execution. */
export function prepareRequest<T>(work: Promise<T>, signal: AbortSignal, stage: string, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new Error(`Request cancelled during ${stage}.`)))
    const timer = setTimeout(() => finish(() => reject(new Error(`Preparing request timed out during ${stage}. Please retry.`))), timeoutMs)
    function finish(action: () => void) { clearTimeout(timer); signal.removeEventListener('abort', abort); action() }
    signal.addEventListener('abort', abort, {once:true})
    if (signal.aborted) abort()
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(new Error(`Preparing request failed during ${stage}. Please retry.`, {cause:error}))))
  })
}
export function canAttachPage(url: string): boolean {
  return classifyPageAccess(url, {fileAccess:true}).kind === 'ok'
}
