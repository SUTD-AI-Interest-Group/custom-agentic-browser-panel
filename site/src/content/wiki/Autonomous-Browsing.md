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
