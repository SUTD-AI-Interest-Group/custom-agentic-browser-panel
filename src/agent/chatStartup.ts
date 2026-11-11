import { getChatRun } from '../data/chatRuns'

/** Only retry delivery of the same run ID, never create a second model run.
 * Some Chromium contexts can disappear during message delivery. The durable
 * run is authoritative if the reply was lost after execution began. */
export async function startChatRun(conversationId: string, id: string): Promise<void> {
  let deliveryError: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'chat.start', conversationId, id })
      if (reply?.ok === true && reply.id === id) return
      if (reply?.error) throw new Error(reply.error)
    } catch (error) {
      deliveryError = error instanceof Error ? error.message : String(error)
    }
    // Acknowledgement can be lost even though the host accepted the run. Do
    // not mark that live run failed or issue a fresh inference request.
    for (let check = 0; check < 10; check++) {
      const run = await getChatRun(conversationId)
      if (!run || run.id !== id) throw new Error('The chat run was removed or replaced during startup.')
      if (run.state !== 'queued') return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(deliveryError
    ? `Could not start background generation: ${deliveryError}. Reload Lychee AI on your browser’s Extensions page, then reopen the panel and retry.`
    : 'The extension background host did not respond. Reload Lychee AI on your browser’s Extensions page, then reopen the panel and retry. Closing and reopening the panel alone does not reload the extension.')
}
