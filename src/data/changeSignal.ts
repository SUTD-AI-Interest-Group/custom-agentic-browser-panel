/** Small invalidation messages; records and secrets stay in IndexedDB. */
export function createChangeSignal(name: string) {
  const listeners = new Set<(key: string) => void>()
  let channel: BroadcastChannel | undefined
  const deliver = (key: string) => {
    for (const listener of listeners) {
      try { listener(key) } catch (error) { console.error(error) }
    }
  }
  const connect = () => {
    if (!channel && typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(name)
      channel.onmessage = (event) => {
        if (typeof event.data === 'string') deliver(event.data)
      }
    }
    return channel
  }
  return {
    subscribe(listener: (key: string) => void) {
      listeners.add(listener)
      connect()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { channel?.close(); channel = undefined }
      }
    },
    publish(key: string) {
      deliver(key)
      connect()?.postMessage(key)
      if (!listeners.size) { channel?.close(); channel = undefined }
    },
  }
}

/** Coalesce invalidations, never overlap reads, and re-read if a change lands
 * during a read. Return a delay only when a liveness check is still needed. */
export function observeChanges(signal: ReturnType<typeof createChangeSignal>, key: string, read: () => Promise<number | void>) {
  let alive = true, reading = false, dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    dirty = true
    if (reading || !alive) return
    reading = true
    clearTimeout(timer)
    try {
      do {
        dirty = false
        const delay = await read()
        if (alive && !dirty && delay) timer = setTimeout(() => void refresh(), delay)
      } while (alive && dirty)
    } catch (error) {
      if (alive) {
        console.error(error)
        timer = setTimeout(() => void refresh(), 5000)
      }
    } finally { reading = false }
  }
  const unsubscribe = signal.subscribe(changed => { if (changed === key) void refresh() })
  void refresh()
  return () => { alive = false; clearTimeout(timer); unsubscribe() }
}

/** Subscribe BEFORE reading. A change during a read makes the next wait immediate.
 * Timeouts recover from a context being killed before it can publish a commit. */
export function changeMailbox(signal: ReturnType<typeof createChangeSignal>, key: string) {
  let dirty = false
  let wake: (() => void) | undefined
  const unsubscribe = signal.subscribe((changed) => {
    if (changed !== key) return
    dirty = true
    wake?.()
  })
  return {
    wait(timeout: number) {
      if (dirty) { dirty = false; return Promise.resolve() }
      return new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); wake = undefined; dirty = false; resolve() }
        const timer = setTimeout(finish, timeout)
        wake = finish
      })
    },
    close() { unsubscribe(); wake?.() },
  }
}
