import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ConversationsList from './ConversationsList'
import { listConversations, togglePin } from '../../data/conversations'
vi.mock('../../data/conversations', () => ({ listConversations: vi.fn(), togglePin: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn() }))
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.mocked(listConversations).mockResolvedValue([{ id: 'chat', title: 'A conversation', updatedAt: Date.now(), messageCount: 2 }] as any)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks() })
async function render(onOpen = vi.fn()) {
  await act(async () => root.render(createElement(ConversationsList, { currentConversationId: '', onOpen, onConversationsChanged: vi.fn() })))
}
it('only opens the conversation when the row itself receives Enter, not its nested controls', async () => {
  const open = vi.fn()
  await render(open)
  await act(async () => host.querySelector('[title="Pin conversation"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(open).not.toHaveBeenCalled()
  await act(async () => host.querySelector('.library-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(open).toHaveBeenCalledExactlyOnceWith('chat')
})
it('shows failed writes without removing the existing conversation', async () => {
  vi.mocked(togglePin).mockRejectedValueOnce(new Error('Storage unavailable'))
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Pin conversation"]')!.click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable')
  expect(host.querySelector('.library-row')?.textContent).toContain('A conversation')
})
it('lets a failed initial read be retried instead of presenting an empty library', async () => {
  vi.mocked(listConversations).mockRejectedValueOnce(new Error('Storage unavailable'))
  await render()
  expect(host.textContent).toContain('Storage unavailable')
  expect(host.textContent).not.toContain('No conversations')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector('.library-row')?.textContent).toContain('A conversation')
})
