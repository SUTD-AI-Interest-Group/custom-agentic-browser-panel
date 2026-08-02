/**
 * "Stick to bottom" for the transcript, as a pure predicate.
 *
 * The transcript used to scroll to its own bottom on EVERY `messages` change —
 * and `messages` gets a new identity on every streamed token (see the `patch`
 * helper in Chat.tsx). So while a reply was streaming, a user who scrolled up
 * to re-read an earlier message was yanked back down within one token, roughly
 * ten times a second. Reading back through a long turn was impossible for
 * exactly as long as the turn ran, which is when a transcript is most worth
 * re-reading.
 *
 * The fix is the standard one: follow the tail only while the viewport is
 * already parked at (or very near) the bottom, and stop following the moment
 * the user scrolls away. Kept pure and DOM-free so the threshold arithmetic —
 * the part that is easy to get subtly wrong, and impossible to eyeball in a
 * browser — is unit-tested directly.
 */

/** The three numbers a scroll container reports; the DOM shape, narrowed. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * How far from the bottom still counts as "at the bottom", in CSS pixels.
 *
 * Not zero: sub-pixel layout, a growing final bubble, and Chrome's own
 * fractional `scrollTop` mean an untouched container routinely reports a
 * remainder of a pixel or two. A zero threshold would read that as "the user
 * scrolled up" on the very first token and never follow the stream again.
 * Comfortably smaller than one line of text, so a deliberate scroll of even one
 * wheel notch still detaches.
 */
export const STICK_THRESHOLD_PX = 64

/**
 * True when the viewport is close enough to the bottom that the transcript
 * should keep following new content.
 *
 * A container shorter than its viewport (`scrollHeight <= clientHeight`, i.e. a
 * chat with one short message) yields a negative distance and is correctly
 * treated as at-the-bottom — there is nothing to scroll, so the tail is always
 * in view.
 */
export function isNearBottom(m: ScrollMetrics, threshold: number = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold
}
