# scripts/von-finetune/feasibility.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "huggingface_hub>=0.30", "numpy",
# ]
# ///
"""Measure what a full fine-tune of Von costs on THIS machine, instead of guessing.

For each packed length T (the target question's real shape: a goal/page state,
then K `[MASK] [i] button "…" → click` options), runs a few real AdamW steps
(forward + backward + optimizer) of the full 395M model with Von 1.2's
independent-option masks, and reports step time and peak device memory.
Prints a JSON summary; `--json PATH` also writes it.

    uv run scripts/von-finetune/feasibility.py                 # auto device
    uv run scripts/von-finetune/feasibility.py --lengths 512,1024,2048,4096 --ckpt
"""
import argparse, json, os, platform, random, sys, time
import torch
from huggingface_hub import hf_hub_download
from von.models.option_marker import OptionMarkerModel

REPO = "wfzyx/von"
REVISION = "5df8185a4f2327ad0a7cd117cc4f701ac557b9ae"  # same pin as scripts/export-von/export.py


def pick_device(name):
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def mem_now(dev):
    if dev.type == "cuda":
        return torch.cuda.max_memory_allocated(dev)
    if dev.type == "mps":
        return torch.mps.driver_allocated_memory()
    return 0


def sync(dev):
    if dev.type == "cuda":
        torch.cuda.synchronize(dev)
    elif dev.type == "mps":
        torch.mps.synchronize()


def synth_row(tok, model, target_tokens, rng):
    """A target-question-shaped packed sequence of roughly `target_tokens` tokens."""
    words = "cart checkout size colour blue red email name address next back search filter sort save cancel".split()
    state = "Goal: add the blue variant to the cart\nPage: Acme Shop (shop.example)\nDone so far: nothing yet\nProvided values: none"
    opts = []
    while True:
        i = len(opts)
        opts.append(f"[{i}] button \"{rng.choice(words).title()} {rng.choice(words)} {rng.choice(words)}\" → click")
        packed = model.pack_sequence(state, "Which element should be used next to progress toward the goal?", opts)
        n = len(tok(packed)["input_ids"])
        if n >= target_tokens or len(opts) >= 400:
            return packed, len(opts), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="auto")
    ap.add_argument("--lengths", default="512,1024,2048,4096")
    ap.add_argument("--batch", type=int, default=1, help="rows per micro-batch (same length)")
    ap.add_argument("--steps", type=int, default=4, help="timed steps per length (after 1 warm-up)")
    ap.add_argument("--ckpt", action="store_true", help="enable gradient checkpointing on the encoder")
    ap.add_argument("--bf16", action="store_true", help="bf16 autocast (cuda, or mps on torch>=2.6)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    dev = pick_device(args.device)
    files = ["config.json", "model.safetensors", "option_marker.pt", "tokenizer.json",
             "tokenizer_config.json", "marker_calibration.json"]
    paths = {f: hf_hub_download(REPO, f, revision=REVISION) for f in files}
    model = OptionMarkerModel(base_model_id=os.path.dirname(paths["config.json"]))
    model.load_state_dict(torch.load(paths["option_marker.pt"], map_location="cpu", weights_only=True), strict=True)
    model.to(dev).train()
    if args.ckpt:
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    n_params = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=1e-5, weight_decay=0.01)
    tok = model.tokenizer
    rng = random.Random(0)
    base_mem = mem_now(dev)

    results = []
    for T in [int(x) for x in args.lengths.split(",")]:
        packed, k, real_t = synth_row(tok, model, T, rng)
        enc = tok([packed] * args.batch, return_tensors="pt", padding=True)
        ids = enc["input_ids"].to(dev)
        am = enc["attention_mask"].to(dev)
        mpos = [(enc["input_ids"][b] == model.mask_token_id).nonzero(as_tuple=True)[0].tolist() for b in range(args.batch)]
        label = torch.tensor([0], device=dev)
        times, peak, err = [], 0, None
        try:
            for s in range(args.steps + 1):
                sync(dev)
                t0 = time.perf_counter()
                ctx = torch.autocast(dev.type, dtype=torch.bfloat16) if args.bf16 else torch.autocast(dev.type, enabled=False)
                with ctx:
                    logits = model(input_ids=ids, attention_mask=am, mask_positions=mpos, independent_options=True)
                    loss = sum(torch.nn.functional.cross_entropy(l.float().unsqueeze(0), label) for l in logits) / len(logits)
                loss.backward()
                opt.step()
                opt.zero_grad(set_to_none=True)
                sync(dev)
                if s > 0:
                    times.append(time.perf_counter() - t0)
                peak = max(peak, mem_now(dev))
        except RuntimeError as e:  # OOM on MPS/CUDA surfaces as RuntimeError
            err = str(e).splitlines()[0][:200]
        row = {"T": real_t, "options": k, "batch": args.batch,
               "stepSec": round(sorted(times)[len(times) // 2], 3) if times else None,
               "tokPerSec": round(real_t * args.batch / sorted(times)[len(times) // 2]) if times else None,
               "peakGB": round(peak / 2**30, 2), "error": err}
        print(json.dumps(row), flush=True)
        results.append(row)
        if dev.type == "mps":
            torch.mps.empty_cache()
        if err:
            break

    summary = {"device": str(dev), "machine": platform.platform(), "torch": torch.__version__,
               "params": n_params, "gradCheckpointing": args.ckpt, "bf16": args.bf16,
               "modelWeightsGB": round(base_mem / 2**30, 2), "rows": results}
    print(json.dumps(summary, indent=2))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(summary, f, indent=2)


if __name__ == "__main__":
    main()
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0)
