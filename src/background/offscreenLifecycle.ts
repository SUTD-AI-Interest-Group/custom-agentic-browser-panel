// Serialize creation, dispatch and closure. A persisted queued/paused job is
// not a live resource; the host is authoritative about what it is executing.
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work)
  queue = result.catch(() => {})
  return result
}

export function withOffscreen<T>(dispatch: () => Promise<T>): Promise<T> {
  return serialize(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Process background chat, research, documents and memory consolidation.',
      })
    }
    return dispatch()
  })
}

export function closeOffscreenIfIdle(): Promise<void> {
  return serialize(async () => {
    if (!(await chrome.offscreen.hasDocument())) return
    const status = await chrome.runtime.sendMessage({ type: 'offscreen.status' })
    // Unknown/unresponsive hosts must not be killed during live work.
    if (status?.busy === false) await chrome.offscreen.closeDocument()
  })
}
