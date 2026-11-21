"""Build the decider model files the extension imports into OPFS.

    python build.py --ckpt <checkpoint snapshot dir> --out <output dir> [--work <scratch dir>]

Steps (run sequentially; the fp32 load is ~20 GB of RAM and the fp32 ONNX ~7.5 GB on disk):
  1. fp32 torch -> ONNX (dynamo, T 4..32768, Q 1..64) in a scratch dir
  2. quantize the torso to 8-bit MatMulNBits (block 32, symmetric); the readout MatMul stays fp32
  3. write embed.bin / ple.bin (block-int8, block 256, rows pre-multiplied by the embed scale)
  4. copy the tokenizer, write selftest.json and manifest.json (64 MiB chunk sha256s)
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np

MODEL_ID = "strands-decider-E2B-gemma4-v2-2611"
TEMPERATURE = 1.5456
SOFTCAP = 30.0
MAX_LENGTH = 32768
CHUNK_BYTES = 64 * 1024 * 1024
BLOCK = 256
SELFTEST_ROWS = 5
SELFTEST_MAX_STATE = 3000


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- tables


def quantize_rows(w: np.ndarray) -> np.ndarray:
    """[R, D] f32 -> [R, D/BLOCK*(4+BLOCK)] u8. Per block: LE f32 scale, then BLOCK int8."""
    r, d = w.shape
    assert d % BLOCK == 0
    nb = d // BLOCK
    blocks = w.reshape(r, nb, BLOCK)
    scale = np.abs(blocks).max(axis=2) / np.float32(127.0)  # [R, nb] f32
    safe = np.where(scale == 0, np.float32(1.0), scale)
    q = np.clip(np.rint(blocks / safe[:, :, None]), -127, 127).astype(np.int8)  # rint = half-even
    out = np.empty((r, nb, 4 + BLOCK), dtype=np.uint8)
    out[:, :, :4] = np.ascontiguousarray(scale.astype("<f4")).view(np.uint8).reshape(r, nb, 4)
    out[:, :, 4:] = q.view(np.uint8)
    return out.reshape(r, nb * (4 + BLOCK))


def write_table(path: str, weight, scale: float, rows_per_chunk: int = 2048) -> None:
    import torch

    n = weight.shape[0]
    s = torch.tensor(scale, dtype=torch.float32)
    with open(path, "wb") as f:
        for lo in range(0, n, rows_per_chunk):
            chunk = (weight[lo : lo + rows_per_chunk].to(torch.float32) * s).numpy()
            f.write(quantize_rows(np.ascontiguousarray(chunk)).tobytes())


# ---------------------------------------------------------------- export + quantize


def export_fp32(ckpt: str, fp32_dir: str, tables_dir: str) -> dict:
    import torch

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from torso import Torso, embed, load, pack

    torch.set_grad_enabled(False)
    log("loading fp32 model")
    text, readout = load(ckpt, torch.float32)
    meta = {
        "hidden": int(text.config.hidden_size),
        "layers": int(text.config.num_hidden_layers),
        "pleDim": int(text.config.hidden_size_per_layer_input),
        "vocab": int(text.config.vocab_size),
    }
    log(f"model dims {meta}")

    log("writing embed.bin / ple.bin")
    write_table(
        os.path.join(tables_dir, "embed.bin"),
        text.embed_tokens.weight,
        float(text.embed_tokens.scalar_embed_scale),
    )
    write_table(
        os.path.join(tables_dir, "ple.bin"),
        text.embed_tokens_per_layer.weight,
        float(text.embed_tokens_per_layer.scalar_embed_scale),
    )

    model = Torso(text, readout).eval()
    # Two questions so the exporter sees Q > 1 and T != Q.
    ids, pos, seg, gidx = pack(list(range(1000, 1040)), [list(range(2000, 2010)), list(range(3000, 3007))])
    e, p = embed(text, ids)
    T = torch.export.Dim("T", min=4, max=MAX_LENGTH)
    Q = torch.export.Dim("Q", min=1, max=64)
    log("torch.onnx.export (dynamo)")
    prog = torch.onnx.export(
        model,
        (e, p, pos, seg, gidx),
        dynamo=True,
        input_names=["inputs_embeds", "per_layer_raw", "position_ids", "segment_ids", "gather_idx"],
        output_names=["logits"],
        dynamic_shapes={
            "inputs_embeds": {1: T},
            "per_layer_raw": {1: T},
            "position_ids": {1: T},
            "segment_ids": {0: T},
            "gather_idx": {0: Q},
        },
        optimize=True,
    )
    prog.save(os.path.join(fp32_dir, "torso.onnx"), external_data=True)
    del prog, model, text, readout, e, p
    gc.collect()
    return meta


def quantize_q8(fp32_dir: str, out_dir: str) -> None:
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import (
        DefaultWeightOnlyQuantConfig,
        MatMulNBitsQuantizer,
    )

    model = onnx.load(os.path.join(fp32_dir, "torso.onnx"), load_external_data=True)
    inits = {i.name: i for i in model.graph.initializer}
    exclude = [
        n.name
        for n in model.graph.node
        if n.op_type == "MatMul"
        and len(n.input) > 1
        and n.input[1] in inits
        and list(inits[n.input[1]].dims)[-1] == 255
    ]
    if len(exclude) != 1:
        raise SystemExit(f"expected exactly one readout MatMul (last dim 255), found {exclude}")
    log(f"readout kept full precision: {exclude}")
    # accuracy_level=1 keeps CPU math in fp32, so verify.py measures the weights, not int8 activations.
    cfg = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, accuracy_level=1, bits=8)
    q = MatMulNBitsQuantizer(
        model, bits=8, block_size=32, is_symmetric=True, accuracy_level=1,
        nodes_to_exclude=exclude, algo_config=cfg,
    )
    q.process()
    onnx.save_model(
        q.model.model,
        os.path.join(out_dir, "torso.onnx"),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="torso.onnx.data",
        size_threshold=1024,
    )


# ---------------------------------------------------------------- manifest


def sha256_chunks(path: str) -> list[str]:
    digests = []
    with open(path, "rb") as f:
        while True:
            buf = f.read(CHUNK_BYTES)
            if not buf:
                break
            digests.append(hashlib.sha256(buf).hexdigest())
    return digests


def golden_rows(ckpt: str, n: int, max_state: int) -> list[dict]:
    rows = []
    with open(os.path.join(ckpt, "golden_vectors.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            if not r["images"] and len(r["state_ids"]) <= max_state:
                rows.append(r)
                if len(rows) == n:
                    break
    return rows


def write_selftest_and_manifest(ckpt: str, out: str, meta: dict) -> None:
    from strands_decider.core import CODE_TOKEN_IDS, CONTROL_TOKEN_IDS

    for name in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copyfile(os.path.join(ckpt, name), os.path.join(out, name))

    rows = golden_rows(ckpt, SELFTEST_ROWS, SELFTEST_MAX_STATE)
    selftest = [
        {"request": r["request"], "expected": {n: q["probabilities"] for n, q in r["questions"].items()}}
        for r in rows
    ]
    with open(os.path.join(out, "selftest.json"), "w") as f:
        json.dump(selftest, f)

    revision = os.path.basename(os.path.realpath(ckpt))
    names = [
        "torso.onnx", "torso.onnx.data", "embed.bin", "ple.bin",
        "tokenizer.json", "tokenizer_config.json", "selftest.json",
    ]
    files = []
    for n in names:
        p = os.path.join(out, n)
        log(f"hashing {n}")
        files.append({"name": n, "bytes": os.path.getsize(p), "sha256": sha256_chunks(p)})
    manifest = {
        "format": 1,
        "modelId": MODEL_ID,
        "revision": revision,
        "hidden": meta["hidden"],
        "layers": meta["layers"],
        "pleDim": meta["pleDim"],
        "vocab": meta["vocab"],
        "temperature": TEMPERATURE,
        "softcap": SOFTCAP,
        "maxLength": MAX_LENGTH,
        "controlTokenIds": dict(CONTROL_TOKEN_IDS),
        "codeTokenIds": list(CODE_TOKEN_IDS),
        "tables": {
            "blockSize": BLOCK,
            "embed": {"file": "embed.bin", "blocks": meta["hidden"] // BLOCK},
            "ple": {"file": "ple.bin", "blocks": meta["layers"] * meta["pleDim"] // BLOCK},
        },
        "chunkBytes": CHUNK_BYTES,
        "files": files,
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", default=None, help="scratch dir for the fp32 intermediate (~7.5 GB)")
    a = ap.parse_args()
    ckpt, out = os.path.realpath(a.ckpt), os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    work = tempfile.mkdtemp(prefix="decider-fp32-", dir=a.work)
    t0 = time.time()
    try:
        meta = export_fp32(ckpt, work, out)
        log("quantizing torso to 8-bit")
        quantize_q8(work, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    write_selftest_and_manifest(ckpt, out, meta)
    log(f"done in {time.time() - t0:.0f}s -> {out}")


if __name__ == "__main__":
    main()
