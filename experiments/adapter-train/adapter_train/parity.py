"""Parity: does the trainer's model with the adapter say what llama.cpp says with the Q4_0 base and the adapter GGUF?

The last step of an export. Both sides run greedy on the same N prompts, as token ids (a prompt is a prefix of a datagen record's
`render.input_ids`, cut where the assistant begins), and write a JSON list of `{"id", "generated_ids": [...]}`:

    trainer side   `python -m adapter_train.parity trainer --adapter DIR --base MODEL --prompts prompts.json --out trainer.json`  (torch)
    engine side    the phone's engine (`centraid-assist-llama`, `AdapterUse::On`), run by `assist-eval --adapter` (Part F) or `assist-step`
    compare        `python -m adapter_train.parity compare trainer.json engine.json --min-match 0.9`

NOT AN EXACT MATCH BY DESIGN: the trainer holds the base in bf16 or fp32 and the phone in Q4_0, so a greedy run diverges somewhere. The
report gives, per prompt, how many leading tokens agree, and the share that agree for the first `--prefix` tokens; the gate is a floor
(`--min-match`) on that share, not equality. With `base.weights: q4_0_dequantised` (a seam, `trainer.NotBuilt`) the two sides see the same
weights and a tighter floor becomes meaningful. Needs the model weights and a trained adapter: no test here runs it end to end.
"""
from __future__ import annotations

import argparse
import json
import sys


def agree(a: list[int], b: list[int]) -> int:
    """How many leading tokens two generations share."""
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def compare(trainer: list[dict], engine: list[dict], *, prefix: int = 16, min_match: float = 0.9) -> dict:
    """The parity report. Both lists are matched by `id`; a prompt one side lacks is a failure, not a skip."""
    by_id = {r["id"]: r["generated_ids"] for r in engine}
    rows, missing = [], []
    for r in trainer:
        theirs = by_id.pop(r["id"], None)
        if theirs is None:
            missing.append(r["id"])
            continue
        want = min(prefix, len(r["generated_ids"]), len(theirs)) if (r["generated_ids"] and theirs) else 0
        n = agree(r["generated_ids"], theirs)
        rows.append({"id": r["id"], "agree": n, "trainer_len": len(r["generated_ids"]), "engine_len": len(theirs),
                     "prefix_ok": want > 0 and n >= want})
    extra = sorted(by_id)
    share = sum(1 for r in rows if r["prefix_ok"]) / len(rows) if rows else 0.0
    return {"prompts": len(rows), "prefix": prefix, "prefix_match_share": share, "exact": sum(1 for r in rows if r["agree"] == r["trainer_len"] == r["engine_len"]),
            "missing_in_engine": missing, "extra_in_engine": extra, "min_match": min_match,
            "passed": bool(rows) and not missing and not extra and share >= min_match, "rows": rows}


def trainer_side(adapter_dir, model, prompts: list[dict], max_new_tokens: int, *, device="cpu") -> list[dict]:
    """Greedy ids from `model` (a base, loaded as the job loaded it) with the PEFT adapter at `adapter_dir` on."""
    import torch
    from peft import PeftModel

    peft_model = PeftModel.from_pretrained(model, str(adapter_dir)).to(device).eval()
    out = []
    with torch.no_grad():
        for p in prompts:
            ids = torch.tensor([p["prompt_ids"]], device=device)
            gen = peft_model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), do_sample=False, max_new_tokens=max_new_tokens)
            out.append({"id": p["id"], "generated_ids": gen[0, ids.shape[1]:].tolist()})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compare")
    c.add_argument("trainer")
    c.add_argument("engine")
    c.add_argument("--prefix", type=int, default=16)
    c.add_argument("--min-match", type=float, default=0.9)
    t = sub.add_parser("trainer")
    t.add_argument("--adapter", required=True)
    t.add_argument("--base", required=True)
    t.add_argument("--revision", required=True)
    t.add_argument("--prompts", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--max-new-tokens", type=int, default=64)
    a = ap.parse_args(argv)
    if a.cmd == "compare":
        report = compare(json.load(open(a.trainer)), json.load(open(a.engine)), prefix=a.prefix, min_match=a.min_match)
        print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=1))
        return 0 if report["passed"] else 1
    from transformers import AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained(a.base, revision=a.revision)
    json.dump(trainer_side(a.adapter, model, json.load(open(a.prompts)), a.max_new_tokens), open(a.out, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
