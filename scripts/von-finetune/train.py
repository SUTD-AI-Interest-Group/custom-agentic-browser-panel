# scripts/von-finetune/train.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "huggingface_hub>=0.30", "numpy", "wandb>=0.19",
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
    uv run scripts/von-finetune/train.py --epochs 3 --wandb --wandb-project von-finetune   # tracked run
    uv run scripts/von-finetune/train.py --resume                 # continue OUT/last/ after an interruption

Tracking (`--wandb`, optional): the run config (arguments, git commit, dataset
hashes and render stats), per optimizer step the loss, learning rate, gradient
norm and throughput, every validation report row at each eval (per head, per
corpus: accuracy, coverage at the 0.6 gate, accuracy on the covered, the refit
temperature), a best-so-far summary, and at the end the best checkpoint as a
model artifact plus the dataset's lineage (hashes + render stats, not the rows)
as a dataset artifact. The key comes from `wandb login` / WANDB_API_KEY, never
from a file this script writes; WANDB_MODE=offline records locally for a later
`wandb sync`. Without `--wandb` nothing is imported or sent.

Checkpoints: OUT/ always holds the BEST checkpoint (export-ready, as before);
OUT/last/ holds a resumable one every --save-every optimizer steps — model,
optimizer, scheduler, step, the position inside the epoch and the RNG states,
written to a temp dir and renamed, so an interrupted pod (RunPod community
cloud can be preempted) resumes with `--resume` on the same batch order.
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
                    "corpus": r.get("meta", {}).get("corpus", "teacher"),
                    "op": r.get("meta", {}).get("op"), "round": r.get("meta", {}).get("round")})
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
        key = r["kind"] if r["kind"] not in ("target", "act") else f"{r['kind']}:{r['round']}"
        rec = (int(np.argmax(p)) == r["label"], float(p.max()))
        groups[key].append(rec); groups["all"].append(rec)
        groups[f"corpus:{r['corpus']}"].append(rec)
        if r["kind"] == "move":
            groups[f"move:{r['move']}"].append(rec)
        if r["kind"] in ("act", "operation") and r.get("op"):
            groups[f"{r['kind']}:{'element' if r['op'] in ('CLICK', 'TYPE_TEXT', 'SELECT_OPTION') else r['op']}"].append(rec)
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


class Tracker:
    """Weights & Biases when enabled, a no-op otherwise — the training loop never branches on it."""

    def __init__(self, args, config):
        self.run = None
        if not args.wandb:
            return
        import wandb
        self.wandb = wandb
        self.run = wandb.init(project=args.wandb_project, entity=args.wandb_entity or None, name=args.wandb_run_name or None,
                              config=config, resume="allow", id=args.wandb_run_id or None,
                              tags=[t for t in (args.wandb_tags or "").split(",") if t])
        wandb.define_metric("train/step")
        wandb.define_metric("train/*", step_metric="train/step")
        wandb.define_metric("val/*", step_metric="train/step")
        print(f"[wandb] run {self.run.id} · {self.run.url or 'offline'}", flush=True)

    @property
    def run_id(self):
        return self.run.id if self.run else None

    def log(self, data):
        if self.run:
            self.run.log(data)

    def val(self, step, rep, temperature=None):
        """Every report row as val/<group>/<metric>; the 'all' row also lands in the run summary when it is the best."""
        if not self.run:
            return
        data = {"train/step": step}
        for group, m in rep.items():
            for k, v in m.items():
                if v is not None:
                    data[f"val/{group}/{k.replace('@', '_at_')}"] = v
        if temperature is not None:
            data["val/temperature"] = temperature
        self.run.log(data)

    def summary(self, **kv):
        if self.run:
            for k, v in kv.items():
                self.run.summary[k] = v

    def artifact(self, name, kind, path=None, files=(), metadata=None):
        if not self.run:
            return
        a = self.wandb.Artifact(name, type=kind, metadata=metadata or {})
        if path:
            a.add_dir(path)
        for f in files:
            if os.path.exists(f):
                a.add_file(f)
        self.run.log_artifact(a)

    def finish(self):
        if self.run:
            self.run.finish()


def file_sha(path, limit=None):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


def save_last(last_dir, model, opt, sched, state):
    """A resumable checkpoint, written to a temp dir and swapped in, so an interruption mid-write never leaves a torn one."""
    tmp = last_dir + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    torch.save({k: v.detach().cpu() for k, v in model.state_dict().items()}, os.path.join(tmp, "model.pt"))
    torch.save({"opt": opt.state_dict(), "sched": sched.state_dict(),
                "rng": {"python": random.getstate(), "numpy": np.random.get_state(), "torch": torch.get_rng_state()}},
               os.path.join(tmp, "optim.pt"))
    with open(os.path.join(tmp, "state.json"), "w") as f:
        json.dump(state, f, indent=2)
    old = last_dir + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(last_dir):
        os.replace(last_dir, old)
    os.replace(tmp, last_dir)
    shutil.rmtree(old, ignore_errors=True)


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
    ap.add_argument("--save-every", type=int, default=100, help="optimizer steps between resumable OUT/last/ checkpoints (0 = never)")
    ap.add_argument("--resume", action="store_true", help="continue from OUT/last/ (same data, same args)")
    ap.add_argument("--max-steps", type=int, default=0, help="stop after this many optimizer steps (smoke tests)")
    ap.add_argument("--max-rows", type=int, default=0, help="use only the first N train and N val rows (smoke tests)")
    ap.add_argument("--wandb", action="store_true", help="track the run in Weights & Biases (key from `wandb login`/WANDB_API_KEY)")
    ap.add_argument("--wandb-project", default="von-finetune")
    ap.add_argument("--wandb-entity", default="")
    ap.add_argument("--wandb-run-name", default="")
    ap.add_argument("--wandb-run-id", default="", help="resume this W&B run (set automatically from OUT/last/ with --resume)")
    ap.add_argument("--wandb-tags", default="")
    ap.add_argument("--wandb-artifacts", choices=["best", "none"], default="best",
                    help="upload the best checkpoint (option_marker.pt ~1.6 GB + calibration + history) as a model artifact at the end")
    args = ap.parse_args()

    random.seed(args.seed); torch.manual_seed(args.seed)
    dev = pick_device(args.device)
    out_dir = args.out or os.path.join(args.data, "ckpt")
    budget = args.tokens_per_batch or (16384 if dev.type == "cuda" else 4096)
    model, base_calib, base_paths = load_base()
    model.to(dev).train()
    if args.grad_checkpointing:
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    def read(f):
        rows = [json.loads(l) for l in open(os.path.join(args.data, f)) if l.strip()]
        return rows[:args.max_rows] if args.max_rows else rows
    train_rows = [] if args.eval_only else encode(model, read("train.jsonl"), "train")
    val_rows = encode(model, read("val.jsonl"), "val")
    print(f"[run] device={dev} tokens/batch={budget} accum={args.grad_accum} ckpt={args.grad_checkpointing} bf16={args.bf16}", flush=True)

    last_dir = os.path.join(out_dir, "last")
    resume_state = None
    if args.resume:
        sp = os.path.join(last_dir, "state.json")
        if not os.path.exists(sp):
            sys.exit(f"--resume: no resumable checkpoint at {last_dir}")
        resume_state = json.load(open(sp))
        if not args.wandb_run_id and resume_state.get("wandb_run_id"):
            args.wandb_run_id = resume_state["wandb_run_id"]

    data_files = {f: os.path.join(args.data, f) for f in ("train.jsonl", "val.jsonl", "render-stats.json")}
    lineage = {f: file_sha(p) for f, p in data_files.items() if os.path.exists(p)}
    render_stats = json.load(open(data_files["render-stats.json"])) if os.path.exists(data_files["render-stats.json"]) else None
    tracker = Tracker(args, {
        "args": vars(args), "device": str(dev), "tokens_per_batch": budget, "git_commit": git_commit(),
        "base": {"repo": REPO, "revision": REVISION}, "data_sha256": lineage,
        "rows": {"train": len(train_rows), "val": len(val_rows)},
        "render": {k: render_stats.get(k) for k in ("head", "episodes", "rendered")} if render_stats else None,
    })

    t0 = time.time()
    if resume_state:
        history = resume_state["history"]
        print(f"[resume] from step {resume_state['step']} (epoch {resume_state['epoch']}, micro {resume_state['micro_in_epoch']})", flush=True)
    else:
        base_logits = infer(model, val_rows, dev, budget, args.bf16)
        history = [{"step": 0, "val": report(base_logits, val_rows, base_calib)}]
        print(f"[eval] base ({time.time() - t0:.0f}s): {json.dumps(history[0]['val']['all'])}", flush=True)
        for k, v in history[0]["val"].items():
            print(f"         {k:18s} {v}")
        tracker.val(0, history[0]["val"])
    if args.eval_only:
        tracker.finish()
        return

    head = [p for n, p in model.named_parameters() if n.startswith("scorer.")]
    body = [p for n, p in model.named_parameters() if not n.startswith("scorer.")]
    opt = torch.optim.AdamW([{"params": body, "lr": args.lr}, {"params": head, "lr": args.head_lr}], weight_decay=0.01)
    per_epoch = len(batches(train_rows, budget, False, 0))
    total = max(1, int(per_epoch * args.epochs / args.grad_accum))
    warm = max(1, int(total * args.warmup))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    print(f"[run] {len(train_rows)} rows → {per_epoch} micro-batches/epoch → {total} optimizer steps", flush=True)

    step, micro, seen_tokens, best, best_step = 0, 0, 0, None, None
    epoch, skip = 0, 0
    if resume_state:
        model.load_state_dict(torch.load(os.path.join(last_dir, "model.pt"), map_location="cpu", weights_only=True))
        o = torch.load(os.path.join(last_dir, "optim.pt"), map_location="cpu", weights_only=False)
        opt.load_state_dict(o["opt"]); sched.load_state_dict(o["sched"])
        random.setstate(o["rng"]["python"]); np.random.set_state(o["rng"]["numpy"]); torch.set_rng_state(o["rng"]["torch"])
        step, seen_tokens, best, best_step = resume_state["step"], resume_state["seen_tokens"], resume_state["best"], resume_state["best_step"]
        epoch, skip = resume_state["epoch"], resume_state["micro_in_epoch"]
        micro = step * args.grad_accum
    # --max-steps only stops early; the LR schedule always spans the full run, so a run stopped and resumed follows
    # exactly the schedule an uninterrupted one would.
    stop_at = min(total, step + args.max_steps) if args.max_steps else total
    t_train = time.time()
    seen_at_start = seen_tokens
    while step < stop_at:
        order = batches(train_rows, budget, True, args.seed + epoch)  # deterministic per epoch: resuming replays the same order
        for mi, b in enumerate(order):
            if mi < skip:
                continue
            rows = [train_rows[i] for i in b]
            ids, am, marks = collate(rows, model.tokenizer.pad_token_id, dev)
            with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=args.bf16):
                out = model(input_ids=ids, attention_mask=am, mask_positions=marks, independent_options=True)
            loss = loss_fn(out, rows, args.brier_weight) / args.grad_accum
            loss.backward()
            micro += 1; seen_tokens += int(am.sum())
            if micro % args.grad_accum:
                continue
            gnorm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
            el = time.time() - t_train
            tok_s = (seen_tokens - seen_at_start) / max(el, 1e-9)
            tracker.log({"train/step": step, "train/loss": loss.item() * args.grad_accum, "train/grad_norm": gnorm,
                         "train/lr_body": opt.param_groups[0]["lr"], "train/lr_head": opt.param_groups[1]["lr"],
                         "train/tokens_per_s": tok_s, "train/epoch": epoch + (mi + 1) / max(1, len(order)), "train/seen_tokens": seen_tokens})
            if step % 25 == 0:
                print(f"[train] step {step}/{stop_at} loss {loss.item() * args.grad_accum:.4f} · gnorm {gnorm:.2f} · {tok_s:.0f} tok/s · eta {el / max(1, step - (resume_state or {}).get('step', 0)) * (stop_at - step) / 60:.0f} min", flush=True)
            if step % args.eval_every == 0 or step == stop_at:
                logits = infer(model, val_rows, dev, budget, args.bf16)
                t = fit_temperature(logits, val_rows)
                calib = dict(base_calib, calibration_map=None, temperature=t)
                rep = report(logits, val_rows, calib)
                history.append({"step": step, "temperature": t, "val": rep})
                tracker.val(step, rep, t)
                print(f"[eval] step {step}: T={t:.3f} {json.dumps(rep['all'])}", flush=True)
                if best is None or rep["all"]["acc"] > best:
                    best, best_step = rep["all"]["acc"], step
                    save(model, calib, base_paths, out_dir, {"step": step, "args": vars(args), "history": history,
                         "source": {"repo": REPO, "revision": REVISION}, "data_sha256": lineage,
                         "git_commit": git_commit(), "wandb_run_id": tracker.run_id})
                    tracker.summary(best_val_acc=best, best_step=step, best_temperature=t,
                                    **{f"best/{k}": v["acc"] for k, v in rep.items()})
                    print(f"[save] best so far → {out_dir}", flush=True)
            if args.save_every and (step % args.save_every == 0 or step == stop_at):
                save_last(last_dir, model, opt, sched, {
                    "step": step, "epoch": epoch, "micro_in_epoch": mi + 1, "seen_tokens": seen_tokens,
                    "best": best, "best_step": best_step, "history": history, "wandb_run_id": tracker.run_id, "args": vars(args)})
                print(f"[save] resumable step {step} → {last_dir}", flush=True)
            if step >= stop_at:
                break
        epoch += 1
        skip = 0
    with open(os.path.join(out_dir, "history.json"), "w") as f:
        json.dump(history, f, indent=2)
    if args.wandb_artifacts == "best" and best is not None:
        tracker.artifact(f"von-ckpt-{tracker.run_id}", "model", path=None,
                         files=[os.path.join(out_dir, f) for f in ("option_marker.pt", "marker_calibration.json", "train_meta.json", "history.json")],
                         metadata={"best_val_acc": best, "best_step": best_step, "note": "backbone files are the pinned base model's"})
    tracker.artifact("von-finetune-data", "dataset", files=[data_files["render-stats.json"]],
                     metadata={"sha256": lineage, "rows": {"train": len(train_rows), "val": len(val_rows)}})
    tracker.finish()
    print(f"[done] best val acc {best} (step {best_step}) · {(time.time() - t_train) / 60:.1f} min · {out_dir}")


if __name__ == "__main__":
    main()
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0)
