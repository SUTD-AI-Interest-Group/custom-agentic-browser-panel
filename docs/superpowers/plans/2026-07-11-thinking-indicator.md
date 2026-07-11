# Whimsical Thinking Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single easy-to-miss "thinking" dot with a whimsical waiting indicator (three bouncing dots + a rotating gerund + a whole-turn elapsed timer) that also fills the currently-blank gap between tool steps.

**Architecture:** A new presentational `ThinkingIndicator` component in `Chat.tsx` renders while the turn is streaming but nothing is visibly appearing. `MessageView` decides when to show it purely from `streaming` + the shape of the last part (no changes to `agent.ts`). Turn-start time is promoted from a `send()` local to component state so the timer can render.

**Tech Stack:** React 18 (function components, `useState`/`useEffect`), plain CSS with `@keyframes`, TypeScript strict. No new dependencies.

## Global Constraints

- **No test suite** (per `CLAUDE.md`). Do **not** add a test framework. Each implementation task gates on `npm run build` (`tsc --noEmit && vite build`) passing; the final task is a manual browser verification via the `/verify-extension` flow.
- **Code style:** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** */` on exported/non-obvious units.
- **Aesthetic:** "Dia-inspired: quiet neutrals, bubble-less assistant text." Secondary UI is muted gray via `var(--text-muted)`, ~13px, system font. New styling must stay in that language.
- **Do not touch** the `pulse` function in `src/tools/tools.ts` / `src/platform/presence.ts` — that is the on-page click pulse, unrelated to the CSS `@keyframes pulse` being removed here.
- Imports: `useState`/`useEffect` are already imported at the top of `Chat.tsx` (`import { useEffect, useMemo, useRef, useState } from 'react'`) — no import changes needed.

---

### Task 1: Indicator styles

Replace the old single-dot styles with the bouncing-dots indicator styles, plus a reduced-motion fallback. CSS-only; the interim visual (the still-present `<div className="thinking-dot" />` in `MessageView`, removed in Task 2) will render as a single 5px bouncing dot until Task 2 lands — harmless.

**Files:**
- Modify: `src/ui/styles.css` (the `.thinking-dot` + `@keyframes pulse` block, currently lines ~582–598)

**Interfaces:**
- Consumes: nothing.
- Produces (class names Task 2's component depends on): `.thinking-indicator`, `.thinking-dots`, `.thinking-dot`, `.thinking-elapsed`.

- [ ] **Step 1: Replace the styles block**

Find this exact block in `src/ui/styles.css`:

```css
.thinking-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}
```

Replace it with:

```css
/* ---- Thinking / waiting indicator ---- */

/* Shown while a turn is live but nothing is visibly streaming: before the first
   token, and in the gap after a tool result while the model decides its next
   move. Muted and bubble-less to match the assistant text. */
.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.thinking-dots {
  display: inline-flex;
  align-items: flex-end;
  gap: 3px;
}

.thinking-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: thinking-bounce 1.2s ease-in-out infinite;
}

/* Stagger the three dots so the bounce ripples left-to-right. */
.thinking-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.thinking-dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes thinking-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.thinking-elapsed {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dot {
    animation: none;
    opacity: 0.6;
  }
}
```

- [ ] **Step 2: Verify the build passes**

Run: `npm run build`
Expected: exits 0, `dist/` written, no TypeScript errors. (CSS isn't type-checked, but this confirms nothing else broke.)

- [ ] **Step 3: Commit**

```bash
git add src/ui/styles.css
git commit -m "feat: bouncing-dots styles for thinking indicator"
```

---

### Task 2: ThinkingIndicator component + wiring

Add the component and the word pools, promote turn-start time to state, and swap the old dot for the new indicator with its show condition.

**Files:**
- Modify: `src/ui/Chat.tsx` — add `THINKING_WORDS`/`DIGESTING_WORDS` + `ThinkingIndicator` (above `MessageView`, ~line 1270); add `turnStartedAt` state (~line 231); promote the `send()` local (~line 786 & 853) and clear it in the `finally` (~line 880); pass the prop at the `MessageView` call site (~line 951); update `MessageView` signature + show condition (~line 1270 & 1299).

**Interfaces:**
- Consumes (from Task 1): CSS classes `.thinking-indicator`, `.thinking-dots`, `.thinking-dot`, `.thinking-elapsed`.
- Produces: `ThinkingIndicator` is internal to `Chat.tsx`; no external consumers.

- [ ] **Step 1: Add word pools + component above `MessageView`**

Insert immediately **before** the line `function MessageView({ message, streaming }: ...` (currently line 1270):

```tsx
// Whimsical waiting-state words, two registers blended (dry-witty + gen-z) so
// the indicator reads differently turn to turn. Random-per-mount starting word;
// index is `% length`, so ordering doesn't matter.
const THINKING_WORDS = [
  'Thinking', 'Pondering', 'Percolating', 'Noodling', 'Cerebrating',
  'Ruminating', 'Marinating', 'Conjuring', 'Mulling', 'Puzzling', 'Brewing',
  'Simmering', 'Wrangling', 'Untangling', 'Musing', 'Cogitating', 'Scheming',
  'Reticulating splines', 'Computing', 'Contemplating', 'Incubating',
  'Concocting', 'Hatching', 'Churning', 'Crunching', 'Formulating',
  'Deliberating', 'Stewing', 'Tinkering', 'Whirring', 'Spitballing',
  'Ideating', 'Plotting', 'Daydreaming', 'Head-scratching',
  'Cooking', 'Locking in', 'Big braining', 'Galaxy braining', 'Manifesting',
  'Vibing', 'Sussing it out', 'Understanding the assignment', 'Lowkey grinding',
  'Deadass thinking', 'Cracked mode engaged', 'Cooking up something',
  'In my thinking era', 'Brain going brrr', 'Spinning up the neurons',
  'Doing the thing', 'Locking in fr', 'No thoughts just cooking',
  "Chef's kiss incoming", 'Working on the glow-up',
]

// Shown in the gap right after a tool result, while the model reads what came
// back and decides its next move.
const DIGESTING_WORDS = [
  'Reviewing', 'Digesting', 'Parsing', 'Absorbing', 'Interpreting',
  'Synthesizing', 'Processing', 'Distilling', 'Piecing it together',
  'Making sense of it', 'Cross-referencing', 'Sifting', 'Connecting the dots',
  'Untangling the results', 'Weighing it up', 'Sorting it out',
  'Reading the receipts', 'Peeping the results', 'Reading the room',
  'Doing the math', 'Vibe-checking the output', 'Catching up on the tea',
  'Fact-checking the vibes', 'Putting the pieces together fr',
  'Decoding the lore',
]

/**
 * Whimsical waiting-state indicator: three bouncing dots, a rotating word, and
 * a whole-turn elapsed timer. Rendered by MessageView while the turn is
 * streaming but nothing is visibly appearing. `startedAt` is the turn start
 * (ms) so the timer stays continuous across tool steps; `variant` picks the
 * word pool. A fresh random offset per mount makes successive gaps in one turn
 * read differently.
 */
function ThinkingIndicator({
  startedAt,
  variant,
}: {
  startedAt: number
  variant: 'thinking' | 'digesting'
}) {
  const [now, setNow] = useState(() => Date.now())
  const [baseOffset] = useState(() => Math.floor(Math.random() * 1000))

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const pool = variant === 'digesting' ? DIGESTING_WORDS : THINKING_WORDS
  // Rotate roughly every 3s; continuous elapsed keeps it moving across steps.
  const word = pool[(baseOffset + Math.floor(elapsed / 3)) % pool.length]

  return (
    <div className="thinking-indicator" role="status" aria-label="Assistant is working">
      <span className="thinking-dots" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
      <span aria-hidden="true">{word}…</span>
      {elapsed >= 1 && (
        <span className="thinking-elapsed" aria-hidden="true">
          {elapsed}s
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add `turnStartedAt` state**

Find (line ~231):

```tsx
  const [streaming, setStreaming] = useState(false)
```

Add directly below it:

```tsx
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
```

- [ ] **Step 3: Promote the `send()` turn-start local to state**

Find (lines ~785–786):

```tsx
    setStreaming(true)
    const turnStartedAt = Date.now()
```

Replace with:

```tsx
    setStreaming(true)
    const startedAt = Date.now()
    setTurnStartedAt(startedAt)
```

Then find the journal push that used the old local (line ~853):

```tsx
        { role: 'user', text: journalUserText, at: turnStartedAt },
```

Replace with:

```tsx
        { role: 'user', text: journalUserText, at: startedAt },
```

- [ ] **Step 4: Clear turn-start in the `finally`**

Find (line ~880, inside the `send()` `finally` block):

```tsx
      setStreaming(false)
```

Replace with:

```tsx
      setStreaming(false)
      setTurnStartedAt(null)
```

- [ ] **Step 5: Pass the prop at the `MessageView` call site**

Find (lines ~951–955):

```tsx
          <MessageView
            key={msg.id}
            message={msg}
            streaming={streaming && i === messages.length - 1}
          />
```

Replace with:

```tsx
          <MessageView
            key={msg.id}
            message={msg}
            streaming={streaming && i === messages.length - 1}
            turnStartedAt={turnStartedAt}
          />
```

- [ ] **Step 6: Update `MessageView` signature and swap the dot for the indicator**

Find the signature (line ~1270):

```tsx
function MessageView({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null)
```

Replace with:

```tsx
function MessageView({
  message,
  streaming,
  turnStartedAt,
}: {
  message: UIMessage
  streaming: boolean
  turnStartedAt: number | null
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
```

Then find the assistant-return body (lines ~1289–1300):

```tsx
  return (
    <div className="msg-assistant">
      <div className="msg-assistant-body" ref={bodyRef}>
        {message.parts.map((part, i) =>
          part.type === 'text' ? (
            <AssistantText key={i} text={part.text} />
          ) : (
            <ToolPill key={part.toolCallId} part={part} />
          ),
        )}
        {message.parts.length === 0 && <div className="thinking-dot" />}
      </div>
```

Replace with (adds the `digesting` derivation just before `return`, and swaps the last line of the body):

```tsx
  // Show the waiting indicator while the turn is live but nothing is visibly
  // streaming: before the first part (thinking), or in the gap right after a
  // tool result while the model decides its next move (digesting). The inline
  // `turnStartedAt != null` also narrows it to a number for the prop.
  const last = message.parts[message.parts.length - 1]
  const digesting = last?.type === 'tool' && last.state === 'done'

  return (
    <div className="msg-assistant">
      <div className="msg-assistant-body" ref={bodyRef}>
        {message.parts.map((part, i) =>
          part.type === 'text' ? (
            <AssistantText key={i} text={part.text} />
          ) : (
            <ToolPill key={part.toolCallId} part={part} />
          ),
        )}
        {streaming &&
          turnStartedAt != null &&
          (message.parts.length === 0 || digesting) && (
            <ThinkingIndicator
              startedAt={turnStartedAt}
              variant={digesting ? 'digesting' : 'thinking'}
            />
          )}
      </div>
```

- [ ] **Step 7: Verify the build passes**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. If `tsc` complains that `turnStartedAt` is possibly `null` at the `startedAt={turnStartedAt}` prop, confirm the `turnStartedAt != null &&` clause sits immediately before the JSX in the `&&` chain (that is what narrows it).

- [ ] **Step 8: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat: whimsical thinking/waiting indicator with elapsed timer"
```

---

### Task 3: Manual end-to-end verification

No automated tests exist; verify in the real extension.

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 2: Load/reload the unpacked extension**

`chrome://extensions` → Developer mode → reload the extension (or Load unpacked → select `dist/`). Open the side panel.

- [ ] **Step 3: Plain-question scenario (initial wait)**

Send a plain question (e.g. "tell me a joke"). Expected: immediately below the (empty) assistant reply, three dots bounce left-to-right with a rotating word (e.g. "Cooking…", "Percolating…") and, after 1s, a `Ns` elapsed timer. When text starts streaming, the indicator disappears.

- [ ] **Step 4: Tool scenario (between-steps gap + continuity)**

Send a task that triggers a tool (e.g. "summarize this page" on a normal web page, approving any card). Expected: the indicator shows before the first tool, hides while the tool pill is running, then **reappears** after the tool completes — now drawing from the digesting pool (e.g. "Reading the receipts…", "Digesting…") — and the elapsed timer **continues** from the turn's total (does not reset to 0). It disappears again once the final answer streams in.

- [ ] **Step 5: Reduced-motion**

Enable OS "Reduce motion" (macOS: System Settings → Accessibility → Display → Reduce motion), reload the panel, send a message. Expected: the dots no longer bounce (sit static, slightly dimmed) but the word + timer line still shows.

- [ ] **Step 6: Confirm no regressions**

Confirm the completed message's toolbar (copy/sources) still appears after streaming ends, and no stray dot/indicator lingers on finished messages.

---

## Self-Review

**Spec coverage:**
- Bouncing 3-dots glyph (staggered) → Task 1 CSS (`thinking-bounce`, `nth-child` delays) + Task 2 markup. ✓
- Rotating "playful & varied" words, random per mount, ~3s → Task 2 `THINKING_WORDS`, `baseOffset`, `Math.floor(elapsed / 3)`. ✓
- Context-aware thinking vs digesting pools → Task 2 `variant` + `digesting` derivation. ✓
- Whole-turn elapsed, continuous across steps, shown ≥1s → `startedAt` from turn-start state; `elapsed >= 1`. ✓
- Show during initial wait + between tool steps; hidden during active text / running tool / approval → Task 2 show condition (`parts.length === 0 || last done tool`). ✓
- Turn-start state + wiring → Task 2 Steps 2–5. ✓
- Accessibility (`role="status"`, stable `aria-label`, `aria-hidden` children, reduced-motion) → Task 2 markup + Task 1 media query. ✓
- Remove old `.thinking-dot`/`pulse`; don't touch JS `pulse` → Task 1 (constraint noted). ✓
- Files limited to `Chat.tsx` + `styles.css` → yes. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full content. ✓

**Type consistency:** `ThinkingIndicator` props (`startedAt: number`, `variant: 'thinking' | 'digesting'`) match both call/definition; `turnStartedAt: number | null` consistent across state, `MessageView` prop, and call site; `digesting` boolean matches `variant` selection. ✓
