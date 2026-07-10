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
    void chrome.windows.getCurrent().then((w) => {
      if (w.id !== undefined) port.postMessage({ type: 'hello', windowId: w.id })
    })
  } catch (err) {
    // A missing port just means the shortcut can't toggle-close; chat still works.
    console.error('panel port failed', err)
  }
}
