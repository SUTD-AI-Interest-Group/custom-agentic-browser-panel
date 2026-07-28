// The "Ask Lychee about this" context menu: right-click a selection, link,
// image, or the page itself to hand it straight to the panel. The ids and the
// (re)registration live here rather than in background.ts so the ordering
// hazard below can be unit-tested against a fake chrome.contextMenus.

export const CONTEXT_MENU_IDS = {
  selection: 'lychee-ask-selection',
  link: 'lychee-ask-link',
  image: 'lychee-ask-image',
  page: 'lychee-ask-page',
} as const

const CONTEXT_MENU_ITEMS: chrome.contextMenus.CreateProperties[] = [
  { id: CONTEXT_MENU_IDS.selection, title: 'Ask Lychee about this selection', contexts: ['selection'] },
  { id: CONTEXT_MENU_IDS.link, title: 'Ask Lychee about this link', contexts: ['link'] },
  { id: CONTEXT_MENU_IDS.image, title: 'Ask Lychee about this image', contexts: ['image'] },
  { id: CONTEXT_MENU_IDS.page, title: 'Ask Lychee about this page', contexts: ['page'] },
]

/**
 * Serializes registrations against each other. Module scope is the right
 * lifetime: the race is between two listeners in ONE service worker, and a
 * restarted worker re-registers from a clean slate anyway.
 */
let registration: Promise<void> = Promise.resolve()

/**
 * (Re)create the menu items, and resolve once they exist. removeAll() first,
 * since onInstalled and onStartup can both fire across a single install (an
 * update staged before a browser restart) and chrome.contextMenus.create
 * rejects a duplicate id.
 *
 * removeAll is *async*, though, so a bare removeAll-then-create is not enough:
 * when both events fire in one worker, BOTH removeAll calls reach the browser
 * before either callback runs, so the second batch of creates lands on the ids
 * the first batch just added — "Cannot create item with duplicate id
 * lychee-ask-selection", once per item. Chaining on `registration` makes the
 * second call wait for the first to finish *creating*, so its own removeAll has
 * something to remove.
 *
 * Reading runtime.lastError in the create callback is the second half. A
 * duplicate create is harmless in itself (the item is already there); what
 * Chrome escalates into a logged extension error is an *unchecked* lastError.
 */
export function registerContextMenus(): Promise<void> {
  registration = registration.then(
    () =>
      new Promise<void>((resolve) => {
        chrome.contextMenus.removeAll(() => {
          let pending = CONTEXT_MENU_ITEMS.length
          const done = () => {
            const err = chrome.runtime.lastError // reading it is what marks it checked
            if (err) console.debug('[menus] create skipped:', err.message)
            if (--pending === 0) resolve()
          }
          for (const item of CONTEXT_MENU_ITEMS) chrome.contextMenus.create(item, done)
        })
      }),
  )
  return registration
}
