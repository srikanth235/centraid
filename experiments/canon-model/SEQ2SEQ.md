# SEQ2SEQ (Tier B) — a properly trained small seq2seq under the grammar mask

**Round 1 was cut at step 343 of 2,634 (epoch 0.78 of 6) on 2026-09-22 09:18, by the coordinator: the lane was moved to a dedicated container and this box was needed by the encoder and data lanes.** The run was killed before its first checkpoint, which was due at step 440 (epoch 1.0), so **no checkpoint of this lane's training survives and this file reports no new decode, parse, executor or latency numbers.** What it does carry is the training curve to epoch 0.78, the measured cost of every step of the plan on this box, and the harness that was built and smoke-tested, so the dedicated container can start from step 0 without re-deriving any of it. Every number below the curve is a _prior_ lane's (TRAIN.md, the 0.46-epoch runs) and is labelled as such.

## What was running when it was cut

```
HF_HOME=$PWD/hf OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OMP_WAIT_POLICY=PASSIVE KMP_BLOCKTIME=0 \
  ./.venv/bin/python -u train.py --model google/flan-t5-small \
    --data data/trainval.jsonl --out runs/flan-t5-small-conv/final \
    --epochs 6 --lr 3e-4 --batch 16 --accum 2 \
    --eval-steps 440 --dev-cap 128 --save-steps 440 --threads 2
```

`data/trainval.jsonl` is `data/train.jsonl` (14,043 rows, `split=train`) plus `data/val.jsonl` (2,213 rows, `split=validation`) concatenated with an explicit `split` field, so `train.py`'s `split_rows` uses the lane's own whole-template split instead of re-deriving one. It is byte-for-byte the same _content_ as the pre-existing `data/merged.jsonl` (16,256 rows); only the `split` marking differs. Effective batch 32 → **439 optimiser steps per epoch, 2,634 for 6 epochs.**

## Training curve (flan-t5-small, lr 3e-4, effective batch 32)

Training loss, logged every 20 steps. This is the whole curve that exists.

| epoch | step | train loss |
| ----- | ---- | ---------- |
| 0.05  | 20   | 3.942      |
| 0.09  | 40   | 2.342      |
| 0.14  | 60   | 1.536      |
| 0.18  | 80   | 1.181      |
| 0.23  | 100  | 0.900      |
| 0.27  | 120  | 0.812      |
| 0.32  | 140  | 0.701      |
| 0.36  | 160  | 0.601      |
| 0.41  | 180  | 0.564      |
| 0.46  | 200  | 0.501      |
| 0.50  | 220  | 0.481      |
| 0.55  | 240  | 0.456      |
| 0.59  | 260  | 0.417      |
| 0.64  | 280  | 0.392      |
| 0.68  | 300  | 0.363      |
| 0.73  | 320  | 0.353      |
| 0.77  | 340  | 0.313      |

**No validation loss exists**: the first eval was scheduled at step 440 with the first checkpoint, and the run did not reach it. So the curve above cannot distinguish learning from memorisation, and **nothing here says whether the earlier runs' grammar-shaped nonsense is fixed by convergence — that question is still open.** The one thing it does show is that the prior lane's 200-step budget stopped at loss ≈ 0.50 on a curve still falling steeply at 0.31 by step 340; at epoch 0.78 the model is nowhere near converged, which is consistent with, but not proof of, "undertrained" being the right diagnosis for TRAIN.md's numbers.

(Note the loss scale differs from TRAIN.md's run at the same epoch — 0.50 here at step 200 vs 0.89 there — because this run used effective batch 32 with 439 steps/epoch against that run's identical effective batch but a different step-to-epoch accounting; the curves are comparable by _epoch_, not by _step_.)

## Cost measured on this box (the reason the plan was descoped twice)

The box is 4 cores / 15 GB shared with an encoder lane also training on 2 threads; `uptime` load average was 5.4–8.4 throughout.

| thing | measured |
| --- | --- |
| flan-t5-small training, 2 threads, eff. batch 32 | **5.1–8.6 s/step**, ~4 samples/s |
| → one epoch (439 steps) | **~45–60 min** |
| → the briefed 6 epochs | **~4.0–5.8 h of wall time for this model alone** |
| unconstrained greedy decode, 434 turns, 2 threads | **108 s** (prior lane's log) |
| **masked** greedy decode (`LLGConstraint`), 1 thread, while training ran | **0.21–0.74 s/turn** → ~3–5 min for 434 turns |
| flan-t5-small checkpoint on disk (fp32) | ~300 MB; free disk on the box was **4.4 GB** |

The headline planning fact for the dedicated container: **the mask is cheap and training is the entire budget.** Decoding all four cells (greedy × masked × teacher × free) of a checkpoint costs well under 15 minutes; a single epoch of flan-t5-small costs an hour. Any plan that trades epochs for decode cells is trading the wrong way.

## Harness built and smoke-tested (ready to use, nothing to re-derive)

- **`infer_masked.py`** (new, this lane) — `infer.py`'s exact conventions (`"<prev canonical or NONE> ||| <utterance>"`, `--mode teacher|free`, raw output written before anything parses it) with the decode swapped to `llg_mask.generate_one`, i.e. greedy or beam decoding under `LLGLogitsProcessor`. It records per-turn `ms` for the latency table, the pre-close-out `emitted` string, and a `closed_out` flag; `UNPARSED` is written as an empty `canonical` and counted as a failed turn, never repaired. Flags: `--beams`, `--int8` (dynamic qint8 on `Linear`), `--limit`, `--threads`. Smoke-tested on 4 turns against the prior lane's 0.46-epoch checkpoint: 4/4 decoded, 0 unparsed, 0.21–0.74 s each, e.g. `show tasks during tomorrow`, `show it during this week`, `show the last thing I added that (sequence = "completed") that (count of activities = 4)`.
- **`sweep.sh <tag> <checkpoint-dir>`** (new, this lane) — decodes a checkpoint across {greedy, masked} × {teacher, free}, writes `out/<tag>.<decode>.<mode>.jsonl` and `logs/score-…`, with `OMP_WAIT_POLICY=PASSIVE` and 2 threads. Trim it to masked-free if the coordinator's round-1 scoping still holds.
- **`data/trainval.jsonl`** — the split-marked corpus described above.
- `target/debug/run-model` is already built on this box (not on the new one).

## Baseline this lane was to beat — PRIOR lane's numbers, not mine

From `TRAIN.md` (200 steps = 0.46 epoch per model, unconstrained greedy, free mode, scored by `score_outputs.py` and `run-model`):

| model         | suite parse | blind parse | holdout parse | exact |
| ------------- | ----------- | ----------- | ------------- | ----- |
| t5-small      | 37.9%       | 31.9%       | 26.3%         | 1/434 |
| flan-t5-small | 52.4%       | 47.2%       | 36.0%         | 0/434 |
| flan-t5-base  | 55.2%       | 61.1%       | 49.1%         | 0/434 |

|  | suite | blind | holdout |
| --- | --- | --- | --- |
| oracle ceiling | 120/120 | 60/60 | 73/78 |
| **tier-D parser floor** | **53/120** | **34/60** | **31/78** |
| best 0.46-epoch model (flan-t5-base, free) | 3/120 | 7/60 | 8/78 |
| best degenerate null (`BoardOnly`) | 5/120 | 4/60 | 0/78 |

Exact-match was ≤ 1/434 everywhere, so the leakage detector never fired; that remains true of this lane, which produced no decodes at all.

## What I did not do

- **Did not train to convergence, and did not produce a checkpoint.** Cut at epoch 0.78; the first save was at epoch 1.0.
- **Did not decode or score anything of my own** — no parse rate, no per-turn accuracy, no strict sessions, no exact-match, no latency p50/p95, no int8 size, and therefore no comparison against the tier-D floor or the 0.46-epoch numbers. There are no wrong-output quotes for this lane because there are no outputs.
- **Did not train t5-small** (dropped by the coordinator's first trim) and **did not train the from-scratch tiny transformer** (same trim). The tiny model remains, in my judgement, the most informative untried point: the canonical vocabulary is small, and at d_model 256 / 4 layers it is roughly 1/6 the per-sample cost of flan-t5-small, so it is the only configuration that can actually reach 6+ epochs in a few hours on a contended box.
- **Did not train flan-t5-base**: 250 M params ≈ 1 GB fp32, ~250 MB at int8, over the owner's 100 MB shipped-model budget unless int4 — noted, not measured.
- **Did not run beam=4 under the mask**, and did not run round 2 on `train+distill`. `data/distill.jsonl` did appear during this lane's run and was growing (141 KB at 08:54 → 12,467 rows at 09:18), but round 1 never finished, so the data-vs-epochs ablation has no round-1 arm to compare against.
- **Did not hit the known `check.py` bug** (`first N of …`, `count … Cmp N`, `next N days` raising `ValueError` through `canon_grammar.complete`): zero occurrences, because only 4 masked decodes were ever run. Not fixed, as instructed.
- Committed and pushed nothing.

## For whoever picks this up on the dedicated container

1. The one real risk to re-check is that **6 epochs may overfit**: training loss was 0.31 at epoch 0.78 and still falling, with no val loss to check it against. Set `--eval-steps 439 --save-steps 439` so every epoch is both evaluated and checkpointed, and keep the epoch checkpoints rather than only the last — with masked decode at ~4 minutes per corpus pass, the parse-and-executor score _per epoch_ is nearly free and is the actual answer to "what does convergence buy", which a single final checkpoint cannot give.
2. `train.py`'s `--save-steps 0` means "no intermediate checkpoint"; anything else saves with `save_total_limit=1`, which **deletes the previous epoch's checkpoint**. Copy each one aside as it lands if you want the per-epoch curve.
3. Use `decode.load_model` for training and for inference both — it adds the seven characters T5's SentencePiece vocabulary lacks (`{ } < \ ~ ^ \``) and resizes the embeddings; a checkpoint trained without it can only spell a `Cmd`as`<unk>`.
