# November 2026 Update

The recent work has been about making Lychee easier to live with as it does more:
chats that continue in the background, page-specific tools, Studio, scheduled
watches, and fewer things waking up when nobody needs them.

I wanted the extra capability to make the application more useful without making
every screen, state transition and background process more complicated. The
11 November pass follows that through both the interface and resource ownership.

## Where the code stands

There are two development histories to keep clear here:

- **Merged into `main`:** the October MCP transport/OAuth/subscription work,
  interactive clarification, durable server tasks, remote skills and the
  follow-up user-journey fixes. The
  [integration record](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/bb027218be5b0be384232f4d99b44fc86fff2afb/docs/development-handoff.md)
  records the 17 October merge and its verification.
- **Pushed, still unmerged on 11 November:** the optimisation and background
  cleanup snapshot at
  [`9180e33`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/commit/9180e33bb35e1cf688a8861443307aacbe6e7b8d),
  on `codex/optimisation-background-cleanup`. This also commits the supporting
  durable-chat, Studio, page-watch and local-companion work already present in
  that checkout. It is not yet an integration of all the newer `main` changes.

The repository records a 0.5.0 store submission on 14 October with manual
publishing. That is a historical submission record; this wiki update does not
establish its current store status or publish a new extension build.

## The feature changes and the choices behind them

**Background chats have a durable run, independent of the panel.** The panel
observes the run and can reattach after reopening. Stop still cancels. This gives
the UI a simpler job and avoids making a React component's lifetime decide whether
the user's work survives. Approval waits and tool results stay associated with
the run, so reconnecting does not mean replaying a completed action.

**Native WebMCP exposes the page's own actions.** Discovery tracks tool identity
and metadata changes, so an action shown earlier cannot silently execute against
a different current definition. The browser verification covers denial, changed
tools, cancellation, deadlines and no automatic replay after uncertain completion.
Suggestions are now explicitly requested; opening a page does not trigger a model
call to invent them. The hardening is recorded in
[`5ed9969`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/commit/5ed9969),
with the idle-work changes in `9180e33`.

**Studio gives site customisation a place of its own.** Fonts, a paired palette,
element removal and CSS/JavaScript belong to the current origin. Agent-generated
changes appear for review before **Save & apply**. Saved styles and scripts can
survive panel closure and browser restart; the foreground editor does not need
to remain mounted to keep the customisation working. The
[Studio guide](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/docs/features/studio-mode.md)
records the execution and permission boundaries.

**Page watches turn a repeated check into a bounded job.** Setup needs a target,
condition, interval and deadline, shown for approval. Each check reads a fresh
temporary tab and uses deterministic DOM conditions; it does not call a model or
click through the page. A match ends the watch. If the target becomes ambiguous
or inaccessible, the watch needs attention instead of guessing. The
[page-watch guide](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/docs/features/page-watches.md)
also explains missed intervals, user-owned tabs and notification limits.

**The local ChatGPT companion has a separate lifetime and trust boundary.** The
branch includes an optional native messaging companion, installed separately,
that keeps its credentials outside extension JavaScript and storage. Existing
API-key providers do not need it. Its automated tests cover transport, storage
and cancellation; installation and real account authorization were not exercised
in this pass. The
[companion README](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/companion/chatgpt/README.md)
is the implementation guide, not evidence of live account acceptance.

## Making that extra work cheaper to keep around

The optimisation pass removed repeated explanatory copy, consolidated foreground
surface state, loaded secondary screens on demand, and replaced idle polling with
change notifications. In the measured five-chat fixture, idle panel database
transactions went from 61 to zero and script injections from four to zero over
3.2 seconds. Initial side-panel entry JavaScript fell by about 10.1% minified.
The sampling boundary and bundle caveats are in
[Simplifying Lychee](Simplifying-Lychee).

The follow-up accounted for the resources behind those features: the shared
offscreen host, model calls, tool connections, browser-tab leases, workers,
sandbox frames, caches and alarms. A job finishing, failing or being cancelled
now has explicit release paths, while work that should survive panel closure
continues. [Background Work and Cleanup](Background-Work-and-Cleanup) explains
the races, the ownership rules and what the real-browser checks established.
