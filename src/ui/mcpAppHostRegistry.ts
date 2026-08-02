/**
 * Per-conversation registry of the host actions an `<McpAppCard>` needs
 * (approval-gated tool calls, composer drafting).
 *
 * Keyed by conversationId — NOT a single shared slot — because the panel
 * deliberately keeps a background conversation mounted alongside the visible
 * one (see tabChats.ts's `liveChatIds`), so more than one conversation can be
 * registering actions at once. A single shared slot would let one
 * conversation's app card be serviced by a DIFFERENT conversation's approval
 * state (its "Allow this chat" grants, its session-allow set) whenever that
 * other conversation happened to render most recently — see CLAUDE.md's MCP
 * invariant and the CRITICAL cross-conversation-approval-bypass finding this
 * module fixes.
 *
 * Kept pure and React-free (no hooks, no JSX) so it's directly unit-testable
 * without mounting any component.
 */
export interface McpAppHostActions {
  /** Approval-gated tool call, scoped by the caller to one server. */
  callTool(server: string, tool: string, args: unknown): Promise<unknown>
  /** Put app-suggested text in the composer as a draft the user reviews. */
  draftMessage(text: string): void
}

const registry = new Map<string, McpAppHostActions>()

/**
 * Register (or replace) one conversation's host actions. Returns a cleanup
 * that removes the entry — but only if it's still the one this call
 * installed, so an out-of-order cleanup (e.g. a stale effect cleanup racing a
 * newer registration for the same conversation) can never delete a newer
 * registration. Call the returned cleanup from the registering effect's own
 * cleanup so an unmounted/switched-away conversation can never be mistaken
 * for one still able to service tool calls.
 */
export function registerMcpAppHostActions(conversationId: string, actions: McpAppHostActions): () => void {
  registry.set(conversationId, actions)
  return () => {
    if (registry.get(conversationId) === actions) registry.delete(conversationId)
  }
}

/** Look up the host actions for one conversation, or null if none are registered. */
export function getMcpAppHostActions(conversationId: string): McpAppHostActions | null {
  return registry.get(conversationId) ?? null
}
