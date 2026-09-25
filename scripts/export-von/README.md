# Von → ONNX (browser)

`uv run scripts/export-von/export.py` exports Von 1.2 (pinned revision) to
`out/`, gates q4 then fp16 on parity with the PyTorch reference, and writes
`out/manifest.json` plus `src/system1/__fixtures__/von-golden.json`.

Publish (maintainer):

    hf repo create <you>/von-onnx-web --type model
    hf upload <you>/von-onnx-web scripts/export-von/out . --exclude "von_*.onnx"

Then copy the commit sha from `hf api` / the web UI and the printed manifest
sha256 into `src/system1/weightsManifest.ts`. Never pin `main`.
License: Von is Apache-2.0 — keep its LICENSE/attribution in the HF repo card.
