# Progressive Tool Disclosure

**The problem.** A typical install was shipping **~18–20 verbose tool schemas on
every single message** — roughly 3–4k tokens — including for "hi". Worse than the
cost: we had near-duplicate tools (`ViewCurrentTab` vs `GetActiveTabDOM` vs
`InspectPage`) that actively degraded the model's ability to pick the right one.

Spec: [`2026-07-11-tool-progressive-disclosure-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-11-tool-progressive-disclosure-design.md).

---

## Step one: fewer tools, not cleverer routing

Before building any disclosure machinery, we deleted the confusion:

- `58b0fe6` — `ViewCurrentTab` + `GetActiveTabDOM` + `InspectPage` → **`ReadPage`**
  (with a `mode` enum)
- `25b6694` — `ViewOpenedTabs` + `GetAllDOM` → **`ReadTabs`**
- `2cb5795` — four separate browsing-insight tools → **`QueryBrowserData`**
  (with a `source` enum)

**20 tools became 14.** It's worth dwelling on the ordering here: the instinct
when a model picks the wrong tool is to build a smarter retrieval layer. The
cheaper fix, almost always, is to stop offering three tools that do the same
thing. Consolidation first, machinery second.

## Step two: three tools, and a catalog

Now the model starts each step with an always-on core of **three**:

| Tool | Role |
| --- | --- |
| `ReadPage` | the one capability common to nearly every turn |
| `ToolSearch` | list what exists |
| `GetTool` | load some by name |

Everything else is loaded on demand. `GetTool` grows a per-turn
`activeNames: Set<string>`, and `prepareStep` turns that set into the step's
`activeTools` — so only those schemas ever reach the model.

The catalog is **derived from the filtered ToolSet**, which is the detail that
makes this maintainable: a new tool added to `createAgentTools()` becomes
discoverable automatically. There is no catalog to hand-maintain, and therefore
no catalog to forget to update.

`activeNames` is seeded from context rather than starting empty — an `@memory`
mention pre-loads `SearchMemory`; an open page-control session pre-loads the
control cluster. Making the model spend a discovery round-trip re-finding a tool
it obviously needs is a tax on nothing.

## The decisions that kept it honest

Two elegant options were rejected, and for the same reason both times: **it must
work against the weakest OpenAI-compatible endpoint we support.**

- **No embeddings / vector search over the catalog.** It assumes an embeddings
  endpoint a local Llama server may not expose. For ~14 tools, substring matching
  is genuinely enough — and `toolDiscovery.ts` is a pure, Chrome-free,
  AI-SDK-free module precisely so it can be unit-tested without either.
- **No pre-turn classifier LLM call** to decide which tools to load. It doubles
  latency and assumes competence the weakest model may not have.

## And then it broke the security model

The design's own "Risks" section anticipated the model simply *failing to
discover* a tool. The bug that actually shipped was considerably worse, and it's
told in full in [The Agent Turn Loop](The-Agent-Turn-Loop#3-the-dead-end-that-progressive-disclosure-created):

Under `activeTools`, the SDK rejects a call to an unloaded tool with
`NoSuchToolError` **before `execute()` runs** — and `execute()` is where the
approval card lives. So a user who denied page control created a state where the
model could *never re-ask*, because its request was rejected before it could ever
reach the human.

Two good ideas — "only show the model what it needs" and "every tool asks
permission" — combined into a silent dead end. The fix (`5d6853e`) rewrites a
call naming a real-but-unloaded tool into `GetTool`, and it is now a CLAUDE.md
invariant with regression tests, because it is exactly the kind of property a
future refactor would quietly destroy.

**The lesson we'd pass on:** when you add a mechanism that *hides* capability,
enumerate every path that assumed the capability was visible. The interaction
between two safe systems is not automatically safe.
