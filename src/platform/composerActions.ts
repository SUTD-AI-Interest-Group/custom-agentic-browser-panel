// A one-shot mailbox that carries a right-click "Ask Lychee about this" action
// from the service worker to the side panel. The panel may be CLOSED at the
// moment the context-menu item is clicked, so a plain runtime message would be
// dropped; the mailbox (chrome.storage.session) survives until the freshly
// opened panel mounts and drains it. The SW also broadcasts COMPOSER_ACTION_MSG
// as a best-effort nudge for the already-open case — the panel drains on both
// mount and message, whichever comes first, and the read clears the mailbox so
// the action fires exactly once.
//
// storage.session (not local): the action is transient UI intent, must not
// outlive the browser session, and its default TRUSTED_CONTEXTS access level
// reaches the SW and extension pages (the side panel) but not web content.

/** A right-click action the user asked to hand to the composer, by context. */
export type ComposerAction =
  | { kind: 'selection'; text: string; pageUrl: string; pageTitle?: string }
  | { kind: 'link'; url: string; pageUrl: string }
  | { kind: 'image'; srcUrl: string; pageUrl: string }
  | { kind: 'page'; pageUrl: string; pageTitle?: string }

/** Runtime message the SW broadcasts after staging an action, so an already-open
 *  panel drains immediately instead of only on its next mount. */
export const COMPOSER_ACTION_MSG = 'composer-action'

const KEY = 'pendingComposerAction'

/** Stage an action for the panel to pick up. Overwrites any un-drained action —
 *  only the most recent right-click matters. */
export async function setComposerAction(action: ComposerAction): Promise<void> {
  await chrome.storage.session.set({ [KEY]: action })
}

/** Read and remove the staged action in one shot (returns null if none). Both
 *  the mount-time read and the message-driven read call this, so whichever runs
 *  first consumes it and the other sees null — the action fires exactly once. */
export async function drainComposerAction(): Promise<ComposerAction | null> {
  const data = await chrome.storage.session.get(KEY)
  const action = (data[KEY] as ComposerAction | undefined) ?? null
  if (action) await chrome.storage.session.remove(KEY)
  return action
}
