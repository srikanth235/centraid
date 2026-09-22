"""Lane E deliverable (A): the two decoder verifications, over the FULL set.

  1. The grammar mask never blocks a gold token -- teacher-force every one
     of the gold canonicals in crates/evalsuite/grammar/map.json.
  2. A randomly initialised model under the mask emits only strings that
     crates/evalsuite/grammar/check.py parses.

Raw generations are saved BEFORE parsing, to raw_random_init.jsonl.
"""

from __future__ import annotations

import argparse
import json
import random
import time

from transformers import AutoConfig, T5ForConditionalGeneration

import canon_grammar as G
import check
from decode import (UNPARSED, GrammarConstraint, constrained_generate,
                    load_model)

MAP = G.GRAMMAR_DIR + "/map.json"


def gold_rows():
    return json.load(open(MAP))["turns"]


def verify_gold_all(tok):
    """Teacher-force EVERY gold canonical through the mask."""
    constraint = GrammarConstraint(tok)
    rows = gold_rows()
    blocks, steps, not_tokenizable, eos_blocks = [], 0, [], []
    for row in rows:
        gold = row["canonical"]
        ids = tok(gold, add_special_tokens=False).input_ids
        if tok.unk_token_id in ids or not G.same_meaning(
                tok.decode(ids, skip_special_tokens=True), gold):
            not_tokenizable.append(gold)
            continue
        prefix = ()
        for step in ids:
            allowed = set(constraint.allowed(prefix))
            steps += 1
            if step not in allowed:
                blocks.append({"canonical": gold, "position": len(prefix),
                               "token": tok.convert_ids_to_tokens(step)})
                break
            prefix = prefix + (step,)
        else:
            if constraint.eos not in set(constraint.allowed(prefix)):
                eos_blocks.append({"canonical": gold, "position": len(prefix),
                                   "token": "</s>"})
    return {"total": len(rows), "checked": len(rows) - len(not_tokenizable),
            "token_steps": steps, "blocked": blocks, "eos_blocked": eos_blocks,
            "not_tokenizable": not_tokenizable}


def real_inputs(count, seed=0):
    """Real member utterances: the request text of every mapped turn."""
    reqs = sorted({r["request"] for r in gold_rows()})
    random.Random(seed).shuffle(reqs)
    out = list(reqs)
    while len(out) < count:                    # 416 unique; only if asked more
        out += reqs
    return out[:count]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/flan-t5-small")
    ap.add_argument("--n-random", type=int, default=200)
    ap.add_argument("--max-new-tokens", type=int, default=48)
    ap.add_argument("--raw", default="raw_random_init.jsonl")
    ap.add_argument("--stage", choices=["all", "gold", "random"], default="all")
    args = ap.parse_args()

    tok, _model, added = load_model(args.model)
    print("model %s  added %s  vocab %d" % (args.model, added, len(tok)),
          flush=True)

    if args.stage in ("all", "gold"):
        gold_stage(tok)
    if args.stage in ("all", "random"):
        random_stage(tok, args)


def gold_stage(tok):
    started = time.perf_counter()
    report = verify_gold_all(tok)
    print(json.dumps({k: (v if not isinstance(v, list) else len(v))
                      for k, v in report.items()}), flush=True)
    print("gold sweep %.1fs" % (time.perf_counter() - started), flush=True)
    for row in report["blocked"][:20]:
        print("  BLOCKED", row)
    for row in report["eos_blocked"][:20]:
        print("  EOS BLOCKED", row)
    for row in report["not_tokenizable"][:20]:
        print("  NOT TOKENIZABLE", repr(row))


def random_stage(tok, args):
    # ---- 2. randomly initialised model ------------------------------------
    config = AutoConfig.from_pretrained(args.model)
    rand = T5ForConditionalGeneration(config)
    rand.resize_token_embeddings(len(tok))
    rand.eval()
    constraint = GrammarConstraint(tok)
    inputs = real_inputs(args.n_random)
    parsed = truncated = 0
    started = time.perf_counter()
    with open(args.raw, "w") as handle:
        for index, text in enumerate(inputs):
            # Generate here rather than through `constrained_generate` so the
            # RAW decoder output is recorded before anything looks at it.
            batch = tok(text, return_tensors="pt")
            seq = rand.generate(**batch, num_beams=1,
                                max_new_tokens=args.max_new_tokens,
                                do_sample=False,
                                prefix_allowed_tokens_fn=constraint)
            raw = tok.decode(seq[0], skip_special_tokens=True)
            ids = tuple(int(i) for i in seq[0].tolist())
            ids = tuple(i for i in ids
                        if i not in (tok.pad_token_id, tok.eos_token_id))
            emitted = constraint.text_for(ids)
            out, finisher = emitted, False
            if not G.complete(emitted):
                state = constraint.state_for(ids)
                tail = (G.shortest_completion(state)
                        if state is not None else None)
                if tail is None:
                    out = UNPARSED
                else:
                    out, finisher = emitted + tail, True
            ok, error = False, None
            if out is UNPARSED or out == UNPARSED:
                truncated += 1
                error = "no legal completion from the reached state"
            else:
                try:
                    check.parse(out)
                    ok = True
                except Exception as exc:            # noqa: BLE001 - recorded
                    error = "%s: %s" % (type(exc).__name__, exc)
            parsed += ok
            handle.write(json.dumps(
                {"i": index, "input": text, "raw_decode": raw,
                 "emitted": emitted, "final": out, "used_finisher": finisher,
                 "parses": ok, "error": error}) + "\n")
            if (index + 1) % 25 == 0:
                print("  %d/%d  parsed=%d  (%.0fs)"
                      % (index + 1, len(inputs), parsed,
                         time.perf_counter() - started), flush=True)
    print("random-init: %d/%d parse via check.py (%d UNPARSED) %.1fs"
          % (parsed, len(inputs), truncated, time.perf_counter() - started))


if __name__ == "__main__":
    main()
