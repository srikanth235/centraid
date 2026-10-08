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
| `authored/` | training-data sources: `worlds/` (households), `sessions/` (recipe-authored sessions with reference calls; the val worlds' T03, T12 and T23 are held out, "Data versions" below), `build.py` (replays each session through the runtime and writes training records, train == inference), `park_oracle.py` (replays the reference calls of train-world sessions twice, once as a run and once with `nativetools session --writes park --auto-confirm` or `--writes shadow`, and holds the parked observation, the effect and the confirmed after-write text to the run's, step for step: the proof under R-1088-6; `python3 -I authored/park_oracle.py --vaults DIR --bin nativetools [--a-bin BASE] W ...`), `split.py` (train worlds / val worlds), `gate.py` (hygiene), `dist.py` (train, val, test one distribution?), `coverage.py` (shape), `trace.py` + `trace3_check.py` (the slot trace and its round trip), `BRIEF.md` (how to author), `evalkit/` (how the held-out A to D sessions were authored and checked) |
| `eval/` | `sets/` (the frozen sets and `split.json`), `FROZEN.md`, `build_sets.py` (check, reference check, re-freeze), `rollout.py` (the rollout driver: screen and sample sets, RFT records and DPO pairs from scored runs; `test_rollout.py`), `worlds/` (A to G, held out: from the data version), `run.py` (single-session driver: `--model ref` verifies gold, `--model replay` re-sends a recorded run), `run_batched.py` (the batched greedy driver used on the GPU), `score.py`, `slices.py` (failed turns by class), `replay.py` (a recorded run through the current runtime, on CPU), `seed_worlds.py`, `lib.py`, `gold.py` |
| `train/` | `fmt.py` (prompt and trace rendering), `train.py` (SFT; `--ema D` saves a weight EMA beside every mark as `ckpt-NNN-ema`; `--dpo PAIRS` runs DPO against the frozen initial model), `soup.py` (uniform weight average of checkpoints), `decode.py` (free decoding over tokens: the think guard, the call rendered from the think, one call per message; SPEC §9; the same step over text, for any engine, is `crates/assist/src/native/step.rs`), `hf_backend.py`, `batching.py`, `bundle.py` (stages a job: code, runtime binary, data, `job.json`; `--continue-from gs://CKPT` is the continuation preset: init from it, 1 epoch, lr 4e-6, min-lr 0.05, warmup 0.02, ema 0.999), `kernel.py` (runs the job on the VM), `smoke.py` (CPU end to end), `vm/` (GCP Spot: `launch.sh`, `watch.sh`, `bundles.sh`, `score_ckpt.sh`, `README.md`) |
| `data/` | the r1 training build as trained, materialised from the data version: `train.jsonl.gz`, `train-val.jsonl.gz`, and `README.md` (counts, hashes, the build command) |
| `render.py` | the Python face of the one renderer, `crates/assist/src/native/transcript.rs` (#1088): `render`, `render_prompt_for_generation`, `call_text` and `user_content` are thin wrappers that ask the runtime through `runtime_think` (`nativetools think`, ops `render`, `prompt`, `call_text`, `user_content`); what stays here is the HF tokenizer and `tokens_with_loss`. The tokenizer id and the chat markers are `identity.json` of the export, not literals (read from `export/` beside it in a job tree, else from `contracts/assist/export/`). `train/render_golden.py` writes the goldens the Rust renderer is tested against (`crates/assist/tests/transcript_golden.rs`), from the last Python renderer in git history |

The runtime is `centraid_assist::native` (`crates/assist/src/native/`, #1088); `crates/nativetools` keeps the `nativetools` binary the Python tools drive (`NATIVETOOLS` names it), the world seeder and the export. Its export (`nativetools export DIR`: tool schemas, kind card, tables, rendered prompts, `identity.json`) is committed under `contracts/assist/export/` and checked against a fresh export by `crates/nativetools/tests/export_fixture.rs`; `bundle.py` still ships a fresh export in the job tree.

## Tests

The Python tests (`test_*.py` at the top level and in `authored/`, `authored/gen/`, `eval/` and `train/`: 27 modules, no model weights and no GPU) run on every pull request as the `native-python` job of `.github/workflows/gate.yml`, outside `cargo xtask gate`. The job builds `nativetools`, installs `requirements-ci.txt` by hash, caches the Qwen3.5-0.8B tokenizer and config offline, rebuilds the public worlds (`artefacts.py fetch --public-only`) and runs `python3 run_cpu_tests.py`, whose docstring lists the environment it needs. The suite reads no held-out file and needs no Hub token: a test that needs a seeded household seeds a public train world into a temporary directory (`eval/pubworld.py`), the unit tests of the scorer and the gold conventions run on a made-up one (`eval/fixture_world.py`), and no test writes a tracked file. The script runs the modules four at a time (`--jobs N`), slowest first, each module's output printed whole, and fails on any skipped or red test. `train/smoke.py` and everything under `train/vm/` need the model's weights or a GPU and run in no CI job. The Rust tests that read this tree (`crates/nativetools/tests/think.rs` reads `authored/golden_v3.json`) run in the `gate` job, and gitleaks scans the whole tree there with the synthetic worlds allowlisted by path in `.gitleaks.toml` (D-1044-19).

## The loop

1. Author or regenerate sessions; `authored/build.py` per train world; `authored/gate.py` and `authored/dist.py` on the gold.
2. `train/bundle.py build JOB --train data/train.jsonl.gz --val data/train-val.jsonl.gz --data-version data-vN` (`--data-version` is metadata only: it lands in `train_meta.json` and the model card); `train/vm/launch.sh`; `train/vm/watch.sh`. The trainer's loss, order and marks defaults (decision weight 2, no loss on verbatim copies of the user's message, minimal pairs in one step, marks at 25 / 50 / 75 / 100 %) are in the `train/train.py` docstring; `--decision-weight 1 --copy-weight 1 --no-pair-batches` is the legacy loss and order.
3. `train/vm/bundles.sh` once per runtime build; `train/vm/score_ckpt.sh gs://.../out/ckpt-100 --sets val` (ckpt-100 is the default mark; `train/vm/score_ckpt.sh gs://.../out --mark best` scores the mark with the lowest val decision loss, which the trainer names in `out/best.json`).
4. Diagnose on val: `eval/slices.py`, `eval/replay.py` for runtime changes (no model needed).
5. Test at a milestone only.

## Rollouts: the model's own sessions as training data

`eval/rollout.py` is the CPU side of rejection-sampling fine-tuning and DPO: the GPU runs are `score_ckpt.sh` runs, so a set file is all they need. The set files are `eval/sets/roll-screen.jsonl` and `roll-sample.jsonl` (not frozen sets: `build_sets.py check` and `FROZEN.md` do not read them). The sets are gold of the build's `--gold-from-ref` output (only the sessions that verified); the worlds they were built on (the collision worlds, `build.py --worlds-dir`) go into the scoring bundle through `BUNDLE_WORLDS`, and the sample bundle runs with `NATIVE_SAMPLE=1` through `BUNDLE_EVAL_ENV`. The screen set and its worlds (with their keys) are part of the data version (`screen/`, "Data versions" below): `fetch` brings the set back, and the worlds are read from the version's `screen/worlds/`. `python3 authored/gen/collide.py --out DIR --keys` builds collision worlds and their keys from public sources only (`NATIVETOOLS`; the density targets are the kept numbers `TARGETS`); the worlds of the data-v7 screen set were built from an earlier state of `authored/sessions/` (the twins are the names the sessions reference) and seeded by an earlier runtime, so the command gives different twin rows and ids (11 of the 35 worlds come out byte for byte when the `_p*` and `_k*` session files are left out), and the version keeps the originals. `export` replays each kept rollout through the runtime that scored it, so run it with that binary. The method (what a pair is, what a record keeps) is in the module docstring.

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

## Data versions

The task's data is versioned (R-1088-16). A **data version** is one tag (`data-vN`) on the private Hugging Face dataset repository `srikanth235/centraid-native-data`, and it holds everything one from-scratch run trained and was judged on:

```
version.json                                       version, parent, made, git commit; the runtime (label, commit, binary and export hashes);
                                                   vault_ddl_sha256 (contracts/migrations/*.sql); registry_sha256 (contracts/assist/export/metadata.json:
                                                   the commands the runtime maps its verbs to); the seeds; the refreeze report; a note per training build;
                                                   the sha256 and size of every file
train/<name>/train.jsonl.gz, train-val.jsonl.gz    each training build exactly as trained, with the trainer's own validation slice
eval/val.jsonl, test.jsonl, split.json             val and test as its refreeze report records them: refrozen against its vault and runtime, or kept as frozen (data-v7's test v6)
screen/roll-screen.jsonl, screen/worlds/*          the RFT screen set and the worlds it ran in (with their keys)
worlds/<id>.json                                   every world as built now, train and held-out (no keys)
sources/<tree path>                                the held-out sources: the world builders (eval/worlds/*_build.py, build_worlds.py, authored/worlds/T03, T12, T23) and the
                                                   authored sessions of the val worlds (authored/sessions/T03*.py, T12*.py, T23*.py)
```

A promoted model is a revision of a private Hub **model** repository whose card names its data tag, its git commit and its config. The tree keeps sources and `artefacts.json`, which pins the version in use (`data`: repository, tag, and the commit the tag points at) and lists every file the tree materialises: its tree path, its path in the version, its sha256 and size, and how it comes back. **The public CI reads no held-out file and needs no Hub token.** Not kept: `trainfit`, the stale keys files and `eval/sessions/`.

| class | files | how it comes back |
| --- | --- | --- |
| source (stays in the tree) | `authored/sessions/` (the authored sessions of the 35 train worlds), the 35 train-world builders | not applicable |
| public (rebuilt) | the 35 train world JSON files (`authored/worlds/T*.json`) | the manifest's `rebuild` command: the world's builder, then `artefacts.py format` (the repository's JSON layout). `fetch --public-only` runs them: no version, no token (`artefacts.py verify-rebuild --public-only` proves they are byte for byte the pinned files) |
| held out | `eval/sets/{val,test}.jsonl` and `split.json`, `data/train-val.jsonl.gz` (it holds val sessions), the world JSON of A to G, T03, T12 and T23, the 7 builders of those worlds, the 18 authored session files of the val worlds (`authored/sessions/{T03,T12,T23}*.py`: split.json sends those worlds whole to val), and the keys files of A to D, T03, T12 and T23 | from the version (`fetch`); the keys files are seeded from their world JSON (`NATIVETOOLS`). The checks that mean something only with these files run in `artefacts.py verify-heldout`, which fails when they are absent |
| from the version, not held out | `data/train.jsonl.gz` (r1) and `eval/sets/roll-screen.jsonl` | from the version (`fetch`) |

```
python3 artefacts.py fetch --public-only         # CI and any public checkout: the public worlds, rebuilt
python3 artefacts.py fetch [--dry-run]           # everything, from ARTEFACTS_SOURCE=<a directory laid out as a version> or the pinned Hub commit (HF_TOKEN)
python3 artefacts.py check [--public-only]       # every manifest file is in place and equal to the manifest
python3 artefacts.py verify-rebuild [--public-only]   # rebuild the regenerable files in a scratch copy, compare bytes
python3 artefacts.py verify-version              # read every version file at the pin, compare it with the manifest
python3 artefacts.py verify-heldout              # build_sets.py check, split.py --check: where the held-out files are
```

`ARTEFACTS_SOURCE` is the provider-neutral path (R-1088-14): any directory laid out as a version (a copy of the Hub repository, a bucket synced to disk) serves `fetch` with no network and no token, and `version.json` there must be the version the manifest pins. A file that is present but differs is never overwritten without `--force`, and a download or rebuild whose bytes differ fails and leaves nothing at the path.

**The lifecycle of a version.** Each step is one command; only the owner or the root agent, with the token, runs the upload.

1. **Build** the training data (`authored/build.py` per world, `authored/assemble.py`; `data/README.md`) and **refreeze** val and test on the runtime the version names (`eval/build_sets.py refreeze`, `eval/FROZEN.md`). Record what the refreeze did as a JSON file (the runtime label and commit, whether each set changed).
2. **Assemble** the version: `NATIVETOOLS=<the runtime> python3 artefacts.py version --out DIR --train NAME=TRAIN.jsonl.gz,VAL.jsonl.gz [--train ...] --screen-worlds DIR --refreeze-report FILE --parent data-vM --seeds FILE --note NAME=TEXT` (run `artefacts.py rehash` first when a file of the tree changed). It takes the tree's files as the manifest pins them, so it refuses a tree that differs, and writes `version.json`.
3. **Publish**: `HF_TOKEN=... python3 artefacts.py publish DIR --tag data-vN` sends the tree to the dataset repository's main branch in one commit (deleting the paths that are not in DIR, never the LFS rules), creates the repository private when it is missing, refuses one that is public and never moves a tag. Then `python3 artefacts.py pin COMMIT` records the commit the tag points at in `artefacts.json`; commit that.
4. **Train** with `train/bundle.py build ... --data-version data-vN`.
5. **Card**: `python3 artefacts.py model-card --model CKPT_DIR --data-version data-vN --name NAME --score "LINE" ... --out CKPT_DIR/README.md` writes the Hub card from the checkpoint's `train_meta.json` and `config.json`.
6. **Promote**: `HF_TOKEN=... python3 artefacts.py publish-model CKPT_DIR --repo OWNER/NAME --tag NAME [--card FILE]` does for a model what `publish` does for a version (`--card` sends a card written beside the checkpoint as its `README.md`).

**The lifecycle rule.** A data version is kept while a kept model trained on it is, or while its val and test are the ruler in use; a version neither of those names can be deleted from the Hub. A new version is a new tag: nothing already published is rewritten.

**Taking the data out of the tree** is the owner's step, once, from the repository root, after steps 2 and 3 and a commit of the pinned `artefacts.json`:

```
HF_TOKEN=... NATIVETOOLS=target/debug/nativetools experiments/toolchat/native/move_out.sh      # or ARTEFACTS_SOURCE=<the version's directory> in place of the token
```

`move_out.sh` checks that the manifest pins a commit, moves every manifest file aside, fetches them back (rebuilds, and reads the version) and checks them, runs `verify-heldout`, and only then takes them out of the index, writes the `.gitignore` block (`artefacts.py gitignore`), applies `move_out.gate.patch` (the `native-python` job materialises the public worlds with `fetch --public-only`, with no secret) and removes itself and the patch. It commits nothing.
