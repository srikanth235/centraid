# Fine-tuning the canonical student, and scoring it honestly (2026-09-22)

Three seq2seq models fine-tuned on Lane D's canonical-English corpus, decoded **unconstrained greedy**, parsed by `crates/evalsuite/grammar/check.py`, and scored through the real harness by a new candidate, `run-model`.

**Headline: every model is far below the tier-D no-model floor. The best of the three (`flan-t5-base`) reaches 3/120 strict on suite against tier-D's 53/120 and the oracle's 120/120.** The budget was 0.46 of an epoch per model — 5.7% of the 8 epochs BENCH.md plans for — and the reason is in [The budget actually spent](#the-budget-actually-spent). These numbers are a BASELINE AT 200 OPTIMISER STEPS, not a verdict on the approach.

## What was run

```
cd experiments/canon-model

# 1. Lane D's own split, in the one file train.py honours (BENCH.md's warning).
python3 - <<'EOF'
import json
out=open('data/merged.jsonl','w')
for p,s in (('data/train.jsonl','train'),('data/val.jsonl','validation')):
    for line in open(p):
        r=json.loads(line); r['split']=s; out.write(json.dumps(r)+'\n')
EOF
# 16,256 rows = 14,043 train + 2,213 validation

# 2. Training. Identical hyperparameters for all three; only --model differs.
#    OMP_WAIT_POLICY is not cosmetic -- see "The OpenMP finding" below.
export HF_HOME=$PWD/hf OMP_WAIT_POLICY=PASSIVE OMP_NUM_THREADS=2 \
       MKL_NUM_THREADS=2 KMP_BLOCKTIME=0
./.venv/bin/python -u train.py --model <M> --data data/merged.jsonl \
  --out runs/<name>/final --max-steps 200 --lr 3e-4 --batch 4 --accum 8 \
  --eval-steps 200 --dev-cap 128 --save-steps 0 --threads 2

# 3. A canonical for EVERY turn of all three corpora, both context modes.
./.venv/bin/python -u infer.py --model runs/<name>/final \
  --mode teacher|free --out out/<name>.<mode>.jsonl --threads 2

# 4. Parse rate + exact-match, through check.py itself.
./.venv/bin/python score_outputs.py out/<name>.<mode>.jsonl

# 5. The harness.
CARGO_INCREMENTAL=0 cargo run -q -p centraid-candidates --bin run-model -- \
  --outputs experiments/canon-model/out/<name>.<mode>.jsonl --corpus all
```

`lr` was **3e-4 for all three**; nothing was tuned per model. (`t5-small` is the one that arguably wanted a higher lr — the original T5 was pretrained with Adafactor and is known to want ~1e-3 — and it is also the worst of the three. That confound is not resolved here.)

Artefacts, all committed to disk under `experiments/canon-model/`:

| what | where |
| --- | --- |
| final checkpoints | `runs/{t5-small,flan-t5-small,flan-t5-base}/final` |
| training logs | `logs/train-*.log` |
| RAW generations, written before anything parsed them | `out/<model>.<mode>.jsonl` |
| parse/exact tables | `logs/score-*.txt` |
| harness reports | `logs/harness-*.txt` |

## Context threading: teacher-forced vs free-running

The corpus row format (`data/build.py`) is

```
input  = "<previous canonical or NONE> ||| <utterance>"
```

and `infer.py` builds exactly that string. For a multi-turn session the previous canonical can be either:

- **`--mode teacher`** — the GOLD previous canonical from `grammar/map.json`. Optimistic: the model is handed a correct context it did not earn.
- **`--mode free`** — the model's OWN previous output, raw and unrepaired. **This is the real number**, the one a seat would get.

Both were run for all three models. The spread between them is small (≤ 5 points of parse rate, ≤ 1 strict session) because 56% of suite and 83% of blind sessions are single-turn, where the two modes are identical by construction.

## The curve

### Parse rate (check.py) and exact-match against gold

A malformed or empty generation is a FAILED turn and is counted as one. No output was edited, completed or normalised. Zero empty generations in all six runs (434 turns each).

| model | mode | suite parse | blind parse | holdout parse | suite exact | blind exact | holdout exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t5-small | teacher | 38.7% (96/248) | 31.9% (23/72) | 32.5% (37/114) | 0.4% (1) | 0.0% | 0.0% |
| t5-small | **free** | 37.9% (94/248) | 31.9% (23/72) | 26.3% (30/114) | 0.4% (1) | 0.0% | 0.0% |
| flan-t5-small | teacher | 55.6% (138/248) | 44.4% (32/72) | 41.2% (47/114) | 0.0% | 0.0% | 0.0% |
| flan-t5-small | **free** | 52.4% (130/248) | 47.2% (34/72) | 36.0% (41/114) | 0.0% | 0.0% | 0.0% |
| flan-t5-base | teacher | 58.1% (144/248) | 62.5% (45/72) | 52.6% (60/114) | 0.0% | 0.0% | 0.0% |
| flan-t5-base | **free** | 55.2% (137/248) | 61.1% (44/72) | 49.1% (56/114) | 0.0% | 0.0% | 0.0% |

### Through the harness (`run-model`), free-running

| model | corpus | strict sessions | graded F1 | turns passed | door calls / rows / ms |
| --- | --- | --- | --- | --- | --- |
| t5-small | suite | **1/120 (0.8%)** | 5.4% | 8/248 | 2750 / 36,588 / 11,382 |
| t5-small | blind | **1/60 (1.7%)** | 2.1% | 1/72 | 61 / 8,203 / 1,180 |
| t5-small | holdout | **6/78 (7.7%)** | 8.9% | 8/114 | 68 / 14,704 / 2,408 |
| flan-t5-small | suite | **0/120 (0.0%)** | 6.2% | 10/248 | 169 / 44,247 / 12,551 |
| flan-t5-small | blind | **1/60 (1.7%)** | 2.3% | 1/72 | 48 / 12,693 / 5,473 |
| flan-t5-small | holdout | **4/78 (5.1%)** | 6.2% | 5/114 | 37 / 10,616 / 1,831 |
| flan-t5-base | suite | **3/120 (2.5%)** | 8.4% | 14/248 | 218 / 46,987 / 15,145 |
| flan-t5-base | blind | **7/60 (11.7%)** | 15.2% | 9/72 | 161 / 17,135 / 12,294 |
| flan-t5-base | holdout | **8/78 (10.3%)** | 12.2% | 12/114 | 708 / 19,918 / 5,207 |

Teacher-forced, for the same executor:

| model         | suite          | blind       | holdout     |
| ------------- | -------------- | ----------- | ----------- |
| t5-small      | 1/120, 6.0% F1 | 1/60, 2.1%  | 6/78, 8.9%  |
| flan-t5-small | 1/120, 5.9% F1 | 1/60, 2.3%  | 5/78, 7.1%  |
| flan-t5-base  | 3/120, 7.3% F1 | 7/60, 15.2% | 8/78, 12.2% |

### Against the floor and the ceiling

|  | suite | blind | holdout |
| --- | --- | --- | --- |
| oracle ceiling (gold canonical + same executor) | 120/120 | 60/60 | 73/78 |
| tier-D parser floor (no model) | 53/120 | 34/60 | 31/78 |
| **best trained model (flan-t5-base, free)** | **3/120** | **7/60** | **8/78** |
| best degenerate null (`BoardOnly`) | 5/120 | 4/60 | 0/78 |

**A 200-step model is beaten by the hand-written tier-D parser by a factor of 4 to 18, and on suite it does not even beat the best null.** It clears the null on blind and holdout only.

`run-model` was validated before use by feeding it the 434 GOLD canonicals: it returned **120/120 strict, 100.0% graded, 248/248 turns on suite** — bit-identical to `run-oracle`'s ceiling. The candidate wiring is therefore not the thing losing the points. (`out/_selftest-gold.jsonl`.)

## The outputs are genuinely wrong, not mis-formatted

Exact-match is 0.0% in 16 of the 18 model x corpus x mode cells (the other two are 1 turn of 248). It is worth being precise about _why_, because a 0 that is really a missing bracket would be a different finding from a 0 that is really a wrong meaning. Both are present, and the second dominates.

**t5-small** — mostly the right verb, a systematically missing set parenthesis, and hallucinated command names:

```
req   what's on my calendar tomorrow?
out   show events during tomorrow                     gold  show (events during tomorrow)
req   do I have anything on Wednesday?
out   show events during Wednesday                    gold  show (events during 2026-06-17)
req   reschedule the cabin booking to friday
out   schedule.reschedule_case{ on cabins during 2026-06-15
gold  reschedule{to: 2026-06-19} on (things called "Book the Tahoe cabin")
req   no, the other one
out   schedule.reschedule_case_case of the other one that (created_at during 2026-06-15)
gold  reschedule{to: 2026-06-19} on (tasks called "Book the Tahoe cabin")
```

**flan-t5-small** — same structural failures plus the wrong entity kind, and it latches onto one wrong command and repeats it across a whole session:

```
req   what's on my calendar tomorrow?
out   show tasks during tomorrow                      gold  show (events during tomorrow)
req   reschedule the cabin booking to friday
out   schedule.reschedule_at of cabins during today
gold  reschedule{to: 2026-06-19} on (things called "Book the Tahoe cabin")
req   the calendar one
out   schedule.reschedule_at of cabins during today
gold  reschedule{to: 2026-06-19T09:00} on (events called "Book the Tahoe cabin")
```

**flan-t5-base** — the best of the three, and it gets whole simple turns structurally right (including resolving "Wednesday" to a date), but invents arguments and never produces a quoted literal:

```
req   do I have anything on Wednesday?
out   show events during 2026-06-17                   gold  show (events during 2026-06-17)   [only the parens]
req   what's on my calendar tomorrow?
out   show important dates during tomorrow            gold  show (events during tomorrow)
req   reschedule the cabin booking to friday
out   schedule.reschedule_event{ shift: 00:06 } on cabin booking during 2026-06-19
gold  reschedule{to: 2026-06-19} on (things called "Book the Tahoe cabin")
```

Three failure modes, in rough order of cost:

1. **No literal grounding.** Not one output anywhere quotes a handle from the world (`"Book the Tahoe cabin"`). The model has never been shown this world's names, so every turn that needs one is lost whatever the shape is.
2. **Invented `Cmd` names.** `schedule.reschedule_case`, `schedule.reschedule_at`, `schedule.reschedule_event`, and an invented `shift:` argument. At 200 steps the command vocabulary is not memorised.
3. **A missing set parenthesis** on otherwise-correct `show` turns. This one IS a formatting failure, it is what most of the 42–64% unparseable is, and it is exactly what the grammar mask would fix for free.

That third point is the one bright spot: **the parse rate here is the unconstrained lower bound, and the grammar mask (VERIFY.md, another lane) raises it and cannot lower it.** Points 1 and 2 it will not fix.

## Exact-match as a leakage detector

The brief asks for exact-match as a leakage probe: if suite exact-match were much higher than holdout, some suite text would have reached training.

**It is 0.0% on every corpus for `flan-t5-small` and `flan-t5-base`, and 0.4% (1 turn of 248) on suite for `t5-small` with 0.0% on blind and holdout.** There is no suite-over-holdout gap to explain, so this probe finds **no leakage**. That is a weak result rather than a strong clearance — a model that gets nothing right cannot demonstrate that it also did not cheat — but it is consistent with the isolation statement at the bottom of this file.

The more interesting reading is the _other_ gap. On the held-out templates of Lane D's own corpus, `flan-t5-base` scores **41.4% exact**; on the real member utterances of the three corpora it scores **0.0%**. The model learned Lane D's paraphrase generator, not English. That is a training-DATA finding, not a training-BUDGET one, and more epochs will not obviously close it.

## Dev metrics at the end of training (train.py's own eval, 128 dev rows)

| model         | eval loss   | exact     | skeleton  | parseable |
| ------------- | ----------- | --------- | --------- | --------- |
| t5-small      | not scored* | —         | —         | —         |
| flan-t5-small | 0.606       | 16.4%     | 18.0%     | 67.2%     |
| flan-t5-base  | **0.256**   | **41.4%** | **49.2%** | **81.3%** |

\* `t5-small` was stopped at its step-200 checkpoint before its first scheduled eval fired (see below), so it has no dev row. Its corpus numbers above are measured the same way as the other two and are not affected.

Scale helps, monotonically and by a lot, on every metric measured — dev loss, dev exact, corpus parse rate, strict sessions. **`flan-t5-base` is 2.5x better than `flan-t5-small` on dev exact at the identical budget.** If this line of work continues, the next run should be `flan-t5-base` for longer, not more `small`.

## The budget actually spent

Planned (BENCH.md): 8 epochs x 14,043 rows per model. Delivered:

| model | optimiser steps | samples | epochs | wall time |
| --- | --- | --- | --- | --- |
| t5-small | 200 | 6,400 | 0.46 | ~63 min (contended) |
| google/flan-t5-small | 200 | 6,400 | 0.46 | 28 min |
| google/flan-t5-base | 200 | 6,400 | 0.46 | 52 min |

**The budget is 0.46 of an epoch, uniform across the three models — 5.7% of the 8 epochs BENCH.md recommends.** Saying so is the point: nothing here should be read as "seq2seq cannot do this".

Two things forced it, and both are findings in their own right.

### The OpenMP finding — a 15x wall-clock defect, not a CPU-share effect

The box is shared with other lanes. With another torch process running, training slowed from 2.8 s/step to **142 s/step** — a 50x collapse that CPU sharing cannot explain (both processes were getting ~190% of 400%). The cause is OpenMP's default `ACTIVE` wait policy: two torch processes each with 4 threads on 4 cores spin-wait at every barrier.

Measured A/B, same contention, same model, same data:

| setting | s/step |
| --- | --- |
| `--threads 4`, OMP defaults | 142 |
| `OMP_WAIT_POLICY=PASSIVE OMP_NUM_THREADS=2 KMP_BLOCKTIME=0`, `--threads 2` | **9.2** |

**Any lane running torch on this box should export `OMP_WAIT_POLICY=PASSIVE` and half the cores.** Everything after the A/B was run that way. The first ~63 minutes of `t5-small` were not, which is why its wall time is three times `flan-t5-small`'s for identical work.

### Disk

The workspace filled to 100% mid-run (`target/` at 13 GB, plus three lanes' checkpoints). Two `run-model` invocations died on `No space left on device` and were re-run after freeing 4 GB. `train.py` gained a `--save-steps` flag (`0` = save only the final model) so `flan-t5-base` did not have to hold two 3 GB optimiser checkpoints; `save_total_limit` went 2 -> 1. No check was weakened: the flag only controls intermediate checkpointing.

## Latency — NOT DELIVERED CLEANLY

The brief asks for the trained `flan-t5-small` at int8 greedy, p50/p95 over 50 corpus utterances, on an idle box. The run was started on a verified-idle box (1-minute load average 0.57) and **three other lanes began training on it while the benchmark was in flight** (load average 7.80 by the second row).

The one row that completed, and it is contaminated:

| model | precision | decode | p50 ms | p95 ms | RSS MB |
| --- | --- | --- | --- | --- | --- |
| runs/flan-t5-small/final | fp32 | greedy, `max_new_tokens=96` | 597 | 8,631 | 958 |

**Do not quote that p95.** An 8.6 s tail on a model whose untrained fp32 greedy p95 was 512 ms (BENCH.md) is the other lanes' load, not the model. The int8 row was never reached. `raw_bench_trained.jsonl` holds the generations that were timed.

What can be said without measuring: the trained model's outputs are _longer_ than the untrained ones (the untrained model emitted 2-3 character fragments), and T5 decode time is linear in output length, so the trained model's honest latency is **above** BENCH.md's untrained 92 ms / 247 ms int8 greedy figures, not below. Re-measuring is a ten-minute job on a quiet box and should be done before any "fast and offline" claim.

## Contradictions with the assumptions I was given

1. **`google/flan-t5-base` is only 1.4x slower per step than the smalls**, not 3x — 7.5 s/step vs 5.4 s/step on an idle box. It was left out of BENCH.md's matrix as too expensive; at equal step budgets it is the cheapest way to buy accuracy here and should be in the matrix.
2. **The 5.9 samples/s figure is not stable.** `t5-small` ran at 11.4 samples/s alone and at 0.22 samples/s under OpenMP contention. Any budget derived from a single throughput measurement on this box is unreliable; pin the OMP settings first.
3. **Free-running is barely worse than teacher-forced.** The brief expected free-running to be the meaningfully harder number. It costs ≤ 5 points of parse rate and at most one strict session, because the corpora are mostly single-turn. The multi-turn error compounding this was meant to expose is not measurable at this corpus's turn depth.
4. **`--dev-cap` is load-bearing beyond cost.** BENCH.md flags it as a time saver; it also means the dev `exact` reported above is over 128 rows of 2,213, so ±4 points of sampling noise.

## Rules of evidence

- Every generation was written to `out/<model>.<mode>.jsonl` **before** anything parsed it. The files are the raw decode.
- No output was edited, completed, re-prompted or dropped. No finisher was used — this is unconstrained greedy, as instructed.
- Empty and malformed generations are counted as failed turns. There were 0 empty and 1,393 malformed (of 2,604 generations) across the six runs, all counted.
- Two `run-model` runs failed on a full disk and were re-run to completion; no partial report is quoted.
- Every bad number is in this file, including the contaminated latency row and the 0/120 cell.

## Corpus isolation

`crates/evalsuite/suite.json`, `blind.json` and `holdout.json` were **never opened** by this lane, for any purpose. `crates/evalsuite/grammar/map.json` was read for exactly three fields — `request` (the member's words, the model's input), `canonical` (gold, used as teacher-forced context in `--mode teacher` and for the exact-match column) and the `corpus`/`session`/`turn` keys. **None of it reached training**: training saw only `data/merged.jsonl`, which is Lane D's generated corpus. The one place gold was fed to the executor is `out/_selftest-gold.jsonl`, the validation that `run-model` reproduces the oracle's ceiling, and it is labelled as such.

## The candidate

`crates/candidates/src/model.rs` (`ModelCanonical`) and `crates/candidates/src/bin/run-model.rs`, plus `model_report()` in `crates/candidates/src/lib.rs`. It is `OracleCanonical` with the `map.json` lookup replaced by a lookup into a model-output JSONL; `exec.rs` is untouched and still cannot tell which corpus it is running. A turn with no row in the file, and a canonical that does not parse, are both `Plan::Declined` — failures, never skips.
