// Each alarm performs bounded MCP requests, then disconnects. No long-lived
// stream or model generation is entrusted to the MV3 worker's lifetime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { syncTaskAlarm } from './taskAlarm'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { ChromeOAuthProvider } from '../mcp/auth'
import { mcpSettings, mcpToolPolicy, serverEnabled } from '../mcp/config'
import { loadSettings } from '../data/settings'
import { listMcpTasks, updateMcpTask, mcpConfigHash, terminalTask, type StoredMcpTask } from '../data/mcpTasks'

export const MCP_TASK_ALARM = 'mcp-tasks'
const OPTIONS = { timeout: 15_000 }
let polling: Promise<void> | undefined

export function pollMcpTasks(): Promise<void> {
  return polling ??= poll().finally(() => { polling = undefined })
}

async function poll() {
  const records = await listMcpTasks()
  if (!records.some(record => !record.ready && record.nextPollAt <= Date.now())) return
  const settings = mcpSettings(await loadSettings())
  // Bounded batches keep an alarm well below the worker's five-minute limit.
  const due = records.filter((r) => !r.ready && r.nextPollAt <= Date.now() && serverEnabled(settings, r.server) && mcpToolPolicy(settings, r.server, r.tool) !== 'never').sort((a, b) => a.nextPollAt - b.nextPollAt).slice(0, 4)
  await Promise.allSettled(due.map(async (record) => {
    const entry = settings.servers[record.server]
    if (!entry || record.configHash !== await mcpConfigHash(entry)) {
      await updateMcpTask(record.id, () => undefined)
      return
    }
    if (!serverEnabled(settings, record.server) || mcpToolPolicy(settings, record.server, record.tool) === 'never') return
    const client = new Client({ name: 'lychee-ai-task-monitor', version: '0.5.0' }, {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    })
    try {
      const url = new URL(String(entry.url))
      const options = { authProvider: new ChromeOAuthProvider(record.server, url.toString()), requestInit: entry.headers ? { headers: entry.headers } : undefined }
      // Preserve server session ownership across panel/worker lifetimes.
      const transport = new StreamableHTTPClientTransport(new URL(String(entry.url)), { ...options, sessionId: record.sessionId })
      if (record.sessionId) transport.setProtocolVersion(record.protocolVersion ?? '2025-11-25')
      try {
        await client.connect(transport, OPTIONS)
      } catch (error) {
        await transport.close().catch(() => {})
        // A persisted Streamable HTTP session must not silently become a new session.
        if (record.sessionId || /unauthorized|401/i.test(String(error))) throw error
        await client.connect(new SSEClientTransport(new URL(String(entry.url)), options), OPTIONS)
      }
      const task = await client.experimental.tasks.getTask(record.task.taskId, OPTIONS)
      let patch: Partial<StoredMcpTask> = { task, error: undefined, nextPollAt: Date.now() + Math.max(1000, task.pollInterval ?? 5000) }
      if (task.status === 'completed') {
        const result = await client.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema, OPTIONS)
        patch = { ...patch, result, ready: true }
      } else if (terminalTask(task)) {
        patch = { ...patch, ready: true, error: task.statusMessage || `MCP task ${task.status}.` }
      }
      // Configuration may change during network I/O. Never deliver stale results
      // or resurrect a record removed when its chat/server was deleted.
      const current = mcpSettings(await loadSettings()).servers[record.server]
      if (!current || await mcpConfigHash(current) !== record.configHash) return
      await updateMcpTask(record.id, (old) => old && ({ ...old, ...patch }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const expiresAt = record.task.ttl === null ? Infinity : Date.parse(record.task.createdAt) + record.task.ttl
      await updateMcpTask(record.id, (old) => old && ({
        ...old, error: message, nextPollAt: Date.now() + 60_000,
        ...(Date.now() > expiresAt ? { ready: true, error: `Task result expired or became unavailable: ${message}` } : {}),
      }))
    } finally {
      await client.close().catch(() => {})
    }
  }))
}

export function installMcpTaskMonitor() {
  const schedule = () => void pollMcpTasks().then(async () => {
    await syncTaskAlarm(MCP_TASK_ALARM, (await listMcpTasks()).some(task => !task.ready))
  }).catch(console.error)
  schedule()
  chrome.runtime.onInstalled.addListener(schedule)
  chrome.runtime.onStartup.addListener(schedule)
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MCP_TASK_ALARM) schedule()
  })
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'mcp-task.changed') schedule()
  })
}
