# Von → ONNX (browser)

`uv run scripts/export-von/export.py` exports Von 1.2 (pinned revision) to
`out/`, gates two variants on parity with the fp32 PyTorch reference, ships the
first that passes, and writes `out/manifest.json` plus
`src/system1/__fixtures__/von-golden.json`. `out/` is left holding only the ship set.

Both variants keep every activation fp32, so WebGPU needs no `shader-f16`
(`requiresShaderF16: false`): weights stored fp16 sit behind `Cast(to=float)`,
which ORT's basic constant folding upcasts at session init. `parity` in the
manifest records the shipped variant's gate result (provenance only).

| variant | weights | size | max\|Δp\| (gate ≤ 0.03) |
|---|---|---|---|
| `q8` (primary) | 8-bit block-16 asym on every encoder matmul except attention Wqkv; Wqkv, embeddings, scorer stored fp16 | 616 MB | 0.0236 |
| `fp16w` (fallback) | all large weights stored fp16 | 792 MB | 0.0006 |

q8 passes with a thin margin (0.0236 of 0.03; nearby recipes fail at 0.03–0.06),
and 8-bit on *every* matmul is not parity-faithful (0.056–0.13, argmax flips).
The gate runs on the ORT CPU EP only: Task 9 must verify parity on WebGPU and
re-tune ACT_CONFIDENCE against the shipped variant.

`--ship {q8,fp16w} --accept-drift` ships that variant even if it fails the gate;
the failure is printed and recorded in `parity.gatePassed`.

Publish (maintainer):

    hf repo create <you>/von-onnx-web --type model
    hf upload <you>/von-onnx-web scripts/export-von/out .

Then copy the commit sha from `hf api` / the web UI and the printed manifest
sha256 into `src/system1/weightsManifest.ts`. Never pin `main`.
License: Von is Apache-2.0 — keep its LICENSE/attribution in the HF repo card.
