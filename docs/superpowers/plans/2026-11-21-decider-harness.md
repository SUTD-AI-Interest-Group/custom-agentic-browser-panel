# Decider Harness (shadow mode + lookup form-filling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the `strands-decider-E2B-gemma4-v2-2611` decision model inside the extension on
WebGPU (WASM fallback). Use it to shadow every page-control step and to fill forms by JSON-key
lookup through `AutofillForm`. An answer-keyed eval harness measures both.

**Architecture:** A Python pipeline (`scripts/decider-export/`) converts the checkpoint to an
8-bit ONNX torso plus block-int8 token tables, a tokenizer and a manifest. The panel imports
those files once into OPFS. A module worker (`src/decider/worker.ts`) renders, tokenizes,
looks up tables, runs ORT-web and reads out answers. A panel-side `DeciderEngine` queues
requests to it. `DeciderHooks` connect the engine to `ControlPage` (shadow) and `AutofillForm`
(shadow + the assist path).

**Tech Stack:** TypeScript strict, React 18, Vite 6, Vitest 4, `onnxruntime-web` 1.31.1
(`onnxruntime-web/webgpu`), `@huggingface/tokenizers` 0.2.0, OPFS, IndexedDB; Python 3.12
(torch ≥ 2.9, transformers ≥ 5.24 < 6, onnx, onnxscript, onnxruntime ≥ 1.22) for the export;
Playwright (repo devDependency) for the eval.

**Spec:** `docs/superpowers/specs/2026-11-21-decider-harness-design.md` (approved; commit
`d306284`). Read it first. This plan argues from it.

**Reference code (throwaway spike, same machine):**
`/private/tmp/claude-501/-Users-angks-projects-SUTD-SUTD-AIIG-custom-agentic-browser-panel/1960bb96-5f50-4d1d-b09e-e1b82a86497e/scratchpad/`:
- `spike/torso.py`, `spike/export.py`, `spike/quantize.py`: the proven export;
- `spike/check_ort.py`, `spike/make_fixtures.py`, `spike/replay.py`, `spike/form_lookup.py`;
- `web/bench.mjs`: ORT-web usage;
- `e2e/run.mjs` and `e2e/fixtures/`: the Lychee driver and test pages;
- `spike/RESULTS.md`.

**Checkpoint (already downloaded):**
`CKPT=~/.cache/huggingface/hub/models--StrandsAgents--strands-decider-E2B-gemma4-v2-2611/snapshots/a5f32ea1bffe2e91c25c0c641d444e8115e28212`.
It holds `golden_vectors.jsonl` (490 rows, 430 text-only) and the reference wheel
`strands_decider-0.3.1.dev108+gf011757-py3-none-any.whl`. **Port the prompt from that wheel's
`strands_decider/core/{prompt,request,codes}.py`, not from GitHub main**, whose `render()`
signature has already changed. Unzip the wheel to read it.

## Global Constraints

- **Work location.** Work in a git worktree, branched from local `main` (`git reset --hard main`
  after entering; the worktree base lags). Symlink `node_modules` from the main checkout, then
  `npm install`. Use `npm run typecheck`, never `npx tsc`. Commits carry **no**
  Co-Authored-By/Generated-with trailers.
- **Model files.** Model id `strands-decider-E2B-gemma4-v2-2611`; torso weights 8-bit
  `MatMulNBits`, block 32, symmetric. The readout MatMul (initializer last dim 255) stays
  full precision. Temperature **1.5456**, soft-cap **30**.
  - Readout per question: `p = softmax(tanh(z/30)·30/1.5456)` over its own k codes.
- **Storage.** Files live in OPFS under `decider/<modelId>/`. Import status lives in
  `chrome.storage.local` key **`deciderModel`**, never inside `settings`. Never use Cache
  Storage `lychee-system1`: `legacyCleanup.ts` deletes it on every update.
- **Settings.** `settings.decider?: { mode: 'off' | 'shadow' | 'assist'; actThreshold?: number }`.
  Omitted or malformed means off. `actThreshold` defaults to **0.6**.
- **State size.** `previous_actions` is the last **6** `session.journal[].summary` entries.
  `page_text` is capped at **1,200** characters.
- **Shadow records** contain **no element names, values, URLs or page text**.
- **Realms.** The decider is panel-resident (side panel and its worker). It is never imported
  by `src/background.ts` and never by the research or offscreen code.
- **Off is off.** With `decider` omitted, nothing boots, no OPFS access happens, and every
  existing test passes unchanged.
- **Parity bars.**
  - In the browser on WebGPU over text-only golden rows up to 3,000 tokens: max |Δp| ≤ 0.05
    and 0 top-1 flips.
  - Tokenizer and prompt: exact id parity on all 430 text-only golden rows.
- **Latency bars** (WebGPU, warm, M4 Max): next-action ≤ 300 ms p50 at ≤ 600 tokens and
  ≤ 800 ms at ~1,400 tokens; 7-field lookup ≤ 400 ms.
- **Eval chat models.** The default is LM Studio `google/gemma-4-26b-a4b` at
  `http://127.0.0.1:1234/v1`. `PROVIDER=anthropic` uses `claude-sonnet-5-5`, with the key read
  from `~/.config/lychee-eval/key` and never printed. Spend cap: **$10 per run**, estimated at
  $2 / $10 per M input/output, $0.10 cached read, 1.25× uncached input as the upper bound.
- **Exported files** go to `~/lychee-decider/strands-decider-E2B-gemma4-v2-2611/`, outside the
  repo. Never commit model files, golden vectors or tokenizer.json.

## Review Focus

1. **A half-finished import** (panel closed mid-copy, then reopened) must read as
   `importing`/`failed`, never `ready`. The decider stays off, and page control is unchanged.
   Test: in Task 5, `getModelStatus()` returns `failed` when the stored state is `importing`
   at load.
2. **No WebGPU adapter** means the WASM fallback at multiple seconds per decision. Shadow
   requests must not pile up or delay `ControlPage`. Tests: in Task 4, the engine replaces a
   queued `dropIfBusy` request (the older one resolves `null`); in Task 10, `ControlPage`
   returns without awaiting a never-settling decision.
3. **Pathological pages**: 200 elements with 300-character names, or a prompt over the
   checkpoint's 32,768 tokens. They must be skipped with a reason, never thrown into the
   tool. Tests: in Task 8, option descriptions are truncated to 120 characters; in Task 4,
   the worker answers `failed: too-long` when the packed T exceeds `maxLength`.
4. **No profile memories, or a failed structuring call**, during assist `AutofillForm` without
   `fields` must return a plain error asking for `fields`, not a crash. Test in Task 11.
5. **A steer mid-turn** must change the goal the shadow decider sees to the steer's text.
   Test: in Task 10, `latestUserText` returns the newest user message's text across
   string/parts content.

---

### Task 1: Export pipeline (Python) → model files + self-test

**Files:**
- Create: `scripts/decider-export/requirements.txt`, `scripts/decider-export/torso.py`,
  `scripts/decider-export/build.py`, `scripts/decider-export/verify.py`,
  `scripts/decider-export/README.md`
- Modify: `.gitignore` (add `scripts/decider-export/.venv/`)

**Interfaces:**
- Produces, in `<out>/`:
  - `torso.onnx` + `torso.onnx.data`. Inputs: `inputs_embeds [1,T,1536] f32`,
    `per_layer_raw [1,T,35,256] f32`, `position_ids [1,T] i64`, `segment_ids [T] i64`,
    `gather_idx [Q] i64`. Output: `logits [Q,255] f32`. Drop the `hidden` output the spike had.
  - `embed.bin` and `ple.bin`: block-int8, block size 256. Each block is a little-endian f32
    scale followed by 256 int8 values; value = int8 × scale. Main rows are 6 blocks, per-layer
    rows are 35 blocks. Rows are pre-multiplied by √1536 and √256 respectively, in fp32.
  - `tokenizer.json`, `tokenizer_config.json`.
  - `selftest.json`: `[{ request, expected: {name: probs[]} }]`, 5 text-only golden rows,
    each ≤ 3,000 state tokens.
  - `manifest.json`, matching `DeciderManifest` (Task 3):
    `{ format: 1, modelId, revision, hidden: 1536, layers: 35, pleDim: 256, vocab: 262144, temperature: 1.5456, softcap: 30, maxLength: 32768, controlTokenIds, codeTokenIds, tables: { blockSize: 256, embed: { file: 'embed.bin', blocks: 6 }, ple: { file: 'ple.bin', blocks: 35 } }, chunkBytes: 67108864, files: [{ name, bytes, sha256: string[] }] }`.
    - `sha256` holds one hex digest per 64 MiB chunk.
    - `controlTokenIds` and `codeTokenIds` are copied from the wheel's `core/codes.py`.
    - `files` lists every file above except `manifest.json`.

- [ ] **Step 1: Write `torso.py`** from `spike/torso.py`, keeping its semantics exactly (spec
  §5.3 and Appendix B): fp32 load with audio and vision configs set to `None`; the custom
  bias attention; segment-id mask; slicing `gather_idx` at `first_kv_shared_layer_idx`; final
  norm, then `h @ readoutᵀ`.
- [ ] **Step 2: Write `build.py --ckpt CKPT --out DIR`**:
  1. export fp32 to a temp dir (dynamo, T 4–32768, Q 1–64);
  2. quantize with `MatMulNBitsQuantizer(bits=8, block_size=32, is_symmetric=True, accuracy_level=1)`,
     excluding the readout node (`accuracy_level=1` keeps CPU math in fp32, so `verify.py`
     measures the weights, not int8 activations);
  3. write both tables with numpy (per-block absmax / 127, round-half-even);
  4. copy the tokenizer files, write `selftest.json` and `manifest.json` (chunk hashes).
- [ ] **Step 3: Write `verify.py --out DIR --rows 60`.** Over the first 60 text-only golden
  rows with state ≤ 3,000 tokens:
  - rebuild embeddings **from `embed.bin`/`ple.bin`** (the same dequant the browser does);
  - run ORT CPU and compute probabilities as in Global Constraints;
  - assert `max|Δp| ≤ 0.05` and `flips == 0` against golden;
  - check every manifest chunk hash against the files;
  - print one summary line.
- [ ] **Step 4: Run it**
  ```
  python3.12 -m venv scripts/decider-export/.venv && . scripts/decider-export/.venv/bin/activate && pip install -r scripts/decider-export/requirements.txt
  python scripts/decider-export/build.py --ckpt "$CKPT" --out ~/lychee-decider/strands-decider-E2B-gemma4-v2-2611
  python scripts/decider-export/verify.py --out ~/lychee-decider/strands-decider-E2B-gemma4-v2-2611 --rows 60
  ```
  Expected: `verify: 60 rows, 180 questions, max|dp| ≤0.05, flips 0, hashes ok`; total size
  about 4.9 GB (torso ~2.1 GB + tables ~2.8 GB).
- [ ] **Step 5: README** covering prerequisites, the two commands, the output layout and how
  to import it (Task 6). Then commit
  `scripts/decider-export/ .gitignore` with message "decider: export pipeline (8-bit ONNX torso, block-int8 tables, manifest)".

### Task 2: Prompt rendering + tokenizer with golden id parity

**Files:**
- Create: `src/decider/request.ts`, `src/decider/prompt.ts`, `src/decider/tokenizer.ts`,
  `src/decider/prompt.test.ts`
- Modify: `package.json` (add `"@huggingface/tokenizers": "0.2.0"`)

**Interfaces:**
- Produces (`request.ts`):
  ```ts
  export type Content = string | Record<string, unknown> | unknown[]
  export type DecisionQuestion =
    | { type: 'choice'; instructions: Content; criteria: Record<string, Content | null> }
    | { type: 'noul'; instructions: Content; criteria?: Partial<Record<'true' | 'false', Content | null>> }
    | { type: 'score'; instructions: Content; criteria: string[] }
  export interface DecisionRequest { state: Content; questions: Record<string, DecisionQuestion> }
  ```
- Produces (`prompt.ts`):
  ```ts
  export type EncodeText = (text: string) => number[]
  export interface RenderedQuestion { name: string; kind: 'choice' | 'noul' | 'score'; ids: number[]; options: string[] } // options in code order
  export interface Rendered { stateIds: number[]; questions: RenderedQuestion[] }
  export function renderContent(c: Content | null | undefined): string
  export function renderRequest(req: DecisionRequest, encode: EncodeText, controlTokenIds: Record<string, number>): Rendered
  ```
- Produces (`tokenizer.ts`):
  `export function createEncoder(tokenizerJson: Record<string, unknown>, tokenizerConfig: Record<string, unknown>): EncodeText`.

- [ ] **Step 1: Failing tests (`prompt.test.ts`).**
  - Pure, always on:
    - `renderContent('  x  ') === 'x'`;
    - `renderContent({a: [1, 'é']}) === '{\n  "a": [\n    1,\n    "é"\n  ]\n}'`;
    - a choice question renders option lines `A. name — description\n`, and a `null`
      description gives `A. name\n`;
    - a noul's `options` are `['false', 'true']`, with the default descriptions
      `the statement does not hold for this state` / `the statement holds for this state`;
    - a score's `options` are `['0', …, 'L-1']`.
  - Gated: `describe.skipIf(!process.env.DECIDER_CHECKPOINT)('golden id parity', …)`. For
    every text-only row of `golden_vectors.jsonl`:
    `renderRequest(row.request, createEncoder(tj, tc), CONTROL)` must give `stateIds` equal to
    `row.state_ids`, and each question's `ids` equal to `row.questions[name].question_ids`.
    The test reports the count of mismatching rows, which must be `0` of `430`.
- [ ] **Step 2: Run.** `npm test -- src/decider/prompt.test.ts` should FAIL (module missing).
- [ ] **Step 3: Implement `prompt.ts`.**
  - Port `state_part` / `question_part` / `option_line` / `encode` from the wheel:
    - control tokens are inserted by id;
    - each run of text is one `encode(text)`;
    - names and descriptions are collapsed to single-space lines;
    - the noul defaults and score levels come from `core/request.py` `normalised()`.
  - `renderContent` uses `JSON.stringify(c, null, 2)`.
- [ ] **Step 4: Implement `tokenizer.ts`.** Clone `tokenizerJson`. Drop every `added_tokens`
  entry with `special: true`. Construct `new Tokenizer(json, config)`. Return
  `(t) => tokenizer.encode(t, { add_special_tokens: false }).ids`.
  Dropping special added tokens reproduces the checkpoint's special-token matching **off**:
  control tokens are only ever inserted by id.
- [ ] **Step 5: Run.** `npm i` first, then:
  `DECIDER_CHECKPOINT="$CKPT" npm test -- src/decider/prompt.test.ts`.
  Expected: PASS, `0/430` mismatches. If special-token stripping alone doesn't reach 0, diff
  the first mismatching row's ids and fix the port (whitespace collapse, JSON escaping)
  before moving on.
- [ ] **Step 6: Commit** with message "decider: strands-chat prompt port + tokenizer, golden id parity".

### Task 3: Pure core: manifest, packing, readout, config

**Files:**
- Create: `src/decider/manifest.ts`, `src/decider/pack.ts`, `src/decider/readout.ts`,
  `src/decider/config.ts`, `src/decider/core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // manifest.ts
  export interface DeciderManifest { format: 1; modelId: string; revision: string; hidden: number; layers: number; pleDim: number; vocab: number; temperature: number; softcap: number; maxLength: number; controlTokenIds: Record<string, number>; codeTokenIds: number[]; tables: { blockSize: number; embed: { file: string; blocks: number }; ple: { file: string; blocks: number } }; chunkBytes: number; files: { name: string; bytes: number; sha256: string[] }[] }
  export function parseManifest(raw: unknown): DeciderManifest // throws Error(`manifest: <field> …`)
  // pack.ts
  export interface PackedPass { ids: number[]; positions: number[]; segments: number[]; gather: number[] }
  export function packPass(stateIds: number[], questionIds: number[][]): PackedPass
  // readout.ts
  export interface Answer { kind: 'choice' | 'noul' | 'score'; options: string[]; probs: number[]; top: string; p: number; confidence: number; yes?: number }
  export function codeProbabilities(logits: ArrayLike<number>, row: number, k: number, softcap: number, temperature: number): number[]
  export function toAnswer(q: RenderedQuestion, probs: number[]): Answer
  // config.ts
  export type DeciderMode = 'off' | 'shadow' | 'assist'
  export interface DeciderSettings { mode: DeciderMode; actThreshold?: number }
  export const DEFAULT_ACT_THRESHOLD = 0.6, PREVIOUS_ACTIONS_WINDOW = 6, PAGE_TEXT_CAP = 1200
  export const MODEL_ID = 'strands-decider-E2B-gemma4-v2-2611', MODEL_STATUS_KEY = 'deciderModel'
  export function normalizeDecider(raw: unknown): DeciderSettings | undefined
  ```

- [ ] **Step 1: Failing tests (`core.test.ts`):**
  - `packPass([1, 2, 3], [[7, 8], [9]])` gives:
    - `ids [1,2,3,7,8,9]`
    - `positions [0,1,2,3,4,3]`
    - `segments [0,0,0,1,1,2]`
    - `gather [4,5]`
  - `codeProbabilities([0, 0, 0, …], 0, 3, 30, 1.5456)` returns ≈ `[1/3, 1/3, 1/3]`. For logits
    `[30, 0]`, `p[0] ≈ 1 / (1 + exp(-30·tanh(1)/1.5456))` (within 1e-6). Logits are indexed
    `row*255 + c`.
  - `toAnswer` on a choice: `confidence = (N·pmax−1)/(N−1)`. On a noul, `yes` equals the
    probability of the option `'true'`.
  - `parseManifest` throws mentioning `softcap` when that field is missing, and accepts the
    Task 1 manifest shape.
  - `normalizeDecider`:
    - `undefined` → `undefined`;
    - `{mode: 'shadow'}` → `{mode: 'shadow'}`;
    - `{mode: 'driver'}` → `undefined`;
    - `{mode: 'assist', actThreshold: 2}` → `{mode: 'assist'}` (out-of-range threshold dropped);
    - `'x'` → `undefined`.
- [ ] **Step 2: Run, and see it FAIL.**
- [ ] **Step 3: Implement** the five signatures; float32 math via `Math.fround` is not
  required.
- [ ] **Step 4: Run.** `npm test -- src/decider/core.test.ts` should PASS.
- [ ] **Step 5: Commit** with message "decider: manifest, packing, readout, settings normalization".

### Task 4: Table reader, worker and engine

**Files:**
- Create: `src/decider/tables.ts`, `src/decider/protocol.ts`, `src/decider/worker.ts`,
  `src/decider/engine.ts`, `src/decider/tables.test.ts`, `src/decider/engine.test.ts`
- Modify: `vite.config.ts` (add the entry `deciderWorker: 'src/decider/worker.ts'`),
  `package.json` (add `"onnxruntime-web": "1.31.1"`)

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  ```ts
  // tables.ts
  export function rowBytes(blocks: number, blockSize: number): number // blocks*(4+blockSize)
  export function dequantRow(src: Uint8Array, out: Float32Array, outOffset: number, blocks: number, blockSize: number): void
  export interface ReadAt { read(buf: Uint8Array, opts: { at: number }): number }
  export class TableReader { constructor(file: ReadAt, blocks: number, blockSize: number); rows(ids: number[], out: Float32Array): void }
  // protocol.ts
  export interface DecisionResult { answers: Record<string, Answer>; ms: number; tokens: number; backend: 'webgpu' | 'wasm'; cold: boolean }
  export type DeciderWorkerRequest = { type: 'init'; modelId: string; wasmUrl: string } | { type: 'decide'; id: string; request: DecisionRequest } | { type: 'dispose' }
  export type DeciderWorkerReply = { type: 'ready'; backend: 'webgpu' | 'wasm'; bootMs: number } | { type: 'boot-failed'; message: string } | { type: 'result'; id: string; result: DecisionResult } | { type: 'failed'; id: string; message: string }
  // engine.ts
  export interface WorkerLike { postMessage(m: DeciderWorkerRequest): void; addEventListener(t: 'message', l: (e: MessageEvent<DeciderWorkerReply>) => void): void; terminate(): void }
  export class DeciderEngine {
    constructor(opts?: { spawn?: () => WorkerLike; bootTimeoutMs?: number; decideTimeoutMs?: number; idleMs?: number })
    warm(): Promise<void>
    decide(req: DecisionRequest, opts?: { dropIfBusy?: boolean }): Promise<DecisionResult | null> // null = dropped
    dispose(): void
  }
  export function getDeciderEngine(): DeciderEngine
  ```

- [ ] **Step 1: Failing tests.**
  - `tables.test.ts`:
    - one block with scale `0.5` and int8 `[-2, 4]` dequantizes to `[-1, 2]`;
    - `TableReader.rows([1, 0])`, over a fake `ReadAt` backed by a two-row buffer, writes row 1
      then row 0 contiguously.
  - `engine.test.ts`, with a fake `WorkerLike` like `pdfEngine.test.ts` uses:
    - boots once for two calls;
    - FIFO, so the second call's timeout starts only when it runs;
    - a decide timeout terminates and rebuilds the worker and rejects only the in-flight call;
    - while call A runs, a queued `dropIfBusy` call B is replaced by call C: B resolves `null`,
      C resolves with its result;
    - after `idleMs` without calls the worker is terminated.
- [ ] **Step 2: Run, and see it FAIL.**
- [ ] **Step 3: Implement `tables.ts`, then `engine.ts`.** Model `engine.ts` on
  `src/platform/pdfEngine.ts`:
  - spawn via `new Worker(chrome.runtime.getURL('deciderWorker.js'), { type: 'module' })`;
  - `wasmUrl` from `import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'`
    (the October precedent);
  - defaults: `bootTimeoutMs` 120 000, `decideTimeoutMs` 30 000, `idleMs` 600 000.
- [ ] **Step 4: Implement `worker.ts`.** `import * as ort from 'onnxruntime-web/webgpu'`.
  - **On init:**
    1. read `decider/<modelId>/manifest.json` and both tokenizer files from OPFS;
    2. open `embed.bin`/`ple.bin` with `createSyncAccessHandle()` into `TableReader`s;
    3. create the ORT session from blob URLs of `torso.onnx` and `torso.onnx.data`
       (`URL.createObjectURL(await handle.getFile())`, passed as `externalData` like
       `web/bench.mjs`);
    4. use the `webgpu` EP when `navigator.gpu` gives an adapter, else `wasm` with
       `numThreads = 1` (extension pages aren't cross-origin isolated);
    5. set `ort.env.wasm.wasmPaths = { wasm: wasmUrl }`.
  - **On decide:**
    1. `renderRequest` → `packPass`;
    2. if `ids.length > manifest.maxLength`, reply `failed: too-long`;
    3. `TableReader.rows` → `inputs_embeds`/`per_layer_raw`;
    4. `session.run` → `codeProbabilities` per question → `toAnswer`;
    5. reply `result` with `ms` measured around render through readout, `tokens = ids.length`,
       and `cold` true for the first decide after boot.
- [ ] **Step 5: Run** `npm test -- src/decider/` (PASS), then `npm run typecheck && npm run build`.
  `dist/deciderWorker.js` must exist.
- [ ] **Step 6: Commit** with message "decider: OPFS table reader, ORT worker, queued panel engine".

### Task 5: Settings field + OPFS import/verify/delete

**Files:**
- Create: `src/decider/storage.ts`, `src/decider/storage.test.ts`
- Modify: `src/data/settings.ts` (add `decider?: DeciderSettings` to `Settings` and
  `settings.decider = normalizeDecider(stored?.decider)` in `loadSettings`), `public/manifest.json`
  (add `"unlimitedStorage"` to `permissions`)

**Interfaces:**
- Produces:
  ```ts
  export type ModelStatus = { state: 'absent' } | { state: 'importing'; done: number; total: number } | { state: 'ready'; modelId: string; bytes: number; importedAt: number } | { state: 'failed'; message: string }
  export type ImportSource = { kind: 'files'; files: File[] } | { kind: 'url'; baseUrl: string }
  export function chunkRanges(bytes: number, chunkBytes: number): { offset: number; length: number }[]
  export async function getModelStatus(): Promise<ModelStatus>
  export async function importModel(src: ImportSource, onProgress?: (done: number, total: number) => void): Promise<void>
  export async function deleteModel(): Promise<void>
  export async function isModelReady(): Promise<boolean>
  ```

- [ ] **Step 1: Failing tests (`storage.test.ts`, `chrome.storage` and OPFS faked):**
  - `chunkRanges(150, 64)` gives `[{0,64},{64,64},{128,22}]`.
  - An import whose chunk digest mismatches ends `failed` with a message naming the file. The
    status key is written **before** the first byte (`importing`).
  - **Review Focus 1:** a stored `importing` status read by `getModelStatus()` at startup is
    returned as `{ state: 'failed', message: 'import was interrupted' }`, and `isModelReady()`
    is `false`.
  - `deleteModel()` removes the directory and sets `absent`.
  - `loadSettings` drops `decider: { mode: 'driver' }`, extending the existing settings tests.
- [ ] **Step 2: Run, and see it FAIL.**
- [ ] **Step 3: Implement.**
  1. Read `manifest.json` first, from the `files` list or `${baseUrl}/manifest.json`, and
     validate it with `parseManifest`.
  2. Stream each file into `decider/<modelId>/<name>` via `createWritable()`. For a URL
     source, stream `fetch` bodies, never buffering a whole file.
  3. Hash every 64 MiB chunk with `crypto.subtle.digest('SHA-256')` as it is written.
  4. Report progress in bytes.
  5. Call `navigator.storage.persist()` once.
- [ ] **Step 4: Run** the tests (PASS) and `npm run typecheck`.
- [ ] **Step 5: Commit** with message "decider: OPFS import with chunk-hash verification, settings field".

### Task 6: Experimental settings tab: mode, import, self-test

**Files:**
- Create: `src/ui/settings/ExperimentalTab.tsx`
- Modify: `src/ui/settings/Settings.tsx` (a tab `{ key: 'experimental', label: 'Experimental' }`
  lazy-loading it)

**Interfaces:**
- Consumes: `importModel`, `getModelStatus`, `deleteModel`, `getDeciderEngine().decide`,
  `normalizeDecider`.

- [ ] **Step 1: Build the tab.** It has a "Decision model" section with:
  - a mode select (Off / Shadow — record only / Assist — record + decider fills forms);
  - an "Act threshold" number input (0.4–0.95, step 0.05);
  - a status line from `getModelStatus()`;
  - "Import model folder…" (`<input type="file" webkitdirectory>`);
  - "Import from URL…" (a text input and a button);
  - a progress bar, and Delete;
  - "Run self-test": reads `selftest.json` from OPFS, runs each row through
    `getDeciderEngine().decide`, and shows `rows, max|Δp|, flips, backend, median ms`.

  Mode changes go through the existing `commit` path. The **Decider statistics** block is
  added in Task 10.
- [ ] **Step 2: Verify in a real browser.**
  1. `npm run build`.
  2. Serve the export directory: `npx http-server ~/lychee-decider/strands-decider-E2B-gemma4-v2-2611 -p 8790 --cors -c-1`,
     or a Node static server.
  3. Load `dist/` with the Playwright pattern from
     `scratchpad/e2e/run.mjs` (`launchPersistentContext`, `--load-extension`).
  4. Open `chrome-extension://<id>/sidepanel.html`, go to Settings → Experimental, import from
     `http://127.0.0.1:8790`, wait for `ready`, then click Run self-test.

  Expected: `5 rows, max|Δp| ≤ 0.05, flips 0, backend webgpu`. Record the import time and the
  median ms. Also confirm in `chrome://extensions` that `unlimitedStorage` raised no warning.
  If it did, remove it from the manifest and say so in the commit.
- [ ] **Step 3: Commit** with message "decider: Experimental settings tab with import and self-test".

### Task 7: Registry shows checkbox/radio checked state

**Files:**
- Modify: `src/platform/domIndex.ts:7-47` (add `checked?: boolean` to `IndexedElement`),
  `src/platform/domIndex.ts:~479` (for `input[type=checkbox|radio]` set
  `checked: input.checked` and omit `value`), `src/platform/domIndex.ts:535`
  (`serializeRegistry` renders `(checked)` / `(unchecked)` for elements with `checked` defined)
- Test: `src/platform/domIndex.test.ts`

- [ ] **Step 1: Failing test.** `serializeRegistry([{index: 8, tag: 'input', type: 'checkbox', name: 'I agree', checked: false, …}])`
  equals `[8]<input> checkbox "I agree" (unchecked)`. With `checked: true` the ending is
  `(checked)`. Add the jsdom test the file already uses for the walker: an unticked checkbox
  with `value="on"` produces `checked: false` and no `value`.
- [ ] **Step 2: Run, and see it FAIL. Step 3: Implement. Step 4:** `npm test -- src/platform/domIndex.test.ts`
  plus the full suite (other tests may snapshot registries; update only those that encoded
  the `= "on"` bug). PASS.
- [ ] **Step 5: Commit** with message "domIndex: report checkbox/radio checked state instead of the value attribute".

### Task 8: Decision builders (next action, form fill) + viewport text

**Files:**
- Create: `src/decider/state.ts`, `src/decider/fillPlan.ts`, `src/decider/state.test.ts`,
  `src/platform/viewportText.ts`

**Interfaces:**
- Consumes: `IndexedElement` (with `checked`), `DecisionRequest`, `Answer`.
- Produces:
  ```ts
  // state.ts
  export interface StepFacts { goal: string; plan: string; url: string; title: string; previousActions: string[]; pageText?: string; elements: IndexedElement[] }
  export type OptionAction = { op: 'click' | 'type' | 'select'; index: number } | { op: 'scroll' } | { op: 'done' }
  export function nextActionRequest(f: StepFacts): { request: DecisionRequest; actions: OptionAction[] } // one question named 'next'
  export interface FormField { index: number; kind: 'text' | 'select' | 'checkbox'; label: string; checked?: boolean; options?: string[] }
  export type Lookup = { profile: Record<string, string>; request: Record<string, string> }
  export interface FillQuestion { name: string; field: FormField; options: string[] } // text: dotted keys + 'leave_empty'; select: its options; checkbox: noul
  export function formFields(elements: IndexedElement[], selectOptions: Record<number, string[]>): FormField[] // skips sensitive, submit/button, hidden-type
  export function fillRequest(f: { goal: string; url: string; title: string; lookup: Lookup; fields: FormField[] }): { request: DecisionRequest; questions: FillQuestion[] }
  // fillPlan.ts
  export interface FillPlan { fills: { index: number; kind: FormField['kind']; key: string; value: string; p: number }[]; left: { index: number; reason: 'low-confidence' | 'leave-empty' | 'already-set' }[] }
  export function planFill(questions: FillQuestion[], answers: Record<string, Answer>, lookup: Lookup, threshold: number): FillPlan
  // viewportText.ts
  export async function readViewportText(tabId: number, cap: number): Promise<string> // self-contained inj* function: visible text of elements intersecting the viewport, whitespace-collapsed, sliced to cap
  ```

- [ ] **Step 1: Failing tests (`state.test.ts`):**
  - **Options.** `nextActionRequest` over the recorded form registry (from
    `scratchpad/e2e/e2e-all.json`, form task) gives options in registry order:
    `type into [3]`, `type into [4]`, `type into [5]`, `select in [6]`, `type into [7]`,
    `click [8]`, `click [9]`, `click [10]`, `click [11]`, then `scroll down` and `done`. The
    last two `actions` are `{op: 'scroll'}` and `{op: 'done'}`.
  - **State.** The state has `previous_actions` sliced to the last 6, and `page_text` only
    when given. A link `[0]<a> "Home"` produces the option `click [0]`.
  - **Review Focus 3.** An element whose name has 300 characters gets an option description
    ≤ 120 characters.
  - **Form fields.**
    - `fillRequest` over the contact form: text-field questions whose options are the dotted
      keys of `lookup` plus `leave_empty`; with option descriptions `null`;
    - the select's options as given;
    - checkbox questions of type `noul`;
    - `formFields` excludes `sensitive` elements and `button`/`submit`.
  - **Plan (`planFill`):**
    - a text field at p 0.9 for `profile.email` fills `lookup.profile.email`;
    - p 0.5 with threshold 0.6 is left as `low-confidence`;
    - `leave_empty` is left as `leave-empty`;
    - a checkbox whose `yes ≥ threshold` while unchecked fills `kind: 'checkbox'` (value `'tick'`);
    - a checkbox already checked is `already-set`.
- [ ] **Step 2: Run, and see it FAIL. Step 3: Implement.** Option descriptions are the
  `serializeRegistry` line minus its `[i]` prefix, truncated to 120 characters with `…`.
  `readViewportText` follows the injected-function rules in CLAUDE.md: self-contained, args
  only.
- [ ] **Step 4:** `npm test -- src/decider/state.test.ts` PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** with message "decider: next-action and form-fill decision builders, viewport text".

### Task 9: Shadow store + statistics

**Files:**
- Create: `src/decider/shadowStore.ts`, `src/decider/stats.ts`, `src/decider/shadow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ShadowRecord { id: string; conversationId: string; seq: number; at: number; kind: 'next' | 'fill'; modelId: string; tokens: number; ms: number; backend: 'webgpu' | 'wasm'; cold: boolean; llm: { op: string; index?: number } | null; top3: { op: string; index?: number; p: number }[]; agree: boolean | null; wouldAct: boolean; fill?: { index: number; key: string; p: number; llmAgrees: boolean | null }[]; skipped?: 'too-long' | 'error' }
  export const SHADOW_CAP = 5000
  export async function putShadow(r: ShadowRecord): Promise<void> // DB 'lychee-decider', store 'shadow'; prunes oldest beyond SHADOW_CAP
  export async function listShadow(): Promise<ShadowRecord[]>
  export async function clearShadow(): Promise<void>
  export interface DeciderStats { n: number; agreement: number; byKind: Record<'next' | 'fill', { n: number; agreement: number }>; calibration: { lo: number; hi: number; n: number; agreement: number }[]; coverage: number; p50: number; p95: number; coldP50: number | null; skipped: number }
  export function summarize(records: ShadowRecord[], threshold: number): DeciderStats // calibration buckets 0.1 wide; coverage = share with top p ≥ threshold; latency excludes cold, reports cold apart
  ```
  `fill[].key` is the lookup **key name** only, never a value.

- [ ] **Step 1: Failing tests (`fake-indexeddb`):**
  - put then list round-trips;
  - pruning keeps the newest `SHADOW_CAP`;
  - `summarize` over 4 hand-made records gives the expected agreement, bucket counts and
    coverage, and `p50`, with cold records excluded from `p50`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS** (`npm test -- src/decider/shadow.test.ts`).
- [ ] **Step 5: Commit** with message "decider: shadow record store and statistics".

### Task 10: Shadow hooks wired into ControlPage, Chat and the stats view

**Files:**
- Create: `src/decider/hooks.ts`, `src/decider/hooks.test.ts`
- Modify:
  - `src/tools/tools.ts:250-286`: a new optional last parameter `decider?: DeciderHooks` on
    `createAgentTools`;
  - in `RequestPageControl` after the grant, call `decider?.sessionGranted()`;
  - in `ControlPage.execute`, right after `snap` is read and **before** the
    point-of-no-return check, call `decider?.observeStep({ tabId: tab.id, snap, spec, session })`;
  - `src/ui/Chat.tsx:3352`: build the hooks once per chain and pass them;
  - `src/ui/settings/ExperimentalTab.tsx`: a stats block via `summarize(await listShadow(), threshold)`
    with a Clear button.
- Test: `src/decider/hooks.test.ts`, `src/tools/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 8, 9.
- Produces:
  ```ts
  export interface DeciderHooks {
    mode(): DeciderMode // 'off' unless settings say so AND the model is ready
    threshold(): number
    sessionGranted(): void // engine.warm(), errors swallowed
    observeStep(i: { tabId: number; snap: PageSnapshot; spec: ControlSpec; session: ControlSession }): void // fire-and-forget
    observeFill(i: { tabId: number; snap: PageSnapshot; session: ControlSession; fields: { index: number; value: string }[] }): void // Task 11
    mapForm(i: { tabId: number; snap: PageSnapshot; session: ControlSession; values: Record<string, string> }): Promise<FillPlan | { error: string }> // Task 11
  }
  export function createDeciderHooks(deps: { settings: () => DeciderSettings | undefined; conversationId: string; currentGoal: () => string; chatModel: () => LanguageModel | null; engine?: DeciderEngine; modelReady?: () => Promise<boolean> }): DeciderHooks
  export function latestUserText(history: ModelMessage[]): string
  ```
  `observeStep`:
  1. returns immediately unless `mode() !== 'off'`;
  2. builds `StepFacts` (`goal = currentGoal()`, `plan = session.plan`, url and title from
     `snap`, `previousActions` from the last 6 `session.journal` summaries, `pageText` from
     `readViewportText(tabId, PAGE_TEXT_CAP)`);
  3. calls `engine.decide(request, { dropIfBusy: true })`;
  4. maps the top option back through `actions`;
  5. writes a `ShadowRecord`, where `seq` is a per-hooks counter incremented on every
     `observeStep` call, `llm` comes from `spec`, and `agree` means same op and index (op
     `press`/`navigate`/`wait`/`highlight` → `agree: null`);
  6. wraps everything so that no rejection escapes. A failure writes
     `skipped: 'error'` / `'too-long'`.

  Mode resolution caches `isModelReady()` for the chain.

- [ ] **Step 1: Failing tests:**
  - **`hooks.test.ts`.**
    - `latestUserText` returns the newest user message's text, for string content and for a
      parts array of text plus an image (**Review Focus 5**). With an injected fake engine,
      `observeStep` writes one record whose `agree` is `true` when the top option is
      `type into [3]` and `spec` is `{action: 'type', index: 3}`.
    - **Password through capture.** A `spec` with `text: 'hunter2-SECRET'` into a `sensitive`
      element, plus a registry name `"Card 4111…"`: `JSON.stringify(record)` contains neither
      `hunter2`, `4111`, `example.com` nor any element name.
    - `mode()` returns `'off'` when the model isn't ready even with `settings.mode = 'shadow'`.
  - **`tools.test.ts`.**
    - With hooks whose `observeStep` returns a never-settling promise internally, `ControlPage`
      returns its normal result (**Review Focus 2**).
    - Without `decider`, `ControlPage` behaves exactly as before; the existing tests are
      untouched.
- [ ] **Step 2: FAIL. Step 3: Implement.**
  - **Chat.tsx.** Build the hooks with:
    - `settings: () => settingsRef.current.decider`;
    - `currentGoal: () => latestUserText(historyRef.current)`;
    - `chatModel: () => createModel(model.provider, model.modelId)`.

    Pass the hooks as the new last argument. Steers are spliced into `historyRef`, so the
    getter covers them.
  - **Stats view.** Show n, agreement overall and by kind, the calibration table, coverage at
    the current threshold, p50/p95 and cold p50, and skipped.
- [ ] **Step 4:** `npm test` (full suite) PASS, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: Commit** with message "decider: shadow mode on ControlPage with stats view".

### Task 11: Lookup form-filling (assist) via AutofillForm + shadowing AutofillForm

**Files:**
- Create: `src/decider/profileLookup.ts`, `src/decider/profileLookup.test.ts`
- Modify:
  - `src/decider/hooks.ts`: implement `mapForm` and `observeFill`;
  - `src/tools/tools.ts`, AutofillForm (~1659-1745):
    - the schema gains an optional `fields` and `values: z.record(z.string(), z.string()).optional()`;
    - the decider path runs when `fields` is absent;
    - existing `fields` calls run `observeFill` fire-and-forget;
    - the description adds: "With the decision model in Assist mode you may omit fields and
      pass the request-specific values; the decider maps the fields."
  - `src/platform/domIndex.ts`: a small exported
    `readSelectOptions(tabId, indices): Promise<Record<number, string[]>>` (self-contained
    injection over `[data-agent-idx]`).
- Test: `src/tools/tools.test.ts`, `src/decider/profileLookup.test.ts`

**Interfaces:**
- Produces:
  `export async function profileLookup(model: LanguageModel, memories: MemoryRecord[], signal?: AbortSignal): Promise<Record<string, string>>`.
  - It makes **one** `extractStructured` call with schema
    `{ type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } } }, required: ['fields'] }`.
  - The prompt says: extract snake_case keys from these profile sentences; values only as
    written; nothing invented.
  - The result is held in a module-level `Map` keyed by
    `memories.map(m => m.id + ':' + m.updatedAt).sort().join('|')`. Memory only.
- `mapForm` returns a `FillPlan` or `{ error }`. Its steps:
  1. `formFields(snap.elements, await readSelectOptions(...))`;
  2. `Lookup = { profile: await profileLookup(chatModel(), await getProfileMemories()), request: values }`;
  3. `fillRequest` → `engine.decide(req)` (**not** dropIfBusy) → `planFill(..., threshold())`;
  4. write a `kind: 'fill'` shadow record with key names only.
- AutofillForm's decider path converts `plan.fills` into the same per-field loop it already
  runs:
  - text → `{action: 'type', text: value, clear: true}`;
  - select → `{action: 'select', value}`;
  - checkbox → `{action: 'click'}`.

  Every guard stays as it is: session, foreground per field, origin drift, `isPointOfNoReturn`
  → one-shot card. Submit is never included. It returns
  `{ filled, left: plan.left, mapped: plan.fills.map(f => ({ index: f.index, key: f.key })) }`.

- [ ] **Step 1: Failing tests (`tools.test.ts`, mocking hooks and engine):**
  - The decider path does not run when `mode()` is `'shadow'` or `'off'`. Without `fields` it
    returns
    `{ error: 'fields is required unless the decision model is in Assist mode and ready.' }`.
  - In assist, with a plan of three fills (text p 0.9, select p 0.95, checkbox) and one `left`
    (p 0.4): `runControlStep` is called 3 times, and `left` is returned.
  - A plan fill targeting a `sensitive` element still raises the one-shot `requestApproval`
    with `once: true`. If denied it is skipped.
  - No `runControlStep` call ever has `spec.action === 'click'` on an element with
    `type === 'submit'`. `planFill` input never contains one; assert defensively in the loop.
  - An origin change between fields ends the session, as the existing path does (reuse the
    existing test shape).
  - **Review Focus 4:** `profileLookup` throws, or there are zero profile memories and no
    `values`. The result is
    `{ error: 'Could not map fields automatically (<reason>); pass fields explicitly.' }`,
    with no `runControlStep` calls.
  - **`profileLookup.test.ts`:** the cache hits on identical memories (one model call for two
    lookups) and misses after `updatedAt` changes.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4:** the full `npm test`, `npm run typecheck`,
  `npm run build` all PASS.
- [ ] **Step 5: Real-browser check.** Use the Task 6 setup with mode Assist and seeded
  `profile` memories:
  - "The user's full name is Ada Lovelace."
  - "The user's email address is ada@example.com."
  - "The user's work email is ada@analytical-engines.co.uk."
  - "The user's phone number is +44 20 7946 0958."
  - "The user's home address is 12 St James's Square, London SW1Y 4JH, United Kingdom."

  These are written straight to IndexedDB `lychee-memory` `memories` in `MemoryRecord` shape.
  Ask Lychee (LM Studio) to fill the contact form, then read the page:
  - expected: name, email and message filled, and the consent box ticked, by an `AutofillForm`
    call without `fields`;
  - its result lists `mapped` keys.
- [ ] **Step 6: Commit** with message "decider: assist-mode lookup form filling through AutofillForm".

### Task 12: Eval harness with answer keys, arms, providers and the spend cap

**Files:**
- Create in `scripts/decider-eval/`:
  - `run.mjs`, `keys.mjs`, `keys.test.mjs`, `report.mjs`, `README.md`;
  - `fixtures/` (copy `scratchpad/e2e/fixtures/`, then add the pages below);
  - `.gitignore` (`out/`).
- Modify: `package.json` (`"test:decider:eval": "npm run build && node scripts/decider-eval/run.mjs"`)

**Interfaces:**
- Consumes: the built `dist/`, the export directory, the Experimental tab's import UI, the
  `lychee-decider` shadow store, and `lychee-conversations` / `lychee-traces` as
  `scratchpad/e2e/run.mjs` reads them.
- **CLI:** `node scripts/decider-eval/run.mjs --arms shadow,assist [--tasks id,…] [--reps 1] [--provider lmstudio|anthropic] [--cap 10]`.
- **Profile.** A persistent profile at `~/.cache/lychee-decider-eval/profile`, so the ~4.9 GB
  OPFS import happens once. On startup:
  1. if `deciderModel` isn't `ready`, import from a local static server over the export
     directory, through the Experimental tab;
  2. seed the settings (provider per `--provider`, `decider.mode` per arm) and the five profile
     memories from Task 11.
  
  For `anthropic` runs, the `finally` overwrites `settings` with the LM Studio provider, so
  the key never persists.
- **Tasks** (id: page, prompt, success check). Assist-relevant tasks are marked ◆.
  - **Store** (`store/`). Change `product.html` so Add to cart pushes `qty` copies, and add a
    120-product `store/catalog.html`.
    1. `shop-cheapest`: Search this store for wireless headphones and add the cheapest
       wireless headphones under $100 to my cart. Check: cart `['Arc wireless headphones']`.
    2. `shop-qty`: Find the Orbit wireless speaker and add 2 of them to my cart. Check: cart
       is 2× `Orbit wireless speaker`.
    3. `shop-mug`: Add the blue Aurora mug to my cart. Check: cart `['Aurora mug (blue)']`.
    4. `shop-price`: How much are the Pulse wireless earbuds here? Check: the reply contains
       `$39`.
    5. `dense-catalog` (`store/catalog.html`): Add the Halo noise-cancelling wireless
       headphones to my cart. Check: cart `['Halo noise-cancelling wireless headphones']`.
  - **Forms.** Every form exposes `window.__fields()` → `{label: value|checked}` and
    `window.__submitted`.
    1. ◆ `form-contact` (the existing task; check as in the spike).
    2. ◆ `form-sales`: the contact form with name Ada Lovelace, email ada@example.com, topic
       Sales, message "Do you offer volume discounts?". Don't include my phone number. Send
       it. Check: submitted topic `Sales` and phone `''`.
    3. ◆ `form-shipping` (new `shipping.html`; fields: full name, street, city, postcode,
       country select, delivery radio standard/express, phone (optional), delivery notes, the
       terms checkbox, "Continue to payment"): Fill in the shipping form with my details,
       choose express delivery, accept the terms and continue. Check: submitted `full_name`
       Ada Lovelace, street `12 St James's Square`, city London, postcode `SW1Y 4JH`, country
       United Kingdom, delivery express, terms on.
    4. ◆ `form-newsletter` (new `signup.html`; email, first name, last name, interest
       checkboxes Audio/Kitchen/Deals, Subscribe): Sign me up for the newsletter with my
       personal email, interested in Audio only. Check: email `ada@example.com`, first Ada,
       last Lovelace, interests `['audio']`.
  - **Navigation** (`help/`; give `warranty.html` the text "Headphones carry a 2-year
    warranty." and `shipping.html` the text "Express delivery costs $12.99."):
    1. `nav-returns` (existing; check `45`).
    2. `nav-warranty`: How long is the warranty on headphones? Use this help site. Check: the
       reply contains `2-year` or `2 year`.
    3. `nav-express`: What does express delivery cost, according to this help site? Check:
       the reply contains `12.99`.
  - **Inbox** (`inbox.html`; add an "Acme Energy Offers" email: "Switch to our green tariff
    and save $10 a month."):
    1. `inbox-bill` (existing; `84.20` and 12 December).
    2. `inbox-order`: When is my Northwind Store order expected to arrive? Check: `25 November`.
    3. `inbox-library`: Which book is due back at the library, and when? Check:
       `Analytical Engine` and `28 November`.
    4. `inbox-lookalike`: What amount is due on my latest Acme Energy bill? Check: `84.20`,
       and not `$10` as the answer.
- **Answer keys** (`keys.mjs`):
  `export function key(taskId, registryText, url): { op: 'click' | 'type' | 'select' | 'press' | 'scroll' | 'done'; index?: number }[]`.
  It returns the set of correct next actions, matched by **element labels** in the registry:
  - **Store.** On the store home or a page whose search box isn't yet filled, the key is
    "type into the Search products input". Once it holds the query, the key is "click Search"
    or "press". On results, it is "click the target product link". On the product page, it is
    the Quantity select when qty ≠ 1 and not yet set, then "click Add to cart".
  - **Forms.** Any text field whose current value ≠ its target, or the select/radio not yet
    on its target, or a checkbox whose `(checked)`/`(unchecked)` state ≠ its target. The
    submit button only when none of those remain.
  - **Navigation.** The link whose label leads toward the target page (an explicit per-task
    path table).
  - **Inbox.** The target email's subject link.
  - Unknown states return `[]`, which is scored "no key" and excluded.
- **Scoring.**
  1. ControlPage calls, in conversation order, pair with shadow records by `seq`. The
     registry before call *i* is the `elements` text of the latest earlier tool output that
     has one (as `spike/replay.py` does).
  2. Chat-model correct ⇔ its `(op, index)` ∈ key. Decider correct ⇔ its top1 ∈ key.
  3. Per task and overall, report:
     - success, wall time, chat-model steps, tokens and estimated cost;
     - decider decisions, ms p50/p95, coverage at the threshold;
     - the 2×2 table (both / chat only / decider only / neither) and agreement;
     - for assist tasks, per-field final-value correctness from `window.__fields()`, plus
       the `mapped` keys.
- **Spend cap.** Before each task, `if (spent + 0.5 > cap)` stop and report "cap reached".
  After each task, add the estimate from that turn's trace usage. Print `spent` per task.

- [ ] **Step 1: Failing test (`keys.test.mjs`, `node --test`):** over the recorded registries
  in `scratchpad/e2e/e2e-all.json`:
  - the form step-0 registry gives `{type,3}`, `{type,4}`, `{select,6}`, `{type,7}`, `{click,8}`
    and not `{click,10}`;
  - after all fields hold their targets and box 8 is `(checked)`, the key is exactly
    `[{click,10}]`;
  - the help-home registry for `nav-returns` gives `{click,5}`;
  - the inbox registry for `inbox-bill` gives `{click,7}`.

  (Re-record any registry that predates Task 7's checkbox format, by hand-editing its
  checkbox lines to `(unchecked)`.)
- [ ] **Step 2: FAIL, then implement `keys.mjs`, PASS** (`node --test scripts/decider-eval/keys.test.mjs`).
- [ ] **Step 3: Implement `run.mjs` and `report.mjs`.** `report.mjs` writes
  `out/<ISO-time>/{results.json,report.md}`.
- [ ] **Step 4: Smoke run.** `node scripts/decider-eval/run.mjs --arms shadow --tasks form-contact,nav-returns --reps 1`.
  Expected: both tasks run, shadow records pair to every ControlPage call (`unpaired: 0`), and
  `report.md` shows the 2×2 table.
- [ ] **Step 5: Commit** with message "decider-eval: answer-keyed benchmark with shadow/assist arms and spend cap".

### Task 13: Full verification and results report

**Files:**
- Create: `docs/superpowers/research/2026-11-21-decider-harness-results.md`

- [ ] **Step 1: Run the repo checks.** `npm run typecheck && npm test && npm run build`.
  Expected: all PASS. Record the test count.
- [ ] **Step 2: Parity and latency in the extension.** Run the Task 6 self-test, then a
  latency pass in the worker over the spike's synthetic browse states.
  `scratchpad/spike/make_fixtures.py` requests, k = 10/47/100, rendered via the engine. Record
  p50 against the latency bars.
- [ ] **Step 3: Gemma run.** `node scripts/decider-eval/run.mjs --arms shadow,assist --reps 1`
  (LM Studio). Expected: a report for all 16 tasks.
- [ ] **Step 4: Sonnet run.** `node scripts/decider-eval/run.mjs --arms shadow,assist --reps 1 --provider anthropic --cap 10`.
  Expected: it stops at or before $10, and the report shows the spend.
- [ ] **Step 5: Write the results doc:**
  - parity, latency and import time;
  - per-arm, per-provider tables (success, wall, steps, cost);
  - the decider-versus-chat 2×2 accuracy, overall and by task family;
  - calibration (accuracy by confidence bucket);
  - assist field accuracy;
  - the go/no-go numbers against the spec's bar (≥ 150 keyed steps, decider ≥ 85% accurate
    at p ≥ 0.6, within 5 points of Sonnet, accuracy rising with confidence);
  - the status of the set-of-marks misalignment check (spec §8 bug list);
  - anything that failed.

  Commit the doc with message "decider: harness results".

---

## Phase B (added 2026-11-22 after the go/no-go passed — user instruction: build driver mode, then test performance + integration)

Architecture facts established during Phase A (binding): tool `execute()` runs in the **service worker** (`src/background/toolHost.ts`); the engine is panel-resident; SW↔panel traffic goes through `src/decider/relay.ts` (SW side; runtime imports limited — guard test) and `src/decider/hooks.ts` (panel side, `deciderRelayListener`). Request/response precedent: `decider.mapForm` (requestId, SW-side timeout, `decider.mapForm.cancel`, abort-signal aware). Results: `docs/superpowers/research/2026-11-21-decider-harness-results.md`.

### Task 15a: Untick blind spot + AutofillForm select fix

**Files:** Modify `src/decider/state.ts` (+ `state.test.ts`), `src/decider/fillPlan.ts`, `src/tools/tools.ts` (+ `tools.test.ts`), `src/decider/hooks.ts` (+test) only if the fill record needs the new value.

- [ ] **Step 1: Failing tests.**
  - **Next-action options.** In `nextActionRequest`, a checkbox element gets the option `tick [i]` when `checked === false` and `untick [i]` when `checked === true`. An unchecked radio gets `choose [i]`. The action op stays `'click'` with the same index. Other elements are unchanged.
  - **planFill.** A checkbox that is `checked` with `yes ≤ 1 − threshold` produces fill `{ kind: 'checkbox', key: 'untick', value: 'untick' }`. An unchecked checkbox with `yes ≥ threshold` still produces `tick`.
  - **AutofillForm decider path.** An `untick` fill clicks only an input[type=checkbox] that is currently checked, and a `tick` fill only one that is unchecked. Any other click is still refused (never submit).
  - **AutofillForm `fields` path.** When the target element is a `<select>`, it runs `{ action: 'select', value }` instead of `type`. A regression test covers the 3/3 failure seen in the benchmark.
- [ ] **Step 2: Implement.** Then run `npm test`, `npm run typecheck`, `npm run build`, and the relay guard.
- [ ] **Step 3: Offline re-score.** Use the diagnosis harness (`scratchpad/diag/` cases.py/final.py, fp32 reference) on the 37 states plus the newsletter untick states from the Task 13 runs (`scratchpad/t13/`). Report the before/after top-1 on the untick cases and confirm no regression elsewhere.
- [ ] **Step 4: Commit** (controller).

### Task 15b: Harness fixes found by Task 13

**Files:** `scripts/decider-eval/**` only.

- The store header "Cart (N)" updates after Add to cart, on the same page.
- Scoring:
  - steps after an `AutofillForm` call are scored against the registry *after* that fill;
  - `ControlPage` calls issued in the same model step as another page-mutating call (parallel-call races) are excluded and counted as `raced`.
  - Port these from `scratchpad/t13/` rescoring scripts.
- A `driver` arm stub: seeds `decider.mode = 'driver'`; Task 17 fills in its reporting.
- Tests: `node --test scripts/decider-eval/` stays green, with new tests for both scoring rules.

### Task 16: Driver mode (spec §7.3 + October loop lessons)

**Files:**
- Create `src/decider/driverLoop.ts`: pure, testable. It takes injected `decide`, `act`, `snapshot`, `isPointOfNoReturn`, `approve` and `checks`.
- Create `src/decider/driverLoop.test.ts`.
- Modify `src/decider/config.ts` (`'driver'` mode), `src/decider/relay.ts` and `src/decider/hooks.ts` (+tests) to add the `decider.next` request/response, `src/tools/tools.ts` (+tests) to add the tool, `src/ui/settings/ExperimentalTab.tsx` to add a Driver option, and `src/background/toolHost.ts` only if wiring needs it.

**Interfaces:**
- **Settings.** `DeciderMode = 'off' | 'shadow' | 'assist' | 'driver'`. Driver includes assist and shadow behaviour. `normalizeDecider` accepts `'driver'`.
- **Tool.** `FastSteps` is present in the ToolSet only when the settings mode is `'driver'`. It is added to `activeNames` on the page-control grant in that mode, and the grant note mentions it. Input: `{ goal: string, values?: Record<string,string>, maxSteps?: number }`, with maxSteps defaulting to 12 and capped at 12.
- **Description.** "Run up to 12 quick page steps toward ONE short sub-goal (e.g. 'search for wireless headphones and open the cheapest result under $100') using the on-device decision model, inside an open page-control session. Pass any values to type in `values`. It hands back when done, unsure, blocked, or after 12 steps; risky steps still ask the user."
- **Per-step SW→panel request.** `decider.next {conversationId, requestId, goal, values, snap (masked as relay does), pageText (read pre-action in the SW), previousActions (deciderActionLine), exclude: [{op,index}]}`.
- **Panel reply.** `{ top3: [{op, index?, p}], tokens, ms, value?: { key, text, p } }`. When the top option is `type into [i]`, the panel also runs the single-field fill question (fillRequest with that field; the lookup is profile + values) in the same call, and returns the chosen key's text when p ≥ threshold. Otherwise it replies `{ error }`.
  - The reply has a 30 s SW timeout plus a cancel message, and is abort-aware, as mapForm is.
  - The panel writes a ShadowRecord `kind: 'drive'` with `llm: null` and `agree: null`, key names only.

**Loop** (`driverLoop.ts`). Order per step:
1. abort, steer, session, foreground and origin-drift checks;
2. snapshot;
3. dense cap: if the rendered request exceeds 2,500 tokens → hand back `'dense page'`;
4. decide;
5. gate: top p ≥ 0.6 acts; 0.4–0.6 acts only when `!isPointOfNoReturn` (tentative); < 0.4 hands back `'unsure'`; `done` needs ≥ 0.6;
6. repeat exclusion: if (op,index) equals the previous step's and the page didn't change, exclude it and re-ask once;
7. a `type` with no value (or `leave_empty`) hands back `'needs value'`;
8. point of no return → one-shot `requestApproval` (once:true) plus the stale-element re-check; denied → `'blocked'`;
9. `runControlStep` with presence hooks; quick settle (50 ms quiet, 250 ms cap) for non-committing steps, normal `waitForStable` otherwise;
10. stop on `done`, 2 failed actions, 3 no-change steps in a row, `maxSteps`, abort or steer.

**Return:** `{ status: 'done'|'handback'|'blocked'|'stopped', reason, actions: <redacted journal entries for this call>, elements: <fresh registry>, lastDecision?: top3 }`.

**Tests** (driverLoop is pure, so most cases are unit tests):
- each gate band, the tentative-PoNR hand-back, and the dense hand-back;
- repeat exclusion, the fail and no-change caps, and maxSteps;
- abort mid-loop does nothing further, and steer stops at a step boundary;
- denied PoNR gives `blocked`; done needs ≥ 0.6;
- a type without a value hands back;
- the tool is absent outside driver mode;
- the SW never imports panel modules (relay guard).

**Browser check:** a FRESH profile, LM Studio, driver mode, on the shop-cheapest task; report the statuses and steps.

### Task 17: Performance + integration test of driver mode

- The eval harness `driver` arm reports, per task: success, wall time, chat-model steps and tokens, FastSteps calls, statuses and hand-back reasons, decider steps executed, decider ms p50/p95, and wrong actions. Wrong actions are scored against the keys using the registry before each executed step, so the tool result must expose a per-step `{op,index}` list without page content.
- Runs:
  - Gemma: `off` + `driver` × all 16 tasks, reps 1.
  - Sonnet: `driver` × all 16, reps 1, `--cap 10`. Always keep the cap at $10 per run.
- Report: the driver vs off delta in success, wall time, chat-model steps and tokens per task family. This is the "is it actually faster end to end" answer. Append it to the results doc.
