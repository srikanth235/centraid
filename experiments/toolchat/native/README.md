# The native tool task

Issue [#1044](https://github.com/srikanth235/centraid/issues/1044). One model, Qwen3.5-0.8B, fine-tuned to drive the vault through eight tools (`SPEC.md`) with the slot trace (`CONTRACT_V3.md`), scored on held-out households. The target is 85% session pass on test; a session passes when every turn's effect matches its gold.

## The three numbers

Every checkpoint is scored by one script on three frozen sets (`eval/FROZEN.md`):

| set | sessions | what it tells |
| --- | --- | --- |
| trainfit | 300 (a fixed sample of train) | whether the model learned its own data |
| val | 655, seven held-out worlds | the number every fix is derived on |
| test | 656, the other half of the same pool | scored only at milestones |

A report gives sessions, clean turns (turns not downstream of a session's first failure: the steering metric) and all turns. Scoring is greedy; there is no voting.

## Layout

| path | what |
| --- | --- |
| `authored/` | training-data sources: `worlds/` (households), `sessions/` (recipe-authored sessions with reference calls), `build.py` (replays each session through the runtime and writes training records, train == inference), `split.py` (train worlds / val worlds), `gate.py` (hygiene), `dist.py` (train, val, test one distribution?), `coverage.py` (shape), `trace.py` + `trace3_check.py` (the slot trace and its round trip), `BRIEF.md` (how to author), `evalkit/` (how the held-out A to D sessions were authored and checked) |
| `eval/` | `sets/` (the frozen sets and `split.json`), `FROZEN.md`, `build_sets.py` (check, reference check, re-freeze), `sessions/` (provenance of the hand-written and e1 eval sessions), `worlds/` (A to D), `run.py` (single-session driver: `--model ref` verifies gold, `--model replay` re-sends a recorded run), `run_batched.py` (the batched greedy driver used on the GPU), `score.py`, `slices.py` (failed turns by class), `replay.py` (a recorded run through the current runtime, on CPU), `seed_worlds.py`, `lib.py`, `gold.py` |
| `train/` | `fmt.py` (prompt and trace rendering), `train.py` (SFT; `--ema D` saves a weight EMA beside every mark as `ckpt-NNN-ema`), `soup.py` (uniform weight average of checkpoints), `decode.py` (constrained decoding), `hf_backend.py`, `batching.py`, `bundle.py` (stages a job: code, runtime binary, data, `job.json`), `kernel.py` (runs the job on the VM), `smoke.py` (CPU end to end), `vm/` (GCP Spot: `launch.sh`, `watch.sh`, `bundles.sh`, `score_ckpt.sh`, `README.md`) |
| `data/` | the built artefacts of the current version: `train.jsonl.gz`, `train-val.jsonl.gz`, `README.md` (counts, hashes, the build command) |
| `render.py` | the renderer shared by the runtime export and the trainer |

The runtime is the Rust crate `crates/nativetools`; `NATIVETOOLS` names the binary the Python tools drive.

## The loop

1. Author or regenerate sessions; `authored/build.py` per train world; `authored/gate.py` and `authored/dist.py` on the gold.
2. `train/bundle.py build JOB --train data/train.jsonl.gz --val data/train-val.jsonl.gz`; `train/vm/launch.sh`; `train/vm/watch.sh`. The trainer's loss, order and marks defaults (decision weight 2, no loss on verbatim copies of the user's message, minimal pairs in one step, marks at 25 / 50 / 75 / 100 %) are in the `train/train.py` docstring; `--decision-weight 1 --copy-weight 1 --no-pair-batches` is the legacy loss and order.
3. `train/vm/bundles.sh` once per runtime build; `train/vm/score_ckpt.sh gs://.../out/ckpt-100 --sets trainfit,val` (ckpt-100 is the default mark; `train/vm/score_ckpt.sh gs://.../out --mark best` scores the mark with the lowest val decision loss, which the trainer names in `out/best.json`).
4. Diagnose on val: `eval/slices.py`, `eval/replay.py` for runtime changes (no model needed).
5. Test at a milestone only.

Decisions: `docs/decisions.md`, the #1044 section. Evidence: `receipts/issue-1044-*.md`. Where the work stands and what comes next: `HANDOFF.md`.
