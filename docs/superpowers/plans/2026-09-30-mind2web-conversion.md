# Mind2Web → Von training corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert osunlp/Multimodal-Mind2Web (all four splits, ~14.2K human-demonstrated CLICK/TYPE/SELECT steps on 137 real sites) into the fine-tune pipeline's `pages.jsonl` + `episodes.jsonl` shape, merge it with the teacher-labelled corpus at render time, and add the four structural typed-instruction heads (T5 committing, T4 submit, T2 missing field, T1 done) the spec's first batch calls for.

**Architecture:** A uv Python script streams only the text columns of the parquet shards over HTTP range requests (no 13 GB download, no screenshots). A pure Node library (jsdom over `cleaned_html`) turns each step into a page whose element registry mirrors what `domIndex.ts` would record on that page — same naming order, same `type` defaults, the same sensitivity regexes copied verbatim and pinned by a parity test — bucketed into one or two 1280×720 viewports so the target is visible in one. Episodes come in two goal kinds: a templated per-step goal (unambiguous, like the teacher corpus) and the task-level `confirmed_task` with the trajectory's prior steps as history (the multi-field form signal). `render.mjs` learns to merge corpora, enforce the site-level split across them, and render the typed heads through the shipped builders (`isPointOfNoReturn` bundled from source, never re-implemented).

**Tech Stack:** Python 3.12 via `uv run` (huggingface_hub HfFileSystem, pyarrow), Node 24 ESM (`jsdom` devDependency, esbuild-bundled TS from `src/`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-von-data-round-2-design.md` (§1 datasets, §2 mapping, §3 typed instructions, §6 open items 2–3).

## Global Constraints

- Data files live in the gitignored `scripts/von-finetune/data/` of the MAIN checkout. From this worktree every script runs with `VFT_DATA=/Users/angks/projects/SUTD/SUTD_AIIG/custom-agentic-browser-panel/scripts/von-finetune/data`. New corpus files go under `data/mind2web/` (`raw/<split>.jsonl.gz`, `pages.jsonl`, `episodes.jsonl`, `mind2web-stats.json`); the teacher corpus stays where it is.
- **Placeholder origin (spec open item 2, decided):** `https://www.{website}.com` when `website` has no dot, else `https://www.{website}`; the page carries `originPlaceholder: true`. Never a `.example` or other synthetic TLD — the origin is printed in every state prefix and a corpus-wide marker there would let the model tell the corpora apart. Anchors carry no `href` in `cleaned_html`, so no origin is ever recoverable and no cross-origin fact is ever asserted.
- **Viewport:** 1280×720 (Playwright's default; the `<html>` rect confirms 1280) with `viewportInferred: true`. Window 0 is `scrollY: 0`; a second window is added only when the target's bottom is below `0.9 × 720`, at `scrollY = clamp(round(target.y − 240), 0, scrollHeight − 720)`. Elements intersect a window when `y < scrollY + 720 && y + height > scrollY`.
- **Registry mirrors `domIndex.ts`:** ≤ 200 elements per window in document order (`truncated` when cut); name order `aria_label → own text → placeholder → value (not a toggle's "on") → title → name attr` (alt is NOT a name, as in production); `type` defaults `button→submit`, `input→text`, `select→select-one|select-multiple`, `textarea→textarea`; `value` = `input_value ?? value` for fields, the selected (else first) option's `value` attr for a select; `checked` = `input_checked === "true"` on checkbox/radio; `sensitive` by the three regexes copied from `domIndex.ts` (parity-tested); `ancestorName` by the same climb (form `aria_label` → dialog title → onclick/button/link/menuitem `aria_label`). `href`, `disabled`, `readonly`, `formMethod` are stripped from `cleaned_html` and stay absent.
- **Negatives:** the target always; otherwise tag ∈ {a,button,input,select,textarea}, role matching domIndex's `INTERACTIVE_ROLES`, `is_clickable === "true"`, or — to avoid the target being the only element of its kind — same tag under the same parent as the target, or the same `class` string as the target (≤ 40). Never `option`, `html`, `body`.
- **Skip rules, every one counted in `mind2web-stats.json`:** no visible positive candidate → `no-target`; `original_op === "ENTER"` → `enter` (Act cannot press keys); TYPE on a control whose `opFor` is not `type`, SELECT on a non-`<select>` → `op-mismatch:<OP>:<tag>`; empty repr name or empty registry name → `unnamed-target`; target beyond the 200 cap → `target-truncated`. A skipped step still contributes its value key to the task and appears in later steps' history (index absent).
- **Splits:** Mind2Web `train`, `test_task`, `test_domain` → `train`; `test_website` (142 tasks on 10 sites unseen in every other split) → `val`. `site ← website`. At merge, a val page whose `siteKey` (first DNS label, e.g. `ikea.com`/`ikea` → `ikea`) is also a train site in ANY corpus moves to train — val loses, never the reverse.
- **Provenance:** `writer: "dataset:mind2web"`, `verifier: "dataset:mind2web"`, `corpus: "mind2web"`, `goalKind: "step" | "task"` on every episode; `pageId: "m2w:<annotation_id>:<action_uid>"`.
- **Typed heads** (all rendered through `renderState`/`renderControl`/`renderControlAction`, label ids fixed): `t5_commit` options `reversible|committing` (no `uncertain`: an option with no labels is dead weight exactly like `WAIT`; the confidence gate expresses uncertainty), anchors excluded (their reversibility is a cross-origin fact the state text never shows); `t4_submit` label = the form's single `type ∈ {submit,image}` button among ≥ 2 button-role controls; `t2_field` from task-goal TYPE/SELECT steps on pages with ≥ 2 editable fields, one already valued or history non-empty; `t1_done` yes/no in Von's own noul packing (two options with explicit affirmative/negative descriptions), YES from teacher `DONE` episodes, NO from target episodes capped at 2× YES. Default caps `--typed-cap t1=4000,t5=6000`.
- Commit with pathspecs only; never `git add -A`; no attribution trailers other than the session line.

## Review Focus

1. A SELECT step whose `operation.value` is not one of the `<select>`'s option texts (Mind2Web stores the visible text, sometimes truncated) → in production `selectOption` refuses it as `failed`. The converter must count `select-value-not-in-options` and keep the option list on the element so a later filter can act; test in Task 3.
2. A task whose rows arrive out of `target_action_index` order (a shard boundary, a re-sorted file) must still produce the same history — `convertTask` sorts its rows; test in Task 3.
3. A control on window 0 with the same name as a below-fold target must suppress the `scroll_down` episode (a header search box duplicating a footer one), never emit a wrong "scroll" label; test in Task 3.
4. A window with more than 200 registered elements whose target falls past the cap must be skipped and counted, never silently re-ordered to keep the target; test in Task 2.
5. A `<button>` with no `type` attribute inside a form IS a submit button (the DOM default) — it must be `type: "submit"` in the registry so `isPointOfNoReturn` and T4 see it as production would; test in Task 2.

---

### Task 1: Stream the shards without the screenshots

**Files:**
- Create: `scripts/von-finetune/mind2web-fetch.py`

**Interfaces:**
- Produces: `data/mind2web/raw/<split>.jsonl.gz`, one row per action, keys `split, annotation_id, action_uid, website, domain, subdomain, confirmed_task, action_reprs[], target_action_index (int), target_action_reprs, operation {op, original_op, value}, pos_candidates[] (JSON strings), neg_candidates[] (JSON strings), cleaned_html`, sorted by `(annotation_id, target_action_index)`.

- [ ] **Step 1: Write the script** (the file as committed; header docstring explains the range-read trick and resumability). `uv run` with inline deps `huggingface_hub>=0.30, pyarrow>=15`; `--splits`, `--limit` (smoke: writes `<split>.limit.jsonl.gz`), `--out`; skips a finished split; writes to `.tmp` then `os.replace`.

- [ ] **Step 2: Smoke run**

Run: `UV_CACHE_DIR=<scratchpad>/uvcache VFT_DATA=<main>/scripts/von-finetune/data uv run scripts/von-finetune/mind2web-fetch.py --splits test_website --limit 40`
Expected: `test_website: 40 rows / N tasks → …/test_website.limit.jsonl.gz` within ~15 s; `zcat | head -c 600` shows a row with the keys above and `target_action_index` as an int.

- [ ] **Step 3: Full run in the background** (all four splits; ~14K rows, ~15 min): same command without `--splits/--limit`, `run_in_background`. Expected files: four `.jsonl.gz` totalling well under 1 GB.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(von-finetune): stream Mind2Web text columns from the parquet shards without the screenshots" -- scripts/von-finetune/mind2web-fetch.py
```

---

### Task 2: The registry builder — one Mind2Web page as domIndex would see it

**Files:**
- Create: `scripts/von-finetune/mind2web-lib.mjs`
- Create: `scripts/von-finetune/mind2web-lib.test.mjs`
- Modify: `vitest.config.ts` (`include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs']`)

**Interfaces:**
- Produces (all pure, exported):
  - `SENSITIVE_RE`, `SWIFT_BIC_RAW_RE`, `INTERACTIVE_ROLES`, `normalizeForSensitivity(s)` — verbatim copies.
  - `originFor(website): string`, `siteKey(site): string`.
  - `parseCandidate(c): {tag, nodeId, attrs, rect:{x,y,width,height}, isOriginal}`; `visible(rect): boolean`; `pickTarget(pos[]): cand | undefined`.
  - `buildRegistry(html, candidates[], targetNodeId | undefined): { title: string, scrollHeight: number, elements: PageElement[] }` where `PageElement = { nodeId, tag, role?, name, type?, value?, checked?, sensitive, ancestorName?, form?, options?: {value, text, selected}[], rect }` in document order (unindexed; indexing happens per window).
  - `parseRepr(s): {role, name, op, value} | undefined` for `"[combobox]  Reservation type -> SELECT: Pickup"`.
- Consumes: `jsdom` (`new JSDOM(html)`; `window.close()` after use).

- [ ] **Step 1: Write the failing tests** — `scripts/von-finetune/mind2web-lib.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERACTIVE_ROLES, SENSITIVE_RE, SWIFT_BIC_RAW_RE, buildRegistry, originFor, parseCandidate, parseRepr, pickTarget, siteKey,
} from './mind2web-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const domIndexSrc = fs.readFileSync(path.join(here, '../../src/platform/domIndex.ts'), 'utf8')
const literal = (name) => {
  const m = domIndexSrc.match(new RegExp(`const ${name} =\\s*\\n?\\s*(/.*?/[a-z]*)\\n`))
  if (!m) throw new Error(`${name} not found in domIndex.ts`)
  return m[1]
}

describe('parity with domIndex.ts', () => {
  it('copies the sensitivity and role regexes verbatim', () => {
    expect(`/${SENSITIVE_RE.source}/${SENSITIVE_RE.flags}`).toBe(literal('SENSITIVE_RE'))
    expect(`/${SWIFT_BIC_RAW_RE.source}/${SWIFT_BIC_RAW_RE.flags}`).toBe(literal('SWIFT_BIC_RAW_RE'))
    expect(`/${INTERACTIVE_ROLES.source}/${INTERACTIVE_ROLES.flags}`).toBe(literal('INTERACTIVE_ROLES'))
  })
})

describe('origin and site', () => {
  it('builds a plausible placeholder origin, never a synthetic TLD', () => {
    expect(originFor('exploretock')).toBe('https://www.exploretock.com')
    expect(originFor('recreation.gov')).toBe('https://www.recreation.gov')
  })
  it('keys a site by its first label so ikea.com and ikea collide', () => {
    expect(siteKey('ikea.com')).toBe('ikea')
    expect(siteKey('www.ikea.com')).toBe('ikea')
    expect(siteKey('ikea')).toBe('ikea')
    expect(siteKey('recreation.gov')).toBe('recreation')
  })
})

describe('candidates', () => {
  it('parses attributes and rects; picks the original visible target', () => {
    const c = parseCandidate({ tag: 'LI', is_original_target: true, backend_node_id: '7', attributes: JSON.stringify({ backend_node_id: '7', bounding_box_rect: '179,540,922,40', class: 'x' }) })
    expect(c).toMatchObject({ tag: 'li', nodeId: '7', isOriginal: true, rect: { x: 179, y: 540, width: 922, height: 40 } })
    const hidden = parseCandidate({ tag: 'a', is_original_target: true, attributes: JSON.stringify({ backend_node_id: '8', bounding_box_rect: '-1,-1,-1,-1' }) })
    expect(pickTarget([hidden, c])).toBe(c)
    expect(pickTarget([hidden])).toBeUndefined()
  })
  it('reads a Mind2Web action repr', () => {
    expect(parseRepr('[combobox]  Reservation type -> SELECT: Pickup')).toEqual({ role: 'combobox', name: 'Reservation type', op: 'SELECT', value: 'Pickup' })
    expect(parseRepr('[svg]   -> CLICK')).toEqual({ role: 'svg', name: '', op: 'CLICK', value: '' })
    expect(parseRepr('[textbox]  Find a location -> TYPE: Boston')).toEqual({ role: 'textbox', name: 'Find a location', op: 'TYPE', value: 'Boston' })
  })
})

const HTML = `<html backend_node_id="1">
<head backend_node_id="2"><title backend_node_id="3"><text backend_node_id="4">Acme &amp; Co</text></title></head>
<body backend_node_id="5">
<form backend_node_id="10" aria_label="Search flights">
  <text backend_node_id="11">From</text>
  <input backend_node_id="12" type="text" name="from" placeholder="City or airport" input_value="Boston"/>
  <input backend_node_id="13" type="password" name="pw"/>
  <input backend_node_id="14" name="ccnum" placeholder="Number"/>
  <label backend_node_id="15"><input backend_node_id="16" type="checkbox" name="flex" value="on" input_checked="true"/><text backend_node_id="17">Flexible dates</text></label>
  <select backend_node_id="18" name="type">
    <option backend_node_id="19" value="dine" option_selected="true"><text backend_node_id="20">Dine in</text></option>
    <option backend_node_id="21" value="pickup"><text backend_node_id="22">Pickup</text></option>
  </select>
  <button backend_node_id="23"><text backend_node_id="24">Search</text></button>
  <button backend_node_id="25" type="button"><text backend_node_id="26">Clear</text></button>
</form>
<div backend_node_id="30" role="dialog"><h2 backend_node_id="31"><text backend_node_id="32">Confirm order</text></h2>
  <button backend_node_id="33" type="button"><text backend_node_id="34">Cancel</text></button></div>
<a backend_node_id="40"><text backend_node_id="41">Help</text></a>
<a backend_node_id="42" aria_label="Home"><img backend_node_id="43" alt="Logo"/></a>
<svg backend_node_id="44"></svg>
<ul backend_node_id="50">
  <li backend_node_id="51" class="item"><text backend_node_id="52">Bradley Airport</text></li>
  <li backend_node_id="53" class="item"><text backend_node_id="54">Hartford</text></li>
  <li backend_node_id="55" class="other"><text backend_node_id="56">Not a decoy</text></li>
</ul>
<div backend_node_id="60" class="item"><text backend_node_id="61">Same class elsewhere</text></div>
<p backend_node_id="70"><text backend_node_id="71">Plain paragraph</text></p>
</body></html>`

const cand = (id, tag, extra = {}) => ({ tag, attributes: JSON.stringify({ backend_node_id: String(id), bounding_box_rect: `0,${id * 10},200,20`, ...extra }) })
const ALL = [1, 5, 12, 13, 14, 16, 18, 23, 25, 33, 40, 42, 43, 44, 51, 53, 55, 60, 70].map((id) => {
  const tag = { 1: 'html', 5: 'body', 12: 'input', 13: 'input', 14: 'input', 16: 'input', 18: 'select', 23: 'button', 25: 'button', 33: 'button', 40: 'a', 42: 'a', 43: 'img', 44: 'svg', 51: 'li', 53: 'li', 55: 'li', 60: 'div', 70: 'p' }[id]
  const extra = id === 42 ? { is_clickable: 'true' } : id === 1 ? { bounding_box_rect: '0,0,1280,3000' } : {}
  return parseCandidate(cand(id, tag, extra))
})

describe('buildRegistry', () => {
  const reg = buildRegistry(HTML, ALL, '51')
  const by = Object.fromEntries(reg.elements.map((e) => [e.nodeId, e]))
  it('reads the title (RCDATA tags stripped) and the page height', () => {
    expect(reg.title).toBe('Acme & Co')
    expect(reg.scrollHeight).toBe(3000)
  })
  it('keeps document order and only what domIndex would index, plus the target and its decoys', () => {
    expect(reg.elements.map((e) => e.nodeId)).toEqual(['12', '13', '14', '16', '18', '23', '25', '33', '40', '42', '51', '53', '60'])
  })
  it('names as production does: aria_label, own text, placeholder, value, title, name — never alt', () => {
    expect(by[12].name).toBe('City or airport')
    expect(by[42].name).toBe('Home')
    expect(by[40].name).toBe('Help')
    expect(by[23].name).toBe('Search')
    expect(by[18].name).toBe('Dine in Pickup')
    expect(by[16].name).toBe('')
  })
  it('defaults type like the DOM: a typeless button submits, a typeless input is text', () => {
    expect(by[23].type).toBe('submit')
    expect(by[25].type).toBe('button')
    expect(by[14].type).toBe('text')
    expect(by[18].type).toBe('select-one')
    expect(by[40].type).toBeUndefined()
  })
  it('carries value, checked and the option list', () => {
    expect(by[12].value).toBe('Boston')
    expect(by[16]).toMatchObject({ checked: true })
    expect(by[16].value).toBeUndefined()
    expect(by[18].value).toBe('dine')
    expect(by[18].options).toEqual([{ value: 'dine', text: 'Dine in', selected: true }, { value: 'pickup', text: 'Pickup', selected: false }])
  })
  it('flags sensitive fields by type and by the copied regexes', () => {
    expect(by[13].sensitive).toBe(true)
    expect(by[14].sensitive).toBe(true)
    expect(by[12].sensitive).toBe(false)
  })
  it('records the named ancestor and the enclosing form', () => {
    expect(by[12].ancestorName).toBe('Search flights')
    expect(by[33].ancestorName).toBe('Confirm order')
    expect(by[40].ancestorName).toBeUndefined()
    expect(by[12].form).toBe('10')
    expect(by[40].form).toBeUndefined()
  })
  it('never registers option, html or body, and drops plain text nodes', () => {
    expect(by[1]).toBeUndefined()
    expect(by[5]).toBeUndefined()
    expect(by[70]).toBeUndefined()
  })
  it('without a target, sibling and same-class decoys are not pulled in', () => {
    const r2 = buildRegistry(HTML, ALL, undefined)
    expect(r2.elements.map((e) => e.nodeId)).not.toContain('51')
    expect(r2.elements.map((e) => e.nodeId)).not.toContain('60')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/von-finetune/mind2web-lib.test.mjs` — after widening `vitest.config.ts`'s `include` to `['src/**/*.test.ts', 'scripts/**/*.test.mjs']`.
Expected: FAIL — cannot resolve `./mind2web-lib.mjs`.

- [ ] **Step 3: Implement `mind2web-lib.mjs` (registry half)**

```js
// Pure conversion of Mind2Web action steps into the fine-tune pipeline's
// pages.jsonl / episodes.jsonl shape. The registry half mirrors what
// src/platform/domIndex.ts records on a live page — same name order, the
// same `type` defaults the DOM applies, the SAME sensitivity regexes (copied
// verbatim; mind2web-lib.test.mjs asserts they equal the source) — because a
// training row must describe a control exactly as the browser will at
// inference. What cleaned_html no longer carries (href, disabled, readonly,
// form method, onclick) stays absent rather than guessed.
import { JSDOM } from 'jsdom'

export const VIEWPORT = { width: 1280, height: 720 } // Playwright's default; the <html> rect confirms 1280
export const MAX_ELEMENTS = 200 // domIndex's cap per snapshot
export const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])
export const SAME_CLASS_DECOYS = 40

// ---- copied from src/platform/domIndex.ts buildInteractiveIndex() — keep byte-identical ----
export const SENSITIVE_RE =
  /card|cvv|ccv|\bcvc2?\b|ssn|passw|social security|routing|account\s*(number|no|num)\b|\bcc[-_]?(num|number|no)\b|\bacct|\bpin\b|security code|\botp\b|verification code|one[-\s]?time|iban|sort code/i
export const SWIFT_BIC_RAW_RE = /\bswift[-_]?code\b|\bbic[-_]?code\b/i
export const INTERACTIVE_ROLES =
  /^(button|link|checkbox|radio|tab|menuitem|switch|option|combobox|textbox)$/i
export const normalizeForSensitivity = (s) => s.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ')
const isBareSwiftOrBic = (s) => { const t = String(s).trim().toLowerCase(); return t === 'swift' || t === 'bic' }
// ---- end of copy ----

// observation.ts's TEXT_INPUT/opFor, mirrored for the op-mismatch check (the renderer re-derives it from the shipped code).
const TEXT_INPUT = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])
export function opFor(el) {
  if (el.tag === 'select') return 'select'
  if (el.tag === 'textarea') return 'type'
  if (el.tag === 'input' && TEXT_INPUT.has((el.type ?? '').toLowerCase())) return 'type'
  if (el.role === 'textbox' || el.role === 'searchbox') return 'type'
  return 'click'
}

export const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export const originFor = (website) => `https://www.${website.includes('.') ? website : `${website}.com`}`
export const siteKey = (site) => String(site).toLowerCase().replace(/^www\./, '').split('.')[0]

export function parseRect(s) {
  const [x, y, width, height] = String(s ?? '-1,-1,-1,-1').split(',').map(Number)
  return { x, y, width, height }
}
export const visible = (r) => r.x >= 0 && r.y >= 0 && r.width >= 4 && r.height >= 4 // domIndex drops < 4 px

export function parseCandidate(c) {
  const attrs = typeof c.attributes === 'string' ? JSON.parse(c.attributes) : (c.attributes ?? {})
  return { tag: String(c.tag).toLowerCase(), nodeId: String(c.backend_node_id ?? attrs.backend_node_id), attrs, rect: parseRect(attrs.bounding_box_rect), isOriginal: !!c.is_original_target }
}
export function pickTarget(pos) {
  const vis = pos.filter((p) => visible(p.rect))
  return vis.find((p) => p.isOriginal) ?? vis[0]
}

const REPR = /^\[([^\]]*)\]\s*(.*?)\s*->\s*(CLICK|TYPE|SELECT)(?::\s*(.*))?$/s
export function parseRepr(s) {
  const m = REPR.exec(String(s ?? '').trim())
  if (!m) return undefined
  return { role: m[1].trim(), name: collapse(m[2]), op: m[3], value: collapse(m[4] ?? '') }
}

function typeOf(tag, a) {
  if (tag === 'input') return (a.type ?? 'text').toLowerCase()
  if (tag === 'button') return (a.type ?? 'submit').toLowerCase() // HTMLButtonElement.type defaults to "submit"
  if (tag === 'select') return a.multiple !== undefined ? 'select-multiple' : 'select-one'
  if (tag === 'textarea') return 'textarea'
  return undefined
}

function accessibleName(el, tag, a) {
  if (a.aria_label) return String(a.aria_label).trim().slice(0, 120)
  const text = tag === 'input' || tag === 'textarea' ? '' : collapse(el.textContent)
  const toggle = tag === 'input' && /^(checkbox|radio)$/i.test(a.type ?? '')
  const raw = a.input_value ?? a.value ?? ''
  const value = toggle && raw === 'on' ? '' : raw
  return String(text || a.placeholder || value || a.title || a.name || '').slice(0, 120)
}

function optionsOf(el) {
  return Array.from(el.querySelectorAll('option')).map((o) => ({
    value: o.getAttribute('value') ?? collapse(o.textContent), text: collapse(o.textContent),
    selected: o.hasAttribute('option_selected') || o.hasAttribute('selected'),
  }))
}

function valueOf(tag, a, el) {
  if (tag === 'select') {
    const opts = optionsOf(el)
    const sel = opts.find((o) => o.selected) ?? opts[0] // a select-one always has a selection
    return sel ? sel.value.slice(0, 80) : undefined
  }
  const v = a.input_value ?? a.value
  return v ? String(v).slice(0, 80) : undefined
}

function sensitiveOf(el, tag, a, accessible) {
  const type = typeOf(tag, a)
  const nameAttr = a.name ?? '', idAttr = a.id ?? ''
  const nameId = `${nameAttr} ${idAttr}`
  const aria = a.aria_label ?? '', ph = a.placeholder ?? ''
  const wrapping = el.closest('label')
  const labelForText = wrapping ? collapse(wrapping.textContent).slice(0, 200) : '' // cleaned_html keeps no `for`
  const labelText = [aria, ph, accessible, labelForText, ''].join(' ')
  return type === 'password' ||
    SENSITIVE_RE.test(nameId) || SENSITIVE_RE.test(labelText) || SENSITIVE_RE.test(normalizeForSensitivity(`${nameId} ${labelText}`)) ||
    SWIFT_BIC_RAW_RE.test(nameId) || SWIFT_BIC_RAW_RE.test(labelText) ||
    [nameAttr, idAttr, aria, ph, accessible, labelForText].some(isBareSwiftOrBic)
}

const dialogTitleOf = (d) => {
  const aria = d.getAttribute('aria_label')
  if (aria) return aria.trim().slice(0, 120)
  const h = d.querySelector('h1,h2,h3,h4,h5,h6')
  return h ? collapse(h.textContent).slice(0, 120) : ''
}
function ancestorNameOf(el) {
  let node = el.parentElement, depth = 0
  while (node && depth++ < 40) {
    const role = (node.getAttribute('role') || '').toLowerCase()
    if (node.tagName === 'FORM') {
      const aria = node.getAttribute('aria_label')
      if (aria) return aria.trim().slice(0, 120)
    } else if (role === 'dialog' || role === 'alertdialog') {
      const t = dialogTitleOf(node)
      if (t) return t
    } else if (node.hasAttribute('onclick') || /^(button|link|menuitem)$/.test(role)) {
      const aria = node.getAttribute('aria_label')
      if (aria) return aria.trim().slice(0, 120)
    }
    node = node.parentElement
  }
  return ''
}

/**
 * Which candidates the registry lists. The target always; otherwise what
 * domIndex's isInteractive would accept from the attributes that survive
 * cleaning, plus two decoy rules so the target is never the only element of
 * its kind (21% of Mind2Web click targets are div/li/span/svg with no
 * interactive attribute; without decoys the odd role out would give the
 * answer away).
 */
function registered(c, el, target, targetEl, sameClass) {
  if (target && c.nodeId === target.nodeId) return true
  if (c.tag === 'option' || c.tag === 'html' || c.tag === 'body') return false
  if (INTERACTIVE_TAGS.has(c.tag)) return true
  if (INTERACTIVE_ROLES.test(c.attrs.role ?? '')) return true
  if (c.attrs.is_clickable === 'true') return true
  if (target && c.tag === target.tag) {
    if (targetEl && el.parentElement && el.parentElement === targetEl.parentElement) return true
    if (c.attrs.class && c.attrs.class === target.attrs.class && sameClass.n++ < SAME_CLASS_DECOYS) return true
  }
  return false
}

export function buildRegistry(html, candidates, targetNodeId) {
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    const byNode = new Map(candidates.filter((c) => visible(c.rect)).map((c) => [c.nodeId, c]))
    const target = targetNodeId !== undefined ? byNode.get(targetNodeId) : undefined
    const targetEl = target ? doc.querySelector(`[backend_node_id="${target.nodeId}"]`) : null
    const titleEl = doc.querySelector('title')
    const title = titleEl ? collapse(titleEl.textContent.replace(/<[^>]+>/g, '')) : ''
    const root = candidates.find((c) => c.tag === 'html') ?? candidates.find((c) => c.tag === 'body')
    const scrollHeight = Math.max(root ? root.rect.height : 0, ...candidates.map((c) => (visible(c.rect) ? c.rect.y + c.rect.height : 0)), VIEWPORT.height)
    const sameClass = { n: 0 }
    const elements = []
    for (const el of doc.querySelectorAll('[backend_node_id]')) { // document order
      const c = byNode.get(el.getAttribute('backend_node_id'))
      if (!c || !registered(c, el, target, targetEl, sameClass)) continue
      const a = c.attrs
      const type = typeOf(c.tag, a)
      const name = accessibleName(el, c.tag, a)
      const toggle = c.tag === 'input' && /^(checkbox|radio)$/i.test(type ?? '')
      const form = el.closest('form')
      const rec = {
        nodeId: c.nodeId, tag: c.tag, role: a.role || undefined, name, type,
        value: toggle ? undefined : valueOf(c.tag, a, el),
        checked: toggle ? a.input_checked === 'true' : undefined,
        sensitive: sensitiveOf(el, c.tag, a, name),
        ancestorName: ancestorNameOf(el) || undefined,
        form: form ? form.getAttribute('backend_node_id') ?? undefined : undefined,
        options: c.tag === 'select' ? optionsOf(el) : undefined,
        rect: c.rect,
      }
      elements.push(rec)
    }
    return { title, scrollHeight: Math.round(scrollHeight), elements }
  } finally {
    dom.window.close()
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run scripts/von-finetune/mind2web-lib.test.mjs`
Expected: PASS (all describe blocks). If `by[18].name` differs because jsdom's "in select" parsing drops the `<text>` wrapper, the expected joined option text still holds (character data survives; only the tag is ignored).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(von-finetune): Mind2Web registry builder mirroring domIndex naming, type defaults and sensitivity" -- scripts/von-finetune/mind2web-lib.mjs scripts/von-finetune/mind2web-lib.test.mjs vitest.config.ts
```

---

### Task 3: Viewports, goals, value keys and episodes

**Files:**
- Modify: `scripts/von-finetune/mind2web-lib.mjs` (append)
- Modify: `scripts/von-finetune/mind2web-lib.test.mjs` (append)

**Interfaces:**
- Produces:
  - `bucketViewports(registry, targetNodeId, scrollHeight): { viewports: [{ scrollY, truncated, elements: SlimElement[] }], targetVp: number | undefined, targetIndex: number | undefined, sameNameOnTop: boolean }` — `SlimElement` = the pages.jsonl element shape `{ index, nodeId, tag, role?, name, type?, value?, checked?, sensitive, ancestorName?, form?, options?, y }` (`y` viewport-relative).
  - `keyFor(name, taken: Set<string>): string` — snake_case ≤ 30 chars, `value` when empty, `_2`… on collision (adds to `taken`).
  - `stepGoal({ op, roleWord, name, value, withValue }, r): string` — templated goal, `r` a `lib.mjs` `rng()`.
  - `convertTask(rows, { rng }): { pages: Page[], episodes: Episode[], skipped: Record<string, number>, warnings: Record<string, number> }` — rows of one `annotation_id` in any order.
  - `SPLIT_OF = { train: 'train', test_task: 'train', test_domain: 'train', test_website: 'val' }`.
- Episode shape (superset of the teacher corpus): `{ pageId, corpus: 'mind2web', goalKind, split, site, category, subdomain, goal, vp, writer, verifier, kind: 'target'|'value'|'move', values, steps: [{action, index?, label, valueKey?}], label, op?, field? }`.

- [ ] **Step 1: Append the failing tests**

```js
import { bucketViewports, convertTask, keyFor, stepGoal, SPLIT_OF } from './mind2web-lib.mjs'
import { rng } from './lib.mjs'

describe('bucketViewports', () => {
  const el = (nodeId, y, extra = {}) => ({ nodeId, tag: 'a', name: `n${nodeId}`, sensitive: false, rect: { x: 0, y, width: 100, height: 20 }, ...extra })
  it('one window when the target is on the first screen; indices and y are per window', () => {
    const v = bucketViewports({ elements: [el('1', 10), el('2', 600), el('3', 1500)] }, '2', 3000)
    expect(v.viewports).toHaveLength(1)
    expect(v.viewports[0].elements.map((e) => [e.index, e.nodeId, e.y])).toEqual([[0, '1', 10], [1, '2', 600]])
    expect(v).toMatchObject({ targetVp: 0, targetIndex: 1, sameNameOnTop: false })
  })
  it('adds a second window a third of a screen above a below-fold target, clamped to the page', () => {
    const v = bucketViewports({ elements: [el('1', 10), el('2', 1500), el('3', 2900)] }, '3', 3000)
    expect(v.viewports.map((w) => w.scrollY)).toEqual([0, 2280])
    expect(v.viewports[1].elements.map((e) => [e.index, e.nodeId, e.y])).toEqual([[0, '3', 620]])
    expect(v).toMatchObject({ targetVp: 1, targetIndex: 0 })
  })
  it('reports a same-name control on the top screen (scroll_down must then be withheld)', () => {
    const v = bucketViewports({ elements: [el('1', 10, { name: 'Search' }), el('2', 1500, { name: 'search' })] }, '2', 3000)
    expect(v.sameNameOnTop).toBe(true)
  })
  it('caps a window at 200 in document order and reports a target past the cap as absent, never re-ordered', () => {
    const many = Array.from({ length: 205 }, (_, i) => el(String(i), 5 + i))
    const v = bucketViewports({ elements: many }, '204', 3000)
    expect(v.viewports[0].elements).toHaveLength(200)
    expect(v.viewports[0].truncated).toBe(true)
    expect(v.targetIndex).toBeUndefined()
  })
})

describe('keys and goals', () => {
  it('snake-cases names and dedupes', () => {
    const taken = new Set()
    expect(keyFor('Find a location', taken)).toBe('find_a_location')
    expect(keyFor('Find a location', taken)).toBe('find_a_location_2')
    expect(keyFor('', taken)).toBe('value')
    expect(keyFor('A'.repeat(50), taken)).toHaveLength(30)
  })
  it('renders deterministic goals that name the control and, when asked, the value', () => {
    const r = rng('goal')
    const g1 = stepGoal({ op: 'SELECT', roleWord: 'combobox', name: 'Reservation type', value: 'Pickup', withValue: true }, r)
    expect(g1).toMatch(/Pickup/); expect(g1).toMatch(/Reservation type/)
    const g2 = stepGoal({ op: 'TYPE', roleWord: 'textbox', name: 'Find a location', value: 'Boston', withValue: false }, r)
    expect(g2).not.toMatch(/Boston/); expect(g2).toMatch(/Find a location/)
    const g3 = stepGoal({ op: 'CLICK', roleWord: 'link', name: 'Book Now', value: '', withValue: true }, r)
    expect(g3).toMatch(/Book Now/)
    expect(stepGoal({ op: 'SELECT', roleWord: 'combobox', name: 'Reservation type', value: 'Pickup', withValue: true }, rng('goal'))).toBe(g1)
  })
})

const TASK_HTML = (extra = '') => `<html backend_node_id="1"><body backend_node_id="2">
<input backend_node_id="10" type="text" placeholder="Find a location" input_value=""/>
<select backend_node_id="20"><option backend_node_id="21" value="dine" option_selected="true"><text backend_node_id="22">Dine in</text></option><option backend_node_id="23" value="pickup"><text backend_node_id="24">Pickup</text></option></select>
<a backend_node_id="30"><text backend_node_id="31">Book Now</text></a>
<svg backend_node_id="40"></svg>${extra}</body></html>`
const C = (id, tag, y, extra = {}) => ({ tag, attributes: JSON.stringify({ backend_node_id: String(id), bounding_box_rect: `0,${y},200,20`, ...extra }) })
const NEG = [C(1, 'html', 0, { bounding_box_rect: '0,0,1280,2000' }), C(10, 'input', 100, { type: 'text', placeholder: 'Find a location' }), C(20, 'select', 200), C(30, 'a', 300), C(40, 'svg', 400)]
const row = (i, op, pos, value = '', original_op = op, reprs = ['[textbox]  Find a location -> TYPE: Boston', '[combobox]  Dine in -> SELECT: Pickup', '[link]  Book Now -> CLICK', '[svg]   -> CLICK']) => ({
  split: 'test_website', annotation_id: 'A1', action_uid: `u${i}`, website: 'exploretock', domain: 'Travel', subdomain: 'Restaurant',
  confirmed_task: 'Check for pickup in Boston', action_reprs: reprs, target_action_index: i, target_action_reprs: reprs[i],
  operation: { op, original_op, value }, pos_candidates: pos.map((id) => ({ ...C(id, { 10: 'input', 20: 'select', 30: 'a', 40: 'svg' }[id], id * 10, id === 10 ? { type: 'text', placeholder: 'Find a location' } : {}), is_original_target: true })),
  neg_candidates: NEG, cleaned_html: TASK_HTML(),
})

describe('convertTask', () => {
  const rows = [row(2, 'CLICK', [30]), row(0, 'TYPE', [10], 'Boston'), row(1, 'SELECT', [20], 'Pickup'), row(3, 'CLICK', [40])]
  const out = convertTask(rows, { rng: rng('t') })
  it('orders rows by target_action_index whatever order they arrive in, one page per converted step', () => {
    expect(out.pages.map((p) => p.stepIndex)).toEqual([0, 1, 2])
    expect(out.pages[0]).toMatchObject({ pageId: 'm2w:A1:u0', site: 'exploretock', split: 'val', category: 'Travel', originPlaceholder: true, viewportInferred: true, innerHeight: 720 })
    expect(out.pages[0].viewports[0]).toMatchObject({ scrollY: 0, origin: 'https://www.exploretock.com', url: 'https://www.exploretock.com/' })
  })
  it('skips the unnamed svg click and counts it', () => {
    expect(out.skipped['unnamed-target']).toBe(1)
  })
  it('emits step-goal and task-goal episodes with the human op and the task values as history', () => {
    const eps = out.episodes.filter((e) => e.pageId === 'm2w:A1:u2')
    const step = eps.find((e) => e.goalKind === 'step' && e.kind === 'target')
    expect(step).toMatchObject({ op: 'CLICK', label: 2, values: {}, steps: [], writer: 'dataset:mind2web', corpus: 'mind2web' })
    expect(step.goal).toMatch(/Book Now/)
    const task = eps.find((e) => e.goalKind === 'task' && e.kind === 'target')
    expect(task.goal).toBe('Check for pickup in Boston')
    expect(Object.keys(task.values).sort()).toEqual(['dine_in', 'find_a_location'])
    expect(task.steps).toEqual([
      { action: 'type', index: 0, label: 'Find a location', valueKey: 'find_a_location' },
      { action: 'select', index: 1, label: 'Dine in', valueKey: 'dine_in' },
    ])
  })
  it('gives TYPE/SELECT steps a value row when two keys exist and a BLOCKED row when the goal hides the value', () => {
    const eps = out.episodes.filter((e) => e.pageId === 'm2w:A1:u1')
    const value = eps.find((e) => e.kind === 'value' && e.goalKind === 'task')
    expect(value).toMatchObject({ field: 1, label: 'dine_in' })
    const stepTarget = eps.find((e) => e.kind === 'target' && e.goalKind === 'step')
    expect(stepTarget.values.dine_in).toBe('Pickup')
    const blocked = out.episodes.filter((e) => e.kind === 'move' && e.label === 'BLOCKED')
    for (const b of blocked) expect(b.goal).not.toMatch(/Boston|Pickup/)
  })
  it('counts a SELECT value that is not among the options and keeps the option list', () => {
    const bad = convertTask([row(1, 'SELECT', [20], 'Takeaway')], { rng: rng('t') })
    expect(bad.warnings['select-value-not-in-options']).toBe(1)
    expect(bad.pages[0].viewports[0].elements.find((e) => e.tag === 'select').options.map((o) => o.text)).toEqual(['Dine in', 'Pickup'])
  })
  it('skips ENTER, empty targets and op/tag mismatches with a reason each', () => {
    const r = convertTask([row(2, 'CLICK', [30], '', 'ENTER'), row(0, 'TYPE', []), row(1, 'SELECT', [30], 'x')], { rng: rng('t') })
    expect(r.skipped).toMatchObject({ enter: 1, 'no-target': 1, 'op-mismatch:SELECT:a': 1 })
    expect(r.pages).toHaveLength(0)
  })
  it('emits scroll_down for a below-fold target unless a same-name control is on top', () => {
    const low = row(2, 'CLICK', [30]); low.pos_candidates[0].attributes = JSON.stringify({ backend_node_id: '30', bounding_box_rect: '0,1500,200,20' })
    low.neg_candidates = [...NEG.filter((c) => JSON.parse(c.attributes).backend_node_id !== '30')]
    const r = convertTask([low], { rng: rng('t') })
    const scroll = r.episodes.filter((e) => e.label === 'scroll_down')
    expect(scroll.map((e) => e.goalKind).sort()).toEqual(['step', 'task'])
    expect(scroll[0]).toMatchObject({ vp: 0, kind: 'move' })
    expect(r.episodes.find((e) => e.kind === 'target').vp).toBe(1)
  })
  it('maps every Mind2Web split', () => {
    expect(SPLIT_OF).toEqual({ train: 'train', test_task: 'train', test_domain: 'train', test_website: 'val' })
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail** — `npx vitest run scripts/von-finetune/mind2web-lib.test.mjs`. Expected: FAIL, `bucketViewports is not a function` (and friends).

- [ ] **Step 3: Implement (append to `mind2web-lib.mjs`)**

```js
export const SPLIT_OF = { train: 'train', test_task: 'train', test_domain: 'train', test_website: 'val' }
const WRITER = 'dataset:mind2web'
const ACTION_OF_OP = { CLICK: 'click', TYPE: 'type', SELECT: 'select' }
const OPERATION_OF_OP = { CLICK: 'CLICK', TYPE: 'TYPE_TEXT', SELECT: 'SELECT_OPTION' }

const slim = (e, index, scrollY) => {
  const { rect, ...rest } = e
  const out = { index, ...rest, y: Math.round(rect.y - scrollY) }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/** One or two windows; the target must be visible in one (a reconstruction, not a scroll trace). */
export function bucketViewports(registry, targetNodeId, scrollHeight, vh = VIEWPORT.height) {
  const target = registry.elements.find((e) => e.nodeId === targetNodeId)
  const maxScroll = Math.max(0, scrollHeight - vh)
  const offsets = [0]
  if (target && target.rect.y + target.rect.height > vh * 0.9) {
    const y = Math.min(maxScroll, Math.max(0, Math.round(target.rect.y - vh / 3)))
    if (y > 0) offsets.push(y)
  }
  const viewports = offsets.map((scrollY) => {
    const inWin = registry.elements.filter((e) => e.rect.y < scrollY + vh && e.rect.y + e.rect.height > scrollY)
    const kept = inWin.slice(0, MAX_ELEMENTS)
    return { scrollY, truncated: inWin.length > kept.length, elements: kept.map((e, i) => slim(e, i, scrollY)) }
  })
  let targetVp, targetIndex
  for (let i = viewports.length - 1; i >= 0; i--) {
    const hit = viewports[i].elements.find((e) => e.nodeId === targetNodeId)
    if (hit) { targetVp = i; targetIndex = hit.index; break }
  }
  const tname = (target?.name ?? '').toLowerCase()
  const sameNameOnTop = !!target && targetVp !== 0 && !!tname &&
    viewports[0].elements.some((e) => e.nodeId !== targetNodeId && (e.name ?? '').toLowerCase() === tname)
  return { viewports, targetVp, targetIndex, sameNameOnTop }
}

export function keyFor(name, taken) {
  let base = collapse(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/g, '') || 'value'
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 30 - String(n).length - 1)}_${n}`
  taken.add(key)
  return key
}

const pick = (xs, r) => xs[Math.floor(r() * xs.length)]
const q = (s, r) => (r() < 0.5 ? `"${s}"` : s)
const CLICK_TEMPLATES = {
  link: ['Open {n}', 'Go to {n}', 'Click the {n} link'],
  button: ['Click {n}', 'Press the {n} button', 'Hit {n}'],
  checkbox: ['Tick {n}', 'Check the {n} box', 'Select {n}'],
  radio: ['Choose {n}', 'Select the {n} option'],
  tab: ['Switch to the {n} tab', 'Open the {n} tab'],
  option: ['Choose {n}', 'Pick {n}', 'Select {n} from the list'],
  menuitem: ['Choose {n} from the menu', 'Pick {n}'],
  li: ['Choose {n}', 'Pick {n}', 'Select {n} from the list'],
  default: ['Click {n}', 'Select {n}', 'Open {n}'],
}
const TYPE_WITH = ['Type {v} into {n}', 'Enter {v} in the {n} field', 'Fill in {n} with {v}']
const TYPE_SEARCH = ['Search for {v}', 'Look up {v}']
const TYPE_WITHOUT = ['Fill in the {n} field', 'Enter a value in {n}', 'Type into {n}']
const SELECT_WITH = ['Select {v} from the {n} dropdown', 'Set {n} to {v}', 'Choose {v} under {n}']
const SELECT_WITHOUT = ['Pick an option in the {n} dropdown', 'Choose a value for {n}']

/** A templated, deterministic per-step goal from Mind2Web's own element description. */
export function stepGoal({ op, roleWord, name, value, withValue }, r) {
  const n = q(collapse(name).slice(0, 60), r)
  const v = q(collapse(value).slice(0, 60), r)
  let t
  if (op === 'CLICK') t = pick(CLICK_TEMPLATES[roleWord] ?? CLICK_TEMPLATES.default, r)
  else if (op === 'TYPE') t = withValue ? pick(/search/i.test(`${roleWord} ${name}`) && r() < 0.5 ? TYPE_SEARCH : TYPE_WITH, r) : pick(TYPE_WITHOUT, r)
  else t = withValue ? pick(SELECT_WITH, r) : pick(SELECT_WITHOUT, r)
  return t.replace('{n}', n).replace('{v}', v)
}

const shuffleEntries = (obj, r) => {
  const a = Object.entries(obj)
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return Object.fromEntries(a)
}

/**
 * All the steps of one Mind2Web task → pages (one per converted step) and
 * episodes in both goal kinds. Rows may arrive in any order. Every skip is
 * counted, and a skipped step still lends its value key to the task and its
 * line to later steps' history (without an index).
 */
export function convertTask(rows, { rng: r }) {
  const steps = [...rows].sort((a, b) => a.target_action_index - b.target_action_index)
  const skipped = {}, warnings = {}
  const count = (m, k) => { m[k] = (m[k] ?? 0) + 1 }
  const pages = [], episodes = []
  if (!steps.length) return { pages, episodes, skipped, warnings }
  const first = steps[0]
  const website = first.website, origin = originFor(website), split = SPLIT_OF[first.split] ?? 'train'
  // Value keys for the whole task, from Mind2Web's own element descriptions (present even for skipped steps).
  const taken = new Set()
  const keyOfStep = new Map(), taskValues = {}
  for (const s of steps) {
    if (s.operation.op !== 'TYPE' && s.operation.op !== 'SELECT') continue
    const repr = parseRepr(s.target_action_reprs) ?? parseRepr(s.action_reprs[s.target_action_index])
    const key = keyFor(repr?.name ?? '', taken)
    keyOfStep.set(s.target_action_index, key)
    taskValues[key] = s.operation.value
  }
  const history = [] // {action, index?, label, valueKey?}
  for (const s of steps) {
    const op = s.operation.op
    const repr = parseRepr(s.target_action_reprs) ?? parseRepr(s.action_reprs[s.target_action_index]) ?? { role: '', name: '', op, value: s.operation.value }
    const hist = { action: ACTION_OF_OP[op] ?? 'click', label: repr.name.slice(0, 60), valueKey: keyOfStep.get(s.target_action_index) }
    const done = () => { history.push(Object.fromEntries(Object.entries(hist).filter(([, v]) => v !== undefined))) }
    if (s.operation.original_op === 'ENTER') { count(skipped, 'enter'); done(); continue }
    const pos = s.pos_candidates.map(parseCandidate), neg = s.neg_candidates.map(parseCandidate)
    const target = pickTarget(pos)
    if (!target) { count(skipped, 'no-target'); done(); continue }
    const registry = buildRegistry(s.cleaned_html, [...pos, ...neg], target.nodeId)
    const tEl = registry.elements.find((e) => e.nodeId === target.nodeId)
    if (!tEl) { count(skipped, 'target-unregistered'); done(); continue }
    const kind = opFor(tEl)
    if ((op === 'TYPE' && kind !== 'type') || (op === 'SELECT' && kind !== 'select')) { count(skipped, `op-mismatch:${op}:${tEl.tag}`); done(); continue }
    if (!repr.name || !tEl.name) { count(skipped, 'unnamed-target'); done(); continue }
    const { viewports, targetVp, targetIndex, sameNameOnTop } = bucketViewports(registry, target.nodeId, registry.scrollHeight)
    if (targetVp === undefined) { count(skipped, 'target-truncated'); done(); continue }
    if (op === 'SELECT' && !tEl.options?.some((o) => o.text === s.operation.value || o.value === s.operation.value)) count(warnings, 'select-value-not-in-options')
    hist.index = targetIndex
    const pageId = `m2w:${s.annotation_id}:${s.action_uid}`
    const title = registry.title || website
    pages.push({
      pageId, corpus: 'mind2web', url: `${origin}/`, finalUrl: `${origin}/`, site: website, split, category: s.domain, subdomain: s.subdomain,
      task: s.confirmed_task, stepIndex: s.target_action_index, stepCount: s.action_reprs.length, depth: s.target_action_index,
      innerHeight: VIEWPORT.height, scrollHeight: registry.scrollHeight, viewportInferred: true, originPlaceholder: true,
      viewports: viewports.map((v) => ({ scrollY: v.scrollY, title, origin, url: `${origin}/`, truncated: v.truncated, elements: v.elements })),
    })
    const base = { pageId, corpus: 'mind2web', split, site: website, category: s.domain, subdomain: s.subdomain, writer: WRITER, verifier: WRITER }
    const key = keyOfStep.get(s.target_action_index)
    const action = ACTION_OF_OP[op]
    const others = Object.fromEntries(Object.entries(taskValues).filter(([k]) => k !== key))
    const distractors = Object.fromEntries(Object.entries(others).sort(() => 0).slice(0, 2))
    const field = op !== 'CLICK'
    const emit = (goalKind, goal, values, hist0, targetVpIdx) => {
      const b = { ...base, goalKind, goal, vp: targetVpIdx, values, steps: hist0 }
      episodes.push({ ...b, kind: 'target', label: targetIndex, op: OPERATION_OF_OP[op] })
      if (field && Object.keys(values).length >= 2) episodes.push({ ...b, kind: 'value', field: targetIndex, label: key })
      episodes.push({ ...b, kind: 'move', label: 'act' })
      if (targetVpIdx > 0 && !sameNameOnTop) episodes.push({ ...b, vp: 0, kind: 'move', label: 'scroll_down' })
    }
    // Step goal: the human description of this step alone, no history.
    const withValue = !field || r() < 0.5
    const goal = stepGoal({ op, roleWord: repr.role, name: repr.name, value: s.operation.value, withValue }, r)
    const stepValues = field ? shuffleEntries({ [key]: s.operation.value, ...distractors }, r) : {}
    emit('step', goal, stepValues, [], targetVp)
    if (field && !withValue) episodes.push({ ...base, goalKind: 'step', goal, vp: targetVp, values: distractors, steps: [], kind: 'move', label: 'BLOCKED' })
    // Task goal: the whole task with the trajectory so far.
    emit('task', s.confirmed_task, shuffleEntries(taskValues, r), history.map((h) => ({ ...h })), targetVp)
    done()
  }
  return { pages, episodes, skipped, warnings }
}
```

Note the distractor pick above (`sort(() => 0).slice(0, 2)`) is deterministic document order; keep it that way — the value head's distractors are the task's *other* values, and there are rarely more than three.

- [ ] **Step 4: Run the tests** — `npx vitest run scripts/von-finetune/mind2web-lib.test.mjs`. Expected: PASS. Then the whole suite: `npm test`. Expected: all green (the widened include picks up only the new file).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(von-finetune): Mind2Web viewports, templated step goals, task-goal histories and episodes" -- scripts/von-finetune/mind2web-lib.mjs scripts/von-finetune/mind2web-lib.test.mjs
```

---

### Task 4: The converter CLI

**Files:**
- Create: `scripts/von-finetune/mind2web.mjs`

**Interfaces:**
- Consumes: `data/mind2web/raw/<split>.jsonl.gz` (Task 1), `convertTask` (Task 3), `lib.mjs`'s `DATA`, `log`, `rng`, `writeJsonl`.
- Produces: `data/mind2web/pages.jsonl`, `data/mind2web/episodes.jsonl`, `data/mind2web/mind2web-stats.json` `{ splits: {<split>: {rows, tasks, pages, episodes}}, episodes: {byKind, byGoalKind, byLabel}, skipped, warnings, websites: n, valSites: [...] }`.

- [ ] **Step 1: Write the CLI**

```js
// Stage M2 — Mind2Web raw rows → pages.jsonl + episodes.jsonl in the pipeline's
// shape, one task at a time (the raw files are sorted by task, so only one
// task's rows are ever in memory).
//
//   node scripts/von-finetune/mind2web.mjs [--splits train,test_task,test_website,test_domain] [--limit N tasks] [--raw-suffix limit]
//
// Output: DATA/mind2web/{pages,episodes}.jsonl (rewritten each run — it is a
// deterministic function of the raw files) and mind2web-stats.json.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { parseArgs } from 'node:util'
import { DATA, log, rng, writeJsonl } from './lib.mjs'
import { convertTask } from './mind2web-lib.mjs'

const { values: args } = parseArgs({
  options: {
    splits: { type: 'string', default: 'train,test_task,test_website,test_domain' },
    limit: { type: 'string', default: '0' },
    'raw-suffix': { type: 'string', default: '' },
  },
})
const DIR = path.join(DATA, 'mind2web')
const limit = Number(args.limit) || Infinity

async function* tasksOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity })
  let cur = [], id
  for await (const line of rl) {
    if (!line) continue
    const row = JSON.parse(line)
    if (id !== undefined && row.annotation_id !== id) { yield cur; cur = [] }
    id = row.annotation_id
    cur.push(row)
  }
  if (cur.length) yield cur
}

const add = (m, k, n = 1) => { m[k] = (m[k] ?? 0) + n }
const pages = [], episodes = []
const stats = { splits: {}, episodes: { byKind: {}, byGoalKind: {}, byLabel: {} }, skipped: {}, warnings: {}, websites: 0, valSites: [] }
const sites = new Set(), valSites = new Set()
let tasks = 0
for (const split of args.splits.split(',').filter(Boolean)) {
  const file = path.join(DIR, 'raw', `${split}.${args['raw-suffix'] ? `${args['raw-suffix']}.` : ''}jsonl.gz`)
  if (!fs.existsSync(file)) { log(`missing ${file} — run mind2web-fetch.py first`); continue }
  const s = { rows: 0, tasks: 0, pages: 0, episodes: 0 }
  const t0 = Date.now()
  for await (const rows of tasksOf(file)) {
    if (tasks >= limit) break
    tasks++
    const out = convertTask(rows, { rng: rng(rows[0].annotation_id) })
    s.rows += rows.length; s.tasks++; s.pages += out.pages.length; s.episodes += out.episodes.length
    pages.push(...out.pages); episodes.push(...out.episodes)
    for (const [k, v] of Object.entries(out.skipped)) add(stats.skipped, k, v)
    for (const [k, v] of Object.entries(out.warnings)) add(stats.warnings, k, v)
    for (const p of out.pages) { sites.add(p.site); if (p.split === 'val') valSites.add(p.site) }
    if (s.tasks % 100 === 0) log(`${split}: ${s.tasks} tasks · ${s.pages} pages · ${s.episodes} episodes · ${Math.round((Date.now() - t0) / 1000)}s`)
  }
  stats.splits[split] = s
  log(`${split}: ${JSON.stringify(s)} in ${Math.round((Date.now() - t0) / 1000)}s`)
}
for (const e of episodes) { add(stats.episodes.byKind, e.kind); add(stats.episodes.byGoalKind, e.goalKind); add(stats.episodes.byLabel, e.kind === 'move' ? e.label : e.kind === 'target' ? e.op : 'value') }
stats.websites = sites.size
stats.valSites = [...valSites].sort()
writeJsonl(path.join(DIR, 'pages.jsonl'), pages)
writeJsonl(path.join(DIR, 'episodes.jsonl'), episodes)
fs.writeFileSync(path.join(DIR, 'mind2web-stats.json'), JSON.stringify(stats, null, 2))
log(JSON.stringify({ tasks, pages: pages.length, episodes: episodes.length, skipped: stats.skipped, warnings: stats.warnings, websites: stats.websites, valSites: stats.valSites.length }))
```

- [ ] **Step 2: Smoke run on the 40-row sample** — `VFT_DATA=<main data> node scripts/von-finetune/mind2web.mjs --splits test_website --raw-suffix limit`. Expected: a handful of pages and episodes; `mind2web-stats.json` lists every skip reason with counts; eyeball one page's viewport lines and one episode of each goal kind (`head -c 2000 …/mind2web/pages.jsonl`).

- [ ] **Step 3: Full run** (after Task 1 Step 3 finished) — no `--raw-suffix`. Expected: ~10–12K pages, several tens of thousands of episodes, in ≤ 15 min; record the stats block for the README.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(von-finetune): mind2web.mjs — the Mind2Web corpus converter with per-reason skip counts" -- scripts/von-finetune/mind2web.mjs
```

---

### Task 5: Merge corpora at render time, honour cross-page history, keep the split site-level

**Files:**
- Modify: `scripts/von-finetune/render.mjs`
- Modify: `scripts/von-finetune/prompt-entry.ts` (export `isPointOfNoReturn`)
- Modify: `scripts/von-finetune/lib.mjs` (add `siteKey`, `resolveSplits`)
- Create: `scripts/von-finetune/lib.test.mjs`
- Modify: `scripts/von-finetune/train.py` (`corpus` in `encode`/`report`)

**Interfaces:**
- `render.mjs` gains `--corpus <name>` (repeatable): loads `DATA/<name>/pages.jsonl` + `episodes.jsonl` on top of the base corpus; every page/episode carries `corpus` (`'teacher'` when absent).
- `resolveSplits(pages: Map<pageId, page>): number` in `lib.mjs` — mutates `page.split` (val → train on collision), returns how many moved. Episodes then take their page's split.
- Episode steps accept `{action, index?, label?, valueKey?}`; a target episode's optional `op` overrides `operationFor`.
- `prompt-entry.ts` exports `isPointOfNoReturn` from `../../src/tools/pageControl` (verified 2026-09-30 to bundle and run under Node with no `chrome` stub).

- [ ] **Step 1: Regression baseline** — before touching `render.mjs`: `VFT_DATA=<main data> node scripts/von-finetune/render.mjs` then `cp <main data>/train.jsonl <scratchpad>/baseline-train.jsonl; cp <main data>/val.jsonl <scratchpad>/baseline-val.jsonl; cp <main data>/render-stats.json <scratchpad>/baseline-stats.json` (the current data dir holds an older lazy render; this baseline is the act head on the teacher corpus alone).

- [ ] **Step 2: Failing test for `resolveSplits`** — `scripts/von-finetune/lib.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { resolveSplits, siteKey, splitOf } from './lib.mjs'

describe('resolveSplits', () => {
  it('moves a val page to train when its site key is a train site in any corpus, never the reverse', () => {
    const pages = new Map([
      ['a', { pageId: 'a', site: 'ikea.com', split: 'train', corpus: 'teacher' }],
      ['b', { pageId: 'b', site: 'ikea', split: 'val', corpus: 'mind2web' }],
      ['c', { pageId: 'c', site: 'bbc.com', split: 'val', corpus: 'teacher' }],
      ['d', { pageId: 'd', site: 'bbc', split: 'train', corpus: 'mind2web' }],
      ['e', { pageId: 'e', site: 'united', split: 'val', corpus: 'mind2web' }],
    ])
    expect(resolveSplits(pages)).toBe(2)
    expect([...pages.values()].map((p) => p.split)).toEqual(['train', 'train', 'train', 'train', 'val'])
  })
  it('keys by first label', () => {
    expect(siteKey('www.ikea.com')).toBe('ikea')
    expect(siteKey('recreation.gov')).toBe('recreation')
  })
  it('keeps the teacher split deterministic', () => {
    expect(splitOf('https://www.ikea.com/us/en/')).toBe(splitOf('https://www.ikea.com/x'))
  })
})
```

Run: `npx vitest run scripts/von-finetune/lib.test.mjs`. Expected: FAIL (`resolveSplits` not exported).

- [ ] **Step 3: Implement in `lib.mjs`** (append; `mind2web-lib.mjs` should import `siteKey` from here instead of defining its own — update it and its test import accordingly):

```js
/** First DNS label of a site (`ikea.com`, `www.ikea.com`, `ikea` → `ikea`): the key the corpora share. */
export const siteKey = (site) => String(site).toLowerCase().replace(/^www\./, '').split('.')[0]

/**
 * The site-level split, enforced across corpora: a val page whose site is a
 * train site anywhere moves to train (val loses, never the reverse, so a
 * held-out site can never leak through the other corpus). Returns the count.
 */
export function resolveSplits(pages) {
  const trainKeys = new Set([...pages.values()].filter((p) => p.split === 'train').map((p) => siteKey(p.site)))
  let moved = 0
  for (const p of pages.values()) if (p.split === 'val' && trainKeys.has(siteKey(p.site))) { p.split = 'train'; moved++ }
  return moved
}
```

- [ ] **Step 4: `render.mjs` changes**

Argument and loading (replace the two `const pages/episodes` lines):

```js
    corpus: { type: 'string', multiple: true, default: [] },
…
const pages = new Map(readJsonl(path.join(DATA, 'pages.jsonl')).map((p) => [p.pageId, { corpus: 'teacher', ...p }]))
const episodes = readJsonl(path.join(DATA, 'episodes.jsonl')).map((e) => ({ corpus: 'teacher', goalKind: 'step', ...e }))
for (const name of args.corpus) {
  for (const p of readJsonl(path.join(DATA, name, 'pages.jsonl'))) pages.set(p.pageId, p)
  episodes.push(...readJsonl(path.join(DATA, name, 'episodes.jsonl')))
  log(`corpus ${name}: ${pages.size} pages, ${episodes.length} episodes so far`)
}
const moved = resolveSplits(pages)
for (const ep of episodes) ep.split = pages.get(ep.pageId)?.split ?? ep.split
if (moved) log(`site-level split: ${moved} val pages moved to train (their site is a train site in another corpus)`)
```

`contextOf` steps (cross-page history):

```js
  const steps = ep.steps.map((s) => ({
    operation: OP_OF_ACTION[s.action] ?? 'CLICK', targetId: s.index,
    label: s.label ?? lib.clip(byId.get(s.index)?.name || '(unnamed)', 60),
    valueKey: s.valueKey ?? (s.action === 'type' || s.action === 'select' ? keyOf(s.index) : undefined),
    result: 'success',
  }))
```

Human op wins over inference (both heads): in `actRowsFor` replace `const op = operationFor(target, valueKeys)` with `const op = ep.op ?? operationFor(target, valueKeys)`; same in `rowsFor`'s target branch; in the lazy `move act` branch use `sibling.op ?? operationFor(target, valueKeys)`.

`meta` gains `corpus: ep.corpus, goalKind: ep.goalKind`. `stats()` additionally counts `corpus:<name>` and `goalKind:<kind>`. `targetsByKey` includes `ep.goalKind` in its key.

- [ ] **Step 5: `prompt-entry.ts`** — add `export { isPointOfNoReturn } from '../../src/tools/pageControl'`.

- [ ] **Step 6: `train.py`** — in `encode` add `"corpus": r.get("meta", {}).get("corpus", "teacher")`; in `report` add `groups[f"corpus:{r['corpus']}"].append(rec)`.

- [ ] **Step 7: Verify no regression** — `VFT_DATA=<main data> node scripts/von-finetune/render.mjs` (no `--corpus`), then `diff <(jq -c 'del(.meta.corpus, .meta.goalKind)' <main data>/train.jsonl) <(jq -c . <scratchpad>/baseline-train.jsonl) | head` — expected: no output (identical rows, same order — `rng('render')` is unchanged). Then `npx vitest run scripts/von-finetune` green, `npm run typecheck` green (prompt-entry is TS).

- [ ] **Step 8: Merged render** — `VFT_DATA=<main data> node scripts/von-finetune/render.mjs --corpus mind2web`. Expected: `render-stats.json` shows `corpus:mind2web` and `corpus:teacher` counts, `act:SELECT_OPTION:*` in the hundreds, val rows only from val sites; the log line reports how many val pages moved.

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(von-finetune): render merges corpora, enforces the site-level split across them, and honours cross-page history" -- scripts/von-finetune/render.mjs scripts/von-finetune/lib.mjs scripts/von-finetune/lib.test.mjs scripts/von-finetune/prompt-entry.ts scripts/von-finetune/train.py scripts/von-finetune/mind2web-lib.mjs scripts/von-finetune/mind2web-lib.test.mjs
```

---

### Task 6: The typed-instruction heads

**Files:**
- Modify: `scripts/von-finetune/render.mjs`

**Interfaces:**
- `--typed t1,t2,t4,t5` (default all; `--typed none` to skip), `--typed-cap t1=4000,t5=6000` (per-head row caps after balancing; `t2`/`t4` uncapped by default).
- Row `meta.kind ∈ {t1_done, t2_field, t4_submit, t5_commit}`; `meta.corpus`, `meta.split`, `meta.site`, `meta.pageId` as elsewhere; `t5_commit` also `meta.op` and `meta.label`.

- [ ] **Step 1: Constants and helpers** (top of `render.mjs`):

```js
const T1 = { question: 'Is the task complete on this page, with no further action needed?',
  options: [{ id: 'yes', description: 'Yes: the goal is already achieved on this page and nothing more needs to be done.' }, { id: 'no', description: 'No: at least one more action is still needed to reach the goal.' }] }
const T2_QUESTION = 'Which of these fields still needs a value to complete the task?'
const T4_QUESTION = 'Which of these controls submits the form?'
const T5_QUESTION = 'Is taking this action reversible, or does it commit to something (submit, payment, navigating away)?'
const T5_OPTIONS = [{ id: 'reversible', description: 'Reversible: it only changes what is shown on the page and can be backed out of.' }, { id: 'committing', description: 'Committing: it submits, pays, deletes, sends, signs in, or leaves the page.' }]
const ACTION_OF_OP = { CLICK: 'click', TYPE_TEXT: 'type', SELECT_OPTION: 'select' }
const TYPED = new Set(args.typed === 'none' ? [] : args.typed.split(','))
const CAPS = Object.fromEntries(args['typed-cap'].split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)] }))
```

- [ ] **Step 2: `typedRowsFor(ep, c, meta, page, vp, seen, r)`** — called from `rowsFor` for `target` episodes (once per `(pageId, vp)` for T4/T5 via `seen`) and from the `move` branch for teacher `DONE` (T1 yes):

```js
function typedRowsFor(ep, c, meta, vp, seen, r) {
  const { ctx, byId } = c
  const rows = []
  const withControls = lib.renderState(ctx, c.space.shown)
  const withoutControls = lib.renderState(ctx, c.space.shown, { controls: false })
  const rawById = new Map(vp.elements.map((e) => [e.index, { ...e, rect: { x: 0, y: e.y ?? 0, width: 1, height: 1 } }]))
  const origin = ctx.observation.page.origin
  const once = `${ep.pageId}|${ep.vp}`
  if (TYPED.has('t1')) rows.push({ state: withControls, question: T1.question, options: T1.options, label: ep.kind === 'move' && ep.label === 'DONE' ? 'yes' : 'no', meta: { ...meta, kind: 't1_done' } })
  if (ep.kind !== 'target') return rows
  if (TYPED.has('t2') && ep.goalKind === 'task' && lib.isFieldOperation(ep.op ?? '')) {
    const fields = ctx.observation.controls.filter((x) => x.actions.includes('type_text') || x.actions.includes('select_option'))
    if (fields.length >= 2 && fields.some((x) => x.id === ep.label) && (fields.some((x) => x.value) || ep.steps.length))
      rows.push({ state: withoutControls, question: T2_QUESTION, options: fields.map((x) => ({ id: String(x.id), description: lib.renderControl(x) })), label: String(ep.label), meta: { ...meta, kind: 't2_field' } })
  }
  if (seen.has(once)) return rows
  seen.add(once)
  if (TYPED.has('t4')) {
    const byForm = new Map()
    for (const x of ctx.observation.controls) { const f = rawById.get(x.id)?.form; if (f && x.role === 'button' && x.actions.length) (byForm.get(f) ?? byForm.set(f, []).get(f)).push(x) }
    for (const buttons of byForm.values()) {
      const submitters = buttons.filter((x) => x.fingerprint.type === 'submit' || x.fingerprint.type === 'image')
      if (buttons.length >= 2 && submitters.length === 1)
        rows.push({ state: withoutControls, question: T4_QUESTION, options: buttons.map((x) => ({ id: String(x.id), description: lib.renderControl(x) })), label: String(submitters[0].id), meta: { ...meta, kind: 't4_submit' } })
    }
  }
  if (TYPED.has('t5')) {
    const cands = []
    for (const x of ctx.observation.controls) {
      if (!x.actions.length || x.fingerprint.tag === 'a') continue // a link's reversibility is a cross-origin fact the state never shows
      for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT_OPTION']) {
        if (op === 'TYPE_TEXT' && !x.actions.includes('type_text')) continue
        if (op === 'SELECT_OPTION' && !x.actions.includes('select_option')) continue
        const committing = lib.isPointOfNoReturn({ action: ACTION_OF_OP[op], index: x.id }, rawById.get(x.id), origin)
        cands.push({ x, op, label: committing ? 'committing' : 'reversible' })
      }
    }
    const take = (label) => shuffle(cands.filter((k) => k.label === label), r).slice(0, 2)
    for (const k of [...take('committing'), ...take('reversible')])
      rows.push({ state: withoutControls, question: `${T5_QUESTION}\nAction: ${lib.renderControlAction(k.x, k.op)}`, options: T5_OPTIONS, label: k.label, meta: { ...meta, kind: 't5_commit', op: k.op, label: k.label } })
  }
  return rows
}
```

Wire-up: in `rowsFor`, after `const c = contextOf(ep)`, build `const typed = typedRowsFor(ep, c, meta, pages.get(ep.pageId).viewports[ep.vp], seenTyped, typedRng)` for `ep.kind === 'target'` or (`ep.kind === 'move' && ep.label === 'DONE'`), and return `[...headRows, ...typed]`. `seenTyped = new Set()`, `typedRng = rng('typed')` at module level.

- [ ] **Step 3: Balance and caps** — extend `balance(rows, r)`: after the DONE cap, for T1 keep every `yes` and at most `2 × yes` `no` rows; then for each `k` in `CAPS`, shuffle rows of kind `k` and keep `CAPS[k]`. Keep the shuffle seeded (`r`).

- [ ] **Step 4: Stats** — `stats()` keys typed rows as `${kind}:${label}` for t1/t5 and `kind` for t2/t4.

- [ ] **Step 5: Verify** — `VFT_DATA=<main data> node scripts/von-finetune/render.mjs --corpus mind2web`; check `render-stats.json`: `t5_commit:committing` and `t5_commit:reversible` both present in train and val, `t4_submit` in the hundreds, `t2_field` ≥ 1,000, `t1_done:yes` ≈ teacher DONE count and `t1_done:no` ≤ 2×. Print one row of each kind and read it as Von would (`jq -c 'select(.meta.kind=="t5_commit")' train.jsonl | head -2`). Teacher-only render (`--typed none`) must still equal the Task 5 baseline.

- [ ] **Step 6: Packing check** — `UV_CACHE_DIR=<scratchpad>/uvcache VFT_DATA=<main data> uv run scripts/von-finetune/train.py --eval-only --device cpu` in the background (downloads torch, ~3 GB, ≈ 10 min). Expected: `[data] val: N rows kept, dropped {…}` with `too-long` at most a handful, and a base-model report with `corpus:mind2web`, `t1_done`, `t2_field`, `t4_submit`, `t5_commit` rows. Record the numbers.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(von-finetune): typed-instruction heads — committing, submit, missing-field and done — rendered through the shipped classifiers" -- scripts/von-finetune/render.mjs
```

---

### Task 7: Documentation, memory, merge

**Files:**
- Modify: `scripts/von-finetune/README.md` (new section "The Mind2Web corpus (2026-09-30)" + "Typed-instruction heads": the origin/viewport conventions, the skip counts from the full run, the stats block, the packing check, how to re-run, what remains — AgentTrek, T3)
- Modify: `docs/superpowers/specs/2026-09-30-von-data-round-2-design.md` (§6 item 2 → decided, item 3 → done for T1/T2/T4/T5; status line)
- Modify: `CLAUDE.md` (one clause in the `src/system1/` bullet: `scripts/von-finetune/mind2web*.{py,mjs}` convert Mind2Web; T1–T5 rendered by `render.mjs`)

- [ ] **Step 1: Write the docs** with the real numbers from Tasks 4–6.
- [ ] **Step 2: Memory** — update `von-data-round-2-plan.md` (what is converted, where, the conventions, what is still open) and `MEMORY.md`'s line.
- [ ] **Step 3: Commit docs** — `git commit -m "docs(von-finetune): the Mind2Web corpus and the typed heads" -- scripts/von-finetune/README.md docs/superpowers/specs/2026-09-30-von-data-round-2-design.md CLAUDE.md docs/superpowers/plans/2026-09-30-mind2web-conversion.md`
- [ ] **Step 4: Merge** — `git -C <main> merge --ff-only worktree-m2w-conversion` after `git -C <main> status --short` shows nothing staged by another session for the touched files; then `git branch -d`.
