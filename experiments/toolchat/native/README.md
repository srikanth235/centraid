# The native tool task

Issue [#1044](https://github.com/srikanth235/centraid/issues/1044). One model, Qwen3.5-0.8B, fine-tuned to drive the vault through eight tools (`SPEC.md`) with the slot trace (`CONTRACT_V3.md`), scored on held-out households. The target is 85% session pass on test; a session passes when every turn's effect matches its gold.

**Python is the GPU trainer and nothing else.** The data (messages, render, mix), the eval and the rollouts are Rust: `crates/datagen`, `crates/assist-eval`. The Python data tooling that preceded them (`authored/`, `render.py`, `eval/`) was retired in #1171; it is in git history, at the commit before that one.

## The data

A data version is made by one command, `cargo run -p centraid-datagen -- build --version vN` (`crates/datagen/README.md`): `data/{train,val,test,noise}.jsonl.zst`, `worlds/`, `build/` and a manifest, published as one tag (`v0.2`, ...) of the private Hugging Face dataset `srikanth235/centraid-native-data`, each record an assist-eval session plus its rendered token ids and loss weights. Nothing else makes one.

**data-v7**, the version S2 was trained and judged on, is no longer rebuilt and stays fetchable from the private Hugging Face dataset `srikanth235/centraid-native-data`: `python3 artefacts.py fetch` puts its frozen val and test sets and their worlds under `data/v7/` (`data/README.md`, `data/v7/FROZEN.md`), where `crates/assist-eval` reads the val set by default. `artefacts.json` pins it.

| set | sessions | what it tells |
| --- | --- | --- |
| val | 655, seven held-out worlds | the number every fix is derived on |
| test | 656, the other half of the same pool | scored only at milestones |

A report gives sessions, clean turns (turns not downstream of a session's first failure: the steering metric) and all turns. Scoring is greedy; there is no voting.

## Layout

| path | what |
| --- | --- |
| `train/` | `train.py` (SFT and DPO on datagen records, `render.input_ids` and `render.weights` as they are; `--arm A\|B\|C`; `--ema D` saves a weight EMA beside every mark as `ckpt-NNN-ema`; `--dpo PAIRS` runs DPO against the frozen initial model), `datagen.py` (the record reader), `arms.py` (the three M6 arms), `soup.py` (uniform weight average of checkpoints), `to_gguf.py` (a checkpoint to the Q4_0 GGUF the phone loads, with llama.cpp at the commit the engine vendors), `bundle.py` (stages a training job: the trainer, the data, `job.json`; `--continue-from gs://CKPT` is the continuation preset), `vm/` (the GCP Spot GPU VM that trains a staged job and nothing else: `vm/README.md`), `kaggle/` (the Kaggle kernel of M6: train an arm, export the GGUF, score val with `assist-eval`; superseded for training by `experiments/adapter-train/`, #1188), and the `test_*.py` of all of it |
| `data/` | fetched data-v7 artefacts (`data/v7/`, gitignored) and `README.md` |
| `artefacts.py`, `artefacts.json` | the pin of data-v7 and its fetch and check; the model card and the publishing of a model and of its GGUF |
| `requirements-ci.in`, `requirements-ci.txt` | the hashed pins of the trainer's CPU tests |
| `SPEC.md`, `CONTRACT_V3.md`, `HANDOFF.md` | the tool spec, the slot-trace contract, and where the work stands |

The runtime is `centraid_assist::native` (`crates/assist/src/native/`, #1088); `crates/nativetools` keeps the `nativetools` binary, the world seeder and the export. Its export (`nativetools export DIR`: tool schemas, kind card, tables, rendered prompts, `identity.json`) is committed under `contracts/assist/export/` and checked against a fresh export by `crates/nativetools/tests/export_fixture.rs`.

## Tests

The Python tests (`test_*.py` in this directory and in `train/`: no GPU, no model weights, no network) cover the trainer's input and loss, the arms, resume, EMA, precision, DPO, soup, the GGUF export, the Kaggle report scripts, the job bundle and `artefacts.py`. They need torch (CPU), transformers, peft, safetensors and zstandard, pinned by hash in `requirements-ci.txt`. Run them with `python3 run_tests.py` (it runs each module in an interpreter of its own and fails on a skipped test or a module that ran none); after `pip install --require-hashes --only-binary=:all: --no-deps -r requirements-ci.txt`.

They are **not** part of the pull-request gate (`gate.yml` has no Python job). `.github/workflows/trainer.yml` runs them on `main` when a file of this directory changes, and on demand. Rust changes are gated by `cargo xtask gate`.

## The loop

1. Build a data version: `cargo run -p centraid-datagen -- build --version vN`.
2. Train an adapter on the stock base with [`../../adapter-train/`](../../adapter-train/README.md) (AWS by default, Modal or GCP; Kaggle is for scoring only). The older paths, full SFT on the GCP VM (`train/bundle.py build JOB --train train.jsonl.zst --val val.jsonl.zst --arm A --data-version data-vN`; `train/vm/launch.sh`; `train/vm/watch.sh`) and the Kaggle arms kit (`train/kaggle/`), are kept for history and not extended. The trainer's order and marks defaults (minimal pairs in one step, marks at 25 / 50 / 75 / 100 %) are in the `train/train.py` docstring.
3. Export (`train/to_gguf.py`), then score with `assist-eval` (below). Diagnose on val.
4. Rollouts and a second round: `crates/assist-eval/README.md` ("Rollouts"). Test at a milestone only.

## M6: SFT arms on datagen records (not run on a GPU yet)

[#1171](https://github.com/srikanth235/centraid/issues/1171), M6. Code and CPU tests only: **no arm has been trained, exported or scored, and nothing has been pushed to Kaggle.** The tests build a tiny random Qwen3.5 on the CPU; every GPU, Kaggle and llama.cpp step below is unverified.

**Input.** `train.py` reads the records `crates/datagen` writes (`train.jsonl.zst`, `val.jsonl.zst`; `datagen.py`). Each line is an assist-eval session plus `render: {input_ids, weights, text}`; the trainer trains on `input_ids` and `weights` as they are: no re-rendering, no chat template in Python. A weight of 0 is no loss, 1 is an assistant think or tool call, more than 1 is a deciding token. A record over `--max-len` is dropped and counted in the log (never cut); a record that breaks the contract (lengths differ, a negative or non-finite weight, no token with loss) stops the run. The loss of a step is `sum(weight * CE(next token)) / sum(weight)` over the step's `--bs` records, so the gradient scale is that of a mean. `--decision-weight`, `--copy-weight` and the decision labels do not apply to this format; the "decision" figures in the marks are the CE on tokens weighted above 1. The legacy formats still work (they are retired with the Python data tooling). No DPO on this format.

**Arms** (`train/arms.py`, `train.py --arm A|B|C`): same data, same weights, three starting points.

| arm | base | method | default lr |
| --- | --- | --- | --- |
| A | `Qwen/Qwen3.5-0.8B` | full SFT | 2e-5 |
| B | `RikiyaT/Qwen3.5-0.8B-weight-space-programming` | full SFT | 2e-5 |
| C | the same base as B | LoRA rank 64 (alpha 128) on every linear layer of the language model **except `layers.{15,19}.mlp.down_proj`**, the two edited tensors; adapters merged at export | 2e-4 |

The tokenizer is Qwen/Qwen3.5-0.8B for every arm. In C the base is frozen and the two tensors get no adapter, so the edit survives by construction; `arms.snapshot` / `arms.verify` also check at every export, after the merge, that both tensors equal the base bit for bit (`train/test_datagen.py` asserts it on the saved safetensors). The LoRA rank and learning rates are my choices, not tuned.

**Export.** `to_gguf.py` as it is: `--no-mtp`, Q4_0, the output tensor at Q8_0.

**Kaggle kit** (`train/kaggle/`, see its README): `kernel.py` pulls the data version from the private HF dataset `srikanth235/centraid-native-data` with the Kaggle secret `HF_TOKEN`, trains one arm, exports the GGUF and scores val with `assist-eval` (default tools; S2 under `--tools s2` behind `s2_baseline`). `arm_report.py` writes the per-arm val report and `compare_arms.py` prints the table and the chosen-arm rule.

```
python3 train/kaggle/compare_arms.py arm-A.val.json arm-B.val.json arm-C.val.json [arm-S2.val.json]
```

## The phone's model: a GGUF

The phone runs the model as a GGUF (Q4_0) in llama.cpp, so the number that matters is the GGUF's, decoded by the phone's own step. Three commands, from the repository root, take a promoted checkpoint there:

```
# 1. checkpoint -> Q4_0 GGUF + sidecar. llama.cpp is cloned and llama-quantize built on first use, at the commit llama-cpp-sys-2 0.1.158
#    vendors (train/to_gguf.py: LLAMA_CPP_COMMIT, found by matching all 1865 vendored files against upstream); the same input gives the same bytes.
python3 experiments/toolchat/native/train/to_gguf.py CKPT --out OUT --name native-s2 \
    --source-repo OWNER/NAME --source-tag S2 --source-revision SHA     # the private repository the checkpoint was promoted to
# 2. score it with the Rust eval runner: the phone's own decode step over the same runtime, in process (crates/assist-eval/README.md).
#    target-cpu=native: without it llama-cpp-sys-2 builds ggml for baseline x86-64 (no AVX2). Only this CPU run is affected.
RUSTFLAGS='-C target-cpu=native' cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
target/release/assist-eval --model OUT/native-s2-Q4_0.gguf --out runs/val-s2-q4      # --set defaults to data/v7/val.jsonl (fetched, below)
# 3. publish: a PUBLIC model repository (artefacts.py publish-gguf; HF_TOKEN from the environment; --dry-run prints the plan and the card)
cd .. && python3 artefacts.py publish-gguf OUT/native-s2-Q4_0.gguf --repo OWNER/NAME --tag S2-q4 --dry-run
```

The converter is told `--no-mtp` (the base model's multi-token-prediction block is not in a checkpoint, but its config still declares it) and the quantizer `--output-tensor-type q8_0` (the tied embedding is Q8_0 in the file the phone loads). `assist-eval` decodes greedy through `decode_step` under the phone's own options, `native_turn::phone_options()` (think limit 200, 512 tokens, trace v4, the `full` grammar, a context of 8192), and refuses to score a set whose reference calls do not replay to 100%; `assist-eval compare A B` pairs two reports by session (won, lost, z) and adds tool accuracy, accuracy per argument and fail rate by constraint count; see `crates/assist-eval/README.md`. The Python rig that scored a GGUF through the `assist-step` process (`eval/run.py --model gguf`) is retired.

## Rollouts: the model's own sessions as training data

`assist-eval rollout`, `rollout-report`, `rollout-compare` and `rollout-records` (`crates/assist-eval/src/rollout/`, M7 of #1171) are the rejection-sampling fine-tuning and DPO side: sample decodes of a model over a set, report pass rates per grid cell, and cut RFT records and DPO pairs. The Python rollout driver (`eval/rollout.py`) is retired. `crates/assist-eval/README.md` has the commands and the record shapes; the trainer reads the records as it reads any datagen record (`train.py --dpo` for the pairs).

Evidence: [#1044](https://github.com/srikanth235/centraid/issues/1044), [#1171](https://github.com/srikanth235/centraid/issues/1171). Where the work stands and what comes next: `HANDOFF.md`.

## Data-v7 and the pin

`artefacts.json` pins `data-v7`: one tag of the private Hugging Face dataset repository, and the commit it points at. Its files (the frozen sets, the worlds they run in, the training build as trained) are materialised under `data/v7/` with their sha256 verified; the public CI reads none of them.

```
python3 artefacts.py fetch [--dry-run]           # from ARTEFACTS_SOURCE=<a directory laid out as the version> or the pinned Hub commit (HF_TOKEN, once)
python3 artefacts.py check                       # every manifest file is in place and equal to the manifest
python3 artefacts.py verify-version              # read every version file at the pin, compare it with the manifest
```

`ARTEFACTS_SOURCE` is the provider-neutral path (R-1088-14): any directory laid out as a version (a copy of the Hub repository, a bucket synced to disk) serves `fetch` with no network and no token. A file that is present but differs is never overwritten without `--force`, and a download whose bytes differ fails and leaves nothing at the path.

A promoted model is a revision of a private Hub **model** repository whose card names its data tag, its git commit and its config:

1. `python3 artefacts.py model-card --model CKPT_DIR --data-version data-vN --name NAME --score "LINE" ... --out CKPT_DIR/README.md` writes the card from the checkpoint's `train_meta.json` and `config.json`.
2. `HF_TOKEN=... python3 artefacts.py publish-model CKPT_DIR --repo OWNER/NAME --tag NAME [--card FILE]` sends it, private, in one commit, and never moves a tag.
3. `python3 artefacts.py publish-gguf ...` does the same for the GGUF, to a public repository.

**The lifecycle rule.** A data version is kept while a kept model trained on it is, or while its val and test are the ruler in use. A new version is a new tag: nothing already published is rewritten. Datagen versions are published to the private dataset by the owner: the version's tree at the root of `main` and a tag `v0.N` on that commit (the Kaggle kernel pulls the tag); `artefacts.py` neither assembles nor uploads data versions. data-v7 is reached by its own tag only.
