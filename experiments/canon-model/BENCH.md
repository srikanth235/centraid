# CPU latency per canonical

```
cd experiments/canon-model
HF_HOME=$PWD/hf ./.venv/bin/python -u bench.py --n 50 --threads 4
```

**Box:** 4 CPU cores, 15 GB RAM, no GPU, Linux 6.18. Torch CPU, 4 threads, batch 1, warm model, `max_new_tokens=48`.

**Inputs:** the 50 real member utterances of the mapped turns (`crates/evalsuite/grammar/map.json`, `request` field) — not synthetic strings. Every generation is in `raw_bench.jsonl`.

**Contention:** `bench.py` polls `pgrep -f "cargo test"` and waits before timing. The table below was taken with no `cargo` or `rustc` process on the box (`ps -eo pid,args | grep -E "cargo|rustc"` empty, 1-minute load average 0.05 after the run) and reproduces an earlier run within noise.

| model | params | disk MB | precision | decode | p50 ms | p95 ms | RSS MB | int8 drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| google/flan-t5-small | 77M | 311 | fp32 | greedy | 103 | 512 | 1084 | - |
| google/flan-t5-small | 77M | 311 | fp32 | beam=4 | 246 | 923 | 1102 | - |
| google/flan-t5-small | 77M | 311 | int8 | greedy | 92 | 247 | 1104 | 46/50 differ |
| google/flan-t5-small | 77M | 311 | int8 | beam=4 | 253 | 749 | 1105 | 41/50 differ |
| t5-small | 60M | 244 | fp32 | greedy | 127 | 461 | 1091 | - |
| t5-small | 60M | 244 | fp32 | beam=4 | 270 | 787 | 1091 | - |
| t5-small | 60M | 244 | int8 | greedy | 127 | 450 | 1091 | 40/50 differ |
| t5-small | 60M | 244 | int8 | beam=4 | 200 | 596 | 1091 | 32/50 differ |

`disk MB` is the whole cached repo under `hf/hub`, weights and tokenizer together. `RSS MB` is the process, torch runtime included (~600 MB of it is torch itself, not the model) — it is an upper bound on the process, not the model's own footprint. `int8 drift` counts inputs where dynamic quantisation changed the decoded string; the models are untrained for this task, so it measures sensitivity, not damage.

## Grammar-constrained decoding is the number that matters, and it is missing

The table times **unconstrained** `generate`. What would ship is `constrained_generate`, where every step calls back into the parser:

| model                | precision | decode             | p50 ms | p95 ms |
| -------------------- | --------- | ------------------ | ------ | ------ |
| google/flan-t5-small | fp32      | constrained greedy | 85     | 897    |

**That row is not usable as a latency figure.** Only 2 of those 50 outputs parse (see VERIFY.md); the rest dead-end after a few tokens and are forced to stop, so the p50 is measuring short outputs, not correct ones. The one honest constrained measurement over full-length generations is the random-init verification run: 200 turns in 303 s, **~1.5 s per turn**, and that is with the mask cache warm within a single process.

## Is any of this "fast and offline" at a phone-class budget?

Taking a phone-class budget as a p95 under 300 ms on a mid-range device, and this 4-core x86 box as roughly two to four times a phone's per-core throughput:

- **Fast enough here, plausibly not on a phone.** `flan-t5-small` int8 greedy (p50 92 ms, p95 247 ms) is the only cell whose p95 is inside budget on this box. Scale it to phone-class silicon and the p95 lands around 0.5–1 s. It is the only candidate worth porting.
- **Not fast enough, any device.** Every `beam=4` cell: p95 596–923 ms on a 4-core desktop CPU. Beam search costs 2.4–2.8x greedy for no measured gain here.
- **Not fast enough, any device.** Both fp32 greedy cells: p95 461–512 ms, and the p50/p95 spread (5x) is output-length variance, which a _correct_ model would make worse, not better — these models emit short wrong answers today.
- **Not measured, and the blocker.** Grammar-constrained decoding, the mode that would actually ship, is ~1.5 s per turn. That is 15x the unconstrained greedy p50 and outside any phone-class budget. The cost is the per-step Python callback into `check.py`'s parser, not the model.

**Nothing in this matrix supports a "fast and offline" claim yet.** The one cell inside budget is measured without the constraint that makes the output legal, on a model that has not been trained. Both numbers have to hold at once before the claim is earned.

## Caveats

- p95 over 50 samples is the 47th value; treat it as indicative.
- `google/flan-t5-base` was cached and is **not** in this matrix — the brief names only `flan-t5-small` and `t5-small`.
- The models are untrained for this task. Latency depends on output length, and output length will change once they are trained.

## train.py on the real corpus

`train.py` runs end to end on Lane D's corpus, not just the synthetic smoke test. 150 optimiser steps on `data/train.jsonl`:

```
HF_HOME=$PWD/hf ./.venv/bin/python -u train.py --data data/train.jsonl \
  --out runs/lane-e-slice --max-steps 150 --batch 4 --accum 2 \
  --eval-steps 150 --dev-cap 64 --threads 2
```

- 11,937 train rows / 64 dev rows (whole templates held out; `--dev-cap` and `--max-steps` were added for this check)
- loss 4.43 → 3.02 → 2.34 → 2.17 → 1.79 → 1.74 → **1.65** over 150 steps
- 203 s, 5.9 samples/s, on 2 threads with the box otherwise busy
- eval at step 150: loss 1.198, exact 3.1%, skeleton 3.1%, parseable 23.4%

The pipeline is sound and loss moves. The numbers are 0.1 of an epoch and mean nothing about quality.

### For the training lane

```
HF_HOME=$PWD/hf ./.venv/bin/python -u train.py \
  --model google/flan-t5-small --data data/train.jsonl \
  --out runs/student --epochs 8 --lr 3e-4 --batch 4 --accum 8 \
  --eval-steps 500 --dev-cap 256 --threads 4
```

Three things to settle first:

1. **Use Lane D's own validation split.** `data/val.jsonl` is a separate file, and `train.py` only honours a `split` field _inside_ one file. Passing `train.jsonl` alone makes it carve its own 15% holdout by template and ignore `val.jsonl`. Concatenate the two with `"split": "validation"` on the val rows, or the run is scored against the wrong holdout.
2. **Cap `--dev-cap`.** `predict_with_generate` over all 2,213 dev rows costs ~15 s per 64 rows on this box — about nine minutes per eval.
3. **Budget.** 5.9 samples/s on 4 threads; 8 epochs over 14,043 rows is ~112,000 samples, so roughly 5–6 hours of CPU, plus evals.
