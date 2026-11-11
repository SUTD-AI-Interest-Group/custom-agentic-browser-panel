import {
  boostCss,
  loadBoost,
  siteOrigin,
  STUDIO_PREFIX,
  type StudioBoost,
  type StudioZap,
} from '../data/studio'

const applying = new Map<number, Promise<void>>()
export function applyBoost(tabId: number, boost: StudioBoost): Promise<void> {
  const task = (applying.get(tabId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const css = boostCss(boost)
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (origin, next) => {
          if (location.origin !== origin) return null
          const state = globalThis as typeof globalThis & {
            __lycheeStudioCss?: string
          }
          const previous = state.__lycheeStudioCss ?? ''
          state.__lycheeStudioCss = next
          return previous
        },
        args: [boost.origin, css],
      })
      if (result?.result == null || result.result === css) return
      if (result.result)
        await chrome.scripting.removeCSS({
          target: { tabId },
          css: result.result,
          origin: 'USER',
        })
      if (css)
        await chrome.scripting.insertCSS({
          target: { tabId },
          css,
          origin: 'USER',
        })
    })
  applying.set(tabId, task)
  void task
    .finally(() => {
      if (applying.get(tabId) === task) applying.delete(tabId)
    })
    .catch(() => {})
  return task
}

/** Shared guard prevents both registered and startup-restored execution in one document. */
export function boostScriptCode(boost: StudioBoost): string {
  const marker = JSON.stringify('__lycheeStudioRan:' + boost.origin)
  return `if (location.origin === ${JSON.stringify(boost.origin)} && !globalThis[${marker}]) {
 globalThis[${marker}] = true;
${boost.js}
}`
}

export async function registerBoostScript(boost: StudioBoost): Promise<void> {
  const id = 'studio-' + encodeURIComponent(boost.origin)
  // userScripts is guarded by Chrome's per-extension Allow user scripts toggle.
  if (!boost.js.trim() || !boost.enabled) {
    try {
      await chrome.userScripts.unregister({ ids: [id] })
    } catch {
      /* unavailable or never registered */
    }
    return
  }
  try {
    const script = {
      id,
      matches: [
        new URL(boost.origin).protocol +
          '//' +
          new URL(boost.origin).hostname +
          '/*',
      ],
      js: [
        {
          code: boostScriptCode(boost),
        },
      ],
      runAt: 'document_idle' as const,
      world: 'USER_SCRIPT' as const,
    }
    const existing = await chrome.userScripts.getScripts({ ids: [id] })
    if (existing.length) await chrome.userScripts.update([script])
    else await chrome.userScripts.register([script])
  } catch (error) {
    throw new Error(
      'Enable “Allow user scripts” in Chrome → Extensions → Lychee AI, then save again. ' +
        String(error),
    )
  }
}

export function installStudio(): void {
  const restore = async (id: number, url?: string, runJavaScript = false) => {
    const origin = siteOrigin(url ?? '')
    if (!origin) return
    const boost = await loadBoost(origin)
    if (!boost.enabled) return
    await applyBoost(id, boost)
    if (runJavaScript && boost.js.trim()) {
      // Chrome 135+: restored tabs can finish before registration is restored.
      // Use the same USER_SCRIPT world + once-per-document guard as registration.
      const api = chrome.userScripts as typeof chrome.userScripts & {
        execute?: (options: {
          target: { tabId: number }
          js: { code: string }[]
          world: 'USER_SCRIPT'
        }) => Promise<unknown>
      }
      if (api?.execute)
        await api.execute({
          target: { tabId: id },
          js: [{ code: boostScriptCode(boost) }],
          world: 'USER_SCRIPT',
        })
    }
  }
  const restoreOpenTabs = (runJavaScript = false) => {
    void chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs)
        if (tab.id !== undefined)
          void restore(tab.id, tab.url, runJavaScript).catch(() => {})
    })
  }
  const restoreRegistrations = async (runJavaScript = false) => {
    const data = await chrome.storage.local.get(null)
    for (const [key, boost] of Object.entries(data))
      if (key.startsWith(STUDIO_PREFIX))
        await registerBoostScript(boost).catch(() => {})
    restoreOpenTabs(runJavaScript)
  }
  chrome.runtime.onStartup.addListener(() => {
    void restoreRegistrations(true)
  })
  void (async () => {
    // Session storage survives worker suspension but resets with the browser.
    const { studioBooted } = await chrome.storage.session.get('studioBooted')
    await chrome.storage.session.set({ studioBooted: true })
    await restoreRegistrations(!studioBooted)
  })()
  chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === 'complete')
      void restore(id, tab.url, true).catch(() => {})
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    for (const key of Object.keys(changes).filter((k) =>
      k.startsWith(STUDIO_PREFIX),
    )) {
      const origin = key.slice(STUDIO_PREFIX.length)
      if (!changes[key].newValue)
        void registerBoostScript({
          ...changes[key].oldValue,
          enabled: false,
        }).catch(() => {})
      void chrome.tabs.query({}).then(async (tabs) => {
        const boost = await loadBoost(origin)
        for (const tab of tabs)
          if (tab.id && siteOrigin(tab.url ?? '') === origin)
            await applyBoost(tab.id, boost).catch(() => {})
      })
    }
  })
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.storage.local.get(null).then(async (data) => {
      for (const [key, value] of Object.entries(data))
        if (key.startsWith(STUDIO_PREFIX))
          await registerBoostScript(value).catch(() => {})
    })
  })
}

/** Continuous, top-frame picker. The panel acknowledges each selection; Escape or
 * the Zap toggle tears down all listeners without modifying the page DOM. */
export function pickStudioElement(token: string): Promise<null> {
  return new Promise((resolve) => {
    document.dispatchEvent(new Event('__lychee_studio_cancel'))
    const box = document.createElement('div')
    box.id = '__lychee_studio_picker'
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f2687e;background:#f2687e25;border-radius:4px'
    document.documentElement.append(box)
    let target: Element | null = null
    const move = (event: MouseEvent) => {
      target = event.target instanceof Element ? event.target : null
      if (!target) return
      box.style.visibility = 'visible'
      const r = target.getBoundingClientRect()
      Object.assign(box.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      })
    }
    const finish = () => {
      document.removeEventListener('__lychee_studio_cancel', cancel)
      box.remove()
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
      resolve(null)
    }
    const click = (event: MouseEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      target = event.target instanceof Element ? event.target : target
      if (
        !target ||
        target === document.body ||
        target === document.documentElement
      )
        return
      const parts: string[] = []
      for (
        let node: Element | null = target;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        if (
          node.id &&
          !/^(radix-|:r|_r_)/.test(node.id) &&
          document.querySelectorAll('#' + CSS.escape(node.id)).length === 1
        ) {
          parts.unshift('#' + CSS.escape(node.id))
          break
        }
        const siblings: Element[] = Array.from(
          node.parentElement?.children ?? [],
        ).filter((el) => el.tagName === node!.tagName)
        parts.unshift(
          node.tagName.toLowerCase() +
            `:nth-of-type(${siblings.indexOf(node) + 1})`,
        )
      }
      const style = getComputedStyle(target)
      let background = style.backgroundColor
      for (
        let parent = target.parentElement;
        parent &&
        (background === 'rgba(0, 0, 0, 0)' || background === 'transparent');
        parent = parent.parentElement
      )
        background = getComputedStyle(parent).backgroundColor
      const text = (
        target.getAttribute('aria-label') ||
        target.textContent ||
        target.getAttribute('alt') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      const tag = target.getAttribute('role') || target.tagName.toLowerCase()
      const item: StudioZap = {
        selector: parts.join(' > '),
        label: text || `${tag} element`,
        tag,
        preview: {
          text: text || tag,
          color: style.color,
          background,
          borderRadius: style.borderRadius,
          fontFamily: style.fontFamily,
        },
      }
      box.style.visibility = 'hidden'
      void chrome.runtime
        .sendMessage({ kind: 'studio.zap', token, item })
        .then((reply) => {
          if (!reply?.accepted) finish()
        })
        .catch(finish)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation()
        event.preventDefault()
        finish()
      }
    }
    const cancel = () => finish()
    document.addEventListener('__lychee_studio_cancel', cancel)
    document.addEventListener('mousemove', move, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', key, true)
  })
}
