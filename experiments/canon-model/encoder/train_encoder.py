"""Multi-task training: skeleton head + slot heads + BIO tagger.

    HF_HOME=$PWD/../hf OMP_WAIT_POLICY=PASSIVE OMP_NUM_THREADS=2 \
      MKL_NUM_THREADS=2 KMP_BLOCKTIME=0 \
      ../.venv/bin/python -u train_encoder.py --base sentence-transformers/all-MiniLM-L6-v2 \
        --out ../runs/enc-minilm --epochs 6
"""
from __future__ import annotations

import argparse
import json
import os
import random
import time

import torch
from torch import nn

from features import encode
from model import CanonEncoder, Vocabs, load_tokenizer
from task import DATA, label_of, read_jsonl


def build(rows):
    texts, labels, keep = [], [], []
    for r in rows:
        try:
            labels.append(label_of(r["target"]))
        except Exception:
            continue
        texts.append(r["input"])
        keep.append(r)
    return texts, labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--head-lr", type=float, default=1e-3)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--extra", default="", help="extra jsonl to add to train")
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    random.seed(0)
    torch.manual_seed(0)

    tr = read_jsonl(os.path.join(DATA, "train.jsonl"))
    if args.extra:
        tr = tr + read_jsonl(args.extra)
    va = read_jsonl(os.path.join(DATA, "val.jsonl"))
    tr_t, tr_l = build(tr)
    va_t, va_l = build(va)
    print("train %d  val %d" % (len(tr_t), len(va_t)), flush=True)

    vocabs = Vocabs.build(tr_l)
    print("templates %d  slots %d  bio %d"
          % (len(vocabs.templates), len(vocabs.slots), len(vocabs.bio)), flush=True)

    tok = load_tokenizer(args.base)
    model = CanonEncoder(args.base, vocabs)
    os.makedirs(args.out, exist_ok=True)
    vocabs.save(os.path.join(args.out, "vocabs.json"))
    json.dump({"base": args.base}, open(os.path.join(args.out, "meta.json"), "w"))
    tok.save_pretrained(args.out)

    heads = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    body = [p for n, p in model.named_parameters() if n.startswith("encoder.")]
    opt = torch.optim.AdamW([{"params": body, "lr": args.lr},
                             {"params": heads, "lr": args.head_lr}],
                            weight_decay=0.01)
    steps = args.epochs * ((len(tr_t) + args.batch - 1) // args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=[args.lr, args.head_lr], total_steps=steps, pct_start=0.1)
    ce = nn.CrossEntropyLoss()
    ce_tag = nn.CrossEntropyLoss(ignore_index=-100)

    best = -1.0
    started = time.time()
    order = list(range(len(tr_t)))
    for epoch in range(args.epochs):
        model.train()
        random.shuffle(order)
        run = 0.0
        for step, at in enumerate(range(0, len(order), args.batch)):
            idx = order[at:at + args.batch]
            feats, _ = encode(tok, [tr_t[i] for i in idx],
                              [tr_l[i] for i in idx], vocabs)
            tlog, slog, glog = model(feats["input_ids"], feats["attention_mask"])
            loss = ce(tlog, feats["template"])
            for name in vocabs.slots:
                loss = loss + 0.5 * ce(slog[name], feats["slot_" + name])
            loss = loss + 2.0 * ce_tag(glog.reshape(-1, glog.shape[-1]),
                                       feats["tags"].reshape(-1))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            run += float(loss)
            if step % 50 == 0:
                print("e%d s%d loss %.4f  %.0fs"
                      % (epoch, step, run / (step + 1), time.time() - started),
                      flush=True)
        acc = evaluate(model, tok, va_t, va_l, vocabs, args.batch)
        print("EPOCH %d  val template %.4f  slots %.4f  tags %.4f  %.0fs"
              % (epoch, acc["template"], acc["slots"], acc["tags"],
                 time.time() - started), flush=True)
        score = acc["template"] + acc["slots"] + acc["tags"]
        if score > best:
            best = score
            torch.save(model.state_dict(), os.path.join(args.out, "model.pt"))
            print("  saved", flush=True)
    print("done in %.0fs" % (time.time() - started), flush=True)


@torch.no_grad()
def evaluate(model, tok, texts, labels, vocabs, batch):
    model.eval()
    ok = tot = 0
    sok = stot = 0
    gok = gtot = 0
    for at in range(0, len(texts), batch):
        sl = slice(at, at + batch)
        feats, _ = encode(tok, texts[sl], labels[sl], vocabs)
        tlog, slog, glog = model(feats["input_ids"], feats["attention_mask"])
        keep = feats["template_ok"].bool()
        ok += int(((tlog.argmax(-1) == feats["template"]) & keep).sum())
        tot += int(keep.sum())
        for name in vocabs.slots:
            sok += int((slog[name].argmax(-1) == feats["slot_" + name]).sum())
            stot += len(texts[sl])
        m = feats["tags"] != -100
        gok += int(((glog.argmax(-1) == feats["tags"]) & m).sum())
        gtot += int(m.sum())
    return {"template": ok / max(1, tot), "slots": sok / max(1, stot),
            "tags": gok / max(1, gtot)}


if __name__ == "__main__":
    main()
