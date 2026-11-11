import { storageErrorMessage } from '../data/durableDatabase'
import { useEffect, useRef } from 'react'
import { claimMcpCompletion, listMcpTasks, updateMcpTask, MCP_TASK_CHANGED, type StoredMcpTask } from '../data/mcpTasks'

/** A leased durable inbox. Multiple panels cannot consume the same event. */
export function useMcpCompletions(conversationId: string, ready: () => boolean, consume: (record: StoredMcpTask, canContinue: () => boolean) => Promise<boolean>) {
  const current = useRef({ ready, consume })
  current.current = { ready, consume }
  useEffect(() => {
    let alive = true, busy = false, failures = 0, retryAfter = 0, lastError = ''
    let renewal: ReturnType<typeof setInterval> | undefined
    const owner = crypto.randomUUID()
    const check = async () => {
      if (!alive || busy || Date.now() < retryAfter || !current.current.ready()) return
      busy = true
      try {
        const records = await listMcpTasks()
        for (const candidate of records) {
          if (!alive || !current.current.ready()) break
          if (candidate.conversationId !== conversationId || !candidate.ready || candidate.delivered || candidate.suppressed) continue
          const record = await claimMcpCompletion(candidate.id, owner)
          if (!record) continue
          renewal = setInterval(() => {
            if (alive) void updateMcpTask(record.id, (old) => old?.lease?.owner === owner
              ? { ...old, lease: { owner, until: Date.now() + 60_000 } } : old).catch(() => {})
          }, 20_000)
          let consumed = false
          try {
            if (alive && current.current.ready()) consumed = await current.current.consume(record, () => alive && current.current.ready())
          } finally {
            clearInterval(renewal)
            if (alive) await updateMcpTask(record.id, (old) => old?.lease?.owner === owner
              ? { ...old, delivered: consumed || old.delivered, lease: undefined } : old)
          }
          if (consumed) break
        }
        failures = 0; retryAfter = 0; lastError = ''
      } catch (error) {
        if (!alive) return
        retryAfter = Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(failures++, 4))
        const detail = storageErrorMessage(error)
        if (detail !== lastError) console.error(`[mcp] completion delivery failed: ${detail}`)
        lastError = detail
      }
      finally { busy = false }
    }
    const onMessage = (message: { type?: string }) => { if (message?.type === MCP_TASK_CHANGED) void check() }
    chrome.runtime.onMessage.addListener(onMessage)
    const interval = setInterval(() => void check(), 5000)
    void check()
    return () => { alive = false; clearInterval(interval); clearInterval(renewal); chrome.runtime.onMessage.removeListener(onMessage) }
  }, [conversationId])
}
