# Von → ONNX (browser)

`uv run scripts/export-von/export.py` exports Von 1.2 (pinned revision) to
`out/`, gates q8 (fp32 activations, no WebGPU shader-f16) then fp16 on parity with the PyTorch reference, and writes
`out/manifest.json` plus `src/system1/__fixtures__/von-golden.json`. The manifest's
`requiresShaderF16` is true only when the shipped graph has fp16 activations, and
`parity` records the shipped variant's gate result (provenance only).

q8 = 8-bit (block 16, asymmetric) weights on every encoder matmul except attention
Wqkv, which with the embeddings and scorer is stored fp16 and upcast at load; all
activations are fp32. Measured max|Δp| 0.0236 vs the fp32 reference (gate 0.03), so
it passes, with little margin; still re-tune ACT_CONFIDENCE against it (Task 9's eval).
8-bit on *every* matmul is not parity-faithful (max|Δp| 0.056–0.13, argmax flips).

`--ship {q8,fp16} --accept-drift` ships that variant even if it fails the gate; the
failure is printed and recorded in `parity.gatePassed`.

Publish (maintainer):

    hf repo create <you>/von-onnx-web --type model
    hf upload <you>/von-onnx-web scripts/export-von/out . --exclude "von_*.onnx"

Then copy the commit sha from `hf api` / the web UI and the printed manifest
sha256 into `src/system1/weightsManifest.ts`. Never pin `main`.
License: Von is Apache-2.0 — keep its LICENSE/attribution in the HF repo card.
