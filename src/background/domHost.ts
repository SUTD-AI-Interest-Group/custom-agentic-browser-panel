import { getExecHost } from '../exec/host'
import { loadPdf, loadPdfMeta, renderPdfPage, renderPdfPageHighlighted } from '../platform/pdf'

let active = 0
export const hasDomWork = () => active > 0

export function installDomHost(onIdle: () => void) {
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js') || msg?.type !== 'chat.dom') return
    const operations = {
      runCode: (code: string, limits: { timeoutMs: number; memoryBytes: number }) => getExecHost().run(code, limits),
      loadPdf, loadPdfMeta, renderPdfPage, renderPdfPageHighlighted,
    }
    const fn = operations[msg.operation as keyof typeof operations]
    if (!fn) { reply({ ok: false, error: 'Unknown document operation.' }); return }
    active++
    void Promise.resolve().then(() => (fn as (...args: any[]) => Promise<unknown>)(...msg.args))
      .then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { active--; onIdle() }).catch(console.error)
    return true
  })
}
