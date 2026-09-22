"""Generate a canonical for EVERY corpus turn with a fine-tuned checkpoint.

    HF_HOME=$PWD/hf ./.venv/bin/python -u infer.py \
        --model runs/flan-t5-small --mode free --out out/flan-t5-small.free.jsonl

The input is built exactly as `data/build.py` builds a training row:

    "<previous canonical or NONE> ||| <utterance>"

`--mode teacher` threads the GOLD previous canonical (teacher-forced
context); `--mode free` threads the MODEL'S OWN previous output, raw and
unrepaired, which is the number a shipping seat would get.

Decoding is UNCONSTRAINED greedy — the grammar mask is not ready (VERIFY.md).
Every generation is written before anything parses it.  Nothing here edits,
normalises or completes the model's string.

`grammar/map.json` is read for two fields only: `request` (the member's
words) and `canonical` (gold, for `--mode teacher`'s context and for the
exact-match leakage check done later by `score_outputs.py`).  No corpus
file is opened, and none of this ever reaches training.
"""

from __future__ import annotations

import argparse
import json
import os
import time

import torch

from decode import load_model

MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "..", "crates", "evalsuite", "grammar", "map.json")


def turns():
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mode", choices=["teacher", "free"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new-tokens", type=int, default=96)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    tok, model, added = load_model(args.model)
    print("loaded %s (added tokens %s)" % (args.model, added))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    handle = open(args.out, "w", encoding="utf-8")
    prev_gold = {}
    prev_model = {}
    started = time.time()
    for at, row in enumerate(turns()):
        key = (row["corpus"], row["session"])
        if row["turn"] == 0:
            prev = "NONE"
        elif args.mode == "teacher":
            prev = prev_gold.get(key, "NONE") or "NONE"
        else:
            prev = prev_model.get(key, "NONE") or "NONE"
        text = "%s ||| %s" % (prev, row["request"])
        batch = tok(text, return_tensors="pt", truncation=True, max_length=192)
        with torch.no_grad():
            ids = model.generate(**batch, max_new_tokens=args.max_new_tokens,
                                 num_beams=1, do_sample=False)
        raw = tok.decode(ids[0], skip_special_tokens=True).strip()
        prev_gold[key] = row["canonical"]
        prev_model[key] = raw
        handle.write(json.dumps({
            "corpus": row["corpus"], "session": row["session"],
            "turn": row["turn"], "mode": args.mode, "model": args.model,
            "request": row["request"], "prev_used": prev,
            "canonical": raw,
        }) + "\n")
        handle.flush()
        if at % 50 == 0:
            print("%4d  %.0fs" % (at, time.time() - started), flush=True)
    handle.close()
    print("wrote %s in %.0fs" % (args.out, time.time() - started))


if __name__ == "__main__":
    main()
