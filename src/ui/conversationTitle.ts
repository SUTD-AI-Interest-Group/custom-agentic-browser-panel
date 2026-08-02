/** Display title for a conversation whose auto-namer hasn't produced one yet. */
export function conversationTitle(title: string | null): string {
  return title ?? 'New chat'
}
