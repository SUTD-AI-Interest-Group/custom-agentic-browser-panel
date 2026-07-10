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

## Architecture

```
public/manifest.json        MV3 manifest (sidePanel, scripting, tabs, storage)
src/background.ts           Service worker: side panel behavior + dream alarm
src/ui/                     React UI: Onboarding, Chat, Memory, Settings, Markdown
src/tools/tools.ts          Tool registry + approval gate
src/agent/agent.ts          One agent turn: streamText → UI part stream
src/agent/provider.ts       Config → AI SDK model (createOpenAICompatible)
src/agent/dream.ts          Dream cycle: episodes + memories → memory ops
src/data/settings.ts        Provider/model/system-prompt storage (chrome.storage)
src/data/memory.ts          IndexedDB: episodes journal + long-term memories
src/data/conversations.ts   IndexedDB: saved chat history
src/platform/tabs.ts        Tab listing + page-content extraction
src/platform/capture.ts     Region screenshots: snipe overlay + crop
src/platform/domImage.ts    DOM element → PNG (copy/attach a component)
src/platform/panelPort.ts   Side-panel ↔ background messaging port
src/platform/time.ts        Relative-time formatting
```

## Extending (planned surfaces)

- **More tools** (form autofill, page control): add an entry in
  `createAgentTools()` in `src/tools/tools.ts`. Route anything that mutates a page
  through the same `requestApproval` gate; write-actions can use
  `chrome.scripting.executeScript` with args, like `extractPageContent` does.
- **Skills**: store named prompt/tool bundles in settings and merge them into
  the `system` string and `tools` object passed to `runAgentTurn`.
- **Cross-tab orchestration**: `src/background.ts` is intentionally minimal and
  is the place for work that must outlive the side panel.
