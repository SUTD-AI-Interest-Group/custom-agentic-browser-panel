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
- **App HTML runs in a manifest-sandboxed page**: unique origin, no `chrome.*`
  APIs, nested iframe with `allow-scripts` and never `allow-same-origin`.
- **OAuth popups launch only from a user click.** Background reconnects get a
  provider that refuses interaction and park at *needs auth*. Tokens live in
  their own storage keys, never in the exportable `mcpServers` JSON.

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

## The near-miss

`07edf4d` — `AutofillForm` filled your name, email, and address into a form field
by field, and **did not re-check the origin between fields.** If the page navigated
mid-fill, it kept typing your PII into a different origin.

Not a crash. Not a wrong answer. A tool built to handle your most sensitive data,
handing it to a stranger, silently.

The fix — re-snapshot and compare the origin **before every field** — is the same
fix that page control needed for cross-origin navigation, and the same lesson:

> **A check performed once at the start of a loop is not a check.**

For a browser agent, "the page changed under you" isn't an edge case. It's Tuesday.
