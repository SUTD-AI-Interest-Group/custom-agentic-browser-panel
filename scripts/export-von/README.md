# Von → ONNX (browser)

`uv run scripts/export-von/export.py` exports Von 1.2 (pinned revision) to
`out/`, gates two variants on parity with the fp32 PyTorch reference, ships the
first that passes, and writes `out/manifest.json` plus
`src/system1/__fixtures__/von-golden.json`. `out/` is left holding only the ship set.

Both variants keep every activation fp32, so WebGPU needs no `shader-f16`:
weights stored fp16 sit behind `Cast(to=float)`, which ORT's basic constant
folding upcasts at session init. `requiresShaderF16` is derived from the saved
graph (shape inference plus a scan for fp16 Casts and directly-consumed fp16
initializers); the run fails if either variant computes an fp16 tensor. `parity` in
the manifest records the shipped variant's gate result and the EP it was measured
on (`ep: "cpu"`; provenance only). `--out DIR` writes somewhere other than `out/`.

| variant | weights | download | device memory (est.) | max\|Δp\| (gate ≤ 0.03) |
|---|---|---|---|---|
| `f16` (`--fast`, 2026-10-02) | the **fast graph** (`fast.py`): fp16 activations and fp16-stored weights, with fp32 islands at every LayerNorm, the final norm and the scorer; RoPE tables and the two option masks are graph INPUTS, attention is one `com.microsoft.MultiHeadAttention` node per layer | 792 MB | ~1.0 GB (fp16 activations) | CPU 0.0035 after a scalar temperature refit (1.389→1.389); WebGPU 0.0264, 0 flips |
| `q8` (the published pin) | 8-bit block-16 asym on the 84 attn-Wo/MLP matmuls (28 layers × 3); Wqkv, embeddings, scorer stored fp16 | 616 MB | ~0.9 GB | 0.0236 |
| `fp16w` (fallback) | all large weights stored fp16 | 792 MB | ~1.6 GB | 0.0006 |

**Why the fast graph exists.** Measured 2026-09-30 on the q8 graph: p50 400 ms
per decision, 817 ms on a 47-option page, 540 of 1,909 nodes on ORT's implicit
CPU EP with a GPU↔CPU sync inside every layer (the RoPE angle and mask
arithmetic). `fast.py` re-expresses ModernBERT so that arithmetic never enters
the graph — the worker computes the four cos/sin tables and the two additive
biases (`src/system1/von.ts` `buildFastInputs`, the twin of `fast_inputs`) and
pads T to a bucket — and attention is one fused node the native WebGPU EP runs
as FlashAttention. Gated the same way (plus the refit): the fp32 fast graph must
first reproduce Von's forward (max|Δp| 0.0000), then the f16 one is judged on
calibrated probabilities. Two export lessons, both pinned by assertions: Von's
`squeeze(-1)` traces to an `If` node (CPU-only, and the fp16 converter types its
branches against the protected scorer, an invalid graph) — the head is spelled
out with a `reshape`; and onnxruntime's fp16 converter leaves a duplicate-named
Cast and an unsorted graph when one tensor feeds two protected nodes —
`sanitize_fp16` repairs both and the ONNX checker runs on the result. Measured
2026-10-02 (eval README): 90 ms per decision at 2–5 options (was 181–308 ms),
320 ms at 47 options (was 854–1,206 ms), same weights.

Device memory: the fp16-stored weights are upcast to fp32 at session init, so on
the GPU they take their fp32 size. For q8 that is ~140M params (Wqkv 88M, embeddings
52M) × 4 B ≈ 560 MB plus ~330 MB of 8-bit weights, scales and zero points; fp16w is
the full fp32 model (~395M params × 4 B). Session init may briefly hold both copies.
Activations come on top and scale with prompt length (T ≤ 4096).

q8 passes with a thin margin (0.0236 of 0.03; nearby recipes fail at 0.03–0.06),
and 8-bit on *every* matmul is not parity-faithful (0.056–0.13, argmax flips).
The gate runs on the ORT CPU EP only: Task 9 must verify parity on WebGPU and
re-tune ACT_CONFIDENCE against the shipped variant.

`--ship {q8,fp16w} --accept-drift` ships that variant even if it fails the gate;
the failure is printed and recorded in `parity.gatePassed`. `--fast` adds the
`f16` variant first in line (`uv run scripts/export-von/export.py --fast
--checkpoint <dir> --out <dir>`); its `von.json` carries `inputs: "fast"`,
`padTokenId`, `headDim`, the two RoPE thetas and the T buckets, and its manifest
`requiresShaderF16: true` — the worker refuses to boot it on a device without
the feature, and the eval harness passes the flag through from the manifest.
When the CPU EP cannot run an f16 contrib kernel the gate is deferred to the
eval's WebGPU parity phase and the manifest says so (`parity.ep:
"webgpu-pending"`); on this machine it runs, so the manifest carries both.

Publish (maintainer):

    hf repo create <you>/von-onnx-web --type model
    hf upload <you>/von-onnx-web scripts/export-von/out . --exclude "von_*.onnx"

(The exporter already deletes its `von_*` intermediates; the exclude is a belt.)

Then copy the commit sha from `hf api` / the web UI and the printed manifest
sha256 into `src/system1/weightsManifest.ts`. Never pin `main`.
License: Von is Apache-2.0 — keep its LICENSE/attribution in the HF repo card.
