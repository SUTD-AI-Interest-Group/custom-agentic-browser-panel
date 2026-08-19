# Agent Perception

How do you make a model *see* a webpage, when you don't control the model, don't
know if it has eyes, and the API you're talking to will happily pretend either
way?

---

## Don't assume vision. Measure it.

An OpenAI-compatible endpoint accepts an image part and tells you nothing about
whether the model behind it can actually process one. Some silently ignore it.
A hardcoded list of "vision-capable models" is wrong the moment someone points
the panel at a self-hosted endpoint — and this product's entire promise is that
they can.

So `src/agent/vision.ts` **probes**. It renders a 240×80 canvas containing a
4-character code, sends it once with *"reply with only the code,"* and grants the
model vision-capable status **only if it echoes the code back**. Anything else —
a refusal, a hallucination, a polite description of an image it never saw — counts
as blind. That last case is the one a static allowlist can never catch: *an
endpoint that silently drops the image part still answers you*, confidently.

The verdict is cached in `chrome.storage.local` per provider+model, so the probe
runs at most once per model. And the code is deliberately **fixed**, not random —
varying it would gain nothing and defeat the cache.

The original consequence was intentionally severe: for a model that failed the
probe, the screenshot tool was **deleted from the ToolSet entirely**, by the same
mechanism as a `never` policy — a tool whose entire product is an image is *worse
than absent* for a model that cannot see; it will call it, get nothing back, and
retry forever. That was the right instinct about the *loop* and the wrong mechanism,
and 20 July replaced it — see [The tool split, and stopped vanishing](#the-tool-split-and-stopped-vanishing).

`7f7d0f9` later bounded the probe with a 20-second timeout, because a hung
provider on a one-shot probe call otherwise hangs the feature it gates.

## The dead letter box

This is the best bug in the codebase.

`9d60c20` shipped set-of-marks perception — a screenshot with numbered boxes
drawn over the interactive elements — delivered to the model as a `media` part on
the tool's return value, via `toModelOutput`. It was clean, it was the obvious
design, and it did not work at all.

`7150b72` — *"Deliver set-of-marks via user-image injection instead of tool-result
media"* — records why:

> **The OpenAI-compatible adapter serializes a tool result's `media` part to plain
> text, so images never reach the model that way.**

We had built an image pipeline into a dead letter box. The screenshots were being
captured, marked up, encoded, attached — and then flattened to text before the
model ever saw them. Nothing errored. The model simply behaved as though it were
blind, because it was.

The fix is now a CLAUDE.md invariant: **an image can only reach the model through
`imageQueue`.** A perception tool pushes `{dataUrl, caption}` onto a shared
per-turn queue, and `prepareStep` drains it into a synthetic `user` message
before the next step — the one channel the adapter actually turns into an
`image_url`.

And the corollary, learned the hard way: **never put image data in a tool's return
value.** That lands in model history and gets re-sent on every subsequent step,
paying for the same picture forever.

### The caption that became a lie

`prepareStep` originally hardcoded one caption onto every drained image: *"Set-of-marks
screenshot — the numbered boxes correspond to the `[index]` values."*

True, while set-of-marks was the only producer. The moment the `Screenshot` tool
started pushing **unmarked** crops onto the same queue, that caption became a
lie — and a specific, dangerous one. As the spec puts it: *a model told "numbered
boxes correspond to indices" while looking at an unmarked crop of a bar chart
will hallucinate indices onto it.*

The caption now travels *with* the image. A shared channel needs per-item
metadata, not a channel-level assumption.

## Two registries, deliberately kept apart

The `Screenshot` tool (`6f0249a`, now split into `GetScreenshot`/`GetElementScreenshot`)
needed a *second* registry, and the temptation was to extend the first one. We didn't:

| | `domIndex` | `regionIndex` |
| --- | --- | --- |
| Answers | "What can I **click**?" | "What can I **look at**?" |
| Contents | interactive elements | charts, figures, tables, media |
| Scope | **viewport only** — you cannot click what you cannot see | **whole document** — you can screenshot below the fold |
| Address | `[3]` | `[r3]` |

The distinct `r` sigil is load-bearing. With bare integers in both, a model would
eventually aim `ControlPage({click, index: 1})` at a `<figure>` — which fails
opaquely. **Distinct sigils make that bug unrepresentable.** That's a nicer
property than "we validate and return a good error message," because it removes
the error case rather than handling it.

Unifying the two pickers onto one shared definition of "a component" then exposed
a bug that had been sitting in the *original* region-picker code all along:

> `svg.tagName` is `'svg'`, not `'SVG'`, so an uppercase compare drops every
> inline-SVG chart.

SVG elements are XML-cased. Every inline-SVG chart on the web — which is to say,
most charts — had been invisible to component detection, and nobody noticed until
two consumers shared one predicate. **Deduplication is a bug-finding technique.**

### Both registries paid for the whole page before the cap got a say

Both registries cap what they return — 200 elements for `domIndex`, 60 regions
(off a pool of up to 240 raw candidates) for `regionIndex` — but until `668f8c5`
that cap only bounded the *classification* loop, not the walk feeding it. Both
injected walkers built their candidate list with
`Array.from(root.querySelectorAll('*'))`, which materializes **every element in
the document** — recursing into every open shadow root — before either cap was
ever consulted. A huge or adversarial page paid a full-document allocation on
every single `ReadPage`, cap or no cap.

The fix looks the same on the surface for both files — walk children directly
and stop the instant the cap is hit, `false` propagating back up through every
enclosing call (shadow-root recursion included) so the *entire* walk halts, not
just the current node's siblings — but only `regionIndex` gets to do it in one
pass. `regionIndex` fuses walking with classification: nothing downstream of a
region depends on regions past the cap, so bailing early loses nothing.
`domIndex` cannot do the same thing, and the reason is a security one, not a
performance one: a `<label for="x">` routinely appears **after** its
`<input id="x">` in the markup — every checkbox/radio pattern is written that
way — and that label feeds the `sensitive` flag
([Page Control](Page-Control)'s point-of-no-return gate reads it directly). A
single fused walk that stopped at the element cap would classify an early
input before ever discovering the later label naming it, silently losing a
sensitivity detection for a field that was well inside the cap — exactly the
kind of gap [Page Control](Page-Control) documents `3bdd228` closing on the
detection side; capping the walk carelessly would have reopened it from the
other direction. So `domIndex`'s two passes split: an exhaustive label sweep
first (a tagName check plus two attribute reads per node — cheap, and never
triggers layout), *then* the capped, `getComputedStyle`/`getBoundingClientRect`
classification pass that actually stops at 200. Document order and
shadow-splice order are unchanged in both files, since correctness depends on
ancestors being visited before descendants either way.

### The stamps that outlived the session

`clearRegions()` — the `regionIndex.ts` counterpart to `domIndex.ts`'s
`clearIndex()`, stripping every `data-agent-region` stamp from the page —
existed from the moment `6f0249a` shipped element-level screenshots, but
nothing ever called it. Page control's `teardownSession()` stripped
`data-agent-idx` (that part of the fence is [Page Control](Page-Control)'s
own `76467a0` hardening pass) but never `data-agent-region`, and `ReadPage`
mode:`'regions'` deliberately skips
its own approval card whenever a page-control session already owns the tab —
so a session that read any regions left those stamps on the user's live page
indefinitely after the agent was done with it. `371b2a1` wired `clearRegions`
into `teardownSession` alongside `clearIndex`, found incidentally while
auditing dead code for an unrelated attachment-delivery fix. Both registries
now clean up after themselves the same way.

## Tall pages: one strip for you, tiles for the model

`captureVisibleTab` only ever returns the visible viewport of the *active* tab, so
anything taller is scroll-and-stitch. The planning math (`planStitch` / `planTiles`)
is pure and unit-tested; the Chrome/canvas code is a thin shell over it.

Three things the naive version gets wrong:

- **Sticky headers stamp themselves into every slice.** They're hidden from the
  *second* slice onward — slice 0 should show the real header once, or the
  stitched page "reads as a hall of mirrors."
- **`captureVisibleTab` is rate-limited** to roughly 2/sec and *silently rejects*
  past that. Captures are throttled.
- **A downscaled full-page strip is an illegible smear.** So a tall page goes to
  the **user** as one strip, but to the **model** as sequential full-resolution
  tiles — because the pages where full-page capture matters are exactly the pages
  where a downscale destroys the text you needed.

The full-resolution PNG lives in its own IndexedDB store; the tool returns a
`shotId`, and the UI reads the picture from disk. Only an ~8KB thumbnail ever goes
near the transcript.

## The tool split, and stopped vanishing

`6f0249a` shipped a single `Screenshot` tool. On 20 July a fresh spec
([`2026-07-20-screenshot-tools-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-20-screenshot-tools-design.md))
reworked it into two — **`GetScreenshot`** (the rendered viewport, `fullPage:true`
for the stitched strip) and **`GetElementScreenshot`** (one `[rN]` region) — and,
more importantly, changed *who is allowed to have them*.

Deleting the tool from a blind model's ToolSet, it turned out, threw away a real
feature: **every capture is also a user-facing artifact.** A text-only model can't
*see* a screenshot, but the human watching the panel absolutely can — and a
screenshot the user asked for shouldn't vanish because the model behind the panel
happens to lack eyes. So `80030e8` made both tools **always present**, and `1099b4f`
moved the vision decision out of "does the tool exist" and into a pure router,
`planShotDelivery`:

- **`send`** — vision-capable and within image budget: the shot is queued to the
  model *and* saved for the user.
- **`blind` / `budget`** — the model can't see it (or we're out of image budget):
  the shot is still saved and rendered for the user, and the tool result tells the
  model *in words* that no image was sent, so it doesn't loop waiting for one.

The old lesson — "a tool whose product is an image is worse than absent for a blind
model" — was right about the *loop* and wrong about the *tool*. The loop is killed by
the honest text result, not by deleting the tool; and this way the user keeps their
picture. `planShotDelivery` is pure and unit-tested, which is the tell that the hard
part was always the *decision*, not the capture.
