# The adapter trainer: `experiments/adapter-train`

Python is the trainer and nothing else. Data, render, eval and rollouts are Rust ([data.md](./data.md), [eval.md](./eval.md)). Launching jobs, credentials, uploads and held-out gold are in [safety.md](./safety.md). Docs: [`README.md`](../../../experiments/adapter-train/README.md), [`RUNBOOK.md`](../../../experiments/adapter-train/RUNBOOK.md).

## What it trains

- A LoRA adapter on the stock base. Rank and targets are config. Embeddings and the head stay frozen and no tokens are added; the job file has no key for either.
- Targets must be modules the llama.cpp converter can ship (`SHIPPABLE` in `adapter_train/config.py`). `embed_tokens` and `lm_head` are refused with a reason. `in_proj_a` and `in_proj_b` are opt-in.
- The loss is a weighted mean over a step's records, using each record's `render.input_ids` and `render.weights` as they are (`adapter_train/datagen.py`). The trainer never renders, tokenises or decides what is trained. One record at a time, no padding.
- `base.weights` is `hf`, or `q4_0_dequantised` with `base.gguf`: the phone's Q4_0 file read back into Hugging Face form (`q4_0.py`), so the adapter fits the weights the phone runs.

## The job

- `python -m adapter_train train --config job.json`, or `check` to validate without reading data or loading a model. The job file is a path, `s3://` or `gs://` object. Unknown keys are refused.
- `config.py` validates before anything is paid for. The base revision must be a commit hash.
- The three storage locations (`data`, `checkpoints`, `outputs`) are all that differs between clouds.
- Data is `hf://datasets/<owner>/<repo>@<version>`. `hf.py` refuses a moving branch and requests only `train` and `val`. It has no key for `test`, and a test asserts it is never asked. A nested subset adds `data.subset`.
- Resume: a reclaim sends SIGTERM, the trainer checkpoints at the next step and exits 0, and the platform restarts it. Which records step N reads is a pure function of (seed, N). A checkpoint for a different job file is refused, so never edit `job.json` to resume.
- `run.json` in the outputs holds the git commit, the job-file hash, the hash and size of every data file as read, package versions, the seed and the metrics. No clock, host name or absolute path.

## Export and launch

- `export.py` converts the PEFT directory to the adapter GGUF with the converter of one llama.cpp commit, pinned in `adapter_train/llama_pin.py` to match the engine crate the phone links. `check_tree` refuses any other checkout. Upgrading the engine crate means redoing that match. `parity.py` compares trainer output with the phone's engine on the same prompts. Then pin the file ([model.md](./model.md)) and score it ([eval.md](./eval.md)).
- `launchers/` has `sagemaker.py` (managed Spot, `ml.g5.xlarge`, us-east-1), `modal_app.py` and `gcp.py`. Each prints its request and calls an SDK only with `--submit`; for Modal, `modal run` is the launch. Launching spends money and is the owner's.
- The Hugging Face token reaches a job as `HF_TOKEN`, or on AWS as `HF_TOKEN_SECRET_ID`, a Secrets Manager id. It never goes in the request.
- The exact commands (image build from the repository root with `GIT_COMMIT`, dry run, submit with a new `--suffix`, resume, fetch, convert, parity) are in `RUNBOOK.md`.

## Centraid rules for this Python

- Keep held-out data out. A new data version comes only from `datagen build`. The trainer fetches `train` and `val`, never `test`.
- Seed every source of randomness from one seed that is passed in and recorded with the output. Use a local `random.Random(seed)`, not the global generator.
- Sort directory listings, keys and sets before they shape output. No wall-clock time, host names or absolute paths in artefacts.
- Version data and checkpoints by content hash, with the command that made them.
- Metrics you steer by come from `val`. `test` is read only at milestones. Training and authoring code never reads either set.
- One implementation of anything training and inference share. A second copy in another language drifts and breaks "train equals inference".
- Dependencies are pinned with hashes. Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile with the command in the pinned file's header. Python is 3.11.
- Credentials are environment variables or the platform's secret store, never a job file, log or run record.

## Tests

- `python3 experiments/adapter-train/run_tests.py` runs each module in its own interpreter with `HF_HUB_OFFLINE=1`. A skip, a module that ran no tests, or a changed tracked file is a failure. Send test output to a temp directory.
- It is not a pull-request check. `.github/workflows/trainer.yml` runs it on `main` when the directory changes, so run it yourself.
- Done means the runner exits 0. It does not cover the Docker build, CUDA, a real model, S3, GCS or Hugging Face calls, a launcher's SDK call, or the converter on a real adapter. Say so when a change touches those.
- Python failures (a missing sibling module under `-I`, hash mismatches, skips, a dirtied tree): the traceback table in [stack/python](../stack/python/centraid.md).
