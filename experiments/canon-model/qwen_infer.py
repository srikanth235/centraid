"""Zero-training masked decode over every corpus turn, from a Qwen3.5 model.

    HF_HOME=$PWD/hf ./.venv-tierc/bin/python -u qwen_infer.py \
        --model Qwen/Qwen3.5-0.8B --mode free --out out/qwen3.5-0.8b.free.jsonl

No fine-tuning: the model is prompted with the grammar summary and 20
exemplars drawn from `data/train.jsonl` (`qwen_prompt.py`), and decoded
GREEDILY under the compiled grammar mask (`qwen_mask.py`).

`--mode teacher` threads the GOLD previous canonical; `--mode free` threads
the model's own previous output, which is what a shipping seat would get.

Every generation is written to the JSONL BEFORE anything parses or scores
it: `emitted` is the model's own string and `canonical` is what goes to the
executor -- they differ only where the close-out search completed a legal
but unfinished prefix, which `used_finisher` records.  Where that search
gave up the row says `Unparsed` and is a FAILED turn; nothing is patched,
normalised or completed outside the mask.

Thinking mode is disabled at the chat template, so the first generated token
is already inside the canonical and the mask governs the whole completion.
"""

from __future__ import annotations

import argparse
import json
import os
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

import qwen_mask
import qwen_prompt

MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "..", "crates", "evalsuite", "grammar", "map.json")


def turns():
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


def build_prompt(tok, system, prev, request):
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": qwen_prompt.user_prompt(prev, request)}]
    try:
        text = tok.apply_chat_template(messages, tokenize=False,
                                       add_generation_prompt=True,
                                       enable_thinking=False)
    except TypeError:
        text = tok.apply_chat_template(messages, tokenize=False,
                                       add_generation_prompt=True)
    return tok(text, return_tensors="pt").input_ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mode", choices=["teacher", "free"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new-tokens", type=int, default=64)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--exemplars", type=int, default=20)
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32)
    model.eval()
    system = qwen_prompt.system_prompt(args.exemplars)
    constraint = qwen_mask.QwenConstraint(tok)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    handle = open(args.out, "w", encoding="utf-8")
    prev_gold, prev_model = {}, {}
    rows = turns()
    if args.limit:
        rows = rows[:args.limit]
    started = time.time()
    for at, row in enumerate(rows):
        key = (row["corpus"], row["session"])
        if row["turn"] == 0:
            prev = "NONE"
        elif args.mode == "teacher":
            prev = prev_gold.get(key, "NONE") or "NONE"
        else:
            prev = prev_model.get(key, "NONE") or "NONE"
        ids = build_prompt(tok, system, prev, row["request"])
        began = time.perf_counter()
        final, emitted, used = qwen_mask.generate_one(
            tok, model, ids, constraint, max_new_tokens=args.max_new_tokens)
        elapsed = time.perf_counter() - began
        prev_gold[key] = row["canonical"]
        prev_model[key] = final if final != qwen_mask.UNPARSED else "NONE"
        handle.write(json.dumps({
            "corpus": row["corpus"], "session": row["session"],
            "turn": row["turn"], "mode": args.mode, "model": args.model,
            "request": row["request"], "prev_used": prev,
            "emitted": emitted, "used_finisher": used,
            "seconds": round(elapsed, 3),
            "canonical": final,
        }) + "\n")
        handle.flush()
        if at % 10 == 0:
            print("%4d/%d  %.0fs  %.1fs/turn" %
                  (at, len(rows), time.time() - started,
                   (time.time() - started) / max(1, at)), flush=True)
    handle.close()
    print("wrote %s in %.0fs" % (args.out, time.time() - started))


if __name__ == "__main__":
    main()
