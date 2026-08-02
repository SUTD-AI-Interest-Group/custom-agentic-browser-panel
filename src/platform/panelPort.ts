// Connects the side panel to the background service worker so the browser-wide
// toggle shortcut (see background.ts) can find and close this panel. On load we
// announce our windowId; when the worker asks us to close, we close ourselves
// (Chrome offers no sidePanel.close(), but a panel document may window.close()).
export function connectPanelPort(): void {
  try {
    const port = chrome.runtime.connect({ name: 'sidepanel' })
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'close') window.close()
    })
    // MV3 can (and routinely does) kill the service worker after ~30s idle; that
    // tears down every Port it held, including this one, and fires OUR
    // onDisconnect (the side with the still-open document is the side that gets
    // notified). Without reconnecting, this panel becomes invisible to the NEW
    // worker instance's openPanels map forever — the toggle shortcut then reads
    // an already-open panel as "not open" and tries to open it again instead of
    // closing it. Reconnecting re-announces our windowId so a fresh SW instance
    // learns about us again. A disconnect can also mean this document itself is
    // unloading (navigating away/closing); reconnecting then is harmless — the
    // new port dies with the page a moment later and there is nothing left to
    // loop, since the listener goes with the document.
    port.onDisconnect.addListener(() => connectPanelPort())
    void chrome.windows
      .getCurrent()
      .then((w) => {
        if (w.id !== undefined) port.postMessage({ type: 'hello', windowId: w.id })
      })
      .catch((err) => console.error('panel port hello failed', err))
  } catch (err) {
    // A missing port just means the shortcut can't toggle-close; chat still works.
    console.error('panel port failed', err)
  }
}
