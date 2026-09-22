"""Generate a canonical for EVERY corpus turn UNDER THE LLGUIDANCE MASK.

    HF_HOME=$PWD/hf ./.venv/bin/python -u infer_masked.py \
        --model runs/flan-t5-small-conv/final --mode free \
        --out out/flan-t5-small-conv.masked.free.jsonl

Identical to `infer.py` in every respect but the decode: the same input
construction ("<previous canonical or NONE> ||| <utterance>"), the same
teacher/free threading of the previous canonical, the same rule that the
RAW generation is written before anything parses it.

The decode is `llg_mask.generate_one` -- greedy (or beam) decoding with
`LLGLogitsProcessor` masking every step to the tokens llguidance's Earley
recognizer over `canon_lark` says a legal canonical can continue with.
`generate_one`'s close-out search is used, so a decode that stops in a
non-accepting state is finished by the recognizer if it can be; when it
cannot, the string written is `UNPARSED` -- a FAILURE, never repaired.

Per-turn wall time is recorded in `ms` for the latency table.  No corpus
file is opened; `grammar/map.json` supplies `request` and (for --mode
teacher only) the gold previous canonical.  None of it reaches training.
"""

from __future__ import annotations

import argparse
import json
import os
import time

import torch

import llg_mask
from decode import load_model
from infer import turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mode", choices=["teacher", "free"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new-tokens", type=int, default=64)
    ap.add_argument("--beams", type=int, default=1)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--int8", action="store_true",
                    help="dynamic-quantise Linear to qint8 before decoding")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    tok, model, added = load_model(args.model)
    if args.int8:
        model = torch.ao.quantization.quantize_dynamic(
            model, {torch.nn.Linear}, dtype=torch.qint8)
    constraint = llg_mask.LLGConstraint(tok)
    print("loaded %s (added tokens %s) int8=%s beams=%d"
          % (args.model, added, args.int8, args.beams), flush=True)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    handle = open(args.out, "w", encoding="utf-8")
    prev_gold, prev_model = {}, {}
    rows = turns()
    if args.limit:
        rows = rows[:args.limit]
    started = time.time()
    unparsed = closed = 0
    for at, row in enumerate(rows):
        key = (row["corpus"], row["session"])
        if row["turn"] == 0:
            prev = "NONE"
        elif args.mode == "teacher":
            prev = prev_gold.get(key, "NONE") or "NONE"
        else:
            prev = prev_model.get(key, "NONE") or "NONE"
        text = "%s ||| %s" % (prev, row["request"])
        t0 = time.time()
        with torch.no_grad():
            final, emitted, finished = llg_mask.generate_one(
                tok, model, text, constraint=constraint,
                max_new_tokens=args.max_new_tokens, num_beams=args.beams)
        took = (time.time() - t0) * 1000.0
        unparsed += final == llg_mask.UNPARSED
        closed += bool(finished)
        prev_gold[key] = row["canonical"]
        prev_model[key] = "" if final == llg_mask.UNPARSED else final
        handle.write(json.dumps({
            "corpus": row["corpus"], "session": row["session"],
            "turn": row["turn"], "mode": args.mode, "model": args.model,
            "decode": "masked-beam%d%s" % (args.beams, "-int8" if args.int8 else ""),
            "request": row["request"], "prev_used": prev,
            "emitted": emitted, "closed_out": bool(finished),
            "ms": round(took, 1),
            "canonical": "" if final == llg_mask.UNPARSED else final,
            "raw_final": final,
        }) + "\n")
        handle.flush()
        if at % 25 == 0:
            print("%4d/%d  %.0fs  unparsed=%d closed=%d"
                  % (at, len(rows), time.time() - started, unparsed, closed),
                  flush=True)
    handle.close()
    print("wrote %s in %.0fs  unparsed=%d closed_out=%d"
          % (args.out, time.time() - started, unparsed, closed), flush=True)


if __name__ == "__main__":
    main()
