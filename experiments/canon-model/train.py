"""Seq2seq fine-tune skeleton: text (+ previous canonical) -> canonical.

`--smoke` runs two steps on synthetic pairs purely to prove the wiring.
The real corpus now exists -- `data/train.jsonl` (14,043 rows) and
`data/val.jsonl` (2,213) -- and this script has been run end to end on it
for 150 steps; loss fell 4.43 -> 1.65.  The full run is not done.  The
command to use, and what it produced, are at the bottom of BENCH.md.

Input is JSONL, one object per line:

    {"input": "...", "target": "...", "template_id": "...", "split": "..."}

`input` is already the joined string the model sees.  Use `--join` to have
this script build it from `text` and `prev_canonical` instead, which is the
multi-turn form: GRAMMAR.md 3 makes a follow-up a REWRITE of the previous
canonical, so the previous canonical is part of the input, never state
hidden in the model.

Validation holds out WHOLE TEMPLATES (`--holdout-frac`), never random
rows: the harness brief's method rule is that a paraphrase model must be
scored on shapes it has not seen.  A row's own `split` field wins when it
has one.

The eval callback reports, through `check.py` itself:

  * `exact`    -- string equality with the gold canonical
  * `skeleton` -- equal after `check.skeleton()` masks every literal, i.e.
    the right SHAPE with possibly the wrong name or date
  * `parseable`-- fraction that parse at all (the floor grammar-constrained
    decoding would lift to 1.0)
"""

from __future__ import annotations

import argparse
import json
import os
import random

import numpy as np
import torch
from torch.utils.data import Dataset
from transformers import (DataCollatorForSeq2Seq, Seq2SeqTrainer,
                          Seq2SeqTrainingArguments)

import canon_grammar as G
from decode import load_model

JOINER = " ||| "


def join_input(text: str, prev_canonical: str | None) -> str:
    """The student's input: the utterance, and the canonical it rewrites."""
    return text if not prev_canonical else text + JOINER + prev_canonical


class Pairs(Dataset):
    def __init__(self, rows, tok, max_source=192, max_target=96):
        self.rows, self.tok = rows, tok
        self.max_source, self.max_target = max_source, max_target

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        item = self.tok(row["input"], max_length=self.max_source,
                        truncation=True)
        labels = self.tok(text_target=row["target"],
                          max_length=self.max_target, truncation=True)
        item["labels"] = labels["input_ids"]
        return item


def read_jsonl(path, join):
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if join:
                row["input"] = join_input(row.get("text", row.get("input", "")),
                                          row.get("prev_canonical"))
            rows.append(row)
    return rows


def split_rows(rows, holdout_frac, seed):
    """Whole templates are held out, not random rows."""
    if any(r.get("split") for r in rows):
        train = [r for r in rows if r.get("split") != "validation"]
        dev = [r for r in rows if r.get("split") == "validation"]
        return train, dev
    templates = sorted({r.get("template_id", str(i)) for i, r in enumerate(rows)})
    random.Random(seed).shuffle(templates)
    held = set(templates[:max(1, int(len(templates) * holdout_frac))])
    return ([r for r in rows if r.get("template_id") not in held],
            [r for r in rows if r.get("template_id") in held])


def build_metrics(tok, dev_rows):
    import check

    def compute(pred):
        ids = pred.predictions
        if isinstance(ids, tuple):
            ids = ids[0]
        ids = np.where(ids != -100, ids, tok.pad_token_id)
        outs = tok.batch_decode(ids, skip_special_tokens=True)
        exact = skeleton = parseable = 0
        for out, row in zip(outs, dev_rows):
            out = out.strip()
            gold = row["target"].strip()
            exact += out == gold
            try:
                tree = check.parse(out)
                parseable += 1
                skeleton += check.skeleton(tree) == check.skeleton(check.parse(gold))
            except Exception:
                pass
        total = max(1, len(outs))
        return {"exact": exact / total, "skeleton": skeleton / total,
                "parseable": parseable / total}

    return compute


SMOKE_TARGETS = None


def smoke_rows(count=50):
    rows = json.load(open(G.GRAMMAR_DIR + "/map.json"))["turns"]
    golds = [r["canonical"] for r in rows if r["covered"]][:count]
    return [{"input": "utterance %d for %s" % (i, gold.split()[0]),
             "target": gold, "template_id": "t%d" % (i % 10)}
            for i, gold in enumerate(golds)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/flan-t5-small")
    ap.add_argument("--data", help="JSONL of {input,target,template_id,split}")
    ap.add_argument("--out", default="runs/student")
    ap.add_argument("--smoke", action="store_true",
                    help="2 steps on 50 synthetic pairs; trains nothing real")
    ap.add_argument("--join", action="store_true",
                    help="build `input` from `text` + `prev_canonical`")
    ap.add_argument("--epochs", type=float, default=8.0)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--holdout-frac", type=float, default=0.15)
    ap.add_argument("--max-steps", type=int, default=-1,
                    help="stop after N optimiser steps (a pipeline check)")
    ap.add_argument("--dev-cap", type=int, default=0,
                    help="score only the first N dev rows (0 = all)")
    ap.add_argument("--eval-steps", type=int, default=200)
    ap.add_argument("--save-steps", type=int, default=200,
                    help="0 = keep no intermediate checkpoint (a tight disk)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    tok, model, added = load_model(args.model)

    if args.smoke:
        rows = smoke_rows(50)
    elif args.data:
        rows = read_jsonl(args.data, args.join)
    else:
        raise SystemExit("--data or --smoke")

    train_rows, dev_rows = split_rows(rows, args.holdout_frac, args.seed)
    if args.dev_cap:
        dev_rows = dev_rows[:args.dev_cap]
    print("train %d  dev %d (whole templates held out)  added tokens %s"
          % (len(train_rows), len(dev_rows), added))

    targs = Seq2SeqTrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        max_steps=2 if args.smoke else args.max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        per_device_eval_batch_size=args.batch,
        bf16=False, fp16=False,                  # CPU: keep it fp32
        use_cpu=True,
        dataloader_num_workers=0,
        eval_strategy="steps" if not args.smoke else "no",
        eval_steps=args.eval_steps,
        save_strategy="no" if args.save_steps == 0 and not args.smoke else "steps",
        save_steps=(args.save_steps or 200) if not args.smoke else 2,
        save_total_limit=1,
        logging_steps=20,
        predict_with_generate=True,
        generation_max_length=96,
        generation_num_beams=1,
        report_to=[],
        seed=args.seed,
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=targs,
        train_dataset=Pairs(train_rows, tok),
        eval_dataset=Pairs(dev_rows, tok),
        data_collator=DataCollatorForSeq2Seq(tok, model=model),
        compute_metrics=build_metrics(tok, dev_rows),
    )
    trainer.train()
    if not args.smoke:
        trainer.save_model(args.out)
        tok.save_pretrained(args.out)
    print(trainer.evaluate())


if __name__ == "__main__":
    main()
