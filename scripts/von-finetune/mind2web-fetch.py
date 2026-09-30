# scripts/von-finetune/mind2web-fetch.py
# /// script
# requires-python = ">=3.12"
# dependencies = ["huggingface_hub>=0.30", "pyarrow>=15"]
# ///
"""Stage M1 — stream osunlp/Multimodal-Mind2Web into DATA/mind2web/raw/<split>.jsonl.gz.

Multimodal-Mind2Web is the one Mind2Web release that ships all four splits
(train 7,775 / test_task 1,339 / test_website 1,019 / test_domain 4,060 actions)
but its parquet shards are ~13 GB because every row carries a full-page
screenshot. Parquet stores columns separately, so this reads each shard over
HTTP range requests (huggingface_hub's HfFileSystem + pyarrow) and only ever
fetches the text columns — measured 2026-09-30: a 100-row row group is 124 MB
on disk, 77 MB of it screenshot bytes, and the 13 columns we keep come down
in ~4 s. Nothing is written to the HF cache.

Rows are sorted by (annotation_id, target_action_index) so the converter
(mind2web.mjs) can walk one task at a time; a task that straddles two shards
still comes out contiguous. Candidate lists are kept as the dataset's own JSON
strings — the converter parses them.

    uv run scripts/von-finetune/mind2web-fetch.py                   # all four splits
    uv run scripts/von-finetune/mind2web-fetch.py --splits test_website --limit 40   # smoke

Resumable per split: a finished <split>.jsonl.gz is skipped unless --limit
is given (a limited run writes <split>.limit.jsonl.gz instead, never over the
full file). Set VFT_DATA to write beside the teacher corpus in another checkout.
"""
import argparse, gzip, json, os, sys, time

import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

REPO = "datasets/osunlp/Multimodal-Mind2Web"
SPLITS = ["train", "test_task", "test_website", "test_domain"]
COLS = ["action_uid", "cleaned_html", "operation", "pos_candidates", "neg_candidates", "website", "domain",
        "subdomain", "annotation_id", "confirmed_task", "action_reprs", "target_action_index", "target_action_reprs"]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("VFT_DATA") or os.path.join(HERE, "data")


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def shards(fs, split):
    names = fs.ls(f"{REPO}/data", detail=False)
    return sorted(p for p in names if os.path.basename(p).startswith(split + "-") and p.endswith(".parquet"))


def rows_of(fs, path):
    with fs.open(path, "rb") as f:
        pf = pq.ParquetFile(f)
        for i in range(pf.metadata.num_row_groups):
            for r in pf.read_row_group(i, columns=COLS).to_pylist():
                yield r


def slim(split, r):
    return {
        "split": split,
        "annotation_id": r["annotation_id"],
        "action_uid": r["action_uid"],
        "website": r["website"],
        "domain": r["domain"],
        "subdomain": r["subdomain"],
        "confirmed_task": r["confirmed_task"],
        "action_reprs": list(r["action_reprs"] or []),
        "target_action_index": int(r["target_action_index"]),
        "target_action_reprs": r["target_action_reprs"],
        "operation": json.loads(r["operation"]) if isinstance(r["operation"], str) else r["operation"],
        "pos_candidates": list(r["pos_candidates"] or []),
        "neg_candidates": list(r["neg_candidates"] or []),
        "cleaned_html": r["cleaned_html"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--splits", default=",".join(SPLITS))
    ap.add_argument("--limit", type=int, default=0, help="rows per split (smoke test); writes <split>.limit.jsonl.gz")
    ap.add_argument("--out", default=os.path.join(DATA, "mind2web", "raw"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    fs = HfFileSystem()
    for split in [s for s in args.splits.split(",") if s]:
        if split not in SPLITS:
            sys.exit(f"unknown split {split}; one of {SPLITS}")
        out = os.path.join(args.out, f"{split}.{'limit.' if args.limit else ''}jsonl.gz")
        if os.path.exists(out) and not args.limit:
            log(f"{split}: {out} exists, skipping")
            continue
        t0 = time.time()
        rows = []
        for sh in shards(fs, split):
            n0 = len(rows)
            for r in rows_of(fs, sh):
                rows.append(slim(split, r))
                if args.limit and len(rows) >= args.limit:
                    break
            log(f"{split}: {os.path.basename(sh)} → {len(rows) - n0} rows ({len(rows)} total, {time.time() - t0:.0f}s)")
            if args.limit and len(rows) >= args.limit:
                break
        rows.sort(key=lambda r: (r["annotation_id"], r["target_action_index"]))
        tmp = out + ".tmp"
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, out)
        tasks = len({r["annotation_id"] for r in rows})
        log(f"{split}: {len(rows)} rows / {tasks} tasks → {out} ({os.path.getsize(out) / 1e6:.0f} MB, {time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
