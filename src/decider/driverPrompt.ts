// `@driver` — a composer message sent straight to the on-device decision model (Driver mode's
// FastSteps) instead of the chat model. PURE: no Chrome, no AI SDK, no engine. Shared by the panel
// (Chat.tsx parses the message and checks availability) and, through the `DriverSpec` type, by the
// offscreen chat host (src/background/chatHost.ts runs the scripted model, src/agent/driverScript.ts).
//
// The decider cannot write text. Everything it can type must already exist: the double-quoted
// spans of the message become FastSteps' `values` (keyed by the word before each quote, so
// `search "wireless headphones"` → `{ search: … }`, which the value question reads as
// `request.search`), and the user's profile memories reach it through the existing cached profile
// lookup. A message that quotes nothing offers its own phrases instead (goalPhrases), each still
// text the user wrote. The token itself grants nothing — every approval card still stands.

/** What a driver turn hands FastSteps: the user's message as the goal, and its quoted values. */
export interface DriverSpec {
  /** The user's words, token removed — what the turn is matched by (driverScript.ts turnStart). */
  goal: string
  values: Record<string, string>
  /**
   * The goal as the DECIDER sees it, when it differs: only when the values are goal phrases (no
   * quoted text) — `search for "<first phrase>", then <goal>` (frameGoal). The scripted run hands it
   * to RequestPageControl as the plan and to FastSteps as the goal; the user bubble and the
   * model-facing history keep the user's own words.
   */
  deciderGoal?: string
}

export const DRIVER_TOKEN = '@driver'
/** `@driver` as a word: start of text or after whitespace, and not a prefix of a longer word. */
export const DRIVER_TOKEN_RE = /(^|\s)@driver\b/i
const DRIVER_TOKEN_ALL = /(^|\s)@driver\b/gi

/** At most this many quoted values ride along; the rest are ignored. */
export const MAX_DRIVER_VALUES = 8
/** A quoted value longer than this is cut. */
export const MAX_DRIVER_VALUE_CHARS = 500
/** A key longer than this is cut (relay.ts refuses a key over 64). */
const MAX_DRIVER_KEY_CHARS = 40

/** Does this message ask for the decision model? */
export function isDriverMessage(text: string): boolean {
  return DRIVER_TOKEN_RE.test(text)
}

/**
 * The message without its `@driver` token(s) — the copy the model-facing history keeps, so a later
 * chat-model turn reads a plain instruction. Only the token and one space after it go; the rest of
 * the text (line breaks included) is left as typed.
 */
export function stripDriverToken(text: string): string {
  return text.replace(/(^|\s)@driver\b[ \t]?/gi, '$1').trim()
}

/**
 * `text` with every occurrence of each tab-mention token removed. A tab titled "Driver Booster" is
 * inserted as `@Driver Booster`, which reads as the @driver token; the mentions are attachments, not
 * words of the request, so they are taken out before anything looks for the token. Longest first,
 * so a token that contains another is removed whole.
 */
export function withoutMentionTokens(text: string, tokens: readonly string[]): string {
  let out = text
  for (const t of [...tokens].sort((a, b) => b.length - a.length)) if (t) out = out.split(t).join('')
  return out
}

/**
 * The @driver spec for a composed message, or undefined when it is an ordinary one: its tab-mention
 * tokens are removed first (withoutMentionTokens), and a leading `/skill` is never combined with it.
 */
export function driverSpecFor(text: string, mentionTokens: readonly string[] = []): DriverSpec | undefined {
  if (/^\/[a-z0-9-]+(?:\s|$)/.test(text)) return undefined
  const routable = withoutMentionTokens(text, mentionTokens)
  return isDriverMessage(routable) ? parseDriverPrompt(routable) : undefined
}

/**
 * The model-facing copy of a driver message: the tab-mention tokens and the @driver token removed —
 * the same text driverSpecFor parsed the goal from, which is how the scripted run finds its turn.
 */
export function driverModelText(text: string, mentionTokens: readonly string[] = []): string {
  return stripDriverToken(withoutMentionTokens(text, mentionTokens))
}

/**
 * Double-quoted spans: straight `"…"` or curly `“…”` (either closing quote closes either opening
 * one, since a keyboard's smart quotes and a pasted straight quote mix). The inside never holds a
 * quote character. A quote right after a digit is an inch mark (`the 15" laptop`), never an opening.
 */
const QUOTED = /(?<!\d)["“]([^"“”]*)["”]/g

/** The key for a value: the word right before its opening quote, lowercased, `[a-z0-9_]` only. */
function keyBefore(between: string): string {
  const words = between.trimEnd().split(/\s+/)
  const word = (words[words.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  return word.slice(0, MAX_DRIVER_KEY_CHARS) || 'text'
}

/**
 * `{ goal, values }` for a driver message. `goal` is the message with the token removed and its
 * whitespace collapsed (quotes kept: they are part of what the user asked for). `values` holds each
 * non-empty quoted span, keyed by the word immediately before its opening quote — only the text
 * between the previous quote and this one counts, so a value never names the next — falling back
 * to `text`; a repeated key becomes `key_2`, `key_3`, …. Capped at MAX_DRIVER_VALUES values of
 * MAX_DRIVER_VALUE_CHARS each. A message with NO quoted value offers its goal's candidate phrases
 * instead (goalPhrases: `phrase`, `phrase_2`, …), so "add the blue Aurora mug to my cart" can still
 * search for "blue Aurora mug" — the decider picks one of them for a field, or leaves it empty.
 */
export function parseDriverPrompt(text: string): DriverSpec {
  const goal = text.replace(DRIVER_TOKEN_ALL, '$1').replace(/\s+/g, ' ').trim()
  const values: Record<string, string> = {}
  let count = 0
  let prevEnd = 0
  for (const m of goal.matchAll(QUOTED)) {
    const start = m.index ?? 0
    const between = goal.slice(prevEnd, start)
    prevEnd = start + m[0].length
    const value = m[1].trim()
    if (!value) continue
    if (count >= MAX_DRIVER_VALUES) break
    const base = keyBefore(between)
    let key = base
    for (let n = 2; Object.prototype.hasOwnProperty.call(values, key); n++) key = `${base}_${n}`
    values[key] = value.slice(0, MAX_DRIVER_VALUE_CHARS)
    count++
  }
  if (count > 0) return { goal, values }
  const phrases = goalPhrases(goal)
  // Framed as a search only for a search/shopping request: "click the login button" or "open my
  // orders" has nothing to search for, and telling the decider to search first would misdirect it.
  return phrases.phrase && isSearchRequest(goal) ? { goal, values: phrases, deciderGoal: frameGoal(goal, phrases.phrase) } : { goal, values: phrases }
}

/** The verbs of a search or shopping request, as whole words (`orders` and `add-on` are not). */
const SEARCH_VERB = /(?<![\w-])(?:search|find|look\s+for|buy|add|order|shop|get)(?![\w-])/i

/**
 * Is this goal a search/shopping request — the kind a search box serves? Only when one of its
 * verbs is present (SEARCH_VERB). Deliberately not "mentions the cart": "go to the checkout page
 * and fill in my address" names the checkout and has nothing to search for. Pure.
 */
export function isSearchRequest(goal: string): boolean {
  return SEARCH_VERB.test(goal)
}

/**
 * A goal whose text to type came from its own words, framed as a plan the decider can follow: the
 * search first, then the rest. Without it, the decider typed the phrase and then could not tell
 * that Search was the step the goal needed (p 0.32 for "add the blue Aurora mug to my cart"). Pure.
 */
export function frameGoal(goal: string, phrase: string): string {
  return `search for "${phrase}", then ${goal}`
}

/** The words a goal's phrases are split on ("of" is not one: "a pair of socks" is one thing). */
const CONNECTORS = ['to', 'into', 'in', 'on', 'for', 'from', 'and', 'then', 'with', 'under', 'over', 'below', 'above', 'at', 'by']
/** Leading imperative verbs, stripped from a phrase's start. */
const VERBS = new Set(['add', 'buy', 'get', 'find', 'search', 'look', 'open', 'go', 'show', 'put', 'order', 'pick', 'choose', 'select', 'click', 'type', 'fill'])
/** Leading determiners and possessives, stripped likewise. */
const DETERMINERS = new Set(['the', 'a', 'an', 'my', 'some', 'this', 'that', 'these', 'those', 'me'])
/** A phrase made only of these says nothing a field could take. */
const STOPWORDS = new Set([...CONNECTORS, ...VERBS, ...DETERMINERS, 'of', 'it', 'them', 'one', 'ones', 'please', 'now', 'up', 'out', 'i', 'you', 'us'])
/** A phrase naming the cart is where the goal ends, not something to type. */
const CART_WORD = /^(carts?|checkouts?|baskets?)$/
/** At most this many phrases are offered. */
export const MAX_DRIVER_PHRASES = 4

// A connector is a whole word: not part of a hyphenated one ("in-ear headphones" stays whole).
const SPLIT = new RegExp(`(?<![\\w-])(?:${CONNECTORS.join('|')})(?![\\w-])|[,;!?]|\\.(?=\\s|$)`, 'i')
const EDGES = /^[\s"“”'‘’()[\]{}:]+|[\s"“”'‘’()[\]{}:]+$/g
const bare = (word: string) => word.toLowerCase().replace(/^[^a-z0-9$]+|[^a-z0-9]+$/g, '')

/**
 * Candidate phrases from a goal that quotes nothing — what a search box could take. The goal is
 * split on connector words (CONNECTORS) and sentence punctuation; each chunk loses its leading
 * imperative verbs and determiners; a chunk that is then empty, all stopwords, or names the
 * cart/checkout/basket is dropped; the rest are deduped (case-insensitively) and capped at
 * MAX_DRIVER_PHRASES, keyed `phrase`, `phrase_2`, …. Pure.
 */
export function goalPhrases(goal: string): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const chunk of goal.split(SPLIT)) {
    const words = (chunk ?? '').replace(EDGES, '').split(/\s+/).filter(Boolean)
    while (words.length && (VERBS.has(bare(words[0])) || DETERMINERS.has(bare(words[0])))) words.shift()
    if (words.length === 0) continue
    if (words.every((w) => !bare(w) || STOPWORDS.has(bare(w)))) continue
    if (words.some((w) => CART_WORD.test(bare(w)))) continue
    const phrase = words.join(' ').replace(EDGES, '').slice(0, MAX_DRIVER_VALUE_CHARS)
    const k = phrase.toLowerCase()
    if (!phrase || seen.has(k)) continue
    seen.add(k)
    const n = seen.size
    out[n === 1 ? 'phrase' : `phrase_${n}`] = phrase
    if (n >= MAX_DRIVER_PHRASES) break
  }
  return out
}

/** What decides whether `@driver` can run right now. */
export interface DriverAvailability {
  /** The settings' decider mode (undefined = never set = off). */
  mode: string | undefined
  /** The imported model's status record says ready, for this build's model. */
  modelReady: boolean
  /** The tool policies (Settings → Permissions) of the two tools a driver turn calls, and ControlPage, which FastSteps follows. */
  requestPolicy: string
  controlPolicy: string
  fastStepsPolicy: string
}

/**
 * Why `@driver` cannot run, worded for the composer's inline error — or null when it can. Mode Off
 * still means off (the token is a per-message opt-in to Driver, not a way past Off).
 */
export function driverUnavailableReason(a: DriverAvailability): string | null {
  if (!a.mode || a.mode === 'off') return 'Turn the decision model on in Settings → Experimental.'
  if (!a.modelReady) return "The decision model isn't imported — Settings → Experimental."
  if (a.requestPolicy === 'never' || a.controlPolicy === 'never' || a.fastStepsPolicy === 'never')
    return 'Page control is set to Never in Settings → Permissions.'
  return null
}
