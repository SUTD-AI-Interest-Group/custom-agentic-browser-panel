// The on-page "agent presence": a persistent, pointer-events:none overlay that
// breathes a soft light-blue frame around the viewport (the ambient "agent is
// here" glow), tints the page, glides an agent cursor to the element being
// acted on, and opens a box-shadow "spotlight" hole over it (the same un-tint
// trick as capture.ts). Persistence lives in the page DOM so each stateless
// injection animates from where the cursor last was.
//
// Two intensities, chosen by the caller:
//   - Ambient (NavigateTab / ReadPage mode "elements"): frame only — page not dimmed.
//   - Active control (a page-control session): frame + soft tint + spotlight +
//     cursor + click ripple. The session flips the tint on with `setTint`.

const ROOT_ID = '__agent_presence'
// Softened from 0.22 so the ambient frame isn't fighting a dark wash and the
// page reads lighter; the spotlight still shows (rest = tint + spot-shadow vs.
// single-tint hole). Slight blue cast to harmonize with the accent.
const TINT = 'rgba(18,22,34,0.13)'
const GLIDE_MS = 450

// NavigateTab intent cue (animateNavIntent): before a `goto` swaps the page out,
// pop a "Navigating to <host>…" pill on the cursor, hold so it can be read, then
// ramp the tint to a heavier dark wash lit by a lively blue shimmer — the
// on-page "I'm about to move you" feedback. Heavier than the 0.13 ambient TINT
// because the current page is being left, not merely observed.
const NAV_HOLD_MS = 650
const NAV_DARKEN_MS = 550
const NAV_TINT = 'rgba(8,10,18,0.55)'

function injMount(rootId: string, tint: string) {
  if (document.getElementById(rootId)) return
  const root = document.createElement('div')
  root.id = rootId
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
  root.dataset.cx = String(window.innerWidth / 2)
  root.dataset.cy = String(window.innerHeight / 2)

  // Tint starts transparent (ambient); the session turns it on via setTint. The
  // spot's own box-shadow still carries `tint`, but the spot is hidden until
  // focusOn (session-only), so ambient shows no dimming.
  const tintEl = document.createElement('div')
  tintEl.className = 'tint'
  tintEl.style.cssText = 'position:absolute;inset:0;background:transparent;transition:background .2s;'

  const spot = document.createElement('div')
  spot.className = 'spot'
  spot.style.cssText =
    'position:absolute;display:none;border:1.5px solid #7ab8ff;border-radius:6px;' +
    `box-shadow:0 0 0 99999px ${tint};transition:all ${450}ms cubic-bezier(.22,.61,.36,1);`

  // The Apple-Intelligence-style ambient frame: a soft light-blue inset glow
  // hugging the viewport edge, gently breathing via the Web Animations API
  // (self-contained — no injected <style>/keyframes; opacity is compositor-only).
  const frame = document.createElement('div')
  frame.className = 'frame'
  frame.style.cssText =
    'position:absolute;inset:0;pointer-events:none;' +
    'box-shadow:inset 0 0 0 2.5px rgba(122,184,255,.8),' +
    'inset 0 0 60px rgba(122,184,255,.6),' +
    'inset 0 0 130px rgba(122,184,255,.32);'

  const cursor = document.createElement('div')
  cursor.className = 'cursor'
  cursor.style.cssText =
    'position:absolute;width:36px;height:36px;left:0;top:0;transition:transform ' +
    `${450}ms cubic-bezier(.22,.61,.36,1);will-change:transform;` +
    `transform:translate(${root.dataset.cx}px,${root.dataset.cy}px);`
  cursor.innerHTML =
    '<svg width="36" height="36" viewBox="0 0 18 18"><path d="M2 2l5.5 13 2-5.5 5.5-2z" fill="#7ab8ff" stroke="white" stroke-width="1"/></svg>'

  root.appendChild(tintEl)
  root.appendChild(spot)
  root.appendChild(frame)
  root.appendChild(cursor)
  document.documentElement.appendChild(root)

  frame.animate(
    [{ opacity: 0.55 }, { opacity: 1 }, { opacity: 0.55 }],
    { duration: 2600, iterations: Infinity, easing: 'ease-in-out' },
  )
}

function injSetTint(rootId: string, background: string) {
  const el = document.getElementById(rootId)?.querySelector('.tint') as HTMLElement | null
  if (el) el.style.background = background
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

// Step 1 of the nav cue: center the cursor and pop a "Navigating to …" pill
// above it. `label` is the finished display string (host parsing stays in the
// caller). Self-contained: re-finds the overlay by id, no closures/imports.
function injNavCue(rootId: string, label: string) {
  const root = document.getElementById(rootId)
  if (!root) return
  const cursor = root.querySelector('.cursor') as HTMLElement | null
  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  // The cursor carries a transform transition from mount, so this glides it to
  // center (a no-op on a fresh mount, where it already sits there).
  if (cursor) cursor.style.transform = `translate(${cx}px,${cy}px)`
  root.dataset.cx = String(cx)
  root.dataset.cy = String(cy)
  let pill = root.querySelector('.navlabel') as HTMLElement | null
  if (!pill) {
    pill = document.createElement('div')
    pill.className = 'navlabel'
    pill.style.cssText =
      'position:absolute;padding:4px 10px;background:#7ab8ff;color:#04101f;border-radius:7px;' +
      'font:600 12px system-ui;white-space:nowrap;pointer-events:none;' +
      'box-shadow:0 2px 10px rgba(122,184,255,.55);transform:translate(-50%,-150%);'
    root.appendChild(pill)
  }
  pill.textContent = label
  // Anchor to the cursor tip; the transform lifts the pill above and centers it.
  pill.style.left = `${cx}px`
  pill.style.top = `${cy}px`
  pill.style.display = 'block'
  pill.animate(
    [
      { opacity: 0, transform: 'translate(-50%,-120%)' },
      { opacity: 1, transform: 'translate(-50%,-150%)' },
    ],
    { duration: 260, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' },
  )
}

// Step 2 of the nav cue: ramp the tint to the heavy dark wash over `ms`, and
// fade in a `.navshimmer` layer — two blue radial blobs that drift and pulse on
// desynced infinite loops (transform + opacity only, so the compositor carries
// them; no injected <style>/keyframes). Inserted right after `.tint` so the
// cursor and pill stay above it.
function injNavDarken(rootId: string, tint: string, ms: number) {
  const root = document.getElementById(rootId)
  if (!root) return
  const tintEl = root.querySelector('.tint') as HTMLElement | null
  if (tintEl) {
    tintEl.style.transition = `background ${ms}ms ease`
    tintEl.style.background = tint
  }
  if (root.querySelector('.navshimmer')) return
  const shimmer = document.createElement('div')
  shimmer.className = 'navshimmer'
  shimmer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;'
  const blob = (css: string) => {
    const b = document.createElement('div')
    b.style.cssText = 'position:absolute;border-radius:50%;' + css
    shimmer.appendChild(b)
    return b
  }
  const b1 = blob(
    'width:70vw;height:70vh;left:-10vw;top:-15vh;' +
      'background:radial-gradient(circle,rgba(122,184,255,.5),rgba(122,184,255,0) 65%);',
  )
  const b2 = blob(
    'width:65vw;height:65vh;right:-12vw;bottom:-18vh;' +
      'background:radial-gradient(circle,rgba(150,205,255,.42),rgba(150,205,255,0) 65%);',
  )
  if (tintEl) tintEl.insertAdjacentElement('afterend', shimmer)
  else root.appendChild(shimmer)
  shimmer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out', fill: 'forwards' })
  b1.animate(
    [
      { transform: 'translate(-6%,-4%) scale(1)', opacity: 0.55 },
      { transform: 'translate(12%,8%) scale(1.18)', opacity: 0.95 },
      { transform: 'translate(-6%,-4%) scale(1)', opacity: 0.55 },
    ],
    { duration: 3800, iterations: Infinity, easing: 'ease-in-out' },
  )
  b2.animate(
    [
      { transform: 'translate(8%,6%) scale(1.1)', opacity: 0.5 },
      { transform: 'translate(-10%,-6%) scale(1)', opacity: 0.85 },
      { transform: 'translate(8%,6%) scale(1.1)', opacity: 0.5 },
    ],
    { duration: 4600, iterations: Infinity, easing: 'ease-in-out' },
  )
}

function injHidden(rootId: string, hidden: boolean) {
  const root = document.getElementById(rootId)
  if (root) root.style.display = hidden ? 'none' : 'block'
}

function injUnmount(rootId: string) {
  document.getElementById(rootId)?.remove()
}

const ATTR = 'data-agent-idx'

// Tabs with the overlay currently mounted, so a turn's `finally` can tear them
// all down (ambient frames live outside any page-control session).
const mounted = new Set<number>()

async function run(tabId: number, func: (...a: any[]) => void, args: any[]): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => {})
}

/** Mount the persistent presence overlay on the tab (ambient: frame only, no tint). */
export function mountPresence(tabId: number): Promise<void> {
  mounted.add(tabId)
  return run(tabId, injMount, [ROOT_ID, TINT])
}

/** Turn the soft dark tint on (entering active control) or off (back to ambient). */
export function setTint(tabId: number, on: boolean): Promise<void> {
  return run(tabId, injSetTint, [ROOT_ID, on ? TINT : 'transparent'])
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

/**
 * Pre-navigation intent cue for a `goto`: pop a "Navigating to …" pill on the
 * cursor, hold ~650ms so it reads, then darken the page with a blue shimmer over
 * ~550ms — on the tab's *current* page, in the window before it swaps. `label`
 * is the finished display string. Best-effort: every injection rides `run`
 * (which swallows failures), so a restricted page just skips the cue; the caller
 * always continues to the real navigation. The load then wipes the overlay, so
 * there is nothing to tear down.
 */
export async function animateNavIntent(tabId: number, label: string): Promise<void> {
  await mountPresence(tabId)
  await run(tabId, injNavCue, [ROOT_ID, label])
  await new Promise((r) => setTimeout(r, NAV_HOLD_MS))
  await run(tabId, injNavDarken, [ROOT_ID, NAV_TINT, NAV_DARKEN_MS])
  await new Promise((r) => setTimeout(r, NAV_DARKEN_MS))
}

/** Hide/show the overlay (used to take a clean screenshot). */
export function setPresenceHidden(tabId: number, hidden: boolean): Promise<void> {
  return run(tabId, injHidden, [ROOT_ID, hidden])
}

/** Remove the overlay from one tab. */
export function unmountPresence(tabId: number): Promise<void> {
  mounted.delete(tabId)
  return run(tabId, injUnmount, [ROOT_ID])
}

/** Remove the overlay from every tab it's mounted on (turn-end cleanup). */
export async function unmountAllPresence(): Promise<void> {
  const ids = [...mounted]
  mounted.clear()
  await Promise.all(ids.map((id) => run(id, injUnmount, [ROOT_ID])))
}
