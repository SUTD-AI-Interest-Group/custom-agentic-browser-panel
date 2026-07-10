// The on-page "agent presence": a persistent, pointer-events:none overlay that
// tints the page, glides an agent cursor to the element being acted on, and
// opens a box-shadow "spotlight" hole over it (the same un-tint trick as
// capture.ts). Persistence lives in the page DOM so each stateless injection
// animates from where the cursor last was.

const ROOT_ID = '__agent_presence'
const TINT = 'rgba(20,22,30,0.22)'
const GLIDE_MS = 450

function injMount(rootId: string, tint: string) {
  if (document.getElementById(rootId)) return
  const root = document.createElement('div')
  root.id = rootId
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
  root.dataset.cx = String(window.innerWidth / 2)
  root.dataset.cy = String(window.innerHeight / 2)

  const tintEl = document.createElement('div')
  tintEl.className = 'tint'
  tintEl.style.cssText = `position:absolute;inset:0;background:${tint};transition:opacity .2s;`

  const spot = document.createElement('div')
  spot.className = 'spot'
  spot.style.cssText =
    'position:absolute;display:none;border:1.5px solid #7ab8ff;border-radius:6px;' +
    `box-shadow:0 0 0 99999px ${tint};transition:all ${450}ms cubic-bezier(.22,.61,.36,1);`

  const cursor = document.createElement('div')
  cursor.className = 'cursor'
  cursor.style.cssText =
    'position:absolute;width:18px;height:18px;left:0;top:0;transition:transform ' +
    `${450}ms cubic-bezier(.22,.61,.36,1);will-change:transform;` +
    `transform:translate(${root.dataset.cx}px,${root.dataset.cy}px);`
  cursor.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 2l5.5 13 2-5.5 5.5-2z" fill="#7ab8ff" stroke="white" stroke-width="1"/></svg>'

  root.appendChild(tintEl)
  root.appendChild(spot)
  root.appendChild(cursor)
  document.documentElement.appendChild(root)
}

function injFocus(rootId: string, attr: string, index: number, label: string) {
  const root = document.getElementById(rootId)
  if (!root) return
  const el = document.querySelector(`[${attr}="${index}"]`)
  const spot = root.querySelector('.spot') as HTMLElement
  const cursor = root.querySelector('.cursor') as HTMLElement
  if (!el) {
    spot.style.display = 'none'
    return
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  const r = el.getBoundingClientRect()
  const pad = 4
  spot.style.display = 'block'
  spot.style.left = `${r.left - pad}px`
  spot.style.top = `${r.top - pad}px`
  spot.style.width = `${r.width + pad * 2}px`
  spot.style.height = `${r.height + pad * 2}px`
  const tx = r.left + r.width / 2
  const ty = r.top + r.height / 2
  cursor.style.transform = `translate(${tx}px,${ty}px)`
  root.dataset.cx = String(tx)
  root.dataset.cy = String(ty)
  if (label) {
    let tag = root.querySelector('.label') as HTMLElement
    if (!tag) {
      tag = document.createElement('div')
      tag.className = 'label'
      tag.style.cssText =
        'position:absolute;padding:3px 7px;background:#7ab8ff;color:#04101f;border-radius:5px;' +
        'font:12px system-ui;white-space:nowrap;transform:translateY(-130%);'
      root.appendChild(tag)
    }
    tag.textContent = label
    tag.style.left = `${r.left}px`
    tag.style.top = `${r.top}px`
    tag.style.display = 'block'
  }
}

function injPulse(rootId: string) {
  const root = document.getElementById(rootId)
  if (!root) return
  const ring = document.createElement('div')
  ring.style.cssText =
    `position:absolute;left:${root.dataset.cx}px;top:${root.dataset.cy}px;width:8px;height:8px;` +
    'border-radius:50%;background:#7ab8ff;transform:translate(-50%,-50%);opacity:.9;' +
    'transition:all .4s ease-out;pointer-events:none;'
  root.appendChild(ring)
  requestAnimationFrame(() => {
    ring.style.width = '46px'
    ring.style.height = '46px'
    ring.style.opacity = '0'
  })
  setTimeout(() => ring.remove(), 420)
}

function injHidden(rootId: string, hidden: boolean) {
  const root = document.getElementById(rootId)
  if (root) root.style.display = hidden ? 'none' : 'block'
}

function injUnmount(rootId: string) {
  document.getElementById(rootId)?.remove()
}

const ATTR = 'data-agent-idx'

async function run(tabId: number, func: (...a: any[]) => void, args: any[]): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => {})
}

/** Mount the persistent presence overlay on the tab. */
export function mountPresence(tabId: number): Promise<void> {
  return run(tabId, injMount, [ROOT_ID, TINT])
}

/** Glide the cursor + spotlight to element `index`, then wait out the transition. */
export async function focusOn(tabId: number, index: number, label = ''): Promise<void> {
  await run(tabId, injFocus, [ROOT_ID, ATTR, index, label])
  await new Promise((r) => setTimeout(r, GLIDE_MS))
}

/** Play a click ripple at the cursor. */
export function pulse(tabId: number): Promise<void> {
  return run(tabId, injPulse, [ROOT_ID])
}

/** Hide/show the overlay (used to take a clean screenshot). */
export function setPresenceHidden(tabId: number, hidden: boolean): Promise<void> {
  return run(tabId, injHidden, [ROOT_ID, hidden])
}

/** Remove the overlay entirely. */
export function unmountPresence(tabId: number): Promise<void> {
  return run(tabId, injUnmount, [ROOT_ID])
}
