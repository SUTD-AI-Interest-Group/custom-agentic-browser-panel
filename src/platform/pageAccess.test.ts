import { describe, it, expect } from 'vitest'
import { classifyPageAccess, FILE_ACCESS_HINT } from './pageAccess'

const granted = { fileAccess: true }
const denied = { fileAccess: false }

describe('classifyPageAccess', () => {
  it('passes ordinary web pages through', () => {
    for (const url of [
      'https://example.com/docs',
      'http://localhost:5173/',
      'https://arxiv.org/pdf/1706.03762',
    ]) {
      expect(classifyPageAccess(url, denied), url).toMatchObject({ kind: 'ok', reason: '' })
    }
  })

  it('gates file:// on the user-granted toggle, not on host_permissions', () => {
    // Verified in a real browser: <all_urls> DOES cover file:// once the toggle
    // is on, so nothing about the manifest changes between these two cases.
    expect(classifyPageAccess('file:///Users/x/quiz.html', granted).kind).toBe('ok')
    expect(classifyPageAccess('file:///Users/x/quiz.html', denied).kind).toBe('needs-file-access')
  })

  it('marks only the file case as user-fixable, and names the fix', () => {
    const blocked = classifyPageAccess('file:///Users/x/notes.pdf', denied)
    expect(blocked.fixable).toBe(true)
    expect(blocked.reason).toContain('Allow access to file URLs')
    expect(blocked.reason).toContain('chrome://extensions')
    expect(FILE_ACCESS_HINT).toContain('Allow access to file URLs')
  })

  it('rejects browser-internal schemes no toggle can ever unlock', () => {
    for (const url of [
      'chrome://extensions',
      'chrome://settings/privacy',
      'edge://settings',
      'brave://settings',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'chrome-extension://abc/sidepanel.html',
      'moz-extension://abc/panel.html',
      'data:text/html,hi',
      'blob:https://example.com/1234',
    ]) {
      const a = classifyPageAccess(url, granted)
      expect(a.kind, url).toBe('browser-internal')
      expect(a.fixable, url).toBe(false)
    }
  })

  it('rejects the Chrome Web Store on every hostname it uses', () => {
    expect(classifyPageAccess('https://chromewebstore.google.com/detail/abc', granted).kind).toBe('web-store')
    expect(classifyPageAccess('https://chrome.google.com/webstore/category/ext', granted).kind).toBe('web-store')
    // A different path on the same host is an ordinary page.
    expect(classifyPageAccess('https://chrome.google.com/', granted).kind).toBe('ok')
  })

  it('reports a missing or unparseable address as no-url rather than guessing', () => {
    for (const url of ['', undefined, 'not a url']) {
      expect(classifyPageAccess(url, granted).kind, String(url)).toBe('no-url')
    }
  })

  it('gives every blocked kind a non-empty reason, and ok none', () => {
    expect(classifyPageAccess('https://example.com', granted).reason).toBe('')
    for (const url of ['chrome://extensions', 'https://chromewebstore.google.com/x', 'file:///a', '']) {
      const a = classifyPageAccess(url, denied)
      if (a.kind === 'ok') continue
      expect(a.reason.length, url).toBeGreaterThan(0)
    }
  })
})
