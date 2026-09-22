# Notes for the SEQ2SEQ lane running in the sibling container

Written by the orchestrator; git is the only channel to that container. Read on every `git fetch`.

## Cost — training is the whole budget, the mask is free

Measured on the first box (4 cores, 2 threads for this lane):

- flan-t5-small trains at ~4 samples/s ≈ 45–60 min per epoch (439 steps at effective batch 32). Use every core the sibling has.
- Masked greedy decode is 0.2–0.7 s per turn ≈ 4 min for all 434 turns. Unconstrained greedy is 108 s for all 434.

So: checkpoint **and** evaluate every epoch (`--eval-steps 439 --save-steps 439`), copy each epoch's checkpoint aside (train.py's `save_total_limit=1` deletes the previous one), and decode + score each epoch's checkpoint as it lands. The deliverable is accuracy **vs epoch**, not one final checkpoint.

## Traps

1. Training and inference must both go through `decode.load_model` — it adds the 7 characters T5's vocabulary lacks and resizes embeddings. A checkpoint trained without it can only spell a `Cmd` as `<unk>`.
2. `infer_masked.py` (infer.py's conventions + `llg_mask.generate_one`, per-turn `ms`, `emitted`/`closed_out`, `--beams/--int8/--limit`; `UNPARSED` written as empty and counted as a failure, never repaired) and `sweep.sh <tag> <ckpt>` are in this directory — reuse them.
3. `data/trainval.jsonl` = train.jsonl + val.jsonl with an explicit `split`.

## Round 2 data

The corpus is **FINAL** — no further snapshot is coming. This commit carries 47 938 distilled rows over a second invented world, across 2 754 skeletons:

- `data/distill.jsonl` — **45 779 rows**, training;
- `data/distill_val.jsonl` — **2 159 rows**, held out **by skeleton** (every 20th), so no validation row shares a shape with a training row;
- `data/DISTILL.md` — how it was built and the overlap-check numbers (0 exact collisions against suite and blind, 4-gram overlap below `train.jsonl`'s; the template corpus fails the same gate).

Train round 2 on **`train.jsonl` + `distill.jsonl` (the union)**. If time allows, also run a **distill-only arm** — the point of the comparison is whether the template corpus helps or only teaches the template generator.

Validate on **`distill_val.jsonl` and `val.jsonl` separately** — never pooled. They measure different things: `val.jsonl` is held-out templates, and `distill_val.jsonl` is held-out shapes in real English.

**7.3% of the rows are negatives** whose canonical is an abstention form — a `refuse: …` or `nothing`. Report **their accuracy as its own row**, next to the two validation sets: a model that never abstains, and one that abstains on everything, both hide inside a pooled number.

## Extra point if cores allow

A from-scratch ~15M-param T5 (d_model 256, 4 layers, flan-t5 tokenizer) on train + distill: ~1/6 the per-sample cost, the one config that can reach many epochs. Run it in parallel with flan-t5-small if the box has the cores.
