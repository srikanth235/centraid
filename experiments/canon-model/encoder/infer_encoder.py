"""Generate a canonical for every corpus turn with the trained encoder.

    HF_HOME=... ../.venv/bin/python -u infer_encoder.py \
        --model ../runs/enc-minilm --mode free --out ../out/encoder-minilm.free.jsonl

Input is `infer.py`'s exactly: "<prev canonical or NONE> ||| <utterance>".
`--mode teacher` threads the GOLD previous canonical, `--mode free` the
model's own previous output.  The model emits only argmaxes; the canonical is
ASSEMBLED by `task.assemble_from` and written raw, before anything parses or
scores it.  There is no string-level repair of model output anywhere.
"""
from __future__ import annotations

import argparse
import json
import os
import time

import torch

from features import decode_tags, encode
from model import CanonEncoder, Vocabs, load_tokenizer
from task import HOLE_RX, assemble_from, gold_rows


def load(path):
    vocabs = Vocabs.load(os.path.join(path, "vocabs.json"))
    base = json.load(open(os.path.join(path, "meta.json")))["base"]
    model = CanonEncoder(base, vocabs)
    model.load_state_dict(torch.load(os.path.join(path, "model.pt"),
                                     map_location="cpu"))
    model.eval()
    return load_tokenizer(path), model, vocabs


@torch.no_grad()
def predict(tok, model, vocabs, text, prev):
    feats, offsets = encode(tok, [text], None, vocabs, with_labels=False)
    tlog, slog, glog = model(feats["input_ids"], feats["attention_mask"])
    template = vocabs.templates[int(tlog.argmax(-1))]
    needed = {m.group(1) + m.group(2) for m in HOLE_RX.finditer(template)}
    closed = {}
    for name, head in slog.items():
        logits = head[0]
        if name in needed:
            # the template HAS this hole, so <none> is not an option: take the
            # argmax over the real vocabulary.  Still one argmax, still closed.
            value = vocabs.slots[name][int(logits[1:].argmax(-1)) + 1]
        else:
            value = vocabs.slots[name][int(logits.argmax(-1))]
        if value != "<none>":
            closed[name] = value
    lits = decode_tags(feats["input_ids"][0].tolist(), offsets[0].tolist(),
                       glog[0].argmax(-1).tolist(), text, vocabs)
    return assemble_from(template, closed, lits, prev), template, closed, lits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mode", choices=["teacher", "free"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    tok, model, vocabs = load(args.model)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    handle = open(args.out, "w", encoding="utf-8")
    prev_gold, prev_model = {}, {}
    started = time.time()
    lat = []
    for row in gold_rows():
        key = (row["corpus"], row["session"])
        if row["turn"] == 0:
            prev = "NONE"
        elif args.mode == "teacher":
            prev = prev_gold.get(key, "NONE") or "NONE"
        else:
            prev = prev_model.get(key, "NONE") or "NONE"
        text = "%s ||| %s" % (prev, row["request"])
        t0 = time.time()
        raw, template, closed, lits = predict(tok, model, vocabs, text, prev)
        lat.append(time.time() - t0)
        prev_gold[key] = row["canonical"]
        prev_model[key] = raw
        handle.write(json.dumps({
            "corpus": row["corpus"], "session": row["session"],
            "turn": row["turn"], "mode": args.mode, "model": args.model,
            "request": row["request"], "prev_used": prev,
            "canonical": raw,
            "heads": {"template": template, "closed": closed, "lits": lits},
        }) + "\n")
        handle.flush()
    handle.close()
    lat.sort()
    print("wrote %s in %.0fs  p50 %.0fms  p95 %.0fms"
          % (args.out, time.time() - started,
             1000 * lat[len(lat) // 2], 1000 * lat[int(0.95 * len(lat))]))


if __name__ == "__main__":
    main()
