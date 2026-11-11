// DOM-only helpers stay in the offscreen document; browser tools keep Chrome
// API access in the service worker. No arbitrary code/function RPC is exposed.
export type DomOperation = 'runCode' | 'loadPdf' | 'loadPdfMeta' | 'renderPdfPage' | 'renderPdfPageHighlighted'
export async function domWork<T>(operation: DomOperation, args: unknown[]): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type: 'chat.dom', operation, args })
  if (!reply?.ok) throw new Error(reply?.error ?? 'Background document is unavailable.')
  return reply.value as T
}
