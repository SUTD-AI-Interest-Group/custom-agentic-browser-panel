# Lychee AI — improvement & feature recommendations

Originally written 2026-08-02 against `7e698c1`. **Re-reviewed the same day
against `933be1f`**, after 33 commits landed: an envelope-encryption vault, prompt
attachments, and a 14-domain security audit with three hardening waves and an
adversarial review pass.

Verification for this revision: merged `origin/main`, ran the suite
(**1283 / 1284 pass**), and rebuilt the extension.

---

## What landed since the first review

Substantial, and it changes the picture:

- **Secrets are encrypted at rest.** An envelope-encryption vault (IndexedDB KEK,
  AES-KW-wrapped GCM DEK) now seals API keys and MCP OAuth tokens through
  `loadSettings`/`saveSettings`, with in-place migration, a live status chip in
  Settings, and a deliberate choice to *surface* undecrypted secrets on a vault
  outage rather than masquerade. This supersedes the "keys sit in plaintext"
  note from the first review entirely.
- **Prompt attachments shipped** — drag-drop, paste-to-attach, paperclip picker,
  a capped `lychee-attachments` store, a pure delivery planner, provider-aware
  routing for native-document models, and dehydrate/hydrate across persisted
  history. This was recommendation #7 and it is done, more thoroughly than
  proposed.
- **A 97-defect audit, fixed across three waves plus an adversarial review.**
  Tests went **475 → 1284**, test files 42 → 106.

Several findings in that audit are worth calling out because they bear directly
on what remains:

- The artifact sandbox's CSP set only `connect-src 'none'`, so remote
  `<script src>` executed and `<img>`/`<form>` exfiltrated freely — while three
  code comments and the `CreateArtifact` description all promised "no network".
- `linkPreview` rendered a page's declared `og:image` unscreened, and the chat
  rendered image URLs straight out of the model's reply text with no private-IP
  check — **both explicitly noted as reachable by prompt injection with no
  approval gate**.
- Observability shipped `AutofillForm`/`ControlPage` arguments verbatim to
  Langfuse, before the approval gate resolved, so denied actions leaked too.
- The point-of-no-return classifier recognised only native `type=submit` and
  only English labels; `🗑` and "Löschen" committed with no card.

The first review's documentation-drift item (#13) predicted the shape of the
first of those without knowing it existed. The commit that fixed it says so
outright: *"`src/exec/` was a whole subsystem neither document described — the
audit had to reconstruct its contract from the code, which is how its CSP hole
survived three separate comments asserting the opposite."* Keeping `CLAUDE.md`
current is not hygiene; it is how this class of bug is prevented.

---

## Still open

Each re-verified against `933be1f`.

### 1. The root prompt-injection defense is still absent — and the audit proved the threat is live

`DEFAULT_SYSTEM_PROMPT` is byte-identical to before. There is still no envelope
around untrusted content: nothing in `tools.ts` or `Chat.tsx` marks page text as
data-not-instructions, on any of the six channels (`ReadPage`/`ReadTabs`,
`@mention` `<tab>` blocks, `FetchUrl`/`BrowseSite`, `ExtractData`, MCP results,
`ReadPdf`).

The audit closed two *specific* injection-reachable exfil paths (`og:image`,
model-emitted image URLs) and hardened the consent classifier considerably. That
is real progress on the blast radius. But it is vector-by-vector work against a
root cause that is untouched: the model still cannot distinguish a user
instruction from text a page wrote. Every new rendering surface reopens the
question, which is exactly the pattern those two fixes exhibit.

The specific residual risks from the first review still hold:

- An `always` policy bypasses the card entirely, removing the only control
  between a hostile page and an action.
- The research pipeline is ungated by design and `browsePolicy.ts` still permits
  cross-origin navigation with no inspection of the query string — exfiltration
  through a *permitted* action, which no amount of classifier hardening catches.
- `AutofillForm` still maps profile memories onto page-supplied field labels.

Recommended, in order: (a) an explicit untrusted-content envelope plus one line
in the system prompt, with the sentinel stripped from page text so a page can't
close it; (b) a pure egress predicate in `browsePolicy.ts` flagging navigation
whose URL carries a large query payload or a substring of the notebook; (c)
scoping `always` grants to the origin they were granted on, the way
`ControlSession` already scopes to tab + origin.

### 2. Five tools remain invisible to the permission matrix

Unchanged: `TOOL_CATALOG` still holds the same 18 entries, and `RunCode`,
`CreateArtifact`, `UpdateArtifact`, `GetScreenshot` and `GetElementScreenshot`
are still absent. `resolveToolPolicy` falls back to `'ask'`, `PermissionsTab`
renders only catalog rows — so **`RunCode` still cannot be turned off**, and
screenshots still cannot be auto-approved.

This is sharper now than it was. The audit's finding that the artifact sandbox
was executing remote scripts is precisely the scenario where a user would want
to disable `CreateArtifact` outright — and could not have.

Related and also unchanged: `CreateArtifact`'s card still shows only a title and
a byte count (`tools.ts:635`). The CSP hole is fixed, but the user is still
approving HTML they cannot see, in a codebase whose own principle is that "a
headline count is not consent".

### 3. A foreground turn still dies on the first transient error

`withResilience` is still wired only into `research.ts`. `dream.ts` and
`extract.ts` borrow constants and `isAbortError` from the module, but the
foreground chat has no retry: a 429 lands in `runTurnChain`'s catch, pops the
user's message off history, and renders `**Error:**`.

Still the best effort-to-value ratio on the list — the module exists, is tested,
and `classifyError` was itself improved during the audit (a permanent 400 is no
longer treated as transient). A foreground variant needs a seconds-scale
deadline, a visible retry state, and must not outlive a Stop.

### 4. The same test is still environment-flaky

`src/exec/engine.test.ts:35` races an 8 MB memory cap against a 5 s timeout and
still fails here, reproducibly:

```
Test Files  1 failed | 105 passed (106)
      Tests  1 failed | 1283 passed (1284)
```

It survived a 97-defect audit and four adversarial reviewers, which is itself the
argument: it passes on the maintainers' hardware and fails on slower machines, so
it will only ever be discovered by a new contributor or by CI. Assert on
`out.error` matching `/memory/` rather than on which limit won the race.

### 5. There is still no CI — and `npm install` still breaks on Linux

No `.github/` on `main`. A clean install in this container failed again with
`Cannot find module @rollup/rollup-linux-x64-gnu` — reproduced twice today, on
two separate checkouts.

Given the volume and sensitivity of what just landed, this is now the most
disproportionate gap in the project. 1284 tests and a clean typecheck are worth
a great deal less when nothing runs them on a pull request, and the first thing
a new contributor meets is a broken install.

### 6. Conversation search is still title-only, and there is still no export

`ConversationsList.tsx:57` still filters on `displayTitle`. No export path exists
anywhere — no markdown, no JSON, no whole-chat copy. For a local-first product
that now encrypts your secrets at rest, being unable to get your own transcripts
out remains an odd asymmetry.

### 7. `Chat.tsx` grew

4,544 → **5,013 lines**. The attachments work landed largely inside it. The
staged extraction proposed in the first review (presentational components →
`src/ui/chat/`, then `useComposer`, then `useTurnChain`) is the same plan, now
with more to move. The audit's own findings argue for it: the approval-queue
FIFO bug and the MCP-app-registry conversation-keying bug were both state-scoping
errors in exactly this closure.

### 8. Bundle is unchanged

```
dist/sidepanel.js                1,002.11 kB │ gzip: 310.14 kB
dist/assets/highlightText…js       747.36 kB │ gzip: 192.70 kB
dist/assets/pdf.worker.min.mjs   1,255.07 kB
dist/assets/pdf…js                 430.64 kB │ gzip: 128.26 kB
dist total                            5.4 MB
```

Same three targets: narrow highlight.js to the languages that matter, make pdf.js
a dynamic import behind `ReadPdf`, trim eagerly-emitted KaTeX faces.

---

## Revised: cost tracking

The first review listed this as a gap. `src/agent/usage.ts:5-7` shows it is a
deliberate decision — *"Cost lives in Langfuse, not here: it prices a generation
from its own model table, so the extension's job is to report accurate tokens and
let Langfuse do the pricing."* That is a defensible boundary and the reasoning is
sound.

The narrower point survives it: observability is **off by default and optional**,
so the default user has no cost visibility at all, and background research is
allowed to retry against a 24-hour deadline. A wedged research task against a
frontier model is unbounded in cost and the user finds out from their invoice.

So the recommendation shrinks to one thing: **a token-based budget ceiling on
research tasks**, with a soft warning and a hard stop. That needs no price table
and no change to the Langfuse boundary — tokens are already counted accurately,
which is precisely what `usage.ts` says the extension's job is.

---

## Unchanged from the first review

Still worth queueing, none affected by what landed: scheduled/recurring agent
tasks and page-watching (#9 — all the infrastructure exists: alarms, offscreen
host, task persistence, notifications); voice input and read-aloud (#10 — no
`SpeechRecognition` or `MediaRecorder` anywhere in `src/`); `ApprovalCard`
accessibility (no `role="alertdialog"`, no `aria-live`, no autofocus, no keyboard
shortcut on the app's central security control); provider fallback; `MAX_STEPS`
and `MAX_AUTO_CONTINUES` as compile-time constants; silent dream failures; and
i18n scaffolding.

---

## Suggested sequencing

**Now** — CI (#5), including the lockfile fix, because everything below is
riskier without it. Then the flaky test (#4), the five catalog entries (#2), and
foreground retry (#3). All small; all close a gap between what the docs promise
and what the code does.

**Next** — the untrusted-content envelope (#1a). The audit has repeatedly found
injection-reachable surfaces one at a time; the envelope is the first move that
addresses why they keep appearing. Then the egress predicate (#1b) and
origin-scoped `always` grants (#1c).

**Then** — the `Chat.tsx` extraction (#7) before the next feature lands inside it,
the research budget ceiling, conversation search + export (#6), and bundle
splitting (#8).
