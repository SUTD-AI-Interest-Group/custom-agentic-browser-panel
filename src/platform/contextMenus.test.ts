import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { registerContextMenus, CONTEXT_MENU_IDS } from './contextMenus'

// onInstalled and onStartup can both fire in a single service worker (an update
// staged before a browser restart), so registerContextMenus must be safe to call
// twice concurrently. It was not: removeAll is async, so both calls' removeAll
// reached the browser before either callback ran, and the second batch of
// creates then collided with the ids the first batch had just added —
// "Unchecked runtime.lastError: Cannot create item with duplicate id
// lychee-ask-selection", once per menu item.

/**
 * A chrome.contextMenus stand-in that reproduces the ordering that matters: API
 * calls are dispatched to the browser in the order they are made and their
 * callbacks come back later, so work queued from callback A runs after every
 * call that was already in flight. Anything less faithful (synchronous
 * callbacks) cannot show the bug.
 */
function fakeChrome() {
  const items = new Set<string>()
  const attempts: string[] = []
  const duplicates: string[] = []
  const queue: (() => void)[] = []
  let lastError: { message: string } | undefined

  const chrome = {
    runtime: {
      get lastError() {
        return lastError
      },
    },
    contextMenus: {
      removeAll(cb: () => void) {
        queue.push(() => {
          items.clear()
          lastError = undefined
          cb()
        })
      },
      create(props: { id: string }, cb: () => void) {
        queue.push(() => {
          attempts.push(props.id)
          if (items.has(props.id)) {
            duplicates.push(props.id)
            lastError = { message: `Cannot create item with duplicate id ${props.id}` }
          } else {
            items.add(props.id)
            lastError = undefined
          }
          cb()
        })
      },
    },
  }

  // Drain until nothing new is queued — one entry per macrotask, so callbacks
  // that queue further calls land behind whatever was already in flight.
  async function settle() {
    for (let guard = 0; guard < 1000; guard++) {
      if (queue.length === 0) {
        await new Promise((r) => setTimeout(r, 0))
        if (queue.length === 0) return
      }
      queue.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    throw new Error('context-menu queue did not settle')
  }

  return { chrome, items, attempts, duplicates, settle }
}

let restore: unknown

beforeEach(() => {
  restore = (globalThis as any).chrome
})
afterEach(() => {
  ;(globalThis as any).chrome = restore
})

describe('registerContextMenus', () => {
  it('creates the four menu items', async () => {
    const fake = fakeChrome()
    ;(globalThis as any).chrome = fake.chrome

    const done = registerContextMenus()
    await fake.settle()
    await done

    expect([...fake.items].sort()).toEqual([...Object.values(CONTEXT_MENU_IDS)].sort())
    expect(fake.duplicates).toEqual([])
  })

  it('survives two overlapping registrations without a duplicate-id error', async () => {
    const fake = fakeChrome()
    ;(globalThis as any).chrome = fake.chrome

    // onInstalled and onStartup, back to back in one worker.
    const a = registerContextMenus()
    const b = registerContextMenus()
    await fake.settle()
    await Promise.all([a, b])

    // The second pass re-created the menu (8 attempts), but every create landed
    // on a cleared menu, so none of them collided.
    expect(fake.duplicates).toEqual([])
    expect(fake.attempts.length).toBe(8)
    // And the menu is left with exactly one of each item, not eight.
    expect([...fake.items].sort()).toEqual([...Object.values(CONTEXT_MENU_IDS)].sort())
  })
})
