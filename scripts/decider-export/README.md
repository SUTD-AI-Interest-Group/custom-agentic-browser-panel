# decider-export

Builds the model files for the on-device decision model
`StrandsAgents/strands-decider-E2B-gemma4-v2-2611` (design: `docs/superpowers/specs/2026-11-21-decider-harness-design.md`, section 5).
The extension imports the result into OPFS (Settings, Experimental, Decision model). Model files
are never committed.

## Prerequisites

- Python 3.12, about 25 GB of free RAM for the fp32 load, about 15 GB of free disk (7.5 GB scratch
  plus about 5 GB of output).
- The checkpoint downloaded locally, for example
  `hf download StrandsAgents/strands-decider-E2B-gemma4-v2-2611`. Below, `CKPT` is its snapshot
  directory (`~/.cache/huggingface/hub/models--StrandsAgents--strands-decider-E2B-gemma4-v2-2611/snapshots/<rev>`).
- A venv (the `strands_decider` wheel in the snapshot supplies the control and code token ids):

```
python3.12 -m venv scripts/decider-export/.venv
. scripts/decider-export/.venv/bin/activate
pip install -r scripts/decider-export/requirements.txt
pip install "$CKPT"/strands_decider-*.whl
```

## Run

```
python scripts/decider-export/build.py  --ckpt "$CKPT" --out ~/lychee-decider/strands-decider-E2B-gemma4-v2-2611
python scripts/decider-export/verify.py --out ~/lychee-decider/strands-decider-E2B-gemma4-v2-2611 --rows 60
```

`build.py` runs sequentially (export, 8-bit quantize, tables, hashes) and removes its fp32
scratch directory (`--work` picks where it lives). `verify.py` rebuilds embeddings from the
tables, runs the torso under ORT CPU against the checkpoint's golden vectors, checks every
chunk hash, and prints
`verify: 60 rows, 180 questions, max|dp| <=0.05, flips 0, hashes ok` (it exits non-zero if the
parity bar of max|dp| 0.05 and zero argmax flips is missed).

## Output layout

| File | Content |
|---|---|
| `torso.onnx`, `torso.onnx.data` | Packed text decoder plus readout. 8-bit `MatMulNBits`, block 32, symmetric; the readout MatMul (last dim 255) stays fp32. Inputs `inputs_embeds [1,T,1536]`, `per_layer_raw [1,T,35,256]` (f32), `position_ids [1,T]`, `segment_ids [T]`, `gather_idx [Q]` (i64); output `logits [Q,255]`. |
| `embed.bin`, `ple.bin` | Token tables, block-int8 with block size 256. Each block is a little-endian f32 scale followed by 256 int8 values (value = int8 x scale). A main row is 6 blocks, a per-layer row 35 blocks. Rows are pre-multiplied by sqrt(1536) / sqrt(256) in fp32. |
| `tokenizer.json`, `tokenizer_config.json` | Copied from the checkpoint. |
| `selftest.json` | 5 text-only golden rows (`[{request, expected: {name: probs[]}}]`, state at most 3,000 tokens). |
| `manifest.json` | Format version, model id and revision, dims, temperature 1.5456, soft-cap 30, control and code token ids, table layout, and per-file size plus one sha256 per 64 MiB chunk. |

Probabilities for a question with k options: `p = softmax(tanh(z/30) * 30 / 1.5456)` over its
first k logits.

## Importing

Point Settings, Experimental, Decision model, "Import model folder..." at the output directory.
The import streams every file into OPFS under `decider/<modelId>/` and verifies it against
`manifest.json`.
