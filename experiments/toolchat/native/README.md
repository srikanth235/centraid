# The native tool task

Issue [#1044](https://github.com/srikanth235/centraid/issues/1044). One model, Qwen3.5-0.8B, fine-tuned to drive the vault through eight tools (`SPEC.md`) with the slot trace (`CONTRACT_V3.md`), scored on held-out households. The target is 85% session pass on test; a session passes when every turn's effect matches its gold.

## The two sets

Every checkpoint is scored by one script on two frozen sets (`eval/FROZEN.md`):

| set | sessions | what it tells |
| --- | --- | --- |
| val | 655, seven held-out worlds | the number every fix is derived on |
| test | 656, the other half of the same pool | scored only at milestones |

A report gives sessions, clean turns (turns not downstream of a session's first failure: the steering metric) and all turns. Scoring is greedy; there is no voting.

## Layout

| path | what |
| --- | --- |
| `authored/` | training-data sources: `worlds/` (households), `sessions/` (recipe-authored sessions with reference calls), `build.py` (replays each session through the runtime and writes training records, train == inference), `park_oracle.py` (replays the reference calls of train-world sessions twice, once as a run and once with `nativetools session --writes park --auto-confirm` or `--writes shadow`, and holds the parked observation, the effect and the confirmed after-write text to the run's, step for step: the proof under R-1088-6; `python3 -I authored/park_oracle.py --vaults DIR --bin nativetools [--a-bin BASE] W ...`), `split.py` (train worlds / val worlds), `gate.py` (hygiene), `dist.py` (train, val, test one distribution?), `coverage.py` (shape), `trace.py` + `trace3_check.py` (the slot trace and its round trip), `BRIEF.md` (how to author), `evalkit/` (how the held-out A to D sessions were authored and checked) |
| `eval/` | `sets/` (the frozen sets and `split.json`), `FROZEN.md`, `build_sets.py` (check, reference check, re-freeze), `rollout.py` (the rollout driver: screen and sample sets, RFT records and DPO pairs from scored runs; `test_rollout.py`), `sessions/` (provenance of the hand-written and e1 eval sessions), `worlds/` (A to D), `run.py` (single-session driver: `--model ref` verifies gold, `--model replay` re-sends a recorded run), `run_batched.py` (the batched greedy driver used on the GPU), `score.py`, `slices.py` (failed turns by class), `replay.py` (a recorded run through the current runtime, on CPU), `seed_worlds.py`, `lib.py`, `gold.py` |
| `train/` | `fmt.py` (prompt and trace rendering), `train.py` (SFT; `--ema D` saves a weight EMA beside every mark as `ckpt-NNN-ema`; `--dpo PAIRS` runs DPO against the frozen initial model), `soup.py` (uniform weight average of checkpoints), `decode.py` (free decoding over tokens: the think guard, the call rendered from the think, one call per message; SPEC §9; the same step over text, for any engine, is `crates/assist/src/native/step.rs`), `hf_backend.py`, `batching.py`, `bundle.py` (stages a job: code, runtime binary, data, `job.json`; `--continue-from gs://CKPT` is the continuation preset: init from it, 1 epoch, lr 4e-6, min-lr 0.05, warmup 0.02, ema 0.999), `kernel.py` (runs the job on the VM), `smoke.py` (CPU end to end), `vm/` (GCP Spot: `launch.sh`, `watch.sh`, `bundles.sh`, `score_ckpt.sh`, `README.md`) |
| `data/` | the built artefacts of the current version: `train.jsonl.gz`, `train-val.jsonl.gz`, `README.md` (counts, hashes, the build command) |
| `render.py` | the Python face of the one renderer, `crates/assist/src/native/transcript.rs` (#1088): `render`, `render_prompt_for_generation`, `call_text` and `user_content` are thin wrappers that ask the runtime through `runtime_think` (`nativetools think`, ops `render`, `prompt`, `call_text`, `user_content`); what stays here is the HF tokenizer and `tokens_with_loss`. The tokenizer id and the chat markers are `identity.json` of the export, not literals (read from `export/` beside it in a job tree, else from `contracts/assist/export/`). `train/render_golden.py` writes the goldens the Rust renderer is tested against (`crates/assist/tests/transcript_golden.rs`), from the last Python renderer in git history |

The runtime is `centraid_assist::native` (`crates/assist/src/native/`, #1088); `crates/nativetools` keeps the `nativetools` binary the Python tools drive (`NATIVETOOLS` names it), the world seeder and the export. Its export (`nativetools export DIR`: tool schemas, kind card, tables, rendered prompts, `identity.json`) is committed under `contracts/assist/export/` and checked against a fresh export by `crates/nativetools/tests/export_fixture.rs`; `bundle.py` still ships a fresh export in the job tree.

## Tests

The Python tests (`test_*.py` at the top level and in `authored/`, `authored/gen/`, `eval/` and `train/`: 27 modules, no model weights and no GPU) run on every pull request as the `native-python` job of `.github/workflows/gate.yml`, outside `cargo xtask gate`. The job builds `nativetools`, installs `requirements-ci.txt` by hash, caches the Qwen3.5-0.8B tokenizer and config offline, seeds world A and runs `python3 run_cpu_tests.py`, whose docstring lists the environment it needs. The script runs the modules four at a time (`--jobs N`), slowest first, each module's output printed whole, and fails on any skipped or red test. `train/smoke.py` and everything under `train/vm/` need the model's weights or a GPU and run in no CI job. The Rust tests that read this tree (`crates/nativetools/tests/think.rs` reads `authored/golden_v3.json`) run in the `gate` job, and gitleaks scans the whole tree there with the synthetic worlds allowlisted by path in `.gitleaks.toml` (D-1044-19).

## The loop

1. Author or regenerate sessions; `authored/build.py` per train world; `authored/gate.py` and `authored/dist.py` on the gold.
2. `train/bundle.py build JOB --train data/train.jsonl.gz --val data/train-val.jsonl.gz`; `train/vm/launch.sh`; `train/vm/watch.sh`. The trainer's loss, order and marks defaults (decision weight 2, no loss on verbatim copies of the user's message, minimal pairs in one step, marks at 25 / 50 / 75 / 100 %) are in the `train/train.py` docstring; `--decision-weight 1 --copy-weight 1 --no-pair-batches` is the legacy loss and order.
3. `train/vm/bundles.sh` once per runtime build; `train/vm/score_ckpt.sh gs://.../out/ckpt-100 --sets val` (ckpt-100 is the default mark; `train/vm/score_ckpt.sh gs://.../out --mark best` scores the mark with the lowest val decision loss, which the trainer names in `out/best.json`).
4. Diagnose on val: `eval/slices.py`, `eval/replay.py` for runtime changes (no model needed).
5. Test at a milestone only.

## Rollouts: the model's own sessions as training data

`eval/rollout.py` is the CPU side of rejection-sampling fine-tuning and DPO: the GPU runs are `score_ckpt.sh` runs, so a set file is all they need. The set files are `eval/sets/roll-screen.jsonl` and `roll-sample.jsonl` (not frozen sets: `build_sets.py check` and `FROZEN.md` do not read them). The sets are gold of the build's `--gold-from-ref` output (only the sessions that verified); the worlds they were built on (the collision worlds, `build.py --worlds-dir`) go into the scoring bundle through `BUNDLE_WORLDS`, and the sample bundle runs with `NATIVE_SAMPLE=1` through `BUNDLE_EVAL_ENV`. `export` replays each kept rollout through the runtime that scored it, so run it with that binary. The method (what a pair is, what a record keeps) is in the module docstring.

```
# 1. screen set: every session once, greedy (B = the build outputs, W = their worlds dir, NT = the runtime binary the bundle ships)
python3 eval/rollout.py sets --built $B/built $B/built-k1 --tokens
BUNDLE_NATIVETOOLS=$NT BUNDLE_WORLDS=$W train/vm/bundles.sh --sets roll-screen
# 2. score the screen set (the owner launches; --new-vm leaves no metadata to remove from the training VM); fetch score/<NAME>/roll-screen/{run.jsonl,report.json}
JOB=<job> BUCKET=<bucket> train/vm/score_ckpt.sh $CKPT --name roll-screen --sets roll-screen --bundles-prefix bundles-roll --new-vm
# 3. sample set: k copies (ids <id>-s<k>) of every failed session and a seeded 0.3 of the passing ones
python3 eval/rollout.py sets --sample --screen-report screen/report.json [-k 6] [--frac 0.3] [--seed 1044]
BUNDLE_NATIVETOOLS=$NT BUNDLE_WORLDS=$W BUNDLE_EVAL_ENV='{"NATIVE_SAMPLE": "1"}' train/vm/bundles.sh --sets roll-sample
# 4. score the sample set (same checkpoint, a new --name; temperature 0.6, top-p 0.95)
JOB=<job> BUCKET=<bucket> train/vm/score_ckpt.sh $CKPT --name roll-sample --sets roll-sample --bundles-prefix bundles-roll --new-vm
# 5. export: rft.jsonl.gz (up to -m 2 passing rollouts per session), dpo.jsonl.gz (up to -p 2 pairs), summary.json
NATIVETOOLS=$NT python3 eval/rollout.py export --screen-run screen/run.jsonl --screen-report screen/report.json \
    --sample-run sample/run.jsonl --sample-report sample/report.json --worlds $W --out OUT [-m 2] [-p 2]
```

Decisions: `docs/decisions.md`, the #1044 section. Evidence: `receipts/issue-1044-*.md`. Where the work stands and what comes next: `HANDOFF.md`.

## Artefacts

The built and frozen files of this task are not source (R-1088-14). `artefacts.json` lists each one: logical name, path, sha256, size, where it comes from, and how it comes back. `artefacts.py` is the one tool, standard library only except the Hub calls (`huggingface_hub`, pinned by hash in `requirements-ci.txt`); the token is read from `HF_TOKEN` and from nowhere else.

| class | files | MB | how it comes back |
| --- | --- | --- | --- |
| source (stays in the tree) | `authored/sessions/` 469 and `eval/sessions/` 26 (the authored, hand-written and e1 session sources), the 42 world builders | 6.9 | not applicable |
| regenerable | 45 world JSON files (`authored/worlds/T*.json`, `eval/worlds/A..G.json`) and the 7 keys files a fresh seeding reproduces (A B C D T03 T12 T23) | 5.2 | the manifest's `rebuild` command: the world's builder, then `artefacts.py format` (the repository's JSON layout); `eval/seed_worlds.py` for a keys file. All 52 rebuild byte for byte (`artefacts.py verify-rebuild`) |
| frozen | `eval/sets/` 5 files, `data/` 2 files, the 38 keys files whose ids a fresh seeding no longer gives | 17.2 | a private Hugging Face Hub dataset repository, at the revision the manifest records |

```
python3 artefacts.py check                      # every file in place and equal to the manifest
python3 artefacts.py fetch [--dry-run]          # materialise what is missing, at the original paths, each file verified
python3 artefacts.py fetch --rebuild-only       # no token: the regenerable files only
python3 artefacts.py verify-rebuild             # rebuild the regenerable files in a scratch copy, compare bytes
python3 artefacts.py verify-hub                 # download the frozen files at their revision, compare sha256
```

`fetch` needs `NATIVETOOLS` for the keys files (they seed from the world JSON) and `HF_TOKEN` for the frozen ones. A file that is present but differs is never overwritten without `--force`, and a download or rebuild whose bytes differ fails and leaves nothing at the path. The tests that read the keys file of a train world (`authored/gen/test_gen.py`, `eval/test_build_sets.py`) need the frozen ones: nothing in the CPU suite reads `eval/sets/` or `data/`.

The owner's steps, once, from the repository root:

```
HF_TOKEN=... python3 experiments/toolchat/native/artefacts.py upload --repo srikanth235/centraid-native-data
git add experiments/toolchat/native/artefacts.json && git commit -m "build(native): record the Hub revision of the frozen artefacts (#1088)"
HF_TOKEN=... NATIVETOOLS=target/debug/nativetools experiments/toolchat/native/move_out.sh
```

`upload` creates the dataset repository private when it is missing, refuses one that is public, sends the 45 frozen files in one commit and writes the commit id into the manifest. `move_out.sh` checks that the manifest records it, moves every file aside, fetches them back (rebuilds and downloads) and checks them, and only then takes them out of the index, writes the `.gitignore` block (`artefacts.py gitignore`), applies `move_out.gate.patch` (the `native-python` job runs `fetch` before it seeds world A, rebuilding only when the secret is absent) and removes itself and the patch. It commits nothing.
