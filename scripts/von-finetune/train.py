# scripts/von-finetune/train.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "huggingface_hub>=0.30", "numpy",
# ]
# ///
"""Continue-train Von 1.2 on the rendered Act rows (render.mjs → train/val.jsonl).

Mirrors Von's own trainer (training/train_option_marker.py at ca5d608) where it
matters — OptionMarkerModel with independent_options=True, cross-entropy +
0.5·Brier against the (optionally soft) target — but also runs on Apple MPS,
which Von's trainer does not (it picks cuda or cpu). Packing is Von's
pack_sequence, which the TS worker's packPrompt mirrors (golden-tested), so a
row trains on exactly the tokens the browser will score.

Writes OUT/ (default data/ckpt/) in the layout scripts/export-von/export.py
--checkpoint loads: option_marker.pt, marker_calibration.json (temperature
refit on val), and the base config/tokenizer/encoder files it builds from.

    uv run scripts/von-finetune/train.py --epochs 2               # auto device (mps here)
    uv run scripts/von-finetune/train.py --eval-only              # base-model numbers only
"""
import argparse, json, math, os, random, shutil, sys, time
from collections import defaultdict
import numpy as np
import torch
from huggingface_hub import hf_hub_download
from von.models.option_marker import OptionMarkerModel

REPO = "wfzyx/von"
REVISION = "5df8185a4f2327ad0a7cd117cc4f701ac557b9ae"  # same pin as scripts/export-von/export.py
HERE = os.path.dirname(os.path.abspath(__file__))
ACT_CONFIDENCE = 0.6  # src/system1/actLoop.ts
MAX_TOKENS = 4096     # von.json maxTokens (the browser rejects longer inputs)
BASE_FILES = ["config.json", "model.safetensors", "option_marker.pt", "tokenizer.json",
              "tokenizer_config.json", "marker_calibration.json"]


def pick_device(name):
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_base():
    paths = {f: hf_hub_download(REPO, f, revision=REVISION) for f in BASE_FILES}
    base_dir = os.path.dirname(paths["config.json"])
    calib = json.load(open(paths["marker_calibration.json"]))
    assert calib.get("independent_options") is True, "expects Von >= 1.2"
    model = OptionMarkerModel(base_model_id=base_dir, digit_split=bool(calib.get("digit_split", False)))
    model.load_state_dict(torch.load(paths["option_marker.pt"], map_location="cpu", weights_only=True), strict=True)
    return model, calib, paths


def calibrate(logits, state_tokens, calib):
    """Von's input-conditioned temperature (== von.ts calibrate)."""
    logits = np.asarray(logits, dtype=np.float64)
    sm = lambda x: (lambda e: e / e.sum())(np.exp(x - x.max()))
    m = calib.get("calibration_map")
    if m:
        p = sm(logits); n = len(p)
        ent = float(-(p * np.log(np.clip(p, 1e-12, None))).sum() / math.log(n)) if n > 1 else 0.0
        raw = (m.get("bias", 0) + m.get("entropy", 0) * ent + m.get("log_tokens", 0) * (math.log10(max(state_tokens, 1)) / 4.0)
               + m.get("n_options", 0) * (n / 8.0))
        t = min(m.get("hi", 12.0), max(m.get("lo", 0.5), raw))
    else:
        t = float(calib.get("temperature", 1.0))
    return sm(logits / max(t, 1e-4))


def encode(model, rows, tag):
    """Tokenize every row once; drop what the browser could never score."""
    tok = model.tokenizer
    out, dropped = [], defaultdict(int)
    for r in rows:
        opts = r["options"]
        ids_opt = [o["id"] for o in opts]
        if r["label"] not in ids_opt:
            dropped["label-not-an-option"] += 1; continue
        packed = model.pack_sequence(r["state"], r["question"], [o["description"] for o in opts])
        ids = tok(packed)["input_ids"]
        if len(ids) > MAX_TOKENS:
            dropped["too-long"] += 1; continue
        marks = [i for i, t in enumerate(ids) if t == model.mask_token_id]
        if len(marks) != len(opts):
            dropped["mask-count"] += 1; continue
        soft = r.get("target") if isinstance(r.get("target"), list) and len(r["target"]) == len(opts) else None
        out.append({"ids": ids, "marks": marks, "label": ids_opt.index(r["label"]), "soft": soft,
                    "stateTokens": len(tok.encode(r["state"], add_special_tokens=False)),
                    "kind": r.get("meta", {}).get("kind", "?"), "move": r.get("meta", {}).get("move"),
                    "round": r.get("meta", {}).get("round")})
    print(f"[data] {tag}: {len(out)} rows kept, dropped {dict(dropped) or 0}", flush=True)
    return out


def batches(rows, budget, shuffle, seed):
    """Token-budget batches over length-sorted buckets (padding is cheap, OOM is not)."""
    idx = sorted(range(len(rows)), key=lambda i: len(rows[i]["ids"]))
    out, cur, cur_max = [], [], 0
    for i in idx:
        n = len(rows[i]["ids"])
        if cur and max(cur_max, n) * (len(cur) + 1) > budget:
            out.append(cur); cur, cur_max = [], 0
        cur.append(i); cur_max = max(cur_max, n)
    if cur:
        out.append(cur)
    if shuffle:
        random.Random(seed).shuffle(out)
    return out


def collate(rows, pad_id, dev):
    T = max(len(r["ids"]) for r in rows)
    ids = torch.full((len(rows), T), pad_id, dtype=torch.long)
    am = torch.zeros((len(rows), T), dtype=torch.long)
    for b, r in enumerate(rows):
        ids[b, :len(r["ids"])] = torch.tensor(r["ids"]); am[b, :len(r["ids"])] = 1
    return ids.to(dev), am.to(dev), [r["marks"] for r in rows]


def loss_fn(batch_logits, rows, brier_weight):
    """Von's compute_marker_rlcd_loss: CE + w·Brier, against a soft target when given."""
    ce, br = [], []
    for logits, r in zip(batch_logits, rows):
        logits = logits.float()
        if r["soft"] is not None:
            dist = torch.tensor(r["soft"], dtype=logits.dtype, device=logits.device); dist = dist / dist.sum()
        else:
            dist = torch.zeros_like(logits); dist[r["label"]] = 1.0
        logp = torch.log_softmax(logits, -1)
        ce.append(-(dist * logp).sum())
        br.append(((logp.exp() - dist) ** 2).sum())
    return torch.stack(ce).mean() + brier_weight * torch.stack(br).mean()


@torch.no_grad()
def infer(model, rows, dev, budget, bf16):
    model.eval()
    logits = [None] * len(rows)
    for b in batches(rows, budget, False, 0):
        ids, am, marks = collate([rows[i] for i in b], model.tokenizer.pad_token_id, dev)
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=bf16):
            out = model(input_ids=ids, attention_mask=am, mask_positions=marks, independent_options=True)
        for i, l in zip(b, out):
            logits[i] = l.float().cpu().numpy()
    model.train()
    return logits


def fit_temperature(logits, rows):
    """Scalar T minimising val NLL (grid, then refine) — Von's calibration map was fit on its own corpus."""
    def nll(t):
        s = 0.0
        for l, r in zip(logits, rows):
            z = l / t; z = z - z.max(); s -= z[r["label"]] - math.log(np.exp(z).sum())
        return s / len(rows)
    grid = np.exp(np.linspace(math.log(0.2), math.log(8), 60))
    best = min(grid, key=nll)
    fine = np.linspace(best * 0.85, best * 1.15, 31)
    return float(min(fine, key=nll))


def report(logits, rows, calib):
    """Top-1 by question kind, and what the ACT_CONFIDENCE gate lets through."""
    groups = defaultdict(list)
    for l, r in zip(logits, rows):
        p = calibrate(l, r["stateTokens"], calib)
        key = r["kind"] if r["kind"] != "target" else f"target:{r['round']}"
        rec = (int(np.argmax(p)) == r["label"], float(p.max()))
        groups[key].append(rec); groups["all"].append(rec)
        if r["kind"] == "move":
            groups[f"move:{r['move']}"].append(rec)
    out = {}
    for k, recs in sorted(groups.items()):
        n = len(recs)
        gated = [ok for ok, top in recs if top >= ACT_CONFIDENCE]
        out[k] = {"n": n, "acc": round(sum(ok for ok, _ in recs) / n, 4),
                  "coverage@0.6": round(len(gated) / n, 4),
                  "acc@0.6": round(sum(gated) / len(gated), 4) if gated else None}
    return out


def save(model, calib, base_paths, out_dir, extra):
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "option_marker.pt.tmp")
    torch.save({k: v.detach().cpu() for k, v in model.state_dict().items()}, tmp)
    os.replace(tmp, os.path.join(out_dir, "option_marker.pt"))
    for f in ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"]:
        dst = os.path.join(out_dir, f)
        if not os.path.exists(dst):
            shutil.copyfile(base_paths[f], dst)
    with open(os.path.join(out_dir, "marker_calibration.json"), "w") as f:
        json.dump(calib, f, indent=2)
    with open(os.path.join(out_dir, "train_meta.json"), "w") as f:
        json.dump(extra, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--out", default=None, help="default: DATA/ckpt")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-5, help="continue-training: small, the base already knows a lot")
    ap.add_argument("--head-lr", type=float, default=5e-5)
    ap.add_argument("--brier-weight", type=float, default=0.5)
    ap.add_argument("--tokens-per-batch", type=int, default=0, help="0 = 4096 on mps, 16384 on cuda")
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--warmup", type=float, default=0.05)
    ap.add_argument("--eval-every", type=int, default=250, help="optimizer steps")
    ap.add_argument("--grad-checkpointing", action="store_true", help="~11 GB peak at T=4096 on mps instead of ~47 GB")
    ap.add_argument("--bf16", action="store_true", help="bf16 autocast (recommended on cuda)")
    ap.add_argument("--eval-only", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    random.seed(args.seed); torch.manual_seed(args.seed)
    dev = pick_device(args.device)
    out_dir = args.out or os.path.join(args.data, "ckpt")
    budget = args.tokens_per_batch or (16384 if dev.type == "cuda" else 4096)
    model, base_calib, base_paths = load_base()
    model.to(dev).train()
    if args.grad_checkpointing:
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    read = lambda f: [json.loads(l) for l in open(os.path.join(args.data, f)) if l.strip()]
    train_rows = [] if args.eval_only else encode(model, read("train.jsonl"), "train")
    val_rows = encode(model, read("val.jsonl"), "val")
    print(f"[run] device={dev} tokens/batch={budget} accum={args.grad_accum} ckpt={args.grad_checkpointing} bf16={args.bf16}", flush=True)

    t0 = time.time()
    base_logits = infer(model, val_rows, dev, budget, args.bf16)
    history = [{"step": 0, "val": report(base_logits, val_rows, base_calib)}]
    print(f"[eval] base ({time.time() - t0:.0f}s): {json.dumps(history[0]['val']['all'])}", flush=True)
    for k, v in history[0]["val"].items():
        print(f"         {k:18s} {v}")
    if args.eval_only:
        return

    head = [p for n, p in model.named_parameters() if n.startswith("scorer.")]
    body = [p for n, p in model.named_parameters() if not n.startswith("scorer.")]
    opt = torch.optim.AdamW([{"params": body, "lr": args.lr}, {"params": head, "lr": args.head_lr}], weight_decay=0.01)
    per_epoch = len(batches(train_rows, budget, False, 0))
    total = max(1, int(per_epoch * args.epochs / args.grad_accum))
    warm = max(1, int(total * args.warmup))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    print(f"[run] {len(train_rows)} rows → {per_epoch} micro-batches/epoch → {total} optimizer steps", flush=True)

    step, micro, seen_tokens, best = 0, 0, 0, None
    epoch = 0
    t_train = time.time()
    while step < total:
        for b in batches(train_rows, budget, True, args.seed + epoch):
            rows = [train_rows[i] for i in b]
            ids, am, marks = collate(rows, model.tokenizer.pad_token_id, dev)
            with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=args.bf16):
                out = model(input_ids=ids, attention_mask=am, mask_positions=marks, independent_options=True)
            loss = loss_fn(out, rows, args.brier_weight) / args.grad_accum
            loss.backward()
            micro += 1; seen_tokens += int(am.sum())
            if micro % args.grad_accum:
                continue
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
            if step % 25 == 0:
                el = time.time() - t_train
                print(f"[train] step {step}/{total} loss {loss.item() * args.grad_accum:.4f} · {seen_tokens / el:.0f} tok/s · eta {el / step * (total - step) / 60:.0f} min", flush=True)
            if step % args.eval_every == 0 or step == total:
                logits = infer(model, val_rows, dev, budget, args.bf16)
                t = fit_temperature(logits, val_rows)
                calib = dict(base_calib, calibration_map=None, temperature=t)
                rep = report(logits, val_rows, calib)
                history.append({"step": step, "temperature": t, "val": rep})
                print(f"[eval] step {step}: T={t:.3f} {json.dumps(rep['all'])}", flush=True)
                if best is None or rep["all"]["acc"] > best:
                    best = rep["all"]["acc"]
                    save(model, calib, base_paths, out_dir, {"step": step, "args": vars(args), "history": history,
                         "source": {"repo": REPO, "revision": REVISION}})
                    print(f"[save] best so far → {out_dir}", flush=True)
            if step >= total:
                break
        epoch += 1
    with open(os.path.join(out_dir, "history.json"), "w") as f:
        json.dump(history, f, indent=2)
    print(f"[done] best val acc {best} · {(time.time() - t_train) / 60:.1f} min · {out_dir}")


if __name__ == "__main__":
    main()
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0)
