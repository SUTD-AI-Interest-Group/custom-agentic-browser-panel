# Decider eval

An answer-keyed benchmark for the on-device decision model (`src/decider/`). It drives the
built extension through 16 fixture tasks with a real chat model, once per **arm**:

- **`off`**: the decider is omitted from settings. A sanity check that shadow mode changes nothing.
- **`shadow`**: the decider records a decision on every `ControlPage` step.
- **`assist`**: shadow, plus the decider maps form fields for `AutofillForm`. It runs only on
  the four ◆ form tasks.

Every `ControlPage` step is then scored against an **answer key**: the set of correct next
actions for the state the agent was in. The chat model's action and the decider's top option
are scored independently, so the report can say which one was right. Agreement alone cannot.

```sh
npm run build    # the harness loads dist/
node scripts/decider-eval/run.mjs --arms shadow,assist [--tasks id,…] [--reps 1] \
  [--provider lmstudio|anthropic] [--cap 10] [--threshold 0.6] [--dry-run]
# or: npm run test:decider:eval -- --arms shadow
node --test scripts/decider-eval/          # the keys and the scoring, no browser
```

Other flags:

- `--profile <dir>`, `--dist <dir>`, `--export-dir <dir>`, `--out <dir>`;
- `--port 8770` (the fixture server);
- `--timeout-min 8` (per task);
- `--key-file <path>`, which overrides the Anthropic key location.

`CHROME_BIN` selects the Chrome for Testing binary. Without it, the run uses Playwright's own
build, or else the newest `chromium-*` in the Playwright cache. Branded Chrome ignores
`--load-extension`.

`--dry-run` does all the setup without sending anything: profile, model import, memories, and
per task the settings, fixture tab, panel and composer.

## Chat models and the spend cap

- **LM Studio is the default** (`google/gemma-4-26b-a4b` at `http://127.0.0.1:1234/v1`), per
  CLAUDE.md. It costs $0.
- **`--provider anthropic`** is an explicit opt-in. It uses `claude-sonnet-5-5`, with the key
  read from `~/.config/lychee-eval/key` (mode 0600). The key is never printed.
  - Before each task the run stops if `spent + $0.50 > --cap` (default **$10**) and reports
    "cap reached". After each task it adds that task's estimate from the turn-trace usage.
  - The estimate is $2 / $10 per M input / output tokens and $0.10 per M cached reads. Uncached
    input is charged at 1.25×, the cache-write upper bound, and the cap uses that upper figure.
  - Not counted: the chat-naming call and Assist's profile-structuring call. Neither appears in
    the turn trace. Both are small, and the $0.50 margin covers them.
  - The run's `finally` overwrites `settings` with the LM Studio provider, so the key does not
    persist in the profile. Every run also scrubs at startup, which covers a run that crashed.

## The profile

The Chrome profile persists at `~/.cache/lychee-decider-eval/profile`, so the ~4.6 GB OPFS model
import happens only once. On startup the run:

1. scrubs `settings` to LM Studio;
2. replaces every memory with the five Task 11 profile memories (Ada Lovelace's name, emails,
   phone and address), and marks a dream as just done so consolidation does not rewrite them
   mid-run;
3. for `shadow`/`assist`, checks `chrome.storage.local.deciderModel`. If it is not `ready`, the
   run serves `--export-dir` (default
   `~/lychee-decider/strands-decider-E2B-gemma4-v2-2611`) on a local CORS server and imports it
   through **Settings → Experimental → Import from URL…**.

Each task then gets fresh settings (provider, plus `decider.mode` for the arm), a fresh fixture
tab and a fresh panel. Approval cards are clicked automatically.

The profile must load the same `dist/` path every time: the extension id, and with it the OPFS
origin, is derived from that path. Only one Chrome can hold the profile at a time.

## Tasks

| id | page | success check |
|---|---|---|
| `shop-cheapest` | `store/` | cart is `['Arc wireless headphones']` |
| `shop-qty` | `store/` | cart is 2 × `Orbit wireless speaker` |
| `shop-mug` | `store/` | cart is `['Aurora mug (blue)']` (green and white mugs exist) |
| `shop-price` | `store/` | reply contains `$39` (a `Pulse Pro` exists) |
| `dense-catalog` | `store/catalog.html` | cart is `['Halo noise-cancelling wireless headphones']` among four Halo products |
| ◆ `form-contact` | `form.html` | submitted name, email, topic Billing, consent on |
| ◆ `form-sales` | `form.html` | submitted topic Sales and phone `''` |
| ◆ `form-shipping` | `shipping.html` | submitted name, street, city, postcode, country, express, terms on |
| ◆ `form-newsletter` | `signup.html` | submitted email, first/last name, interests `['audio']` (Deals starts ticked) |
| `nav-returns` | `help/` | reply contains `45` |
| `nav-warranty` | `help/` | reply contains `2-year` / `2 year` |
| `nav-express` | `help/` | reply contains `12.99` |
| `inbox-bill` | `inbox.html` | reply has `84.20` and 12 December |
| `inbox-order` | `inbox.html` | reply has 25 November |
| `inbox-library` | `inbox.html` | reply has `Analytical Engine` and 28 November |
| `inbox-lookalike` | `inbox.html` | reply has `84.20` and no `$10` (the newer "Acme Energy Offers" email) |

Success is read from page state (the cart, `window.__submitted`) or from the reply. It is never
read from the model's claim.

## Answer keys (`keys.mjs`)

`key(taskId, registryText, url)` returns the correct next actions as
`{op: 'click'|'type'|'select'|'press'|'scroll'|'done', index?}`. Elements are matched by their
registry **label**, never by a remembered index. A key entry without an index (`press`, `scroll`,
`done`) matches any index.

- **Store:**
  - a search box that is empty, or holds a query that would not find the target → type into
    it (on the home page, the category link that lists the target is also correct; on the
    catalog, so is scrolling);
  - a query that finds the target → click Search, or press Enter;
  - the target's link on the page → click it (for the price question, `done` too, since the
    price is shown);
  - the target's product page → the Quantity select if it is wrong, then Add to cart, then
    `done` (`#added`).
- **Forms:**
  - every field whose value differs from its target → type or select it;
  - every checkbox or radio whose `(checked)`/`(unchecked)` state differs from its target → click
    it (a radio is only keyed when it should end up ticked);
  - the submit button only when nothing else is pending → click it;
  - once sent (`#submitted`) → `done`;
  - a target field missing from the (viewport-only) registry leaves the state unkeyed;
  - fields with no target, such as the optional phone or the notes, are never keyed.
- **Navigation:** an explicit per-task path table of link labels; the target page → `done`.
- **Inbox:** the target email's subject link. With an email open, `done` if it is the target,
  else Back to inbox. The open email is named in the URL fragment (`#open=<slug>`).
- Anything else → `[]`, which is scored "no key" and excluded.

The fixtures write their state into the URL fragment (`#added`, `#submitted`, `#open=…`) for
exactly this purpose: a `ControlPage` result carries no URL, and the registry alone cannot tell
a sent form from an unsent one.

## Scoring (`report.mjs`)

- **Steps.** Each `ControlPage` call, in conversation order, is a step.
  - The **registry** before it is the `elements` of the latest earlier tool output that has one.
  - The **URL** is the fixture tab's URL, taken from Playwright `framenavigated` events, at the
    start of the model step that made the call. Trace step *k*'s calls are mapped to
    conversation call *k*. If the counts differ, the URL falls back to the latest output URL.
- **Pairing.** `kind: 'next'` shadow records pair with calls in `seq` order, by the
  longest order-preserving match on `(op, index)`.
  - A call that returned before the decider hook has no record by design. Examples are no
    session yet, the tab not in front, origin drift, or an unreadable page; `tools.ts` returns
    these before the snapshot the hook observes.
    - On a tie, the later, repeated call gets the record.
    - These calls are reported as "returned before the hook", not as unpaired.
  - `unpaired` counts the other calls without a record, and records without a call.
  - The hooks number every step they are handed, and write nothing for a decision superseded
    under `dropIfBusy`. A missing `seq` is therefore reported as a seq gap, or dropped step.
- **Correctness.** The chat model is correct when its `(op, index)` is in the key. The decider
  is correct when its top-1 is in the key.
  - `highlight` and `wait` steps are left unkeyed for both models. They change nothing on the
    page. Highlighting the answer after the task is done is presentation, not a wrong move.
  - `navigate` is scored, and is never in a key.
- **Per task and per arm**, the report shows:
  - success, wall time, chat steps, tokens and cost;
  - decider decisions, ms p50/p95, and coverage and accuracy at the threshold;
  - the 2×2 (both right / chat only / decider only / both wrong) and agreement;
  - calibration by confidence bucket;
  - for form tasks, per-field final-value correctness (`window.__fields()`) and the
    `AutofillForm` `mapped` keys;
  - every keyed step where either model was wrong, with its URL and key.

Output goes to `scripts/decider-eval/out/<ISO-time>/{results.json,report.md}` (git-ignored).
`results.json` keeps each step's full state: registry, URL, key and both choices. The fixtures
hold no user data, so this is safe here. Nothing like it exists in the shipped shadow store.
