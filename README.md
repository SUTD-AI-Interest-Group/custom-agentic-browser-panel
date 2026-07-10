# Agent Chat — Chrome Extension

A plain, model-agnostic AI agent chat in Chrome's side panel (Manifest V3). The
agent can ask for your permission to see your tabs and answer questions about
the pages you have open. All AI workflows are built on the
[Vercel AI SDK](https://ai-sdk.dev) (v5) and run entirely inside the extension —
no backend server.

## Setup

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder. Click the extension's toolbar icon to
open the side panel.

During development, `npm run dev` rebuilds on change (click the extension's
reload button in `chrome://extensions` to pick up changes).

## Onboarding

First run walks through a three-step wizard: pick/configure an
OpenAI-compatible endpoint, **test it live** (one tiny completion proves the
base URL + key + model id work before you can continue), and choose the
agent's **tab visibility** — *only my current tab* or *all open tabs*. In
active-tab mode the `ViewOpenedTabs` tool is never exposed to the model and
@mentions offer only the current tab. Both the endpoint and the visibility
preference can be changed later in Settings.

## @mentioning tabs

Type `@` in the composer to open a tab picker (filtered as you type, arrow
keys + Enter to select). Mentioned tabs' contents are read at send time and
appended to your message inside `<tab>` blocks — an explicit share, so no
permission card is involved. Which tabs are offered respects the visibility
preference above.

## Configuring providers

The extension is provider-agnostic: any **OpenAI-compatible** endpoint works.
Open settings (gear icon) and add a provider with a base URL, API key, and the
model ids you want. One-click presets are included for:

| Provider | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic (compat layer) | `https://api.anthropic.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Ollama (local) | `http://localhost:11434/v1` |

API keys are stored in `chrome.storage.local` and sent only to the endpoint you
configure. The extension's `host_permissions` exempt these requests from CORS,
which is why no proxy server is needed.

## Agent tools

The model's tools are all gated by a human-in-the-loop permission card in
the chat:

- **ViewCurrentTab** — reads the active tab (title, URL, selection, visible text).
- **ViewOpenedTabs** — lists all open tabs; optionally reads specific tabs by id.
- **SaveMemory** — saves a durable fact/preference/project to long-term memory.
- **SearchMemory** — keyword-searches long-term memory for older context.
- **InspectPage** — reads the active tab as a numbered list of interactive elements.
- **RequestPageControl** — asks once to control the tab for a task, then the agent acts.
- **ControlPage** — performs one action (click / type / select / scroll / highlight / navigate / press).

## Screenshots

The camera button beside Send starts an Arc/Dia-style capture on the active
tab (`src/platform/capture.ts`): the page tints and the cursor becomes a sniper —
hovering auto-snaps to the component under the cursor (the snapped area lights
up), clicking captures it, click-hold-drag captures an arbitrary area, Esc
cancels. The selection overlay removes itself before
`chrome.tabs.captureVisibleTab` fires, the shot is cropped on a canvas
(downscaled to ≤1400 px), and the result lands as a removable thumbnail on the
composer. Screenshots are sent as image parts of your next message, so any
vision-capable model can read them; multiple attachments per message are
supported.

The tool's `execute()` simply suspends on an approval promise until you click
Allow / Allow this chat / Deny, so the AI SDK's multi-step agent loop
(`streamText` + `stopWhen: stepCountIs(n)`) needs no special handling. Page
content is extracted via `chrome.scripting.executeScript` function injection —
there is no persistent content script.

## Page control

Beyond reading pages, the agent can act on one: click, type, select, scroll,
highlight, navigate, or press a key — the "browser-use" capability, built
entirely on the manifest's existing `scripting`/`tabs`/`activeTab`
permissions (no `chrome.debugger`, no extra host permissions).

- **Indexed-DOM registry** (`src/platform/domIndex.ts`) — `InspectPage` and
  `RequestPageControl` inject a walker that finds visible interactive
  elements (links, buttons, inputs, ARIA-interactive roles), stamps each with
  a `data-agent-idx` attribute so a later, separate injection can re-find it
  (`chrome.scripting` calls share no JS state, only the DOM), and returns a
  numbered registry. `ControlPage` addresses elements by that `[index]`, and
  every action re-snapshots the page afterward so the model always sees the
  current state.
- **Adaptive perception** — every model gets the indexed registry as a
  compact text list (`[index]<tag role=...> "name" = "value"`); that's the
  primary channel regardless of model. For vision-capable models, a
  set-of-marks screenshot (the same registry drawn as numbered boxes over a
  fresh tab capture, `src/platform/marks.ts`) is captured too and delivered
  as a `user`-role image message injected by `streamText`'s `prepareStep`
  right before the model's next step (`src/agent/agent.ts`) — an
  OpenAI-compatible tool result cannot carry image content, so the image
  can't ride along on the tool's own response. Whether a model can actually
  read images is decided by a cheap runtime probe (`src/agent/vision.ts`): a
  tiny canvas image with a random code is sent once per provider+model, and
  the model is judged vision-capable only if it echoes the code back; the
  result is cached in `chrome.storage.local` so the probe runs at most once
  per model. Non-vision models, and models where the probe fails, rely on
  the text registry alone.
- **Per-task session grant** (`src/tools/pageControl.ts`) —
  `RequestPageControl` shows one approval card naming the page and the
  agent's stated plan; approving opens a `ControlSession` scoped to that tab
  and origin with a budget of `MAX_SESSION_ACTIONS` (20) `ControlPage` calls,
  after which the session closes and the agent must ask again. Within a
  granted session, individual steps still run through
  `isPointOfNoReturn()` — form submits, cross-origin navigation, an Enter
  keypress, or a field flagged sensitive (passwords, payment inputs) — each
  of which pops its own one-shot confirmation card (no "Allow this chat")
  before it executes. The chat's Stop control aborts the turn and always
  tears the session down.
- **On-page presence overlay** (`src/platform/presence.ts`) — while a
  session is open the page gets a translucent tint with a spotlight cutout
  and a small cursor that glides to each element before it's acted on and
  pulses on click, so the user can watch the agent work. It's hidden for the
  instant a set-of-marks screenshot is taken (so the tint doesn't pollute
  what the model sees) and always restored afterward, and is fully removed
  when the session ends.

## Memory & dreaming

The extension has a two-tier memory housed in IndexedDB (`src/data/memory.ts`):

- **Episodes** — a raw journal of every conversation, appended turn by turn
  from `Chat.tsx`. Never shown to the model during normal chat.
- **Memories** — small, durable, distilled facts (`fact` / `preference` /
  `project` / `summary`). The top memories are injected into the system prompt
  each turn, and the model can `SaveMemory` / `SearchMemory` on demand.

Episodes become memories through **dreaming** (`src/agent/dream.ts`): the model
re-reads unconsolidated episodes alongside its current memories and emits JSON
operations — add, update (merge duplicates), delete (forget stale entries) —
plus a compact day summary. Dreaming is fully automatic — no user action
involved: the background service worker checks an hourly `chrome.alarms` tick
(and the panel re-checks on open), dreaming at most once per ~20 h and only
after 30+ minutes of user inactivity. The Memory panel (moon icon) is a
read-only window into the memory store and the last dream; individual memories
can be forgotten there.

## Skills

Skills are reusable instruction bundles — single-file `SKILL.md` records (a
YAML-ish frontmatter block plus a Markdown body) stored in their own IndexedDB
database, independent of the memory/conversation stores (`src/data/skills.ts`).

- **Invoke by name**: type `/name` in the composer (e.g. `/summarizing-pages`) —
  a `/` menu opens and autocompletes matching skills as you type, arrow keys +
  Enter to pick one, mirroring the `@`-mention tab picker above.
- **Autonomous loading**: an always-present catalog (name + description of
  every model-invocable skill) is appended to the system prompt every turn.
  When a request matches one, the agent calls `ReadSkill` to load its full body
  before proceeding, or `ListAllSkills` to see the complete current list.
- **Skills Library**: the archival-box icon in the top bar, left of the
  settings gear, opens a masonry grid of skill cards with an inline editor —
  create, edit, or delete custom skills, and export the current draft as
  `SKILL.md` text (copied to your clipboard) or import one from a `.md` file.
  Built-in skills are read-only in the Library; duplicate one to customize it.
- **`/create-skill`** is a built-in meta-skill (`src/data/builtinSkills.ts`)
  that interviews you — task, triggers, inputs, output, strictness — then
  saves the result with `SaveSkill`.
- **Approval policy**: `SaveSkill` mutates the store and always shows the
  human-in-the-loop permission card. `ReadSkill` and `ListAllSkills` only read
  your own local skills — as benign as `SearchMemory` — so they auto-approve
  without a card.

## Architecture

```
public/manifest.json        MV3 manifest (sidePanel, scripting, tabs, storage)
src/background.ts           Service worker: side panel behavior + dream alarm
src/ui/                     React UI: Onboarding, Chat, Memory, Settings, Markdown
src/ui/SkillsLibrary.tsx    Skills Library masonry UI + editor
src/tools/tools.ts          Tool registry + approval gate
src/tools/pageControl.ts    Control session, point-of-no-return rules, action dispatch
src/agent/agent.ts          One agent turn: streamText → UI part stream
src/agent/provider.ts       Config → AI SDK model (createOpenAICompatible)
src/agent/dream.ts          Dream cycle: episodes + memories → memory ops
src/agent/vision.ts         Runtime probe: does this model actually read images?
src/data/settings.ts        Provider/model/system-prompt storage (chrome.storage)
src/data/memory.ts          IndexedDB: episodes journal + long-term memories
src/data/conversations.ts   IndexedDB: saved chat history
src/data/skills.ts          IndexedDB: skills store + SKILL.md parse/serialize
src/data/builtinSkills.ts   /create-skill meta-skill + example seeds
src/platform/tabs.ts        Tab listing + page-content extraction
src/platform/capture.ts     Region screenshots: snipe overlay + crop
src/platform/domImage.ts    DOM element → PNG (copy/attach a component)
src/platform/domIndex.ts    Indexed-DOM registry (data-agent-idx) for page control
src/platform/pageActions.ts Real DOM mutations: click/type/select/scroll/press/navigate
src/platform/presence.ts    On-page overlay: tint + gliding cursor + spotlight
src/platform/marks.ts       Set-of-marks screenshot (numbered boxes over a tab capture)
src/platform/panelPort.ts   Side-panel ↔ background messaging port
src/platform/time.ts        Relative-time formatting
```

## Extending (planned surfaces)

- **More tools** (form autofill, richer control actions): add an entry in
  `createAgentTools()` in `src/tools/tools.ts`. Route anything that mutates a page
  through the same `requestApproval` gate; write-actions can use
  `chrome.scripting.executeScript` with args, like `extractPageContent` does.
- **Cross-tab orchestration**: `src/background.ts` is intentionally minimal and
  is the place for work that must outlive the side panel.

Skills (named, reusable instruction bundles) and page control (act on the
active tab, not just read it) were on this list and are now implemented —
see [Skills](#skills) and [Page control](#page-control) above.
