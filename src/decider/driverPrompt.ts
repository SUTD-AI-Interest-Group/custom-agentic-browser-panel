// `@driver` — a composer message sent straight to the on-device decision model (Driver mode's
// FastSteps) instead of the chat model. PURE: no Chrome, no AI SDK, no engine. Shared by the panel
// (Chat.tsx parses the message and checks availability) and, through the `DriverSpec` type, by the
// offscreen chat host (src/background/chatHost.ts runs the scripted model, src/agent/driverScript.ts).
//
// The decider cannot write text. Everything it can type must already exist: the double-quoted
// spans of the message become FastSteps' `values` (keyed by the word before each quote, so
// `search "wireless headphones"` → `{ search: … }`, which the value question reads as
// `request.search`), and the user's profile memories reach it through the existing cached profile
// lookup. The token itself grants nothing — every approval card still stands.

/** What a driver turn hands FastSteps: the user's message as the goal, and its quoted values. */
export interface DriverSpec {
  goal: string
  values: Record<string, string>
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
 * Double-quoted spans: straight `"…"` or curly `“…”` (either closing quote closes either opening
 * one, since a keyboard's smart quotes and a pasted straight quote mix). The inside never holds a
 * quote character.
 */
const QUOTED = /["“]([^"“”]*)["”]/g

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
 * MAX_DRIVER_VALUE_CHARS each.
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
  return { goal, values }
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
