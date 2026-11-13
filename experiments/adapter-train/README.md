# The adapter trainer

[#1188](https://github.com/srikanth235/centraid/issues/1188), Part E. The on-device assistant is the **stock** Qwen3.5-0.8B (the GGUF pinned in `crates/assist/model.json`) plus a small Centraid **LoRA adapter** that the app switches on for vault turns and off elsewhere, so the stock behaviour is kept by construction. This directory trains that adapter. Scoring is not here: Kaggle is for scoring only, through the score-only kit in `crates/assist-eval/kaggle/`. LoRA on the stock base only: rank and targets are config, embeddings and the head are frozen, no tokens are added. Full fine-tunes, edited bases, checkpoint soups and DPO are out of scope until a first adapter is scored; the older full-model trainer, its Kaggle and VM kits and data v7 are gone.

**Nothing here has been run on a GPU, on a cloud, or against a real model. The Modal and GCP launchers are untested. No job has been started and nothing was uploaded.** The CPU tests (below) run the whole loop on a tiny random Qwen3.5.

## One image, one command, three locations

```text
python -m adapter_train train --config job.json     # job.json is a path, s3:// or gs:// object
python -m adapter_train check --config job.json     # validate and print; reads no data, loads no model
```

The job file (`adapter_train/config.py` documents every key; unknown keys are refused) names the three storage locations, and they are the only thing that differs between clouds: **data** (`s3://`, `gs://`, a mounted path, or `hf://datasets/srikanth235/centraid-assist-data@<data version>`), **checkpoints** and **outputs**.

| piece | what it is |
| --- | --- |
| `adapter_train/config.py` | the job file, validated before anything is paid for: the base revision must be a commit hash; the targets must be modules the llama.cpp converter can ship (`q_proj k_proj v_proj o_proj in_proj_qkv in_proj_z out_proj gate_proj up_proj down_proj`; `in_proj_a`/`in_proj_b` only when named); `embed_tokens`, `lm_head` are refused with their reason; there is no key for new tokens or trainable embeddings |
| `adapter_train/storage.py` | local path, `s3://`, `gs://` behind four calls (`get`, `put`, `keys`, `delete`); `boto3` and `google-cloud-storage` are imported on first use |
| `adapter_train/hf.py` | the data version on the private Hugging Face dataset, pinned to a revision (a branch is refused). **Only `train` and `val` are ever requested; the test split is never fetched.** `HF_TOKEN` is read from the environment inside the fetcher and nowhere else, and is in no message or record. This one function knows the repo layout (`manifest.json`, `data/{train,val}.jsonl.zst`, `data/subsets/`; the test split is in another repo it never names); this is what changes when the layout does |
| `adapter_train/checkpoints.py` | `ckpt-NNNNNNNN/` with the marker `COMPLETE` uploaded last; resume takes the newest complete one; older ones are pruned |
| `adapter_train/trainer.py` | the loop (torch, peft); which records step N reads is a pure function of (seed, N); SIGTERM checkpoints at the next step and exits 0; `base.weights: q4_0_dequantised` loads the phone's Q4_0 weights via `q4_0.py` |
| `adapter_train/q4_0.py` | the phone's Q4_0 GGUF read back into Hugging Face form: Q4_0/Q8_0 dequantised, the converter's rewrites undone (`ssm_a`, conv1d, norms +1); fails by name on a missing, extra or misshapen tensor |
| `adapter_train/record.py` | `run.json` in the outputs: git commit, job-file hash, base model and revision, the hash and size of every data file as read, the HF repo, revision and manifest, package versions, seed, resumed-from step, final metrics, adapter file hashes. No clock, host name or absolute path |
| `adapter_train/datagen.py` | the datagen record reader: the rendered token ids and per-token loss weights, taken as they are |
| `adapter_train/llama_pin.py` | the one pin of the llama.cpp commit the engine vendors, and the refusal of any other checkout |
| `adapter_train/export.py`, `parity.py` | PEFT directory to the adapter GGUF with `convert_lora_to_gguf.py` of the **pinned** llama.cpp commit (never master); then a parity comparison of trainer output against the phone's engine |
| `launchers/` | `sagemaker.py` (default: managed Spot, `ml.g5.xlarge`, us-east-1), `modal_app.py`, `gcp.py` (Vertex AI Spot). Each builds its platform's request and **prints it**; only `--submit` calls an SDK (`modal run` for Modal). Launching spends money and is the owner's |
| `Dockerfile`, `requirements.txt` | the image; build from the repository root with `--build-arg GIT_COMMIT=...` (the record needs it) |

## Resume on Spot

A reclaim sends SIGTERM; the trainer writes a checkpoint at the next step and exits. The platform restarts the container (SageMaker managed Spot, Vertex `restartJobOnWorkerRestart`, Modal retries) and `train` resumes from the newest complete checkpoint under the job file's `checkpoints`, whichever machine wrote it. A checkpoint written for a different job file is refused. The tests prove a halted-and-resumed run ends with exactly the weights of an uninterrupted one. SageMaker's own `CheckpointConfig` is deliberately not set: the container reads and writes S3 itself, and a second sync of the same files would only race.

## The phone's weights

`base.weights: "q4_0_dequantised"` (with `base.gguf`, the phone's Q4_0 file) fits the adapter to the weights the phone runs, not the bf16 ones it was derived from. `q4_0.py` loads the Hugging Face model, then overwrites its language-model parameters with the GGUF's, dequantised (ggml's Q4_0 and Q8_0 arithmetic, proven by exact equality on hand-built blocks) and with the converter's rewrites undone. The vision tower is left as it is. Costs: the base is fp32/bf16 in memory after the swap (no on-the-fly dequantisation), and the loader needs the GGUF locally (it is fetched from the job's storage). **Not proven on the real file:** that its dequantised weights make the trainer's logits equal llama.cpp's; the loader prints the largest distance from the bf16 weights as a sanity check, and the parity step (`--gguf`) is the end-to-end proof. Default stays `hf`.

## Runbook

[`RUNBOOK.md`](RUNBOOK.md): the exact commands to build and push the image, dry-run, submit on SageMaker, resume after a Spot interruption, fetch the adapter, convert it and run the parity check. The Hugging Face token reaches the job through Secrets Manager (`--hf-secret`), never the request.

## What the adapter file must be

From the spike (#1188), against the vendored llama.cpp (`llama-cpp-sys-2 0.1.158`, commit `26394b4e6`): the engine loads a LoRA GGUF for `qwen35`, applies it on a fresh context, off is token-identical to no adapter, on costs about 5-10% speed on a CPU. The converter reads a PEFT directory and writes `<tensor>.lora_a` / `.lora_b`; it skips norms and refuses embeddings and `lm_head`. Qwen3.5-0.8B has 16 key and 16 value heads in its linear-attention layers, so the converter's V-head reorder does not apply.

## Rules

The owner's standing rules for this work:

- **Ask the owner before any training launch, GPU scoring run, VM start or bucket upload.** Launchers print their request and submit only with `--submit`.
- **Credentials only in environment variables** (or the platform's secret store), never saved to a file, a job file or a log. A credential posted in chat is rotated, not used.
- **Authors of training data never open val or test gold**, run outputs or audit reports. The trainer fetches `train` and `val` only; the test split is never requested.
- Back a claim with a paired comparison (sessions won and lost, `z = (won - lost) / sqrt(won + lost)`); `|z| < 2` is noise.

## Tests

```text
python3 experiments/adapter-train/run_tests.py
```

No GPU, no network, no paid call, no model weights. `test_trainer.py` needs torch, transformers, peft, safetensors and zstandard (the hashed CPU pins of `requirements-ci.txt`); the other modules need only the standard library. Not covered by any test: the Docker build, CUDA, a real model, a real S3 or GCS or Hugging Face call, any launcher's SDK call, the Modal file's `modal` calls (the package is not installed here), the converter on a trained adapter, the parity run, the Dockerfile build.
