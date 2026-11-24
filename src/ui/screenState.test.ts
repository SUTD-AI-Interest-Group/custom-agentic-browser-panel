import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestReads, readScreen } from './screenState'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('latestReads', () => {
  it('an older read that finishes last never overwrites a newer one', async () => {
    const written: string[] = []
    const reads = latestReads<string>((v) => written.push(v))
    const older = deferred<string>()
    const newer = deferred<string>()
    reads.start(() => older.promise)
    reads.start(() => newer.promise)
    newer.resolve('new')
    older.resolve('old')
    await reads.settled()
    expect(written).toEqual(['new'])
  })

  it('settled() follows a read started while it was waiting', async () => {
    let value = ''
    const reads = latestReads<string>((v) => { value = v })
    const first = deferred<string>()
    const second = deferred<string>()
    reads.start(() => first.promise)
    const done = reads.settled()
    // A tab event lands while the chain is waiting on its own read.
    reads.start(() => second.promise)
    first.resolve('stale')
    let settled = false
    void done.then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    second.resolve('fresh')
    await done
    expect(value).toBe('fresh')
  })

  it('a failed read writes nothing and does not wedge settled()', async () => {
    const write = vi.fn()
    const reads = latestReads<string>(write)
    const failing = deferred<string>()
    reads.start(() => failing.promise)
    failing.reject(new Error('tabs API unavailable'))
    await reads.settled()
    expect(write).not.toHaveBeenCalled()
  })
})

describe('readScreen', () => {
  afterEach(() => vi.unstubAllGlobals())

  const tab = (id: number, extra: Partial<chrome.tabs.Tab> = {}) =>
    ({ id, windowId: 1, active: true, title: `T${id}`, url: `https://t${id}.test/`, ...extra }) as chrome.tabs.Tab

  function stubTabs(active: chrome.tabs.Tab[], byId: Record<number, chrome.tabs.Tab> = {}) {
    const get = vi.fn(async (id: number) => {
      if (!byId[id]) throw new Error('No tab with id')
      return byId[id]
    })
    vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => active), get } })
    return { get }
  }

  it('reports the focused tab and costs no extra call when the bound tab is on screen', async () => {
    const { get } = stubTabs([tab(7)])
    expect(await readScreen(7)).toEqual({
      onScreen: [{ tabId: 7, title: 'T7', url: 'https://t7.test/', favIconUrl: undefined }],
      boundTab: null,
      boundOnScreen: true,
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('names the bound tab when the user has switched away from it', async () => {
    stubTabs([tab(7)], { 3: tab(3, { active: false }) })
    const state = await readScreen(3)
    expect(state.boundOnScreen).toBe(false)
    expect(state.boundTab?.tabId).toBe(3)
  })

  it('a closed bound tab reads as off screen with nothing to name', async () => {
    stubTabs([tab(7)])
    expect(await readScreen(3)).toMatchObject({ boundOnScreen: false, boundTab: null })
  })

  it('a chat with no bound tab is never reported as drifted from it', async () => {
    stubTabs([tab(7)])
    expect(await readScreen(undefined)).toMatchObject({ boundOnScreen: true, boundTab: null })
  })
})
