<p align="center">
  <img src="assets/banner.png" alt="Lychee AI" width="100%" />
</p>

<p align="center">
  <strong>A model-agnostic AI agent that lives in Chrome's side panel.</strong><br />
  It reads the pages you're on, controls them with your permission, and runs
  long web research in the background — entirely client-side, with no server.
</p>

---

Lychee AI is a Manifest V3 Chrome extension (React 18 + Vite 6 + TypeScript,
built on the [Vercel AI SDK](https://ai-sdk.dev) v5). **There is no backend.**
The panel talks directly to the model endpoint you configure — any
OpenAI-compatible one, plus native OpenAI (Responses API) and Anthropic
(Messages API) — and your API key never leaves `chrome.storage.local`.

Two ideas run through the whole design:

- **Every capability is gated.** Any tool that touches a page, the network, or
  your data stops on a human-in-the-loop approval card before it runs.
- **The agent only sees what it asks for.** Tools are progressively disclosed —
  a typical turn ships a handful of tool schemas, not the whole set — and the
  agent cannot see a webpage at all until you let it.

## Setup

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder. Click the lychee in your toolbar (or
press <kbd>⌘E</kbd> / <kbd>Ctrl+E</kbd>) to open the panel.

During development, `npm run dev` rebuilds on change — there's no hot reload, so
click the extension's reload button in `chrome://extensions` to pick changes up.

| Command | What it does |
| --- | --- |
| `npm run dev` | `vite build --watch` — rebuild `dist/` on change |
| `npm run build` | Typecheck, then build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite over the pure, Chrome-independent logic |

## Onboarding

First run is a three-step wizard: configure an OpenAI-compatible endpoint,
**test it live** (one tiny completion proves the base URL, key, and model id
work before you can continue), and choose the agent's **tab visibility** —
*only my current tab* or *all open tabs*. In active-tab mode the `ReadTabs` tool
is never even exposed to the model. Both settings can be changed later.

## Providers

Add a provider in Settings with a base URL, API key, and the model ids you want
(or hit **Refresh from endpoint** to pull them live); one-click presets are
included for:

| Provider | Base URL | Adapter |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | native Responses API |
| Anthropic | `https://api.anthropic.com/v1` | native Messages API |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI-compatible |
| Groq | `https://api.groq.com/openai/v1` | OpenAI-compatible |
| Ollama (local) | `http://localhost:11434/v1` | OpenAI-compatible |
| LM Studio (local) | `http://localhost:1234/v1` | OpenAI-compatible |

For reasoning models (auto-detected — o-series, gpt-5, Claude, DeepSeek-R1,
Qwen3, gpt-oss, …) the model picker shows a **Faster ↔ Smarter** effort slider;
each provider's profile maps your choice onto its own reasoning parameter, and
OpenAI runs on the Responses API so reasoning and tool-calling work together.

The manifest's `host_permissions` are what exempt these calls from CORS — which
is why no proxy server is needed.

## The composer

- **`@` mentions a tab.** A picker opens (filter as you type, arrow keys +
  Enter). Mentioned tabs are read at send time and appended inside `<tab>`
  blocks — an explicit share, so no permission card is involved. `@memory` asks
  the agent to consult long-term memory before answering.
- **`/` invokes a skill** by name, with the same autocomplete behaviour.
- **The camera button** starts an Arc/Dia-style region capture: the page tints,
  the cursor becomes a sniper that snaps to the component under it, click to
  capture or drag for an arbitrary area. The shot lands as a thumbnail on the
  composer and rides along as an image part of your next message.

Answers render as rich Markdown — syntax-highlit code, KaTeX math, link
previews, image carousels, and collapsible JSON trees.

## Agent tools

Only an always-on core is active by default: `ReadPage`, plus the two meta-tools
`ToolSearch` (list what exists) and `GetTool` (load some by name). Everything
else is loaded on demand — the model searches the catalog, loads what it needs,
and those tools stay live for the rest of the turn. The pure catalog/search
logic lives in `src/tools/toolDiscovery.ts`.

| Tool | What it does |
| --- | --- |
| `ReadPage` | Read the active tab — text, DOM, or numbered interactive elements |
| `ReadTabs` | List all open tabs; read specific ones by id |
| `GetScreenshot` | Look at the page as an image — the rendered viewport, or `fullPage:true` for a stitched full page |
| `GetElementScreenshot` | Screenshot one element/region (`[rN]` from ReadPage regions, or a CSS selector) |
| `ExtractData` | Pull structured data off the current page |
| `RequestPageControl` / `ControlPage` | Open a control session, then act (click / type / select / scroll / press / navigate) |
| `AutofillForm` | Fill a form from your saved profile |
| `NavigateTab` | Switch, open, or navigate tabs |
| `SaveMemory` / `SearchMemory` | Long-term memory |
| `QueryBrowserData` | History, bookmarks, top sites, downloads (only the sources you enable) |
| `ListAllSkills` / `ReadSkill` / `SaveSkill` | Skills |
| `StartResearch` | Kick off a background research task |

`ToolSearch` and `GetTool` are the only ungated tools — they list and load, but
the tool they load still stops on its own card. **Settings → Permissions** lets
you set each tool to *ask* (default), *always*, or *never*; *never* removes it
from the toolset entirely, so the model never learns it existed.

## Page control

The agent can act on a page — click, type, select, scroll, press, navigate —
built entirely on the manifest's existing `scripting`/`tabs` permissions. No
`chrome.debugger`, no extra host permissions.

- **Indexed-DOM registry** (`src/platform/domIndex.ts`) — an injected walker
  finds visible interactive elements, stamps each with `data-agent-idx` so a
  later injection can re-find it, and returns a numbered registry. `ControlPage`
  addresses elements by that `[index]`, and every action re-snapshots the page
  so the model always sees current state.
- **Two nested gates.** `RequestPageControl` shows one card naming the page and
  the agent's stated plan; approving opens a session scoped to that tab and
  origin. Within it, individual steps *still* confirm one-shot when
  `isPointOfNoReturn()` flags them — form submits, cross-origin navigation,
  Enter keypresses, password and payment fields — every time, with no "allow
  this chat" escape hatch.
- **On-page presence** (`src/platform/presence.ts`) — while a session is open
  the page carries a translucent tint with a spotlight cutout and a small cursor
  that glides to each element and pulses on click, so you can watch the agent
  work. It is always torn down when the turn ends, errors, or is stopped.

## Seeing the page

Whether a model can *actually* read images is decided by a cheap runtime probe
(`src/agent/vision.ts`): a tiny canvas image containing a random code is sent
once per provider+model, and the model counts as vision-capable only if it
echoes the code back. The verdict is cached. The screenshot tools are never
removed — they always save the shot for the user (shown inline in the chat); the
verdict only decides whether the image is *also* sent to the model, or the tool
just tells a text-only model plainly that it cannot see the picture it saved.

Two registries stay deliberately separate: `domIndex` answers *"what can I
click?"* (interactive, viewport-only, addressed `[3]`), while `regionIndex`
answers *"what can I look at?"* (charts, figures, tables, media — whole-document,
addressed `[r3]`). Tall pages reach you as one stitched strip but reach the model
as sequential full-resolution tiles, because a downscaled full-page strip is an
illegible smear on exactly the pages where seeing matters.

## Background research

`StartResearch` hands a question to a phased pipeline that runs in an offscreen
document, so it survives you closing the panel: **Scope & Plan → (Gather ↔
Reflect) → Synthesize → Verify**, over a structured notebook (plan, sources,
findings, images, coverage) that serves as its long-horizon memory. Each gather
round is a fresh turn seeded from a notebook *summary* rather than a growing
transcript.

Its tools — `WebSearch`, `FetchUrl`, `ExtractTable`, `SearchAcademic`,
`SearchImages`, `HarvestImages`, `Notebook.read/write` — are read-only and
ungated, because no user is present to approve anything. When a page refuses to
be fetched (403, bot wall, login wall), the agent escalates to **`BrowseSite`**:
a nested sub-agent drives a real, isolated, minimized browser tab, and every
action it attempts is checked against a pure policy (`src/tools/browsePolicy.ts`)
that permits reading, SSRF-guarded navigation, and site-search — and never a
login, a purchase, or a non-search form submit. That policy *is* the security
model here, so it's exhaustively unit-tested.

Finished reports cite their sources as inline favicon chips, and a system
notification tells you when one lands.

## Long-horizon turns

A turn is a continuation chain: one 24-step budget bounds *all* activity. As it
nears the ceiling the model is nudged to call `Checkpoint`, which ends the turn
with a structured hand-off — what's done, what remains, what to avoid, the next
action — instead of getting cut off mid-action. The panel auto-continues a few
times with a fresh budget (the control session and overlay survive), then
surfaces a Continue card and hands the decision back to you.

## Memory & dreaming

A two-tier memory in IndexedDB:

- **Episodes** — a raw journal of every conversation. Never shown to the model
  during normal chat.
- **Memories** — small, durable, distilled facts (`fact` / `preference` /
  `project` / `summary`). The most relevant are injected into the system prompt
  each turn.

Episodes become memories through **dreaming** (`src/agent/dream.ts`): the model
re-reads unconsolidated episodes alongside its current memories and emits add /
update / delete operations plus a day summary. It runs automatically — a
`chrome.alarms` tick fires once the chosen interval has elapsed and the user has
been idle 30+ minutes. The Memory panel (moon icon) exposes the controls: how
often to consolidate (30 min – 24h, default 24h), which model does it (defaults
to the chat model — a small, cheap one is often better), a **Dream now** button
to run a cycle on demand, and **Reset memory** to wipe the store and start over.
You can also forget individual memories there.

## Skills

Skills are reusable instruction bundles — single-file `SKILL.md` records
(frontmatter + Markdown body) in their own IndexedDB store.

- **Invoke by name** with `/name`, or let the agent load one itself: a catalog
  of every skill's name and description is appended to the system prompt, and
  the agent calls `ReadSkill` when a request matches.
- **`/create-skill`** is a built-in meta-skill that interviews you — task,
  triggers, inputs, output, strictness — then saves the result.
- `SaveSkill` mutates the store and always shows a card. `ReadSkill` and
  `ListAllSkills` only read your own local skills, so they auto-approve.

## Library

The archival-box icon in the top bar opens a tabbed library:

- **Chats** — saved conversation history.
- **Skills** — a masonry grid of skill cards with an inline editor; create,
  edit, duplicate, delete, import a `.md`, or export one to your clipboard.
  Built-in skills are read-only — duplicate one to customize it.
- **Research** — past and in-flight background research tasks and their reports.

## Observability (optional)

Turns can be exported to [Langfuse](https://langfuse.com) — traces, spans per
tool call, and token usage — configured in Settings and off by default.
Ingestion failures surface in the UI rather than being swallowed.

## Architecture

```
public/manifest.json          MV3 manifest + extension icons
src/background.ts             Service worker: panel toggle, dream alarm, research broker
src/background/offscreen.ts   Offscreen host: runs background research

src/ui/App.tsx                Shell: top bar, routing between panels
src/ui/Chat.tsx               Turn chain, approval cards, page-control gate, composer
src/ui/Markdown.tsx           Rich rendering: code, KaTeX, citations, link cards
src/ui/library/               Tabbed library: Chats / Skills / Research
src/ui/settings/              General, Permissions, Memory, Skills tabs
src/ui/Onboarding.tsx         Three-step first-run wizard

src/tools/tools.ts            Tool registry + the requestApproval gate
src/tools/toolDiscovery.ts    Pure catalog / search / active-set (progressive disclosure)
src/tools/pageControl.ts      Control session, point-of-no-return rules, dispatch
src/tools/research.ts         Research toolset (ungated, all-active)
src/tools/browsePolicy.ts     Pure policy: what a research browse session may do

src/agent/agent.ts            One turn: streamText → UI part stream; Checkpoint; repair
src/agent/provider.ts         Config → AI SDK model (createOpenAICompatible)
src/agent/research.ts         Research state machine
src/agent/notebook.ts         Structured research notebook
src/agent/browseAgent.ts      Nested sub-agent that walks a real tab
src/agent/dream.ts            Episodes + memories → memory ops
src/agent/vision.ts           Runtime probe: does this model actually read images?
src/agent/usage.ts            Token accounting
src/agent/observability/      Optional Langfuse export

src/data/settings.ts          Providers, system prompt, tool policies (chrome.storage)
src/data/memory.ts            IndexedDB: episode journal + long-term memories
src/data/conversations.ts     IndexedDB: chat history
src/data/skills.ts            IndexedDB: skills + SKILL.md parse/serialize
src/data/screenshots.ts       IndexedDB: captured images (kept out of model history)
src/data/researchTasks.ts     IndexedDB: research tasks + reports

src/platform/domIndex.ts      "What can I click?" — interactive registry
src/platform/regionIndex.ts   "What can I look at?" — visual-region registry
src/platform/screenshot.ts    Capture engine: viewport / element / stitched full page
src/platform/capture.ts       The human's camera-button region picker
src/platform/pageActions.ts   Real DOM mutations: click/type/select/scroll/press/navigate
src/platform/presence.ts      On-page overlay: tint + gliding cursor + spotlight
src/platform/marks.ts         Set-of-marks screenshot (numbered boxes over a capture)
src/platform/researchTab.ts   Leased, isolated, minimized tab for research
src/platform/webFetch.ts      Fetch + readability extraction (SSRF-guarded)
```

Functions injected via `chrome.scripting.executeScript` run in the page's
isolated world with no shared JS state between injections — each is fully
self-contained and re-finds elements via `data-agent-idx` / `data-agent-region`.

## Brand

| Asset | Where |
| --- | --- |
| Extension icons (16/32/48/128) | `public/icons/` — shipped in the bundle |
| Full-resolution mark, 512px store icon, banner | `assets/` — repo only |

The palette is deliberately narrow: a quiet neutral canvas (the panel is dense,
and a warm cast on every surface makes long transcripts harder to read) with
brand red reserved for the accent and the loader.

| Token | Light | Dark |
| --- | --- | --- |
| `--accent` | `#c9304a` | `#f2687e` |
| `--lychee` (loader) | `#c9304a` | `#f2687e` |
| `--lychee-leaf` | `#3e9e52` | `#5fbf74` |

Both accents clear WCAG AA in both roles the token plays — as text on the canvas
*and* as a fill under `--accent-text`. The logo's brighter crimson (`#d93a54`)
does not, which is why the UI red is a shade deeper than the mark's.
