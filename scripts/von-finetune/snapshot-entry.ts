// Bundled by lib.mjs into an IIFE that collect.mjs evaluates in a plain
// Playwright page (no extension). `snapshotPage` is the real domIndex walker;
// only chrome.scripting.executeScript is stubbed, to call the injected function
// in-page — which is all executeScript does with a self-contained `func`.
import { snapshotPage } from '../../src/platform/domIndex'

type Inject = { func: (...a: unknown[]) => unknown; args: unknown[] }
;(globalThis as unknown as { chrome: unknown }).chrome = {
  scripting: { executeScript: async ({ func, args }: Inject) => [{ result: await func(...args) }] },
}
;(globalThis as unknown as { __vonSnap: () => unknown }).__vonSnap = () => snapshotPage(0)
