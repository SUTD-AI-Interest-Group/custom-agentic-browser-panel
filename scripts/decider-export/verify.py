"""Check a built model folder against the checkpoint's golden vectors.

    python verify.py --out <output dir> [--ckpt <checkpoint snapshot dir>] [--rows 60]

The embeddings are rebuilt FROM embed.bin / ple.bin (the same dequant the browser does), the
torso runs under ORT CPU, and probabilities are softmax(tanh(z/30)*30/1.5456) over each
question's own k codes. Asserts max|dp| <= 0.05 and zero argmax flips, and re-checks every
manifest chunk hash. --ckpt defaults to the Hugging Face cache snapshot named by the manifest.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys

import numpy as np
import onnxruntime as ort

MAX_DP = 0.05


def open_table(path: str, blocks: int, block: int) -> np.ndarray:
    raw = np.memmap(path, dtype=np.uint8, mode="r")
    return raw.reshape(-1, blocks, 4 + block)


def lookup(tab: np.ndarray, ids: np.ndarray) -> np.ndarray:
    rows = np.ascontiguousarray(tab[ids])  # [T, nb, 4+block]
    scale = np.ascontiguousarray(rows[:, :, :4]).view("<f4")  # [T, nb, 1]
    q = rows[:, :, 4:].view(np.int8).astype(np.float32)
    return (q * scale).reshape(len(ids), -1)


def pack(state_ids, questions):
    s = len(state_ids)
    ids, pos, seg, gidx = list(state_ids), list(range(s)), [0] * s, []
    for k, q in enumerate(questions, start=1):
        ids += q
        pos += list(range(s, s + len(q)))
        seg += [k] * len(q)
        gidx.append(len(ids) - 1)
    return (
        np.array(ids, dtype=np.int64),
        np.array([pos], dtype=np.int64),
        np.array(seg, dtype=np.int64),
        np.array(gidx, dtype=np.int64),
    )


def probs(z: np.ndarray, temperature: float, softcap: float) -> np.ndarray:
    s = np.tanh(z.astype(np.float64) / softcap) * softcap / temperature
    s -= s.max()
    e = np.exp(s)
    return e / e.sum()


def check_hashes(out: str, manifest: dict) -> None:
    chunk = manifest["chunkBytes"]
    for f in manifest["files"]:
        p = os.path.join(out, f["name"])
        assert os.path.getsize(p) == f["bytes"], f"{f['name']}: size mismatch"
        with open(p, "rb") as fh:
            for i, want in enumerate(f["sha256"]):
                got = hashlib.sha256(fh.read(chunk)).hexdigest()
                assert got == want, f"{f['name']}: chunk {i} hash mismatch"
            assert fh.read(1) == b"", f"{f['name']}: more data than the manifest lists"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--ckpt", default=None)
    ap.add_argument("--rows", type=int, default=60)
    a = ap.parse_args()
    out = a.out
    m = json.load(open(os.path.join(out, "manifest.json")))
    ckpt = a.ckpt or glob.glob(
        os.path.expanduser(f"~/.cache/huggingface/hub/models--StrandsAgents--{m['modelId']}/snapshots/{m['revision']}")
    )[0]
    block = m["tables"]["blockSize"]
    embed = open_table(os.path.join(out, m["tables"]["embed"]["file"]), m["tables"]["embed"]["blocks"], block)
    ple = open_table(os.path.join(out, m["tables"]["ple"]["file"]), m["tables"]["ple"]["blocks"], block)
    assert embed.shape[0] == m["vocab"] and ple.shape[0] == m["vocab"], "table row count != vocab"

    rows = []
    with open(os.path.join(ckpt, "golden_vectors.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            if not r["images"] and len(r["state_ids"]) <= 3000:
                rows.append(r)
                if len(rows) == a.rows:
                    break

    sess = ort.InferenceSession(os.path.join(out, "torso.onnx"), providers=["CPUExecutionProvider"])
    worst, flips, nq = 0.0, 0, 0
    for r in rows:
        names = list(r["questions"])
        ids, pos, seg, gidx = pack(r["state_ids"], [r["questions"][n]["question_ids"] for n in names])
        e = lookup(embed, ids)[None]
        p = lookup(ple, ids).reshape(1, len(ids), m["layers"], m["pleDim"])
        (logits,) = sess.run(
            ["logits"],
            {"inputs_embeds": e, "per_layer_raw": p, "position_ids": pos, "segment_ids": seg, "gather_idx": gidx},
        )
        for i, n in enumerate(names):
            g = np.array(r["questions"][n]["probabilities"], dtype=np.float64)
            ours = probs(logits[i][: len(g)], m["temperature"], m["softcap"])
            worst = max(worst, float(np.abs(ours - g).max()))
            flips += int(ours.argmax() != g.argmax())
            nq += 1

    check_hashes(out, m)
    print(
        f"verify: {len(rows)} rows, {nq} questions, max|dp| {worst:.4f} (limit {MAX_DP}), "
        f"flips {flips}, hashes ok"
    )
    if worst > MAX_DP or flips != 0:
        sys.exit("verify: FAILED parity bar")


if __name__ == "__main__":
    main()
