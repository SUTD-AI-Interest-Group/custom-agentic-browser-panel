# Security and the Permission Model

Every gate in the system, in one place. This page exists because the gates were
built feature by feature, and the *pattern* only becomes visible when you line
them up.

---

## The rule

> **The human gates what the human can see. Everything else gets a policy that
> cannot be talked out of its job.**

| Context | Human present? | The gate |
| --- | --- | --- |
| Any agent tool (foreground) | yes | `requestApproval` card — `execute()` suspends on it |
| Page control, per session | yes | one card naming the page + the agent's stated plan |
| Page control, irreversible step | yes | **one-shot** card, every time, no bypass |
| MCP tool call (agent-initiated) | yes | same card, under two-level policy: per-tool override → server default → ask |
| MCP tool call (app-initiated, from an app card) | yes | same card again — scoped to the app's own server, "Allow this chat" covers a poll loop |
| Research web egress | **no** | SSRF guard (pure, tested) |
| Research browsing a real tab | **no** | `browsePolicy` (pure, tested) |

## Four kinds of "no"

The distinctions here matter more than they look:

1. **Absent** — the tool is *removed from the ToolSet*, so the model never learns
   it exists. This is what a `never` policy does, what active-tab mode does to
   `ReadTabs`, and what an ungranted browsing permission does to that data source.
   (A failed vision probe *used* to do this to the screenshot tool; since 20 July it
   doesn't — the tool stays present and `planShotDelivery` merely withholds the image
   from a blind model, keeping the capture for the user. See
   [Agent Perception](Agent-Perception#the-tool-split-and-stopped-vanishing).)
2. **Gated** — the tool exists, the model can call it, and `execute()` suspends
   until a human clicks.
3. **Auto-approved** — a tool the user has set to `Always`, or one that touches
   nothing (`ReadSkill`, `SearchMemory`).
4. **Never bypassable** — point-of-no-return actions. *No* setting, including
   `Always`, can suppress these.

**Absent beats denied.** A tool the model can see but not use is a tool it will
keep trying, and every retry burns a step and a permission prompt. Removing it
from the schema removes the loop.

## Why the ungated tools are ungated

Only three tools skip the approval gate, and the boundary was drawn deliberately:

- **`ToolSearch` / `GetTool`** — they list and load. They touch no page, no
  network, no data. The tool they load still stops on *its own* card.
- **`Checkpoint`** — it ends a turn and hands off state. The human gate for
  *resuming* is the Continue card.

Plus one documented exception: **`ReadSkill` / `ListAllSkills`** read only your own
local skills — as benign as `SearchMemory` — so they auto-approve. The spec calls
this out explicitly so it reads as an intentional decision rather than an
oversight.

## When there's no human: pure policies

Background research runs with the panel closed. There is nobody to show a card to,
so the gate becomes code.

**Both gates here are pure functions, and that is the point.** They are
deterministic, exhaustively unit-tested, and contain no LLM. `browsePolicy.ts`
states its own rule: *"No human is at the gate here… so the rule here is 'only do
things that cannot commit anything.'"* Read, navigate, site-search — never a login,
a purchase, or a non-search form submit.

The instinct to have the model judge its own safety is strong and wrong. **A model
can be argued with. A pure function cannot be prompt-injected.**

That rule is only as good as the vocabulary behind it, and for a while the
vocabulary itself had quietly drifted. `pageControl.ts`'s point-of-no-return
classifier and `browsePolicy.ts`'s unattended gate each kept their own copy of the
committing/dismissal word list. `pageControl.ts` had matched `place order` and
`continue` since its first commit; `browsePolicy.ts` was written later for
`BrowseSite` and never picked either up. A bare-named "Continue" or "Place order"
control — no href, no POST form, nothing structural to catch it — walked straight
past the *only* gate the unattended browser has. Worse, the test that should have
caught this had existed the whole time: `pageControl.test.ts` carries a case titled
*"flags the full committing-name vocabulary, mirroring browsePolicy intent,"*
listing both terms, passing continuously — because it only ever drove
`pageControl`'s own copy. It asserted a cross-file parity that did not exist.
`e402af1` extracted both copies into one shared `committingVocabulary.ts` and
converged on the stricter reading: the surface with nobody watching must never be
looser than the one with a confirmation card.

Research writes reports with nobody reviewing them either. `notebook.addImage`
used to record whatever image URL `SearchImages`/`HarvestImages` handed it, and the
synthesized report embedded up to twelve of them as bare `![]()` markdown — which
the panel renders as a plain, auto-loading `<img>`. Nothing here fetches the bytes
through the extension's own privileged network path, so it was never SSRF, but a
URL harvested from an attacker-influenced page could still end up as a passive load
against an internal address inside the user's own report, with no card and no
review. `469e6e0` moved the check to write time, inside `addImage` itself, ahead of
every render surface that exists today or gets added later — the same "screen once,
at the one chokepoint every caller shares" shape as the SSRF guard below. The same
audit deleted a related capability that had never actually shipped: a
screenshot-report mode was wired end to end but never called (both call sites
hardcoded text-only), and it carried its own hazard — `captureVisibleTab` composites
whatever is on screen, including cross-origin iframes, while every guard on that
path only ever inspects the *top frame's* URL. A page can stay on a safe URL while
framing something that isn't. Deleting the capability closed that path outright,
since a warning comment cannot stop someone who doesn't read it.

## MCP: when third parties enter the chat

[MCP support](MCP-Servers-and-Apps) added the first *third-party code* to the
system — remote servers with arbitrary tools, and apps that render their own
HTML in the transcript. The gates extend rather than multiply:

- **Every MCP tool call stops on the same approval card**, agent-initiated or
  app-initiated, under a two-level policy (per-tool override → server default →
  `ask`). `never` at either level means the tool is not built into the ToolSet
  at all — absent beats denied, again.
- **An app is fenced to its producing server.** Its `tools/call` goes through a
  host callback that fixes the server name by construction; the bridge grants
  nothing. Its `ui/message` text becomes a composer *draft* — an app can
  suggest words, never speak as you.
- **App HTML runs in a manifest-sandboxed page**: unique origin, no
  `chrome.*` APIs, the `ui://` app path nests a `srcdoc` iframe with
  `allow-scripts` and never `allow-same-origin`. `sandbox.html`'s own CSP was a
  real gap until `23563b6` — see [Two sandbox CSPs](#two-sandbox-csps-verified-against-real-chromium)
  below.
- A **second** iframe had drifted from that same rule. The one for a
  `text/uri-list` app — which renders a server-chosen `https://` URL directly
  instead of sandboxed HTML — carried `allow-same-origin` until `c2edc53`.
  Cross-origin same-origin-policy still applied (this was never a path into the
  panel itself), but it handed the framed page a full-capability embedded
  browsing session — its own cookies, storage, credentialed requests — with no
  cue that this card behaves differently from a sandboxed `ui://` app. Removed.
- **OAuth popups launch only from a user click.** Background reconnects get a
  provider that refuses interaction and park at *needs auth*. Tokens live in
  their own storage keys, never in the exportable `mcpServers` JSON — and,
  since `a701255`, are bound to the exact URL they were issued for
  (`boundUrl`), not just the server's mutable display name. A name is
  reusable: editing a server's `url`, or importing a shared config that reuses
  a familiar name, used to replay a live bearer token against a different host
  outright, because the SDK attaches `Authorization: Bearer <token>` before any
  handshake or audience check. Every read now refuses — and evicts — a record
  whose `boundUrl` doesn't match, which also self-heals a record that was
  already mis-bound *before* the fix shipped: the manager's in-memory slot map
  is empty on every panel restart, so a purge-on-diff scheme would have had
  nothing to diff against.
- **stdio server credentials are sealed too.** An stdio entry's `env` — the
  standard place a local MCP server's token lives — was the one secret surface
  the vault never swept. `21eec68` folds it into the same seal sweep as
  `headers`, uniformly across every value rather than only names that look
  sensitive: a name heuristic is guessable, and the one miss it makes is a live
  credential left in plaintext.

## Two sandbox CSPs, verified against real Chromium

Both of the extension's manifest-sandboxed pages exist to run untrusted
content — `sandbox-exec.html` for `RunCode`/artifact HTML, `sandbox.html` for
MCP app HTML — and neither question `23563b6` settled could be answered by
reading code. Both were checked against a real Chromium instance driving the
built extension, with a local HTTP listener as ground truth for "did this
reach the network," separate from console output or CSP violation events.

**`RunCode` was completely dead, not merely at risk.** `sandbox-exec.html`'s
`script-src` was `'self' 'unsafe-inline'` with no `wasm-unsafe-eval` token, and
a sandboxed page doesn't get an exemption from that requirement.
`WebAssembly.instantiate()` threw a CSP `CompileError` on every attempt, so
`exec:init` always resolved `{ok:false}` and every `exec:run` failed with
"engine not initialized." The entire test suite passed throughout, because
Vitest runs QuickJS in Node, where no CSP applies at all — the one environment
that could have seen this bug is the one nothing was exercising. Adding
`'wasm-unsafe-eval'` (the same token `manifest.json` already grants
`extension_pages` for the PDF wasm) fixed it; `'unsafe-eval'` stays out
deliberately, since it would also open `eval()`/`Function()` for no benefit
here.

**`sandbox.html` had no CSP at all.** With no meta tag, MCP app HTML ran under
Chrome's MV3 sandbox *default*, which sets only `script-src`/`child-src` and
leaves `connect-src`/`img-src` completely open. Confirmed by observation: an
app's `fetch`, `XMLHttpRequest`, and `<img src>` all reached the listener as
real requests, no violation logged anywhere — only form submission was
incidentally blocked, by `child-src`'s framing restriction, not by
`form-action`. The impact is bounded and worth stating precisely: an app only
ever sees its own server's `toolInput`/`toolResult`, data that server already
has, so this was a tracking/fingerprinting gap rather than an exfiltration
path — but it was inconsistent with `CreateArtifact`'s equivalent surface,
which had always been default-deny with `img-src data:` and no network.
`sandbox.html` now carries the matching shape.

`sandboxCsp.test.ts` parses the real meta tag into a directive map for both
pages (not a substring check) and pins `'wasm-unsafe-eval'` present while
`'unsafe-eval'` is absent — so a future "fix" reaching for the broader token
fails loudly instead of quietly widening the sandbox again.

## Untrusted content can hurt you before the approval gate ever runs

Not every risk here starts with the model asking permission for something.
Attaching a file is parsed the moment the user drops it in — before the model
has anything to approve. `officeparser`'s XLSX path deep-copies a shared
string (`JSON.parse(JSON.stringify(...))`) once per referencing cell, and
nothing bounded that cost: `decompressionLimits` caps inflated zip bytes and
entry count, not cell count, and the XLSX path had no equivalent of the ODF
parser's `CellBudget`. A sub-1MB spreadsheet with a couple of million cells
pointing at one rich string could force multi-GB of transient allocation on
the panel's **main thread**, at attach time — dropping a file was enough.
`3c438fe` bounds the actual cost (cells × string size — either factor alone
can hide a bomb the other makes real) and moves parsing into a worker behind a
wall-clock timeout.

The first version of that guard was fully bypassable, and it was a reviewer
building the file, not reading the diff, that found it: the guard selected
worksheet entries with an **anchored** path regex (`^xl/worksheets/...$`),
while `officeparser` itself finds them with an **unanchored** `.match()` — so
`zzz/xl/worksheets/sheet1.xml` was invisible to the guard and a completely
real worksheet to the parser. The fix selects entries by *content* (sniffing
for `<sst`/`<sheetData`) instead of by path, so a malicious part can no longer
hide behind its own name.

## The SSRF guard, and why it took three commits

`isFetchableUrl()` blocks `localhost`, `.local`, private IPv4, `::1`. Then:

- **`8cf8f1b`** — bypass via **trailing dot**: `http://localhost./` is a legal FQDN.
- **`8cf8f1b`** — bypass via **IPv4-mapped IPv6**: `http://[::ffff:127.0.0.1]`.
- **`bba1499`** — the trailing-dot fix stripped *one* dot. `http://localhost../`
  still worked. Regex became `/\.+$/`.

Every one of these arrived as a **failing test first**, which is the only reason
the second trailing-dot bug was ever found. A guard that isn't driven by
adversarial tests is a guess.

The mirror-image failure is worth remembering too: the link-preview guard's IPv6
check (`host.startsWith('fc')`) blocked **`fdic.gov`** and **`fcbank.com`**
(`343388a`). Guards fail in *both* directions, and only one of those directions
files a bug report.

### A guard not reached, and a check with a gap after it

`isFetchableUrl()` itself has held since `bba1499`. Two different ways to lose
still surfaced in the unattended research pipeline, in `19412c7`:

- **`harvestImages` never called it.** Every other network path on this surface
  — `fetchReadable`, the tab-navigation paths — ran through `isFetchableUrl`.
  This one didn't; it was the one gap in an otherwise-consistent guard.
- **Checking the URL after navigation isn't enough.** Chrome follows redirects
  transparently, and the extension holds no `webNavigation`/`webRequest`
  permission to intercept one — so a public URL could 302 to cloud metadata or
  a LAN service, and the *landed* page would get scraped into the research
  notebook, then cited under the original, safe-looking URL. Checking
  `location.href` after the tab settles still has a gap: `renderPage` scrolled
  and slept 900ms before reading the page, and a page that passed the check
  could navigate itself again inside that window. The fix removes the window
  rather than shrinking it — `injExtractReadable` now captures `location.href`
  and the page content in the **same synchronous page-world execution**, so
  there is nothing to race. `observe()` applies the same rule to both of its
  injections and refuses outright if they disagree: elements read from one
  page and text read from another is a wrong-URL citation even when both pages
  are individually safe. The existing test suite could not have caught this —
  every mock returned one static URL, so "the URL changes between the check and
  the read" had no fixture able to represent it.

A guard has to sit on *every* path that touches the network, and it has to look
at the world at the instant it acts on it — not a snapshot taken a moment
before.

## Detecting what needs a one-shot card

The point-of-no-return card for a sensitive field — password, payment — only
fires if `domIndex.ts` actually flags that field `sensitive`. Until `3bdd228`,
that flag was tested against exactly two things: the element's `name` and `id`.
Most real forms don't put the human-readable label there. A React/MUI field
commonly looks like `id="mui-42" placeholder="Card number"` — the id is
generated, the label lives in the placeholder, an `aria-label`, an
`aria-labelledby`, or an associated/wrapping `<label>`. None of those were
checked, so `AutofillForm` would type a card number into a field shaped exactly
like that with **no confirmation card at all** — and nothing about the failure
was visible: no error, the card simply never appeared.

The regex had a second gap: it expected a literal space between words
(`account\s*number`), so `account_number`, `sort_code`, and
`socialSecurityNumber` — the ordinary snake_case and camelCase real forms
actually use — all read as unremarkable fields.

The fix feeds every label source into the check and normalizes separators
(`-`/`_` collapsed, camelCase split) before matching, additively — the raw
string is still tested too, so nothing previously caught can be lost. Widening
a sensitivity regex isn't free: a spurious card on an ordinary field trains
people to click through without reading. `swift`, `bic`, and `cvc` are the
awkward cases — also a UI framework, a pen brand, and a non-word respectively —
so they're matched narrowly: exact equality for the bare word, substring only
for the unambiguous compound (`swift-code`).

## The near-miss, twice

`07edf4d` — `AutofillForm` filled your name, email, and address into a form field
by field, and **did not re-check the origin between fields.** If the page navigated
mid-fill, it kept typing your PII into a different origin.

Not a crash. Not a wrong answer. A tool built to handle your most sensitive data,
handing it to a stranger, silently.

The fix — re-snapshot and compare the origin **before every field** — is the same
fix that page control needed for cross-origin navigation, and the same lesson:

> **A check performed once at the start of a loop is not a check.**

For a browser agent, "the page changed under you" isn't an edge case. It's Tuesday.

`c2edc53` found the same lesson wearing a different mechanism. `ControlPage` and
`AutofillForm` checked `isForeground` — is the human still looking at this tab —
exactly once, *before* the approval card was ever shown. But the card sits open
for however long the human takes to react, entirely outside the tool's control:
tab away, then click Allow on autopilot, and the committing action fires against
a tab nobody is watching. `AutofillForm` had it worse — one check at entry, then
a whole batch of fields typed with no further look. The fix re-checks
`isForeground` immediately *after* `requestApproval` resolves, and for
`AutofillForm`, before every field — parking the turn through the same
`parkFor` path the entry check already used, and reporting back how many fields
it actually got through before the human stopped watching.

Two different signals — where the page is, whether the human is looking — and
the same gap both times: a check placed once, ahead of something the tool
doesn't control, isn't protecting the moment that actually matters.
