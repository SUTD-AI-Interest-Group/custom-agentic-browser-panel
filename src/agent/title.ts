// Pure cleanup for the auto-generated chat title. Kept out of provider.ts (and
// free of any AI SDK / chrome import) so it can be unit-tested directly.

/** Longest title we keep; the history menu truncates well before this. */
const MAX_TITLE = 60

/**
 * Turn a model's raw reply into a chat title, or null if it yielded nothing
 * usable. Defensive about the two ways a small "just reply with the title" call
 * comes back dirty:
 *
 * - Chain-of-thought inlined in `content`. Most OpenAI-compatible servers split
 *   thinking into `reasoning_content`, but not all do — and a title of "<think>"
 *   is worse than no title at all.
 * - A conversational preamble ("Sure! Here's a title:") ahead of the real answer,
 *   which is why we can't just take the first line.
 */
export function sanitizeTitle(raw: string): string | null {
  const thoughtless = raw
    // A complete inline thinking block.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // …or a dangling one, when the server ate the opening tag but not the close.
    .replace(/^[\s\S]*<\/think>/i, '')
  const lines = thoughtless
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // "Here is a title:" announces the answer rather than being it.
  const line = lines[0]?.endsWith(':') && lines[1] ? lines[1] : lines[0]
  if (!line) return null
  const title = line
    .replace(/^["'“”]+|["'“”.]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE)
  return title || null
}
