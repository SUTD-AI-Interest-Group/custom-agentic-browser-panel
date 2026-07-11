# Whimsical thinking / waiting indicator

## Problem

While the panel waits for the endpoint to stream a reply, or while the model is
"thinking" between tool steps, the chat shows nothing useful. The only existing
cue is a single 8px pulsing dot (`.thinking-dot`), rendered by `MessageView`
**only** when the assistant message has zero parts:

```tsx
{message.parts.length === 0 && <div className="thinking-dot" />}
```

Two moments read as blank/empty and hurt UX:

1. **Initial wait** — after send, before the first token/tool arrives. The lone
   dot is easy to miss, so it reads as "nothing is happening."
2. **Between tool steps** — after a `tool-result` and before the next
   `text-delta`/`tool-call`, `parts` doesn't change, so the last completed tool
   pill just sits there with no sign the model is still working. Today there is
   **no** indicator here at all.

We want a small, whimsical, Claude-Code-style waiting indicator that fills both
moments.

## Architecture context (why the design is shaped this way)

- `src/ui/Chat.tsx` tracks turn activity with a **single** boolean `streaming`
  (set `true` just before `runAgentTurn`, back to `false` in the `send()`
  `finally`). There is no phase enum.
- The message list passes `streaming={streaming && i === messages.length - 1}`
  to `MessageView`, so only the last message's `MessageView` sees `streaming`.
- `src/agent/agent.ts`'s `runAgentTurn` emits `[...parts]` on every stream event
  (`text-delta`, `tool-call`, `tool-result`, `tool-error`). Between a
  `tool-result` and the next event, nothing is emitted — this silent window is
  the "between tool steps" gap. Phase must be **derived in the UI** from
  `streaming` + the shape of the last part; there is no per-turn phase signal to
  plumb through.
- `src/ui/styles.css` has exactly one animation (`@keyframes pulse`). Aesthetic
  (per the file header): "Dia-inspired: quiet neutrals, bubble-less assistant
  text." Secondary UI is muted gray (`var(--text-muted)`), ~12–13px, system
  font. New styling must stay in that language.

## Design

### Component: `ThinkingIndicator`

A new function component in `Chat.tsx`, placed next to `MessageView`. Renders a
single muted line:

```
•••  Percolating…   7s
```

- **Bouncing dots (the glyph):** three `<span class="thinking-dot">` (~5px,
  `var(--text-muted)`) inside a `<span class="thinking-dots">` flex row. All
  three share a new `@keyframes thinking-bounce` (translateY up-and-back with a
  small opacity lift) with staggered `animation-delay` (`0ms / 160ms / 320ms`)
  so the bounce ripples left-to-right. Under `prefers-reduced-motion: reduce`
  the animation is disabled (dots sit static and muted).
- **Rotating word:** a gerund + `…`, rotating every ~3s. "Playful & varied"
  vocabulary. Each time the indicator (re)mounts it starts from a fresh
  random word, so successive gaps within one turn read differently.
- **Context-aware word pool:**
  - *Initial wait* (`parts.length === 0`) draws from the **thinking** pool.
  - *After a completed tool* (last part is a `tool` with `state === 'done'`)
    draws from the **digesting** pool (Reviewing, Digesting, Parsing,
    Absorbing, Interpreting, Synthesizing, …).
  The pool is chosen by a `variant: 'thinking' | 'digesting'` prop.
- **Elapsed timer:** whole-turn seconds since turn start, continuous across tool
  steps (does **not** reset per gap). Shown only once `elapsed >= 1`. Driven by
  a single `setInterval(…, 1000)` living in the component; cleared on unmount.

Word rotation is derived from the elapsed tick plus a per-mount random base
offset — no second interval is needed:

```
word = POOL[(baseOffset + Math.floor(elapsedSeconds / 3)) % POOL.length]
```

`Date.now()` / `Math.random()` are used directly (ordinary React code — the
Workflow-script restriction on those does not apply here).

### When it shows (in `MessageView`)

Replace the current `parts.length === 0` dot with:

```tsx
const last = message.parts[message.parts.length - 1]
const digesting = last?.type === 'tool' && last.state === 'done'
const showThinking = streaming && (message.parts.length === 0 || digesting)
...
{showThinking && (
  <ThinkingIndicator
    startedAt={turnStartedAt ?? Date.now()}
    variant={digesting ? 'digesting' : 'thinking'}
  />
)}
```

- Covers (a) waiting for the first token and (b) the gap after a tool finishes.
- Hidden while text is actively streaming (last part is `text`), while a tool is
  `running`, and while awaiting approval (last part is a `running` tool) — those
  states already convey activity via streamed text / the tool pill / the
  approval card.
- When the turn ends, `streaming` flips to `false` and the indicator disappears.
  A brief flash where `streaming` is still true and the last part is a done tool
  (turn ending on a tool) is acceptable.

### Turn-start time

Add `const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)` to
`Chat`. Set `setTurnStartedAt(Date.now())` where `setStreaming(true)` happens in
`send()`. Pass `turnStartedAt` into `MessageView` (new prop) and on to
`ThinkingIndicator`. It only matters while `streaming` is true, so it need not
be cleared, but MessageView only reads it when `showThinking` is true.

### Accessibility

- Container: `role="status"` with a **stable** `aria-label="Assistant is
  working"`; all visible children (`aria-hidden="true"`). Screen readers
  announce once on insertion, not on every word swap or timer tick.
- Glyph animation gated behind `prefers-reduced-motion`.

### Styling (`styles.css`)

- Add `.thinking-indicator` (flex row, `gap`, `var(--text-muted)`, ~13px),
  `.thinking-dots` (flex row, small gap), `.thinking-dot` (repurpose: ~5px
  circle, `var(--text-muted)`, `thinking-bounce` animation with per-nth-child
  `animation-delay`), `.thinking-word`, `.thinking-elapsed`.
- Add `@keyframes thinking-bounce`.
- The old `.thinking-dot` + `@keyframes pulse` block is replaced. `pulse` is
  unused elsewhere (only `.thinking-dot` referenced it), so it is removed with
  it. (Verify no other `pulse`/`.thinking-dot` references before deleting.)

## Files touched

- `src/ui/Chat.tsx` — new `ThinkingIndicator` component; `turnStartedAt` state +
  wiring; `MessageView` new `turnStartedAt` prop and revised show condition.
- `src/ui/styles.css` — indicator styles + `thinking-bounce` keyframe; remove
  old `.thinking-dot`/`pulse`.

## Word pools (initial content — tune freely)

- **thinking:** Thinking, Pondering, Percolating, Noodling, Cerebrating,
  Ruminating, Marinating, Conjuring, Mulling, Puzzling, Brewing, Simmering,
  Wrangling, Untangling, Musing, Cogitating, Scheming, Reticulating splines,
  Computing, Contemplating.
- **digesting:** Reviewing, Digesting, Parsing, Absorbing, Interpreting,
  Synthesizing, Processing, Distilling, Piecing it together, Making sense of it.

## Out of scope

- No spinner added to *running* tool pills (they already show a labeled pill).
- No reasoning / thinking-token streaming from the model.
- No change to `agent.ts` — phase is derived entirely in the UI.

## Verification

No test suite. Per `/verify-extension`: `npm run build`, reload the unpacked
extension, then in the side panel:

1. Send a plain question → confirm bouncing-dots + rotating word + elapsed timer
   appear during the wait, then vanish when text streams in.
2. Send a task that triggers a tool (e.g. summarize the current page) → confirm
   the indicator reappears in the gap after the tool completes, with a
   "digesting" word, and the elapsed timer continues (does not reset).
3. Toggle OS "reduce motion" → confirm dots stop bouncing but the line still
   shows.
