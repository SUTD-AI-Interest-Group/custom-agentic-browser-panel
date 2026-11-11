# Simplifying Lychee

I wanted Lychee to feel as straightforward as Linear or Apple Notes. Simple
purpose, simple architecture, simple design, simple implementation. That meant
looking at what happens between features as carefully as the features themselves.

This is the 11 November 2026 optimisation pass, recorded in
[`9180e33`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/commit/9180e33bb35e1cf688a8861443307aacbe6e7b8d).
The initial snapshot was pushed on `codex/optimisation-background-cleanup`. It
has since been integrated with the newer `main` updates; see the [11 November integration record](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/verification/2026-11-11-optimisation-merge.md).
The measurements below retain the original optimisation cutoff. This is not a
store-release announcement.

## Start with the screen

The rule was simple: cut taglines, helper text and secondary labels. If a screen
needs a paragraph to explain its layout, fix the layout.

The empty chat lost its slogan and instruction block. The rotating thinking
phrases and mascot animation became a quiet status indicator. Settings, Library
and Studio lost repeated headings and explanatory copy. The website lost its
autoplay hero, decorative model marquee and count-up animation. The film is still
there, behind an explicit play action, in a dialog that handles Escape and returns
keyboard focus when it closes.

Permission consequences, units, setup requirements and useful errors stayed.
Those let someone make a decision. Repeating what the nearby button already says
doesn't.

One layout issue was easy to miss: the website's mobile hero passed an overflow
check while still squeezing its content into two columns. Conflicting CSS rules
were responsible. Consolidating them fixed the layout itself. A page can fit
inside the viewport and still be unpleasant to use.

## Give each state one owner

Settings, Studio and Library used to be controlled by separate booleans. Each
boolean made sense on its own; together they allowed combinations the product
never intended to show. `App` now owns one `surface` value. Library's selected tab
is part of that same choice.

Retained chats still keep their drafts and running work. Visibility now controls
the things that actually need a visible chat: selection capture, input focus and
UI clocks. Keeping a chat mounted should not let it keep behaving like the chat
you are looking at.

The same ownership question simplified other flows:

| Flow | What owns it now | What that fixes |
| --- | --- | --- |
| Onboarding | One provider draft and an `idle / testing / done` test state | Going back or changing the provider cancels the old test; a late result cannot validate new input |
| Settings | A local draft merged against the latest saved settings, with serialized writes | External updates reach untouched fields while local edits survive; encryption and writes cannot finish out of order |
| Tabs | One shared accessible tab component | Arrow keys, Home/End, focus and panel relationships behave consistently |
| Chat rendering | Presentation in `ChatViews`, orchestration in the chat controller | Message UI can change without adding more responsibility to the turn loop |

There is no new state-machine framework. The machines stay next to the features
they control. The chat controller is about 1,900 lines shorter, but it still owns
substantial orchestration. Moving code is useful only when the boundary becomes
easier to understand.

## Stop asking whether anything changed

Several parts of the panel repeatedly read IndexedDB to find out whether a run
had changed. That becomes expensive when five chats remain mounted and each one
has its own observer.

The replacement is a small invalidation signal. A writer commits a record, then
broadcasts its key. A subscriber reads that record from IndexedDB. Messages carry
keys, not transcripts or secrets; durable storage remains the source of truth.

The ordering matters. Subscribe **before** reading, or a change can land between
the read and the subscription and disappear from the observer's view. Reads are
serialized and coalesced. If another change arrives during a read, one trailing
read picks it up. Active approval waits and remote runs retain bounded liveness
checks because a browser context can die before publishing its notification.
Idle chats have no reason to keep asking.

Research now has one shared task subscription per panel. Streaming replies carry
a `partsVersion`, so a heartbeat does not need to serialize the whole transcript
just to discover that its text is unchanged.

Page selection follows the same approach: a debounced `selectionchange` listener
for the visible chat replaces repeated script injection. Native WebMCP tool
changes drive discovery where supported; older implementations keep a slower,
visible-only fallback. Suggested actions require a click before calling a model.
Simply opening a page no longer spends a model request on suggestions.

## Load a feature when it is opened

Settings, its six tabs, Library and Studio now load on demand. Studio's CSS is
separate too. PDF and Office parsing remain lazy. Link previews share in-flight
requests and use a bounded, expiring cache instead of growing indefinitely.

These changes help all three sides of the product. The user gets less unsolicited
work and clearer controls. The developer gets fewer overlapping owners. The
agent gets stable tool identity, current metadata and explicit outcomes instead
of stale actions or a false success message. UX, DX and AX are easier to improve
together when they depend on the same reliable state.

## What changed in the measurements

The idle comparison used the same disposable Chrome fixture, a local model
endpoint, a native WebMCP page and five mounted chats. The sampling window was
3.2 seconds after setup. Counters cover the side panel, not every Chrome process.

| Measurement | Before | After |
| --- | ---: | ---: |
| Idle panel IndexedDB transactions | 61 | 0 |
| Idle panel IndexedDB writes | 0 | 0 |
| Idle panel script injections | 4 | 0 |
| Unrequested model calls across the fixture | 1 | 0 |
| Side-panel entry JavaScript, minified | 764.85 kB | 687.85 kB |
| Side-panel entry JavaScript, gzip | 238.66 kB | 217.31 kB |
| Initial side-panel CSS, minified | 129.77 kB | 116.51 kB |
| Website JavaScript, minified | 442.57 kB | 437.38 kB |
| Website CSS, minified | 28.95 kB | 23.60 kB |

That is about **10.1% less entry JavaScript**, or **8.9% with gzip**. These bundle
figures were captured for the initial optimisation pass, before the follow-up
cleanup additions and this wiki update. They measure entry files, not total
transfer or startup time. The website also bundles its engineering-log text, so
adding articles changes its next build size.

Shared agent code and parser chunks remain large. The observed heap was lower,
but garbage collection was not controlled, so I am not treating that as a memory
benchmark. There is no measured CPU percentage, battery saving or “times faster”
claim here. The useful result is concrete: the idle fixture stopped doing those
reads, injections and unsolicited inference calls.

## Check the behaviour around the change

The pass covered all six Settings tabs, all three Library tabs, Studio,
onboarding, retained chats and the public site in real Chrome. Checks included
external settings updates while a field was dirty, closed-panel continuation,
Stop, native WebMCP tool changes, document tools and narrow layouts. The complete
scope and reproduction commands are in the
[optimisation record](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/docs/optimisation.md).

The next question was what happened after that work finished. That became a
separate pass through [Background Work and Cleanup](Background-Work-and-Cleanup).
