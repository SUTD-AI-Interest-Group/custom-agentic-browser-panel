import { elicitationQueue } from '../mcp/elicitation'

/** Clarifications stay in the executing worker's memory. Only the trusted panel
 * can read/answer them; closing/reopening the panel reattaches without polling. */
export function installElicitationBridge() {
  const unsubscribe = elicitationQueue.subscribe(() => {
    void chrome.runtime.sendMessage({ type: 'mcp.elicitation.changed' }).catch(() => {})
  })
  const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) return
    if (message?.type === 'mcp.elicitation.list') {
      reply({ entries: elicitationQueue.snapshot().map(({ id, server, request }) => ({ id, server, request })) })
    } else if (message?.type === 'mcp.elicitation.respond') {
      try {
        if (!elicitationQueue.snapshot().some(entry => entry.id === message.id)) throw new Error('This clarification is no longer waiting for a response.')
        elicitationQueue.respond(message.id, message.reply)
        reply({ ok: true })
      } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }) }
    }
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => { unsubscribe(); chrome.runtime.onMessage.removeListener(listener) }
}
