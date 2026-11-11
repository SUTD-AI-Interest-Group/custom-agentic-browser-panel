import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { watchInput, validateWatch, matchesWatch, listPageWatches, updatePageWatch, type PageWatch } from '../data/pageWatches'
import { observeWatchTarget } from '../platform/pageWatch'
import { getShot } from '../data/screenshots'
import type { ApprovalRequest } from './tools'

export function createPageWatchTools(options: {
  conversationId: string
  resolveTab: () => Promise<chrome.tabs.Tab | undefined>
  approve: (request: ApprovalRequest) => Promise<boolean>
}): ToolSet {
  return {
    CreatePageWatch: tool({
      description: 'Watch a website component on a schedule and notify once when a condition matches. User MUST specify BOTH interval and deadline; ask for missing values, never assume them. First use ReadPage to locate a unique stable component. Use attached component screenshots as context, or GetElementScreenshot to clarify; if ambiguous ask the user to use the camera component picker. Supports text and enabled/disabled conditions, NOT visual-only interpretation. Checks reopen the URL in temporary inactive tabs, even if the original closes, while Chrome runs. No exact timing guarantee. Show the concrete condition and timing before activation.',
      inputSchema: watchInput,
      execute: async (input) => {
        try {
          validateWatch(input)
          if ((await listPageWatches()).filter(w => w.status === 'active').length >= 20) throw new Error('At most 20 active watches are supported. Cancel an existing watch first.')
          const tab = await options.resolveTab()
          if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('Open the HTTP(S) page to watch first.')
          const url = new URL(tab.url)
          if (url.username || url.password) throw new Error('URLs containing credentials cannot be watched.')
          if (input.screenshotId) {
            const shot = await getShot(input.screenshotId)
            if (!shot || shot.conversationId !== options.conversationId || shot.url !== tab.url) throw new Error('Screenshot must belong to this conversation and page.')
          }
          const approved = await options.approve({
            toolName: 'CreatePageWatch', once: true,
            summary: `Watch ${tab.url}\n${input.description}\nComponent: ${input.selector}\nCondition: ${input.condition}${input.text ? ` ${JSON.stringify(input.text)}` : ''}\nEvery ${input.intervalSeconds} seconds until ${input.deadline}\nLoads this URL in temporary inactive tabs; stops after one match.`,
            reason: 'Run scheduled checks and send a desktop notification when the condition matches.',
          })
          if (!approved) return { error: 'Watch was not approved.' }
          validateWatch(input)
          const baseline = await observeWatchTarget(tab.id, tab.url, input.selector)
          if (['enabled', 'disabled'].includes(input.condition) && !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'A'].includes(baseline.tag)) throw new Error('Choose a button, link, or form control for enabled/disabled checks.')
          const now = Date.now()
          const watch: PageWatch = { ...input, id: crypto.randomUUID(), conversationId: options.conversationId, url: tab.url, baseline, createdAt: now, deadlineAt: Date.parse(input.deadline), nextCheckAt: now + input.intervalSeconds * 1000, status: 'active' }
          if (input.condition !== 'text_changed' && matchesWatch(watch, baseline)) return { alreadyMatches: true, observation: baseline, note: 'Condition already matches. No watch created.' }
          await updatePageWatch(watch.id, () => watch)
          return { watchId: watch.id, status: watch.status, intervalSeconds: watch.intervalSeconds, deadline: watch.deadline, selector: watch.selector, note: 'Checks run while Chrome is available, using fresh inactive tabs. Screenshots are setup context; recurring checks use component text/state. Ask ListPageWatches for status or CancelPageWatch to stop.' }
        } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
      },
    }),
    ListPageWatches: tool({
      description: 'List website watches and their latest observations, errors, deadlines, and notification status for this conversation.',
      inputSchema: z.object({}),
      execute: async () => ({ watches: (await listPageWatches()).filter(w => w.conversationId === options.conversationId) }),
    }),
    CancelPageWatch: tool({
      description: 'Stop a scheduled website watch in this conversation. It will no longer check or notify.',
      inputSchema: z.object({ watchId: z.string() }),
      execute: async ({ watchId }) => {
        let found = false
        await updatePageWatch(watchId, old => {
          if (!old || old.conversationId !== options.conversationId) return old
          found = true
          return { ...old, status: 'cancelled' }
        })
        return { cancelled: found }
      },
    }),
  }
}
