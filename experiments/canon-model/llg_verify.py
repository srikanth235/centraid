"""The new mask's three measurements, the way Lane E measured the old one.

    cd experiments/canon-model
    HF_HOME=$PWD/hf ./.venv/bin/python -u llg_verify.py --stage gold
    HF_HOME=$PWD/hf ./.venv/bin/python -u llg_verify.py --stage random --n-random 500

  * `--stage gold`   teacher-forces all 434 gold canonicals through the mask
    and asserts the gold next token is admitted at every step, and `</s>` at
    the end.  A block is the mask being NARROWER than the grammar.
  * `--stage random` generates from a randomly initialised flan-t5-small
    under the mask, writes every raw generation BEFORE parsing, and feeds
    each to `check.parse`.  A failure is the mask being WIDER, i.e. a leak.

Both stages are checks on `canon_lark.py`, which is the transcription; a
failure in either is fixed there and never by relaxing a check.
"""

from __future__ import annotations

import argparse
import json
import random
import time

import numpy as np
from transformers import AutoConfig, T5ForConditionalGeneration

import llg_mask                                    # puts GRAMMAR_DIR on sys.path
import check                                       # noqa: E402  (the repo's parser)
from decode import load_model

MAP = llg_mask.canon_lark.GRAMMAR_DIR + "/map.json"


def gold_rows():
    return json.load(open(MAP))["turns"]


def real_inputs(count, seed=0):
    """Real member utterances -- the request text of every mapped turn."""
    reqs = sorted({r["request"] for r in gold_rows()})
    random.Random(seed).shuffle(reqs)
    out = list(reqs)
    while len(out) < count:
        out += reqs
    return out[:count]


# ---------------------------------------------------------------------------
# 1. gold sweep
# ---------------------------------------------------------------------------

def stage_gold(tok):
    constraint = llg_mask.LLGConstraint(tok)
    rows = gold_rows()
    blocked, eos_blocked, not_tokenizable = [], [], []
    steps = 0
    started = time.perf_counter()
    for row in rows:
        gold = row["canonical"]
        ids = tok(gold, add_special_tokens=False).input_ids
        if tok.unk_token_id in ids:
            not_tokenizable.append(gold)
            continue
        constraint.reset()
        prefix = []
        ok = True
        for step in ids:
            mask = constraint.mask_for(prefix)
            bits = np.unpackbits(mask.numpy().view(np.uint8), bitorder="little")
            steps += 1
            if not bits[step]:
                blocked.append({"canonical": gold, "position": len(prefix),
                                "token": tok.convert_ids_to_tokens(step)})
                ok = False
                break
            prefix.append(int(step))
        if not ok:
            continue
        mask = constraint.mask_for(prefix)
        bits = np.unpackbits(mask.numpy().view(np.uint8), bitorder="little")
        if not bits[constraint.eos] or not constraint.is_accepting():
            eos_blocked.append({"canonical": gold, "position": len(prefix),
                                "token": "</s>"})
    report = {"total": len(rows), "checked": len(rows) - len(not_tokenizable),
              "token_steps": steps, "blocked": len(blocked),
              "eos_blocked": len(eos_blocked),
              "not_tokenizable": len(not_tokenizable),
              "seconds": round(time.perf_counter() - started, 1)}
    print(json.dumps(report), flush=True)
    for row in blocked[:20]:
        print("  BLOCKED", row)
    for row in eos_blocked[:20]:
        print("  EOS BLOCKED", row)
    for row in not_tokenizable[:20]:
        print("  NOT TOKENIZABLE", repr(row))
    return report


# ---------------------------------------------------------------------------
# 2. random-init parse rate
# ---------------------------------------------------------------------------

def stage_random(tok, args):
    config = AutoConfig.from_pretrained(args.model)
    rand = T5ForConditionalGeneration(config)
    rand.resize_token_embeddings(len(tok))
    rand.eval()
    constraint = llg_mask.LLGConstraint(tok)
    inputs = real_inputs(args.n_random)
    parsed = truncated = finished = 0
    started = time.perf_counter()
    with open(args.raw, "w") as handle:
        for index, text in enumerate(inputs):
            final, emitted, used = llg_mask.generate_one(
                tok, rand, text, constraint=constraint,
                max_new_tokens=args.max_new_tokens)
            ok, error = False, None
            if final == llg_mask.UNPARSED:
                truncated += 1
                error = "no legal completion from the reached state"
            else:
                try:
                    check.parse(final)
                    ok = True
                except Exception as exc:            # noqa: BLE001 - recorded
                    error = "%s: %s" % (type(exc).__name__, exc)
            parsed += ok
            finished += used
            handle.write(json.dumps(
                {"i": index, "input": text, "emitted": emitted,
                 "final": final, "used_finisher": used, "parses": ok,
                 "error": error}) + "\n")
            if (index + 1) % 50 == 0:
                print("  %d/%d  parsed=%d  (%.0fs)"
                      % (index + 1, len(inputs), parsed,
                         time.perf_counter() - started), flush=True)
    print("random-init: %d/%d parse via check.py (%.1f%%); %d closed by the "
          "finisher; %d with no completion; %.1fs"
          % (parsed, len(inputs), 100.0 * parsed / len(inputs), finished,
             truncated, time.perf_counter() - started), flush=True)
    return parsed, len(inputs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/flan-t5-small")
    ap.add_argument("--stage", choices=["all", "gold", "random"], default="all")
    ap.add_argument("--n-random", type=int, default=500)
    ap.add_argument("--max-new-tokens", type=int, default=48)
    ap.add_argument("--raw", default="raw_random_init_llg.jsonl")
    args = ap.parse_args()

    tok, _model, added = load_model(args.model)
    print("model %s  added %s  vocab %d" % (args.model, added, len(tok)),
          flush=True)
    if args.stage in ("all", "gold"):
        stage_gold(tok)
    if args.stage in ("all", "random"):
        stage_random(tok, args)


if __name__ == "__main__":
    main()
