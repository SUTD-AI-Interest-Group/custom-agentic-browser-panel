# Type-to-focus composer

**Date:** 2026-07-23
**Status:** Approved

## Problem

With the side panel open but the composer unfocused (after scrolling the
transcript, clicking a card, or reopening the panel), typing goes nowhere. The
user should be able to just start typing.

## Design

One document-level `keydown` listener in `Chat.tsx` (registered once, ref-only)
that focuses the composer when a stray printable key is pressed, letting the
browser's default action deliver that same keystroke into the textarea — no
manual insertion, no `preventDefault`, no lost or doubled characters. The caret
moves to the end of any draft first.

Redirect only when ALL hold:

- The composer exists, is enabled, and is visible. Chat stays mounted but
  `display:none`-hidden behind Settings/Library (`App.tsx` `view-host
  is-hidden`), so visibility is checked via `offsetParent === null`.
- The event is unclaimed: not `defaultPrevented`, not IME composition
  (`isComposing`), and no Ctrl/Cmd/Alt modifier (Shift alone is fine — that's a
  capital letter). Cmd+C on selected transcript text keeps working.
- The key is a single printable character (`e.key.length === 1`; includes
  space). Tab, arrows, Escape, Enter, F-keys are untouched.
- The event does not already target an editable element (input, textarea,
  select, contenteditable) — never steal focus from another field.

## Testing

Chrome-coupled (focus + native key routing): verified in the loaded extension —
scroll the transcript, type, and see the characters land in the composer;
confirm Settings inputs and Cmd shortcuts are unaffected.
