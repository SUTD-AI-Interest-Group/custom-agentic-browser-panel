# Fast Act runtime (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `Act`'s per-decision latency on WebGPU without retraining: an fp16-activation ONNX graph of the shipped act-head weights in which RoPE angles and the two option masks arrive as inputs and attention is one fused `MultiHeadAttention` node, measured against the current q8 graph by per-kernel profile, parity gate and the real-browser eval.

**Architecture:** A new PyTorch module `VonFast` (`scripts/export-von/fast.py`) re-expresses ModernBERT's forward — embeddings → 28 layers of (attn-norm, Wqkv, fp32 RoPE from input tables, fused attention with an additive bias, Wo, mlp-norm, GeGLU MLP) → final norm → marker gather → scorer — over inputs `input_ids, cos_full, sin_full, cos_sliding, sin_sliding, bias_full, bias_sliding, marker_positions`. `export.py --fast` exports it (fp32), gates it on the CPU EP against Von's own forward, converts activations to fp16 with fp32 islands (RoPE, LayerNorm, scorer), and ships `model_f16.onnx` with `inputs: "fast"` in `von.json` and `requiresShaderF16: true` in the manifest. The browser side gains a pure, tested twin of the input builder (`buildFastInputs` in `src/system1/von.ts`, bucketed T with a masked pad token), a `fast` branch in the worker, an optional kernel profiler, and an eval phase that reports kernel time by name. Nothing above the worker changes.

**Tech Stack:** PyTorch + torch.onnx (opset 18, `dynamo=False`, custom symbolic for `com.microsoft::MultiHeadAttention`), onnxruntime (CPU gate, `onnxruntime.transformers.float16`), onnxruntime-web 1.30 WebGPU (native EP: the worker already loads the asyncify bundle), vitest, the Playwright eval harness.

**Spec:** `docs/superpowers/specs/2026-10-02-von-fast-act-design.md` §3 and §7 (runtime row); §8 risks.

## Global Constraints

- Work in this worktree; data and exports live in the MAIN checkout's gitignored `scripts/von-finetune/data/` (`VFT_DATA=/Users/angks/projects/SUTD/SUTD_AIIG/custom-agentic-browser-panel/scripts/von-finetune/data`) and `scripts/export-von/out/` of this worktree is gitignored too. Python runs through `uv run` with `UV_CACHE_DIR=/private/tmp/claude-501/-Users-angks-projects-SUTD-SUTD-AIIG-custom-agentic-browser-panel/cafe901a-9b05-4580-a892-85b0699a7c22/scratchpad/uvcache`.
- The reference model is the published act-head checkpoint `ks-ang/von-browser-act` (`checkpoint/` → `data/act-head/ckpt`, 3.2 GB; the local copy was removed by the disk cleanup).
- Parity gate: calibrated max|Δp| ≤ 0.03 and no argmax flip on the exporter's probe suite, **after a scalar temperature refit** for the fp16 graph; order invariance < 1e-2 as today. The fp32 fast graph must agree with Von's own forward to < 1e-3 in logits before any conversion.
- Masks and RoPE: exactly `VonExport.forward`'s rules (prefix↔prefix; option→prefix ∪ own span; diagonal always; sliding adds |Δposition| ≤ 64 on the reset position ids) and ModernBERT's RoPE (`inv_freq = θ^(−2i/64)`, θ 160000 for `full_attention` layers, 10000 for `sliding_attention`, `cos/sin = cat(freqs, freqs)`, rotate-half, applied in fp32). A pad token is `pad_token_id` 50283 with `option_id = −2`, position id 0, masked from every real row.
- Bucketed T ∈ {256, 512, 768, 1024, 1536, 2048, 3072, 4096}; a packed input longer than 4096 is still `too-long`.
- `requiresShaderF16: true` for the f16 variant: the worker already requests the feature from the adapter; the eval harness must pass the manifest's value through instead of its hard-coded `false`.
- No production behaviour change for the q8 path: `export.py` without `--fast` is byte-for-byte the old flow; the worker's legacy branch is untouched; `profile` is never set outside the eval.
- Commits with pathspecs; `git add` only the named files; the session attribution line on every commit.

## Review Focus

1. A pad token must never influence a real row: prefix queries see no pad key, option queries see no pad key, and a request padded from 1,100 to 1,536 tokens yields the same logits as the unpadded graph (test in Task 3, parity in Task 5).
2. cos/sin rows are indexed by the token's **reset position id**, not its row index — option tokens restart at the prefix length (test in Task 3 with two options).
3. `marker_positions` and K are untouched by padding; a packed input of exactly 4,096 tokens buckets to 4,096, one of 4,097 is `too-long` (test in Task 3).
4. The fp16 graph's parity is judged only after the temperature refit and on the calibrated probabilities (Task 4 gate), and the manifest's `parity` block records the refit temperature.
5. The eval harness boots the f16 model with `requiresShaderF16` from the manifest, and the kernel phase proves the EP (a `FlashAttention`-named kernel present) before any latency number is believed (Task 6).

---

### Task 1: The reference checkpoint and the export environment

**Files:** none in the repo (data only).

- [ ] **Step 1: Download the act-head checkpoint** (3.2 GB, ~1 min):

```bash
~/.local/bin/hf download ks-ang/von-browser-act --include "checkpoint/*" --local-dir /Users/angks/projects/SUTD/SUTD_AIIG/custom-agentic-browser-panel/scripts/von-finetune/data/act-head/hf
ls -la /Users/angks/projects/SUTD/SUTD_AIIG/custom-agentic-browser-panel/scripts/von-finetune/data/act-head/hf/checkpoint
```
Expected: `config.json marker_calibration.json model.safetensors option_marker.pt tokenizer.json tokenizer_config.json train_meta.json`, sizes 1579143688 / 1581297683 for the two weight files.

- [ ] **Step 2: The exporter's environment** — `uv run scripts/export-von/export.py --help` (already running in the background from the setup) prints the argparse help; `uv run python -c "import onnxruntime, onnx; print(onnxruntime.__version__, onnx.__version__)"` inside the same script env prints versions ≥ 1.20 / 1.17.

---

### Task 2: `VonFast` — the forward with RoPE and masks as inputs

**Files:**
- Create: `scripts/export-von/fast.py`

**Interfaces:**
- Produces: `class VonFast(nn.Module)` with `forward(input_ids[1,T], cos_full[T,64], sin_full[T,64], cos_sliding[T,64], sin_sliding[T,64], bias_full[1,1,T,T], bias_sliding[1,1,T,T], marker_positions[K]) -> logits[K]`; `fast_inputs(ids, option_ids, position_ids, window, T_pad, pad_id, head_dim, theta_full, theta_sliding) -> dict of numpy arrays` (the Python twin of the browser's `buildFastInputs`); `FAST_INPUT_NAMES`, `BUCKETS`, `NEG`.
- Consumes: `export.py`'s `load_reference`, `probe_suite`, `encode`, `plan_sequence`, `reference_logits` (imported; `export.py` stays importable because its work is under `main()`).

- [ ] **Step 1: Write the self-check first** — the bottom of `fast.py` is its test: run as a script it loads the reference, builds `VonFast`, and asserts on the probe suite that (a) unpadded logits agree with `reference_logits` to < 1e-3 and (b) padding to the next bucket leaves them unchanged to < 1e-4. Run it before the forward exists and watch it fail on the import.

```python
# scripts/export-von/fast.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "onnx>=1.17", "onnxruntime>=1.20",
#   "onnx-ir", "huggingface_hub>=0.30", "numpy",
# ]
# ///
"""The fast graph: ModernBERT re-expressed so the math ORT ran on the CPU —
RoPE angles and the two option masks — arrives as inputs, and attention is one
fused node (com.microsoft MultiHeadAttention, which the native WebGPU EP runs as
FlashAttention). Measured 2026-09-30: 540 of the 1,909 nodes of the plain
export fell to ORT's CPU fallback with a sync inside every layer, and the pass
ran at ~1.1 TFLOP/s on a GPU with ten times that (eval README; the research
reports under docs/superpowers/research/).

The forward is exactly ModernBERT's (transformers 5.17 modeling_modernbert.py):
embeddings → LayerNorm; per layer: attn_norm (identity on layer 0) → Wqkv →
RoPE in fp32 (rotate-half; cos/sin = cat(freqs, freqs)) → attention scaled by
1/8 with an additive mask → Wo, residual; mlp_norm → Wi → gelu(input)·gate →
Wo, residual; final_norm; marker gather; the option-marker scorer. No biases
anywhere (attention_bias, mlp_bias, norm_bias are all false in Von's config).

    uv run scripts/export-von/fast.py --checkpoint <dir>   # self-check vs Von's forward
"""
import math, os, sys
import numpy as np
import torch
import torch.nn as nn

NEG = -30000.0
HEAD_DIM = 64
BUCKETS = [256, 512, 768, 1024, 1536, 2048, 3072, 4096]
FAST_INPUT_NAMES = ["input_ids", "cos_full", "sin_full", "cos_sliding", "sin_sliding", "bias_full", "bias_sliding", "marker_positions"]


def bucket_for(T):
    for b in BUCKETS:
        if T <= b:
            return b
    raise ValueError(f"packed input is {T} tokens (max {BUCKETS[-1]})")


def rope_table(position_ids, theta, head_dim=HEAD_DIM):
    """cos/sin per TOKEN ROW from its (reset) position id: ModernBertRotaryEmbedding in fp32, cat(freqs, freqs)."""
    pos = np.asarray(position_ids, dtype=np.float32)
    inv = 1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float32) / head_dim))
    freqs = pos[:, None] * inv[None, :]
    emb = np.concatenate([freqs, freqs], axis=1)
    return np.cos(emb).astype(np.float32), np.sin(emb).astype(np.float32)


def fast_inputs(ids, option_ids, position_ids, window, T_pad, pad_id, theta_full=160000.0, theta_sliding=10000.0):
    """The Python twin of src/system1/von.ts buildFastInputs: padded ids, four RoPE tables, two additive biases."""
    T = len(ids)
    assert T_pad >= T
    pad = T_pad - T
    ids_p = list(ids) + [pad_id] * pad
    oi = np.array(list(option_ids) + [-2] * pad)
    pi = np.array(list(position_ids) + [0] * pad)
    qp = (oi == -1)[:, None]
    kp = (oi == -1)[None, :]
    same = oi[:, None] == oi[None, :]
    allowed = (qp & kp) | (~qp & (kp | same))
    eye = np.eye(T_pad, dtype=bool)
    full = allowed | eye
    sliding = (allowed & (np.abs(pi[:, None] - pi[None, :]) <= window)) | eye
    bias = lambda ok: np.where(ok, 0.0, NEG).astype(np.float32)[None, None]
    cos_f, sin_f = rope_table(pi, theta_full)
    cos_s, sin_s = rope_table(pi, theta_sliding)
    return {
        "input_ids": np.array([ids_p], dtype=np.int64),
        "cos_full": cos_f, "sin_full": sin_f, "cos_sliding": cos_s, "sin_sliding": sin_s,
        "bias_full": bias(full), "bias_sliding": bias(sliding),
    }


class FusedAttention(torch.autograd.Function):
    """Plain attention in PyTorch; one com.microsoft MultiHeadAttention node in ONNX."""

    @staticmethod
    def forward(ctx, q, k, v, bias, num_heads):
        B, S, HD = q.shape
        D = HD // num_heads
        qh = q.view(B, S, num_heads, D).transpose(1, 2)
        kh = k.view(B, S, num_heads, D).transpose(1, 2)
        vh = v.view(B, S, num_heads, D).transpose(1, 2)
        w = torch.matmul(qh, kh.transpose(2, 3)) * (D ** -0.5) + bias
        p = torch.softmax(w, dim=-1, dtype=torch.float32).to(q.dtype)
        return torch.matmul(p, vh).transpose(1, 2).reshape(B, S, HD)

    @staticmethod
    def symbolic(g, q, k, v, bias, num_heads):
        none = g.op("prim::Constant")
        none.setType(torch._C.OptionalType.ofTensor())
        return g.op("com.microsoft::MultiHeadAttention", q, k, v, none, none, bias, num_heads_i=num_heads, scale_f=HEAD_DIM ** -0.5)


class Rope(nn.Module):
    """RoPE in fp32 from input tables; its nodes are named /rope*/ so the fp16 converter can keep them fp32."""

    def forward(self, x, cos, sin):  # x (B,S,H,D); cos/sin (S,D)
        x = x.float()
        half = x.shape[-1] // 2
        rot = torch.cat((-x[..., half:], x[..., :half]), dim=-1)
        return x * cos[None, :, None, :] + rot * sin[None, :, None, :]


class VonFast(nn.Module):
    def __init__(self, model, n_layers=None):
        super().__init__()
        enc = model.encoder
        self.emb = enc.embeddings
        self.layers = enc.layers if n_layers is None else enc.layers[:n_layers]
        self.types = list(enc.config.layer_types)
        self.heads = enc.config.num_attention_heads
        self.final_norm = enc.final_norm
        self.scorer = model.scorer
        self.rope = Rope()

    def forward(self, input_ids, cos_full, sin_full, cos_sliding, sin_sliding, bias_full, bias_sliding, marker_positions):
        x = self.emb.norm(self.emb.tok_embeddings(input_ids))
        for i, layer in enumerate(self.layers):
            full = self.types[i] == "full_attention"
            cos, sin, bias = (cos_full, sin_full, bias_full) if full else (cos_sliding, sin_sliding, bias_sliding)
            h = layer.attn_norm(x)
            qkv = layer.attn.Wqkv(h)
            B, S, _ = qkv.shape
            qkv = qkv.view(B, S, 3, self.heads, HEAD_DIM)
            q = self.rope(qkv[:, :, 0], cos, sin).to(qkv.dtype).reshape(B, S, -1)
            k = self.rope(qkv[:, :, 1], cos, sin).to(qkv.dtype).reshape(B, S, -1)
            v = qkv[:, :, 2].reshape(B, S, -1)
            x = x + layer.attn.Wo(FusedAttention.apply(q, k, v, bias, self.heads))
            x = x + layer.mlp(layer.mlp_norm(x))
        x = self.final_norm(x)
        return self.scorer(x[0].index_select(0, marker_positions)).float()


def tensors(inputs, markers):
    t = {k: torch.from_numpy(v) for k, v in inputs.items()}
    t["marker_positions"] = torch.tensor(markers)
    return t


def main():
    import argparse
    from export import load_reference, probe_suite, encode, plan_sequence, reference_logits
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=None)
    args = ap.parse_args()
    model, calib, paths = load_reference(args.checkpoint)
    w = int(model.encoder.config.sliding_window)
    pad = int(model.encoder.config.pad_token_id)
    fast = VonFast(model).eval()
    worst, worst_pad = 0.0, 0.0
    for case in probe_suite():
        packed, ids, st = encode(model.tokenizer, model, case)
        oid, pid, mk = plan_sequence(ids, model.mask_token_id)
        ref = reference_logits(model, ids, mk)
        with torch.no_grad():
            mine = fast(**tensors(fast_inputs(ids, oid, pid, w, len(ids), pad), mk)).numpy()
            padded = fast(**tensors(fast_inputs(ids, oid, pid, w, bucket_for(len(ids)), pad), mk)).numpy()
        worst = max(worst, float(np.abs(ref - mine).max()))
        worst_pad = max(worst_pad, float(np.abs(mine - padded).max()))
    print(f"[fast] max|Δlogit| vs Von's forward {worst:.2e} · padding to a bucket {worst_pad:.2e}")
    assert worst < 1e-3, "VonFast diverges from Von's forward"
    assert worst_pad < 1e-4, "a pad token influenced a real row"
    print("[fast] OK")


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
```

- [ ] **Step 2: Run it** — `uv run scripts/export-von/fast.py --checkpoint <data>/act-head/hf/checkpoint`. Expected on the first run: a failure that is NOT an import error (the module is the test); if `[fast] max|Δlogit| …` prints with the first number ≥ 1e-3, the forward is wrong — compare against `VonExport.forward` layer by layer (the usual culprits: `qkv.view(B,S,3,H,D)` order, rotate-half sign, the layer-0 identity norm). Expected when right: `[fast] max|Δlogit| vs Von's forward <1e-4 · padding to a bucket <1e-5` and `[fast] OK`.

- [ ] **Step 3: Commit** — `git add scripts/export-von/fast.py && git commit -m "feat(export-von): VonFast — ModernBERT with RoPE tables and option masks as inputs and one fused attention node per layer" -- scripts/export-von/fast.py`

---

### Task 3: The browser twin — `buildFastInputs` and bucketing

**Files:**
- Modify: `src/system1/von.ts` (append)
- Modify: `src/system1/von.test.ts` (append)

**Interfaces:**
- Produces: `FAST_BUCKETS`, `bucketFor(T: number, maxTokens: number): number` (throws `VonInputError('too-long')` past the last bucket), `interface FastConfig { padTokenId: number; slidingWindow: number; headDim: number; rope: { full: number; sliding: number } }`, `interface FastInputs { T: number; ids: number[]; cosFull: Float32Array; sinFull: Float32Array; cosSliding: Float32Array; sinSliding: Float32Array; biasFull: Float32Array; biasSliding: Float32Array }`, `buildFastInputs(ids: number[], plan: SequencePlan, cfg: FastConfig): FastInputs`. `VonConfig` gains optional `inputs?: 'fast'`, `padTokenId?`, `headDim?`, `rope?`, `buckets?`.

- [ ] **Step 1: Failing tests** (append to `src/system1/von.test.ts`):

```ts
import { FAST_BUCKETS, bucketFor, buildFastInputs, planSequence, VonInputError } from './von'

describe('fast inputs', () => {
  const cfg = { padTokenId: 50283, slidingWindow: 64, headDim: 64, rope: { full: 160000, sliding: 10000 } }
  // [CLS] a b [SEP] [MASK] o1 [MASK] o2 [SEP]  → prefix rows 0..4? markers at 4 and 6; last row is the trailing [SEP]
  const MASK = 50284
  const ids = [50281, 11, 12, 50282, MASK, 21, MASK, 22, 50282]
  const plan = planSequence(ids, MASK, 4096)
  const f = buildFastInputs(ids, plan, cfg)
  const T = f.T
  const bias = (b: Float32Array, i: number, j: number) => b[i * T + j]
  it('buckets to the next size and pads with the pad token, option id −2', () => {
    expect(FAST_BUCKETS[0]).toBe(256)
    expect(T).toBe(256)
    expect(f.ids.length).toBe(256)
    expect(f.ids[9]).toBe(50283)
    expect(f.ids.slice(0, 9)).toEqual(ids)
  })
  it('keeps the mask rules: prefix↔prefix, option→prefix ∪ own span, diagonal, never a pad', () => {
    expect(bias(f.biasFull, 0, 3)).toBe(0) // prefix sees prefix
    expect(bias(f.biasFull, 4, 0)).toBe(0) // option 0 sees prefix
    expect(bias(f.biasFull, 4, 5)).toBe(0) // own span
    expect(bias(f.biasFull, 4, 6)).toBe(-30000) // not the other option
    expect(bias(f.biasFull, 0, 4)).toBe(-30000) // prefix never sees an option
    expect(bias(f.biasFull, 8, 4)).toBe(-30000) // the trailing [SEP] is prefix-class
    expect(bias(f.biasFull, 0, 9)).toBe(-30000) // a pad is never a key for a real row
    expect(bias(f.biasFull, 4, 200)).toBe(-30000)
    expect(bias(f.biasFull, 9, 9)).toBe(0) // a pad still attends to itself (no empty softmax row)
    expect(bias(f.biasFull, 7, 7)).toBe(0)
  })
  it('sliding adds the |Δposition| ≤ window rule on the RESET position ids', () => {
    const far = Array.from({ length: 200 }, (_, i) => 100 + i) // one 200-token "option"
    const ids2 = [50281, ...far.slice(0, 80), 50282, MASK, ...far.slice(80), 50282]
    const p2 = planSequence(ids2, MASK, 4096)
    const g = buildFastInputs(ids2, p2, cfg)
    const i = p2.markers[0]
    expect(g.biasFull[i * g.T + 0]).toBe(0)
    expect(g.biasSliding[i * g.T + 0]).toBe(-30000) // prefix token 0 is 82 positions back from the marker
    expect(g.biasSliding[i * g.T + (i - 64)]).toBe(0)
    expect(g.biasSliding[i * g.T + (i - 65)]).toBe(-30000)
  })
  it('indexes the RoPE tables by reset position id, with cat(freqs, freqs) and the right thetas', () => {
    const row = (t: Float32Array, r: number) => Array.from(t.slice(r * 64, r * 64 + 64))
    // option 1's first token (row 6) restarts at the prefix length 4 — the same position as option 0's marker (row 4)
    expect(plan.positionIds[6]).toBe(4)
    expect(row(f.cosFull, 6)).toEqual(row(f.cosFull, 4))
    expect(row(f.cosFull, 4)[0]).toBeCloseTo(Math.cos(4), 5)
    expect(row(f.cosFull, 4)[32]).toBeCloseTo(Math.cos(4), 5)
    expect(row(f.cosFull, 4)[1]).toBeCloseTo(Math.cos(4 * Math.pow(160000, -2 / 64)), 5)
    expect(row(f.cosSliding, 4)[1]).toBeCloseTo(Math.cos(4 * Math.pow(10000, -2 / 64)), 5)
    expect(row(f.sinFull, 4)[0]).toBeCloseTo(Math.sin(4), 5)
    expect(row(f.cosFull, 9)[0]).toBe(1) // pad: position 0
  })
  it('buckets exactly at a boundary and refuses past the last bucket', () => {
    expect(bucketFor(256, 4096)).toBe(256)
    expect(bucketFor(257, 4096)).toBe(512)
    expect(bucketFor(4096, 4096)).toBe(4096)
    expect(() => bucketFor(4097, 4096)).toThrow(VonInputError)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/system1/von.test.ts` — expected FAIL: `buildFastInputs` is not exported.

- [ ] **Step 3: Implement** (append to `src/system1/von.ts`; also extend `VonConfig`):

```ts
/**
 * The fast graph (scripts/export-von/fast.py): RoPE tables and the two option
 * masks are INPUTS, built here exactly as fast_inputs() builds them in Python
 * — the golden fixture is what keeps the two from drifting. T is padded to a
 * bucket so WebGPU pipelines are reused; a pad token has option id −2 and is
 * masked from every real row (it may still see itself, so no softmax row is
 * empty).
 */
export const FAST_BUCKETS = [256, 512, 768, 1024, 1536, 2048, 3072, 4096]
export const NEG_BIAS = -30000

export interface FastConfig {
  padTokenId: number
  slidingWindow: number
  headDim: number
  rope: { full: number; sliding: number }
}
export interface FastInputs {
  T: number
  ids: number[]
  cosFull: Float32Array
  sinFull: Float32Array
  cosSliding: Float32Array
  sinSliding: Float32Array
  biasFull: Float32Array
  biasSliding: Float32Array
}

export function bucketFor(T: number, maxTokens: number): number {
  for (const b of FAST_BUCKETS) if (T <= b && b <= maxTokens) return b
  throw new VonInputError('too-long', `packed input is ${T} tokens (max ${Math.min(maxTokens, FAST_BUCKETS[FAST_BUCKETS.length - 1])})`)
}

function ropeTable(positions: number[], theta: number, headDim: number): { cos: Float32Array; sin: Float32Array } {
  const half = headDim / 2
  const inv = Array.from({ length: half }, (_, i) => 1 / Math.pow(theta, (2 * i) / headDim))
  const cos = new Float32Array(positions.length * headDim)
  const sin = new Float32Array(positions.length * headDim)
  positions.forEach((p, r) => {
    for (let i = 0; i < half; i++) {
      const a = Math.fround(p * Math.fround(inv[i]))
      const c = Math.cos(a)
      const s = Math.sin(a)
      cos[r * headDim + i] = c
      cos[r * headDim + half + i] = c
      sin[r * headDim + i] = s
      sin[r * headDim + half + i] = s
    }
  })
  return { cos, sin }
}

export function buildFastInputs(ids: number[], plan: SequencePlan, cfg: FastConfig): FastInputs {
  const T = bucketFor(ids.length, FAST_BUCKETS[FAST_BUCKETS.length - 1])
  const pad = T - ids.length
  const padded = [...ids, ...Array(pad).fill(cfg.padTokenId)]
  const oi = [...plan.optionIds, ...Array(pad).fill(-2)]
  const pi = [...plan.positionIds, ...Array(pad).fill(0)]
  const biasFull = new Float32Array(T * T)
  const biasSliding = new Float32Array(T * T)
  for (let i = 0; i < T; i++) {
    const qp = oi[i] === -1
    for (let j = 0; j < T; j++) {
      const kp = oi[j] === -1
      const allowed = qp ? kp : kp || oi[i] === oi[j]
      const full = allowed || i === j
      const sliding = (allowed && Math.abs(pi[i] - pi[j]) <= cfg.slidingWindow) || i === j
      biasFull[i * T + j] = full ? 0 : NEG_BIAS
      biasSliding[i * T + j] = sliding ? 0 : NEG_BIAS
    }
  }
  const f = ropeTable(pi, cfg.rope.full, cfg.headDim)
  const s = ropeTable(pi, cfg.rope.sliding, cfg.headDim)
  return { T, ids: padded, cosFull: f.cos, sinFull: f.sin, cosSliding: s.cos, sinSliding: s.sin, biasFull, biasSliding }
}
```
and in `VonConfig`: `inputs?: 'fast'`, `padTokenId?: number`, `headDim?: number`, `rope?: { full: number; sliding: number }`.

- [ ] **Step 4: Run** `npx vitest run src/system1/von.test.ts` — expected PASS (all, old and new).
- [ ] **Step 5: Commit** — `git commit -m "feat(system1): buildFastInputs — the browser twin of the fast graph's RoPE tables, option biases and bucketed padding" -- src/system1/von.ts src/system1/von.test.ts`

---

### Task 4: `export.py --fast` — export, gate, fp16 islands, ship set

**Files:**
- Modify: `scripts/export-von/export.py`

**Interfaces:**
- `--fast` adds the `f16` variant built from `VonFast`; ship files `model_f16.onnx`, tokenizer files, `von.json` with `inputs: "fast"`, `padTokenId`, `headDim`, `rope`, `buckets`; manifest `variant: "f16"`, `requiresShaderF16: true`, `parity: {..., refitTemperature}`. Without `--fast` nothing changes.
- The gate for a fast graph runs `onnx_fast_logits(sess, inputs, markers)` over `fast_inputs(..., T_pad=bucket_for(T))`.

- [ ] **Step 1: Export + fp32 gate.** After the existing wrapper check, when `args.fast`:

```python
    from fast import VonFast, fast_inputs, tensors, bucket_for, FAST_INPUT_NAMES, BUCKETS
    pad_id = int(model.encoder.config.pad_token_id)
    fast = VonFast(model).eval()
    fast_fp32 = os.path.join(out, "von_fast_fp32.onnx")
    _, _, ids, _, oid, pid, mk, _ = encoded[3]
    ex = tensors(fast_inputs(ids, oid, pid, w, bucket_for(len(ids)), pad_id), mk)
    torch.onnx.export(
        fast, tuple(ex[n] for n in FAST_INPUT_NAMES), fast_fp32,
        input_names=FAST_INPUT_NAMES, output_names=["logits"],
        dynamic_axes={"input_ids": {1: "T"}, "cos_full": {0: "T"}, "sin_full": {0: "T"}, "cos_sliding": {0: "T"}, "sin_sliding": {0: "T"},
                      "bias_full": {2: "T", 3: "T"}, "bias_sliding": {2: "T", 3: "T"}, "marker_positions": {0: "K"}, "logits": {0: "K"}},
        opset_version=18, dynamo=False, custom_opsets={"com.microsoft": 1},
    )
    mha = sum(n.op_type == "MultiHeadAttention" for n in onnx.load(fast_fp32).graph.node)
    assert mha == len(fast.layers), f"expected {len(fast.layers)} MultiHeadAttention nodes, got {mha}"
```
and a gate function `gate_fast(path, refit)` beside `gate()`: same probes, inputs via `fast_inputs(..., bucket_for(T))`, feeds built from the dict plus `marker_positions`; when `refit` is true, fit a scalar temperature on the probe set by NLL against the reference's calibrated probabilities before comparing (store it as `refitTemperature`), otherwise use the shipped calibration unchanged. Expected on the fp32 fast graph: `max|Δp| < 1e-3`, 0 flips, invariance < 1e-4 (it is the same math in fp32).

- [ ] **Step 2: fp16 with islands.**

```python
    from onnxruntime.transformers.float16 import convert_float_to_float16
    m = onnx.load(fast_fp32)
    island = [n.name for n in m.graph.node if "/rope" in n.name or "/scorer" in n.name or "/final_norm" in n.name]
    m16 = convert_float_to_float16(m, keep_io_types=True, op_block_list=["LayerNormalization"], node_block_list=island)
    f16 = os.path.join(out, "von_f16.onnx")
    onnx.save(m16, f16)
```
Then `gate_fast(f16, refit=True)` on the CPU EP. If the CPU EP refuses an fp16 `MultiHeadAttention` (NOT_IMPLEMENTED), the gate for f16 is **deferred to the eval's WebGPU parity phase** and the manifest records `parity.ep: "webgpu-pending"`; the fp32 fast gate above still has to pass.

- [ ] **Step 3: Ship set.** Variant `("f16", f16, True)` goes first in `variants` when `--fast`; `von.json` gains `"inputs": "fast", "padTokenId": pad_id, "headDim": 64, "rope": {"full": 160000.0, "sliding": 10000.0}, "buckets": BUCKETS`; the manifest's `parity` gains `refitTemperature`. `drop_onnx` keeps only the shipped file as before.

- [ ] **Step 4: Run** `uv run scripts/export-von/export.py --fast --checkpoint <data>/act-head/hf/checkpoint --out <data>/act-head/fast` — expected: `[fast] wrapper == reference`, `MultiHeadAttention 28`, `[gate] fast-fp32: PASS max|Δp|<0.001`, `[gate] f16: PASS max|Δp|≤0.03 (T refit …)` or the stated deferral, then a ship set with `model_f16.onnx` and `von-golden.json`. Record the gate line.

- [ ] **Step 5: Commit** — `git commit -m "feat(export-von): --fast — fp16 fast graph with fp32 RoPE/LayerNorm/scorer islands, gated after a temperature refit" -- scripts/export-von/export.py`

---

### Task 5: The worker's fast branch and the kernel profiler

**Files:**
- Modify: `src/system1/protocol.ts` (`init.profile?: boolean`; `DecideResult.kernels?: { name: string; ms: number }[]`)
- Modify: `src/system1/worker.ts`
- Modify: `src/system1/engine.ts` only if the init message type needs the optional field (it does not set it)

- [ ] **Step 1: Worker feeds.** In `scoreQuestion`, after `plan`:

```ts
  const feeds: Record<string, ort.Tensor> = cfg!.inputs === 'fast' ? fastFeeds(ids, plan) : legacyFeeds(ids, plan)
  const out = await session!.run(feeds)
```
with

```ts
function fastFeeds(ids: number[], plan: SequencePlan): Record<string, ort.Tensor> {
  const c = cfg!
  const f = buildFastInputs(ids, plan, { padTokenId: c.padTokenId!, slidingWindow: c.slidingWindow, headDim: c.headDim ?? 64, rope: c.rope ?? { full: 160000, sliding: 10000 } })
  const T = f.T
  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(f.ids, (x) => BigInt(x)), [1, T]),
    cos_full: new ort.Tensor('float32', f.cosFull, [T, 64]),
    sin_full: new ort.Tensor('float32', f.sinFull, [T, 64]),
    cos_sliding: new ort.Tensor('float32', f.cosSliding, [T, 64]),
    sin_sliding: new ort.Tensor('float32', f.sinSliding, [T, 64]),
    bias_full: new ort.Tensor('float32', f.biasFull, [1, 1, T, T]),
    bias_sliding: new ort.Tensor('float32', f.biasSliding, [1, 1, T, T]),
    marker_positions: new ort.Tensor('int64', BigInt64Array.from(plan.markers, (x) => BigInt(x)), [plan.markers.length]),
  }
}
```
(`legacyFeeds` is today's four tensors, lifted out unchanged.) The `too-long` check moves before the bucket: `planSequence` already throws past `maxTokens`; `bucketFor` throws past the last bucket.

- [ ] **Step 2: Profiler.** On `init` with `profile: true`: `ort.env.webgpu.profiling = { mode: 'default', ondata: (d) => kernels.push({ name: d.kernelName ?? d.kernelType ?? String(d.name), ms: (d.endTime - d.startTime) / 1e6 }) }` before `InferenceSession.create`; `kernels` is reset at the start of each `decide` and attached to the `DecideResult` as `kernels` when profiling is on. ORT's record shape is `{kernelName, kernelType, startTime, endTime}` (nanoseconds) — if a field is missing the entry is kept with the name `unknown` so nothing is silently dropped.

- [ ] **Step 3: Typecheck + unit tests** — `npm run typecheck`; `npx vitest run src/system1` green (the worker has no unit test; the fast path is exercised by the eval's parity phase).
- [ ] **Step 4: Commit** — `git commit -m "feat(system1): worker fast-graph feeds (bucketed ids, RoPE tables, option biases) and an opt-in WebGPU kernel profiler" -- src/system1/worker.ts src/system1/protocol.ts`

---

### Task 6: The eval — manifest-driven f16, a kernels phase, latency per K

**Files:**
- Modify: `scripts/system1-eval/harness.ts` (`boot(wasmPath, modelPath, requiresShaderF16 = false, profile = false)`)
- Modify: `scripts/system1-eval/run.mjs` (read `requiresShaderF16` from `MODEL_DIR/manifest.json`; new phase `kernels`)
- Modify: `scripts/system1-eval/README.md` (phase doc + results section)

- [ ] **Step 1: Pass the manifest through.** Where `run.mjs` picks the model file from the manifest, also read `requiresShaderF16` and pass it as the third `boot` argument. Verify with the current q8 export that boot still works (`EVAL_PHASES=parity`).

- [ ] **Step 2: `kernels` phase.** Boots a second lab page with `profile: true`, runs the golden cases plus one synthetic 47-option request (`options: 47 × '[N] link "Item N of the catalogue page" → click'`, state: the golden's longest state) three times each, then aggregates `kernels` by name (sum ms, count) over the last run of each, prints the top 12 by ms with their share of the total, flags `flashAttention: names.some(n => /FlashAttention/i.test(n))` and `cpuFallback: names.some(n => /Memcpy/i.test(n))`, and records per-request `ms` by K. Report block: `{ ep: flashAttention ? 'native' : 'unknown', kernels: [...], byK: { 2:…, 8:…, 47:… } }`.

- [ ] **Step 3: Baseline then f16.** Build the eval extension as the README describes (`--mode system1-eval` with `VITE_SYSTEM1_PIN` for the local export). Run `EVAL_PHASES=download,parity,kernels` twice: `EVAL_MODEL_DIR=<data>/act-head/onnx` (q8 baseline) and `EVAL_MODEL_DIR=<data>/act-head/fast EVAL_GOLDEN=<data>/act-head/fast/von-golden.json` (f16). Expected: the q8 profile shows Memcpy/CPU kernels and no FlashAttention; the f16 profile shows FlashAttention and fp16 MatMul kernels and no Memcpy; parity max|Δp| ≤ 0.03 on WebGPU for f16; the 47-option request faster by the §2(a) targets. If the f16 profile shows no FlashAttention, stop and diagnose (the EP, the MHA node's input layout) before measuring anything else.

- [ ] **Step 4: Grounding.** `EVAL_PHASES=grounding` on the f16 export: grounding must equal run B's 50/54 within McNemar noise (same weights) and `decide ms p50` is the headline number (target ≤ 250 ms; shop ≤ 450 ms).

- [ ] **Step 5: Record** the two profiles and the latency table in `scripts/system1-eval/README.md` under "Results — 2026-10-02: fast runtime (Plan A)", and the decision on bucketing (keep) and graph capture (only if dispatch overhead dominated the profile — otherwise state it did not).

- [ ] **Step 6: Commit** — `git commit -m "feat(system1-eval): kernels phase — per-kernel WebGPU profile and latency by option count; manifest-driven shader-f16" -- scripts/system1-eval/harness.ts scripts/system1-eval/run.mjs scripts/system1-eval/README.md`

---

### Task 7: Docs, invariant, memory, merge

**Files:**
- Modify: `scripts/export-von/README.md` (the `f16`/fast variant row, the inputs, the islands, the gate rule)
- Modify: `CLAUDE.md` (one invariant: the fast graph's inputs are built by a tested twin; the golden fixture is the drift guard; `requiresShaderF16` must be honoured end to end)
- Memory: update `von-model-methods-research.md` with the measured numbers and what ships.

- [ ] **Step 1: Write the docs** with the measured numbers.
- [ ] **Step 2: Commit, review (fresh-context reviewer on the branch), fix pass, merge** `--ff-only` to main from the main checkout, remove the worktree.
- [ ] **Step 3: Publishing** the f16 export to `ks-ang/von-browser-act` and re-pinning `weightsManifest.ts` is an outward action: **ask the user** with the numbers in hand; do not upload without an explicit yes.
