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
| `q8` (primary) | 8-bit block-16 asym on the 84 attn-Wo/MLP matmuls (28 layers × 3); Wqkv, embeddings, scorer stored fp16 | 616 MB | ~0.9 GB | 0.0236 |
| `fp16w` (fallback) | all large weights stored fp16 | 792 MB | ~1.6 GB | 0.0006 |

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
the failure is printed and recorded in `parity.gatePassed`.

Publish (maintainer):

    hf repo create <you>/von-onnx-web --type model
    hf upload <you>/von-onnx-web scripts/export-von/out . --exclude "von_*.onnx"

(The exporter already deletes its `von_*` intermediates; the exclude is a belt.)

Then copy the commit sha from `hf api` / the web UI and the printed manifest
sha256 into `src/system1/weightsManifest.ts`. Never pin `main`.
License: Von is Apache-2.0 — keep its LICENSE/attribution in the HF repo card.
