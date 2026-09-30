# Von data round 2 — public browser datasets + our own System-One typed instructions

Status: scouting complete 2026-09-30 (a research sub-agent's report, condensed
here; every number came from live Hub queries, not paper recollection). Not yet
implemented. The next fine-tune runs on a dedicated RunPod GPU, so corpus size
is no longer a constraint; Claude may act as the labelling teacher where a
structural label is not available.

## Why

The act-head fine-tune (`ks-ang/von-browser-act`, eval README "Results —
2026-09-30") fails where its 4,921 teacher-labelled episodes are thin:
`SELECT_OPTION` (9 rows), multi-field form states, DONE/BLOCKED that depend on
page content, scroll decisions, real-site variety, and login-wall recognition.
This round fills those from human-demonstration datasets and from typed
questions we derive structurally from the same data.

## 1. Datasets

Convert first: **osunlp/Mind2Web + osunlp/Multimodal-Mind2Web** (CC-BY-4.0 /
OpenRAIL; 137 real sites, 31 domains; ~14.2K human actions with `op ∈ {CLICK,
TYPE, SELECT}` + value; each step ships `cleaned_html`, the target
(`pos_candidates`) and decoys (`neg_candidates`) with `bounding_box_rect`,
tag and attributes; per-step human descriptions `action_reprs`). Verified on a
live shard: `cleaned_html` carries each element's accessible name as inline
`<text>` nodes keyed by the same `backend_node_id` as the candidates, and every
`<option>` carries both `value` and its visible text — so SELECT rows come with
the option list for free. Op mix on a 774-action shard: 645 CLICK / 106 TYPE /
23 SELECT (~3% → ~400–450 SELECT episodes over the corpus, ~45× today's 9).
Mind2Web's own held-out splits are by site/domain and can serve as our val
split directly. Its gaps: no scroll actions, no post-final-action state.

Second, **conditional on a written licence**: **xlangai/AgentTrek** (52.6K
single-step rows, full BrowserGym AXTree text + `bid`-addressed
`click/fill/select_option/scroll/press/hover/goto/send_msg_to_user`, prior
trajectory embedded as text, explicit `<think>`). No licence tag or file
anywhere (card and GitHub) — reference-only until xlang-ai confirms. Sampled
action mix (8,000 rows, scaled ×6.575): ~22.8K click, ~9.3K noop, ~5.7K fill,
~4.2K goto (drop: outside Von's closed set), ~3.5K send_msg_to_user, **~2.9K
scroll** (the only scroll source found), ~2.2K press, ~340 select_option.
Loses `y` and input `type` (tree order only).

Blocked or rejected: McGill-NLP/WebLINX (best real-demonstration fit, but
CC-BY-NC-SA-4.0 with a derivatives-inherit clause — incompatible with shipping
Apache-2.0 weights; ask for an exception); ServiceNow/WorkArena-Instances (live
benchmark credentials, "must not be used for training"); osunlp/Online-Mind2Web
(eval task list, no step data, contamination risk); OS-Copilot/OS-Genesis-web-data
(MIT but gated, 404 even authenticated — request access); TIGER-Lab/BrowserAgent-*
(search/QA tool use, no element targets); ScreenSpot/-v2/-Pro, GUI-World,
OS-Atlas (screenshot-only); Halluminate/BrowserBench (benchmark, card too thin);
WebShop, MiniWoB++ (toy environments).

## 2. Mapping into `pages.jsonl` + `episodes.jsonl` (Mind2Web)

- One synthetic page per action step (each step has its own full-page HTML):
  `pageId = "{annotation_id}_{action_uid}"`; `site ← website`, `category ←
  domain`, `depth ← step index`; `scrollHeight` from the `Root` div's rect,
  `innerHeight` assumed (~800, flag as inferred); **no real URL exists** —
  synthesize `https://{website}.example/` and treat `origin` as a placeholder.
- `viewports[]`: bucket `pos ∪ neg` candidates into one or two windows by `y`
  so the target is visible in one — a reconstruction, not a scroll trace.
- `elements[]`: `tag`, `name` (the node's `<text>` descendant or preceding
  `<label>`; fallback aria-label/placeholder/value/alt), `type ← attributes.type`,
  `y` from the rect, `role` by tag map, `value`/`checked` from attributes,
  `sensitive` by our own heuristic; `<select>` rows also keep the option list.
- `episodes.jsonl`: `kind:'target'`, `goal ← action_reprs[i]` (the step's own
  human description, e.g. "select PICKUP from combobox 'Reservation type'"),
  `steps` from the op (CLICK→click, TYPE→type, SELECT→select), `values` for
  TYPE/SELECT keyed by the field's name/id, `label` = the target's index,
  `writer/verifier = "dataset:mind2web"` (human ground truth).

Worked sample (live): task "Check for pickup restaurant available in Boston…",
`operation {op: SELECT, value: "Pickup"}`, target `<select backend_node_id=136
name="type">` preceded by `<text>Reservation type</text>`, options "Dine in"
(selected) / "Pickup" / … → episode `{goal: "select Pickup from the Reservation
type dropdown", steps:[{action:"select", index:N}], label:N, field:N,
values:{type:"Pickup"}}`.

AgentTrek (if licensed): parse the `##AXTree:` block (`[bid] role 'name'
attrs…`) into elements; parse `<action>name('bid', …)</action>`; `scroll(dx,dy)`
→ SCROLL_DOWN/UP by sign; drop `goto/go_back/go_forward`; `send_msg_to_user`
is the DONE candidate (verify it is not a clarifying question).

## 3. Our own typed instructions (rendered from the same state block)

| # | head | instruction | label | source, rows | gap |
|---|---|---|---|---|---|
| T5 | Choice reversible / committing / uncertain | "Is taking this action reversible, or does it commit to something (submit, payment, navigating away)?" | **structural: `isPointOfNoReturn()` from `src/tools/pageControl.ts` verbatim** on every candidate action | both corpora, tens of thousands | sensitive/committing |
| T4 | Choice over clickables | "Which of these controls submits the form?" | structural: `type="submit"` | Mind2Web pages with a form + ≥2 buttons, 500–1,000+ | committing |
| T1 | Noul | "Is the task complete on this page, with no further action needed?" | structural: YES = AgentTrek `send_msg_to_user` rows (~3.5K); NO = every pending-action row (~63K); class-weight | AgentTrek + Mind2Web | premature DONE |
| T2 | Choice over fields | "Which of these fields still needs a value to complete the task?" | structural: Mind2Web TYPE/SELECT steps with ≥2 fields, some already filled in that step's HTML; label = the targeted field | ~1.5–2K | multi-field forms |
| T3 | Noul | "Does this page require signing in before the task can proceed?" | hybrid: password field present → candidate YES, **Claude confirms** it gates the task; no password field → NO | 100–300 candidates | login walls |
| T6 | Choice | "Which of these elements matches: '{action_reprs}'?" | structural | ~14.2K (redundant with grounding) | grounding |
| T7 | Score | "How far along is this task (0–100)?" | structural `step/total` | tens of thousands | early-stop robustness |
| T8 | Choice over links | "Which of these links leads toward the goal?" | structural | small | low priority |

First batch by value ÷ effort: **T5, T4, T1, T2**. Defer T3, T6–T8.

## 4. Teacher plan (Claude)

Only T3 needs Claude as a primary labeller (5–15 calls: state block + password
candidates + the ground-truth action sequence → `{gates_task, reason}`, 20–30
candidates per call, run twice with candidates shuffled, keep only agreements).
T1 needs a QA sample only (200–300 `send_msg_to_user` rows, 25–50 per call; if
agreement > ~90% trust the structural rule, else escalate to full labelling
with the same blind double pass). Base conversions need no teacher: Mind2Web's
`action_reprs` is the goal. Total ≈ 10–30 teacher calls for the batch.
Unchanged QC: no labels for any site in our held-out eval set; site-level
splits; disagreements dropped, never adjudicated.

## 5. Yield by gap (full conversion)

| gap | rows | teacher calls |
|---|---|---|
| SELECT_OPTION | ~426 Mind2Web + ~340 AgentTrek ≈ 770 | 0 |
| multi-field forms | ~2.4K TYPE/SELECT + ~5.7K `fill` + 1.5–2K T2 | 0 |
| DONE/BLOCKED | ~3.5K DONE:YES + ~63K DONE:NO + 100–300 T3 | 10–30 (QA + T3) |
| scroll | ~2.9K (AgentTrek only) | 0 |
| real-site variety | 137 sites + AgentTrek's mix | 0 |
| sensitive/committing | T5 tens of thousands + T4 500–1,000 + T3 | 5–15 |

## 6. Open items before conversion

1. Licence: ask xlang-ai (AgentTrek) in writing; ask McGill-NLP (WebLINX) for an
   Apache-compatible exception; request access to OS-Genesis-web-data.
2. Decide the placeholder-origin convention for Mind2Web pages (no real URLs).
3. Extend `render.mjs` with the typed-instruction heads (T1–T5) and the
   trainer's per-head report; the act head's rows stay as they are.
4. Re-run the general benchmarks (jabr, JevBench, DecisionBench) after training
   to confirm no forgetting, as on 2026-09-30.
