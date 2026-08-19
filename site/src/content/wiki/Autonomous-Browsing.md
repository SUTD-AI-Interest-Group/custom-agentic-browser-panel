# Autonomous Browsing

Some pages will not be fetched. A 403, a bot wall, a login wall, a table that only
exists after you click a tab, results that only exist behind pagination. Headless
`fetch` loses those sources entirely — and the research agent's instinct when a
fetch fails is to *search again*, which quietly drops the best source on the floor
and settles for a worse one.

So `BrowseSite` lets the research agent drive a **real browser tab**.

Spec: [`2026-07-13-research-autonomous-browsing-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-13-research-autonomous-browsing-design.md).

---

## Nobody is watching. That changes everything.

In [Page Control](Page-Control), a human approves the session and re-approves
every irreversible step. Here, the user closed the panel twenty minutes ago. There
is no card to show and nobody to show it to.

The tech-centred answer is to let the model decide whether an action is safe. We
refused. `src/tools/browsePolicy.ts` is a **pure function** — deterministic,
exhaustively unit-tested, with no LLM anywhere in it. Its own header says it
plainly:

> No human is at the gate here… so the rule here is **"only do things that cannot
> commit anything."**

| Allowed | Refused |
| --- | --- |
| Read, scroll, extract | Logins |
| Navigate (SSRF-guarded, cross-origin OK) | Purchases |
| Site-search (an idempotent GET submit) | **Any non-search form submit** |

That last row is why `domIndex` learned to record a form's `formMethod`
(`2cb5795`): a GET search submit is idempotent and safe; a POST creates state. The
policy needs to tell them apart *structurally*, not by reading the button's label
and hoping.

**A model asked to police itself can be argued with. A pure function cannot be
prompt-injected.** This policy is the entire security model for this feature, so
it is kept pure and it is tested like it matters.

## The policy checks the request. A redirect happens after.

`browsePolicy.ts` decides whether an action is safe before the page is touched —
but it only ever sees the target the model *asked for*: a click's `el.href`, an
explicit `navigate`'s `url`. It has no way to see where a redirect actually
lands, because Chrome follows an HTTP redirect transparently and the extension
declares no `webNavigation`/`webRequest` permission to intercept the hop. A
`click` on an `<a href>` or a `navigate` action can therefore land the tab
somewhere the policy never approved: a public URL that 302s to
`169.254.169.254`, a LAN admin panel, or `localhost:<port>` — and the landed
page would be scraped into the notebook and reported to the user under the
original, safe-looking URL (`19412c7`).

The fix that shipped documents its own false starts rather than hiding them.
Re-checking the tab's URL once navigation completes was tried first, through an
intermediate helper the commit's own review history calls `checkLandedUrl` —
and it failed open on a URL it couldn't determine, silently waving a navigation
through whenever `chrome.tabs.get` itself hiccuped. Fixing *that* still left a
race: `renderPage` (the render escalation this page and [Deep
Research](Deep-Research) both drive through the same leased tab) scrolls and
sleeps 900ms after the check, to let lazy content load — and a page that passed
the check a moment earlier can redirect itself inside that window with a
delayed `location.href = ...`. Check-then-read is racy no matter how short the
gap between the two calls.

The fix that actually holds has no gap to race, because checking and reading
are the same call. `injExtractReadable` — the function injected into the page
to pull its readable text — now returns `location.href` alongside the content,
both captured in the same synchronous page-world execution. That's what gets
validated, never a URL sampled before or after. `observe()` (`researchBrowse.ts`)
applies the identical rule to its own two injections — `snapshotPage`'s element
registry and `readReadableText`'s excerpt — and refuses outright if the two
disagree, because elements pulled from one page and text pulled from another is
a wrong-URL citation even when both pages are individually public.

`navigateAndWait`'s own post-navigation check survives, demoted: it's now
documented as a fast path allowed to be optimistic (falling back to the
*requested* URL, not refusing outright, when `chrome.tabs.get` itself fails)
precisely *because* the atomic check downstream is what actually closes the
hole. The two are written to be read and changed together — weaken the atomic
check without noticing the fast path depends on it, and the race reopens. The
regression test names the exact bug it reproduces:
`TOCTOU: renderPage refuses when the page redirects DURING the scroll/settle
window, after navigateAndWait already passed` (`researchRender.test.ts`). None
of the previous suite could have caught this — every mock returned one static
URL, so the failing state (safe at check-time, unsafe at read-time) was
unrepresentable until the tests were rewritten to stage a *changing* URL across
successive injections.

One more property is what makes `location.href` trustworthy here at all: every
injected function on this surface runs with no `world` argument (the default,
isolated world — never the page's own JS realm) and no `allFrames` (top frame
only). A page's own script cannot shadow `location`, and an iframe's URL is
never what gets checked. (`captureVisibleTab` *does* composite cross-origin
iframe content that no top-frame check can see — which is why the render
escalation's screenshot mode never shipped; see [Deep Research](Deep-Research).)

The same commit closed an unrelated gap on the wider research surface:
`harvestImages` (behind the `SearchImages`/`HarvestImages` tools, called by the
main gather loop rather than the browse sub-agent) had no `isFetchableUrl`
guard on its request at all — the one network path on the whole surface that
lacked one. See [Deep Research](Deep-Research) for that side of the fix.

## A sub-agent, so the page walk doesn't poison the research

`BrowseSite` runs a **nested sub-agent** (`browseAgent.ts`) in its own context,
with its own step and wall-clock budget. It writes findings straight into the
shared notebook and returns only a digest.

The rejected alternative was obvious and much simpler: give the gather agent the
browse verbs directly. We didn't, because a page walk generates a dozen element
registries, and every one of them would land in the gather agent's history and be
re-sent on every subsequent step. The research agent would spend its entire
context remembering what the buttons on a cookie banner were called.

**Isolate the verbose thing. Return the summary.**

## One tab, leased

Both consumers — the passive one-shot render escalation and the active browse
session — lease the *same* isolated tab from `researchTab.ts`: incognito when
allowed, minimized, mutex'd, idle-torn-down, and swept for orphans if the service
worker restarts.

A session holds its lease for its entire life, so a concurrent render can't
navigate the page out from under an in-progress page walk.

Incognito is preferred for a specific reason: **a real tab navigation rides your
profile's cookie jar**, unlike a headless `fetch`. An isolated incognito window
means the research agent browses as a stranger, not as you.

## Two bugs from the real world

Both from `1eaee6e`, and both found — in the commit's own words — *"during real
research runs."* Neither was reachable from a test suite.

### The header browsers refuse to send

DuckDuckGo was answering with 202/429 bot walls. We had retry logic. It never
worked, and the reason is almost funny:

Our `fetch()` was setting a `User-Agent` header. **`User-Agent` is a forbidden
header name** — the browser silently drops it. We were carefully identifying
ourselves to nobody, then wondering why we looked like a bot.

There is no header-level fix; the browser will not let you. The mitigation is
architectural: fall back to running the search **in the real tab** (`searchInTab`),
which has a real user agent because it is a real browser.

### A promise that resolved `null` instead of rejecting

`BrowseSite` was crashing with `Cannot read properties of null (reading 'id')`.

`chrome.windows.create({incognito: true})` **does not reliably reject** when the
extension isn't allowed in incognito. On some Chrome builds it *resolves `null`*.
Our `try`/`catch` fallback — carefully written, correct-looking — was therefore
never entered. Execution sailed past the error handler and straight into a null
dereference.

The fix checks `!win || win.id === undefined` after *both* the incognito attempt
and the fallback. **A promise that resolves is not the same as a promise that
succeeded**, and a `catch` block only protects you from the failures someone
chose to signal as failures.

## Perception: text, not pictures

We rejected set-of-marks screenshots for the browse agent, despite already having
the machinery. Three reasons: image tokens on *every* step of a page walk; the
window would have to be un-minimized to capture it; and it degrades to nothing on
a text-only model.

The indexed-DOM text registry works on every model, costs a fraction of the
tokens, and the agent is walking a page — not admiring it.
