# Chrome Web Store Listing — Lychee AI

> Last Updated: 2026-07-28 · Manifest version 0.2.0 · **Status: not yet submitted**

This is the single source of truth for the store listing. Copy from here into the
Developer Dashboard at submission time. This file must **not** ship in the upload
ZIP — `scripts/package.sh` zips `dist/` only, so it is excluded automatically.

---

## Store Listing

**Extension Name** [REQUIRED]

```
Lychee AI
```

**Short Description** [REQUIRED] — 124 / 132 characters

```
Bring your own AI model into Chrome. Lychee reads, acts on, and researches the pages you are on — only with your permission.
```

**Detailed Description** [REQUIRED]

```
Lychee AI puts an AI assistant in Chrome's side panel that can actually see and use the page you're on — and it runs on the AI model you choose.

BRING YOUR OWN MODEL
Connect OpenAI, Anthropic, OpenRouter, Groq, or any OpenAI-compatible endpoint using your own API key. Prefer to keep everything on your machine? Point Lychee at a local model through Ollama or LM Studio and nothing leaves your computer at all. There is no subscription and no account to create — Lychee talks to your provider directly.

WORKS WITH THE PAGE IN FRONT OF YOU
Ask about the article you're reading, and Lychee reads it. Ask it to pull the pricing table out of a page, and you get clean structured data. Open a PDF and ask questions about page 40. Point at a chart and Lychee looks at it. It can read other open tabs when you ask, so you can compare two products side by side without copying anything.

LET IT DRIVE, WHEN YOU SAY SO
Lychee can click, type, scroll, and fill in forms for you. Every session starts with your explicit approval, you watch each step happen on the page, and anything you can't take back — submitting a form, leaving for another site, touching a password or payment field — stops and asks you again first. Nothing is submitted on your behalf without a confirmation.

TIDY UP YOUR TABS
Ask Lychee what you have open and it reads a one-line gist of each tab instead of loading them all, so it can tell you which forty tabs are actually the same three projects. It can then sort them into named groups or close the ones you are done with — always showing you the exact list of tabs first, never touching the tab you are on or a pinned one, and keeping the last batch it closed so you can put them back.

BACKGROUND RESEARCH
Give Lychee a research question and it plans, searches, reads sources, and writes you a cited report while you carry on working. It tells you when the report is ready. Every claim links back to the source it came from.

REMEMBERS WHAT MATTERS
Lychee keeps notes about your preferences and ongoing work, then quietly tidies them into cleaner memories over time. You can read, edit, or wipe that memory whenever you like.

MAKE IT YOURS
Write reusable "skills" — saved instructions you invoke by name for tasks you repeat. Connect Model Context Protocol servers to give Lychee access to your own tools. Set every capability to always allow, ask each time, or never.

YOU'RE IN CONTROL
Every action that touches a page, your data, or the network asks first, and you decide per-tool whether it should keep asking. Access to your history, bookmarks, and downloads is entirely optional — Chrome only asks for it if you switch those features on.

PRIVACY
There is no Lychee server. Your conversations, keys, and memories are stored on your own computer, and your page content goes only to the AI provider you configured, under your own account. We collect nothing, receive nothing, and sell nothing. Full policy: https://lychee-ai.netlify.app/privacy

REQUIREMENTS
Chrome 116 or later, and an API key from a supported provider (or a local model server). Open the panel with the toolbar icon or Ctrl+E / Cmd+E.

SUPPORT
More about Lychee: https://lychee-ai.netlify.app
Questions, bugs, and feature requests: https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/issues
```

**Category** [REQUIRED]

```
Productivity
```

**Single Purpose** [REQUIRED]

```
Lychee AI is an AI assistant in the browser side panel that reads, acts on, and
researches web pages on the user's behalf, using an AI model the user configures.
```

> Every feature ladders up to this one purpose: reading a page, controlling a page,
> researching across pages, and remembering context are all the assistant working
> with web content for the user. See "Single-purpose defence" in Review Notes.

**Primary Language** [REQUIRED]

```
English (United States)
```

---

## Graphics & Assets

Generated store art lives in `assets/store/`, which sits outside `public/` and so
never enters the extension bundle. Regenerate with `npm run store:assets`.

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `assets/store/store-icon-128x128.png` (mark fitted to 96×96 inside the frame, per the store's icon padding guidance) |
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Ready | `assets/store/screenshots/screenshot-1-reading-a-page.png` — summarising an arXiv paper |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Ready | `assets/store/screenshots/screenshot-2-permission-gate.png` — approval card mid-conversation |
| Screenshot 3 [RECOMMENDED] | 1280×800 | ✅ Ready | `assets/store/screenshots/screenshot-3-page-control.png` — presence overlay + agent cursor mid-click |
| Screenshot 4 | 1280×800 | ✅ Ready | `assets/store/screenshots/screenshot-4-tool-permissions.png` — the Never/Ask/Always controls |
| Screenshot 5 | 1280×800 | ⬜ Not created | intended to be a research report with citations — blocked, see notes |
| Small Promo Tile [RECOMMENDED] | 440×280 | ✅ Ready | `assets/store/promo-small-440x280.png` (opaque, no alpha) |
| Marquee Promo Tile | 1400×560 | ✅ Ready | `assets/store/promo-marquee-1400x560.png` (opaque, no alpha) |
| Logo master (not uploaded) | 512×512 | ✅ Ready | `assets/store/logo-master-512x512.png` — transparent mark for press, README, or future placements |

Both promo tiles are flattened onto the brand black with the alpha channel
stripped: the dashboard rejects transparency in promo art, and a PNG that merely
*looks* opaque can still carry an alpha channel and be refused.

### Screenshot Notes

Four are captured and store-legal; a fifth is optional. All were shot at 1280×800
with the side panel open next to a real page — never the panel alone, because
reviewers want to see the extension in context.

1. **Reading a page** ✅ — the "Attention Is All You Need" arXiv abstract open, with
   the panel showing the tool trail (`ToolSearch` → `GetTool` → `HighlightContent`)
   above a real summary. Establishes the core value in one glance.
2. **Permission gate** ✅ — the approval card for "Highlight a region on this page",
   naming the reason and offering Deny / Allow this chat / Allow. This directly
   answers the reviewer's trust question and is worth placing second.
3. **Page control in progress** ✅ — the page dimmed by the presence overlay with the
   agent's cursor and a spotlight ring on the control it is about to click, and the
   panel reading "Started controlling the page → Clicked element 2".
4. **Tool permissions** ✅ — the Never/Ask/Always controls with their one-line
   explanations, demonstrating that the user holds the switch.
5. **Research report** ⬜ — a finished report with inline source citations. Not
   captured; see "Research shot blocked" below.

Two alternates are kept beside them for swapping into the listing:
`alt-control-consent.png` (the "Let the agent control arxiv.org?" card, which states
the full plan before acting — arguably a stronger trust artefact than #2) and
`alt-control-done.png` (the same task finished, with the typed text visible on the
page and the panel confirming it did *not* submit the form).

The page used is an arXiv abstract: long-form, obviously a real document, and
carrying no competitor branding. Avoid other companies' logos and trademarks —
that is an independent rejection reason. No API keys, personal data, or password
fields appear in any shot. Note that the browser toolbar shows the capture
profile's other extension icons; unpin them first if you want cleaner art.

**Research shot blocked.** Background research fails on the `gpt-5.4-mini` model
served by the custom "Taobao AI" OpenAI-compatible provider: the pipeline plans
correctly, then parks on `Provider error (HTTP 400) — will retry` and never
recovers. Foreground chat on the same model is fine, so this is specific to the
research path's request shape, not the credentials. Capture #5 once that is fixed
or from a provider that accepts the research payload.

**Why this cannot be fully automated.** Chrome's side panel is browser UI, not page
content, so no headless or page-level automation tool can screenshot it — it has to
be a real window capture. And the panel renders nothing but onboarding until a
provider key is entered, so the capture has to be a genuine session with a real
key. Compositing a fake conversation instead would be a fabricated product
screenshot, which is both a policy problem and a bad look if a reviewer installs
the extension and sees something different.

It *can* be driven end to end on macOS if the controlling app is granted
Accessibility permission, which is how the current set was shot: AppleScript sizes
the window, Quartz `CGEvent`s type into the panel and click the approval cards, and
`screencapture -R` grabs the rect.

**Capture recipe** (macOS):

1. Load the built extension: `npm run build`, then `chrome://extensions` →
   Developer mode → Load unpacked → `dist/`.
2. Enter a real provider key and have the conversation you want to show.
3. Size the window to exactly 1280×800 before capturing, so nothing is rescaled.
   Driving Chrome directly is more reliable than resizing from inside the page,
   because it sets the outer frame rather than the viewport:
   ```sh
   osascript -e 'tell application "Google Chrome" to set bounds of window 1 to {260, 90, 1540, 890}'
   ```
   Then capture exactly that rect — on a Retina display this yields 2560×1600:
   ```sh
   screencapture -x -t png -R260,90,1280,800 shot.raw.png
   ```
   (`screencapture -l<windowid>` is the tidier form, but it needs window metadata
   that a sandboxed shell is not allowed to read.)
4. Normalise down to the exact canvas the store wants:
   ```sh
   magick shot.raw.png -resize 1280x800 -background white -gravity center \
     -extent 1280x800 -alpha remove -alpha off -strip \
     -colorspace sRGB -define png:color-type=2 screenshot-1.png
   ```
   `-alpha remove` matters: the store rejects transparency in screenshots too.
   Downsampling a 2× capture also keeps text far crisper than shooting at 1×.
5. Confirm each one before uploading — it must report `1280x800` and `sRGB`:
   ```sh
   magick identify -format '%wx%h %[colorspace] alpha=%A\n' screenshot-1.png
   ```

---

## Permissions Justification

Paste each cell into the matching field in the Developer Dashboard. Each one names
the user-facing feature that requires it.

| Permission | Type | Justification |
|------------|------|---------------|
| `sidePanel` | permissions | The entire user interface is Chrome's side panel. The extension has no popup — the panel is where the user reads replies, approves actions, and changes settings. |
| `storage` | permissions | Stores the user's own settings on their device: their API key and chosen model, their system prompt, and their per-tool permission choices. Nothing is stored on a remote server; the extension has no backend. |
| `scripting` | permissions | Reads the text and structure of the page the user asks about, and performs the clicks, typing, and scrolling the user has approved. Injected only when the user invokes a feature that acts on the current page. |
| `tabs` | permissions | Needed to read the URL and title of the current tab so the assistant knows which page it is being asked about, to open or switch tabs when the user asks it to navigate, and to list other open tabs when the user asks the assistant to compare pages. |
| `alarms` | permissions | Schedules the periodic tidy-up of the user's saved memories. The extension's background worker is shut down by Chrome when idle, so a timer cannot be used; an alarm is the only way to schedule this work. |
| `clipboardWrite` | permissions | Powers the "copy" buttons on assistant replies, code blocks, and generated content so the user can paste results elsewhere. |
| `favicon` | permissions | Displays each site's own icon next to source citations in research reports and next to link previews, so the user can recognise a source at a glance. |
| `offscreen` | permissions | Lets a background research task keep running after the user closes the side panel, so a long report finishes instead of being cancelled when the panel is dismissed. |
| `notifications` | permissions | Tells the user when a background research report has finished, since the panel may be closed while it runs. |
| `contextMenus` | permissions | Adds right-click items so the user can send the selected text, the current page, or a link to the assistant without opening the panel first. |
| `identity` | permissions | Signs the user in to Model Context Protocol tool servers that require OAuth. Used only for servers the user has explicitly added, and only when they click "Authorize". |
| `<all_urls>` | host_permissions | The assistant works on whatever page the user is currently viewing, and the extension cannot know in advance which sites those will be — restricting this to a list of domains would break the core feature on every site not on the list. It is also required to call the AI provider endpoint the user configures, which is an arbitrary user-supplied address (including self-hosted and local model servers), and to fetch the pages the user asks the assistant to research. Access is exercised only when the user invokes a feature that needs it; the extension does not read pages in the background. |
| `history` | optional_permissions | Only requested if the user turns on the browsing-insights feature in Settings, which lets them ask questions like "what was that page I read last week". Not requested at install; revocable at any time. |
| `bookmarks` | optional_permissions | Only requested if the user turns on browsing insights, so the assistant can find a page the user bookmarked earlier. Not requested at install. |
| `topSites` | optional_permissions | Only requested if the user turns on browsing insights, so the assistant can reference the user's frequently visited sites. Not requested at install. |
| `downloads` | optional_permissions | Only requested when the user asks the assistant to save a generated file, which opens Chrome's own Save dialog, or turns on browsing insights to search past downloads. Not requested at install. |
| `tabGroups` | optional_permissions | Only requested when the user asks the assistant to tidy their open tabs into named groups, and only at the moment they approve that specific action — Chrome's own permission prompt appears when they click Allow on the request. Used to create and name tab groups and to read existing group names so the assistant does not duplicate a group the user already has. Not requested at install; the tidy-tabs feature is the only thing that uses it, and declining it leaves every other feature working. |

**Remote code justification** (dashboard asks this explicitly — answer **No**):

```
No. All code is bundled in the package. The extension does not load or execute any
script fetched from a remote server.
```

See "Remote code" in Review Notes for the two features a reviewer may mistake for
remote code, and the prepared answers.

---

## Privacy & Data Use

Derived from an audit of the actual code paths, not from intent. This must match
`PRIVACY.md` exactly — a mismatch between the disclosure form, the policy, and the
code is the most common cause of rejection.

### Data Collection

**Does the extension collect user data?** **Yes** — it is stored on the user's own
device, and transmitted only to endpoints the user configured. The developer
receives no data and operates no server.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | Yes — only if the user chooses to save profile details (name, email, address) for form filling | Yes — sent to the user's own configured AI provider when relevant to the request, and typed into a form only when the user approves | Personalising replies; filling forms on request | No |
| Health info | No | — | — | — |
| Financial info | No — payment fields are never stored, and the assistant cannot submit them without a separate confirmation | — | — | — |
| Authentication info | Yes — the user's own API keys and tool-server access tokens | Only to the endpoint each credential authenticates against | Authenticating the user's requests to their chosen provider | No |
| Personal communications | Yes — the user's chat messages | Yes — to the user's configured AI provider | Generating replies | No |
| Location | No | — | — | — |
| Web history | Optional — only if the user enables browsing insights and grants the permission | Yes — the matching results are included in the request to the user's provider when they ask | Answering questions about pages the user visited | No |
| User activity | Yes — which pages the user asks the assistant to read or act on, and, when the user asks about their open tabs, the title, URL, and a short self-description of each tab in that window | Yes — to the user's configured AI provider | Carrying out the user's request on that page; grouping or closing tabs the user asked to tidy | No |
| Website content | Yes — text, structure, and screenshots of pages the user asks about | Yes — to the user's configured AI provider | The assistant cannot summarise or act on a page it is not shown | No |

**Not used:** `chrome.storage.sync` — nothing is uploaded to the user's Google
account. No analytics, telemetry, crash reporting, or advertising SDK of any kind
is present in the codebase.

**Third-party endpoints contacted**, all documented in `PRIVACY.md`:
the user's configured AI provider; DuckDuckGo (web search); OpenAlex (academic
search); Wikimedia Commons and Openverse (image search); sites the assistant is
asked to fetch or browse; MCP servers the user adds; and Langfuse **only if** the
user opts in to tracing with their own account (off by default).

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]

```
https://lychee-ai.netlify.app/privacy
```

✅ Verified live 2026-07-28: loads anonymously, 302s to `/#/privacy` via
`site/public/_redirects`, and renders the full current policy. The page is
generated from `PRIVACY.md` by `site/scripts/sync-content.mjs`, so the policy the
store links to and the policy in the repo cannot drift apart.

Equivalent public mirrors, if the dashboard ever objects to the redirect:

```
https://lychee-ai.netlify.app/#/privacy
https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/PRIVACY.md
```

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free
**Mature content**: No

---

## Developer Info

**Publisher Name** [REQUIRED]

```
SUTD AI Interest Group
```

⚠️ Confirm this matches the Chrome Web Store developer account that will publish.
Publishing under an organisation name requires that account's verified identity.

**Contact Email** [REQUIRED] — displayed publicly on the listing

```
ai@sso.sutd.edu.sg
```

A group address rather than a personal one, so the listing survives handover and
no individual's inbox is published on a public page. It must be **monitored** —
this is where Google sends takedown and policy notices, and a missed one can pull
the extension. Confirm someone is actually watching it before you submit.

**Support URL** [RECOMMENDED]

```
https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/issues
```

**Homepage URL** [RECOMMENDED]

```
https://lychee-ai.netlify.app
```

This must stay in step with `homepage_url` in `public/manifest.json` — Chrome
shows the manifest value on the extension's own details page, and a listing that
points somewhere else looks like a mismatch to a reviewer.

---

## Submission Process

Two of these are irreversible or block publishing outright, so read before paying
the fee.

**1. Account setup — the email choice is permanent.**

- Register at <https://chrome.google.com/webstore/devconsole> and pay the one-time
  developer registration fee (US$5).
- **The Google account's email cannot be changed after the account is created.**
  Decide up front whether the account is owned by a person or by the group, and
  register with the account the group will still control in two years. This is the
  single most common thing new publishers get stuck on.
- **2-Step Verification must be enabled on that Google account** before you can
  publish or update anything. Turn it on first.
- The public **contact email** (`ai@sso.sutd.edu.sg`) is a *separate* field added
  on the account page, and it must be **verified by clicking a link Google emails
  to it**. Publishing is blocked while it is blank. So that address has to receive
  mail and someone has to action the link — confirm this before submission day.
- Publisher display name: the listing says "SUTD AI Interest Group". Confirm the
  account is registered such that it can display that name; a personal account
  cannot simply type a group name into the field.

**2. Filling the listing.** Four tabs in the dashboard, all sourced from this file:

| Dashboard tab | What it wants | Where it is here |
|---|---|---|
| Store listing | Name, descriptions, category, language, icon, screenshots, promo tiles, support + homepage URLs | "Store Listing", "Graphics & Assets", "Developer Info" |
| Privacy | Single purpose, permission justifications (one field each), remote-code answer, data-use disclosures + 3 certification checkboxes | "Single Purpose", "Permissions Justification", "Privacy & Data Use" |
| Distribution | Visibility, regions, pricing | "Distribution" |
| Test instructions | Reviewer credentials/notes — **not optional for us** | "Reviewer testing note" in Review Notes |

The test-instructions field matters more than usual here: the extension does
nothing without a user-supplied API key, so a reviewer who installs it sees only
the onboarding screen. Paste the prepared note or the review may stall.

**3. Expect an extended review.** Google states most reviews finish in a few days
but can take a few weeks, and names three things that slow it down — broad host
permissions, sensitive permissions like `tabs` and `downloads`, and code volume.
Lychee has all three, plus first-time-developer scrutiny. Budget weeks, not days,
and do not schedule a launch around a fast approval. If it passes three weeks with
no response, that is the point to contact developer support.

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.2.0 | 2026-07-28 | First store submission. Side-panel assistant with bring-your-own-model support, page reading, approved page control, tab organising (grouping and closing, with undo), background research with citations, long-term memory, skills, MCP tool servers, and sandboxed code execution. | Draft — not yet submitted |

---

## Review Notes

*Internal. Not published to the store.*

### Pre-submission blockers

1. ~~Screenshots~~ — ✅ done 2026-07-28. Four 1280×800 captures from a real
   session live in `assets/store/screenshots/`, all verified sRGB with no alpha.
   The optional fifth (research report) is still open because background research
   errors on the current provider — see "Screenshot Notes" above.
2. ~~Privacy policy URL must resolve publicly~~ — ✅ done 2026-07-28.
   `https://lychee-ai.netlify.app/privacy` verified live, public, and anonymous.
3. **Publisher name** — still to confirm against the actual developer account.
   The listing says "SUTD AI Interest Group", and Google will only show that name
   if the account is registered and verified as that organisation; a personal
   account cannot simply type a group name into the field. ✅ Contact email
   settled: `ai@sso.sutd.edu.sg` (someone must be monitoring it).
4. ~~No LICENSE file exists~~ — ✅ done 2026-07-28. MIT, copyright SUTD AI
   Interest Group. Every dependency in the tree is MIT / Apache-2.0 / ISC / BSD
   with no copyleft, so nothing in the stack constrained the choice.

### Single-purpose defence

The extension is feature-rich, and breadth is a common trigger for a single-purpose
challenge. If questioned, the argument is that every capability is the same purpose
applied to the same object — *an AI assistant operating on web pages for the user*:

- reading a page, a PDF, or another tab → giving the assistant the page,
- clicking, typing, and form filling → the assistant acting on the page,
- research → the assistant reading pages the user has not opened yet,
- memory and skills → carrying the user's context between those tasks,
- MCP servers → the user extending the same assistant with their own tools.

None of these is a standalone product; none functions without the assistant. There
is no unrelated bundled utility (no ad blocker, no coupon finder, no wallet), which
is what the single-purpose policy actually targets.

### Remote code

The dashboard question should be answered **No**, and this is accurate: no
JavaScript is fetched from a network and executed. Two features can superficially
look like remote code, so have these answers ready.

**1. Sandboxed code execution.** The assistant can write and run small snippets to
compute results. These run inside a JavaScript interpreter compiled to WebAssembly
and **bundled in the package** — it is never downloaded. The snippet executes in a
manifest-sandboxed page with a unique origin, no access to any `chrome.*` API, no
access to the user's tabs or data, and `connect-src 'none'`, so it has no network
access whatsoever. It is data being interpreted by bundled code, not code being
loaded and run — the same posture as a bundled regex or expression evaluator.

**2. MCP app views.** If a user connects a Model Context Protocol server, that
server can return an interface to display. It renders in a manifest-sandboxed page
inside a nested `allow-scripts`-only iframe — never `allow-same-origin` — so it has
an opaque origin and cannot reach `chrome.*`, extension storage, the user's pages,
or the extension's own code. Every request it makes is decided by the extension,
not the view, and any tool call it attempts goes through the same user approval and
per-tool permission policy as any other tool. This is server-supplied *content*
rendered in an isolated frame, equivalent to displaying remote HTML, and it applies
only to servers the user explicitly added.

If a reviewer still objects to (2), it is the most severable feature — MCP app
rendering could be disabled for the store build without affecting the core product.

### Broad host permission

`<all_urls>` is genuinely required and is the single most likely thing to draw
review scrutiny. The justification above leads with why a domain list cannot work
(the user's tabs are unknowable in advance) and notes that the provider endpoint is
itself user-supplied. Supporting point if pressed: the extension does not read
pages in the background — access is exercised only inside a user-invoked action,
and page control additionally requires an in-panel grant plus per-step confirmation
for irreversible actions.

### Points in the extension's favour, worth stating in the review notes field

- No backend, no analytics, no telemetry, no accounts — nothing to correlate users.
- No `chrome.storage.sync`, so no user data reaches Google's servers.
- Sensitive permissions (`history`, `bookmarks`, `topSites`, `downloads`) are
  **optional** and not requested at install.
- Every capability is gated by an in-panel approval the user can set to
  always / ask / never per tool.
- Irreversible page actions — form submits, cross-origin navigation, password and
  payment fields — always re-confirm, even inside an approved session.
- Research browsing is restricted by policy to reading, navigating, and site search;
  it cannot log in, purchase, or submit non-search forms.
- Code is minified but **not obfuscated** (obfuscation is a policy violation;
  minification is not).

### Reviewer testing note

The extension requires an API key to do anything, so a reviewer who installs it
sees only the onboarding screen. Include this in the "Instructions for reviewers"
field or the review may stall:

```
Lychee AI requires the reviewer to supply their own AI provider API key, as the
extension has no backend and no bundled credentials.

To test: open the side panel from the toolbar icon (or Ctrl+E / Cmd+E). The
onboarding screen asks for a provider and an API key — any OpenAI, Anthropic,
OpenRouter, or Groq key works, and a local Ollama or LM Studio server works with
no key. After that, open any article and ask "summarise this page" to exercise
page reading. Asking "fill in this form" on a form page will demonstrate the
permission approval flow.

If you require a test key to complete the review, please contact us at the listing
email and we will provide one.
```

### Known issues / limitations

- Requires a user-supplied API key; there is no free bundled tier.
- Cannot operate on `chrome://` pages, the Web Store, or other extension pages —
  Chrome forbids injection there. The panel reports this rather than failing silently.
- PDFs are handled by reading the file directly, since Chrome's PDF viewer exposes
  no page structure to extensions.
- The packaged extension is ~5.3 MB, mostly the bundled interpreter, PDF reader,
  and maths fonts. Well within limits.

### Rejection history

None — not yet submitted.

| Date | Reason | Fix Applied | Resubmitted |
|------|--------|-------------|-------------|
| — | — | — | — |
