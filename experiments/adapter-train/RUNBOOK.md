# Runbook: train the first adapter on AWS

For the owner. **Nothing in this directory has launched, built, uploaded or paid for anything.** Every command below is yours to type; the launcher prints its request and submits only with `--submit`. Placeholders are in CAPITALS. Region is `us-east-1` throughout.

What was and was not checked is in "What is verified" at the end. Read it before spending money.

## 0. Once: accounts, quota, buckets, role, secrets

1. **Quota.** Service Quotas, SageMaker, in us-east-1: _ml.g5.xlarge for spot training job usage_ must be at least 1. New accounts start at 0; the request takes hours to days. Without it the job is refused at submission.
2. **Bucket** `BUCKET` (private, same region). The job file's three locations live under one prefix, `s3://BUCKET/RUN/`.
3. **ECR repository** `adapter-train` in us-east-1.
4. **Hugging Face token**: a read-only token that can read the private dataset `srikanth235/centraid-assist-data`. Store it as a Secrets Manager secret (the token is never put in the training request, because SageMaker shows a job's `Environment` in plain):

   ```bash
   aws secretsmanager create-secret --region us-east-1 --name centraid/hf-token --secret-string "$HF_TOKEN"
   # note the ARN it prints: HF_SECRET_ARN
   ```

5. **IAM role** `ROLE_ARN`, trusted by `sagemaker.amazonaws.com`, with: S3 list/get/put/delete on `arn:aws:s3:::BUCKET` and `BUCKET/RUN/*`; `secretsmanager:GetSecretValue` on `HF_SECRET_ARN` only; pull from the ECR repository (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`); CloudWatch Logs create/put. (`AmazonSageMakerFullAccess` is more than needed.)

## 1. Build and push the image (from the repository root, at the commit you mean to train from)

```bash
COMMIT=$(git rev-parse HEAD); SHORT=$(git rev-parse --short HEAD)
IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/adapter-train:$SHORT
docker build -f experiments/adapter-train/Dockerfile --build-arg GIT_COMMIT=$COMMIT -t $IMAGE .
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
docker push $IMAGE
```

The build clones llama.cpp at the pinned commit and fails if the checkout is any other commit. Build on an x86-64 machine (the base image is amd64).

## 2. The job file

Write `job.json` (every key is documented in `adapter_train/config.py`; unknown keys are refused). The base revision must be a 40-character commit hash of `Qwen/Qwen3.5-0.8B`, and the data a pinned version, never a branch.

```json
{
  "name": "adapter-v1",
  "base": {
    "model": "Qwen/Qwen3.5-0.8B",
    "revision": "BASE_COMMIT_SHA",
    "weights": "q4_0_dequantised",
    "gguf": "s3://BUCKET/RUN/Qwen3.5-0.8B-Q4_0.gguf"
  },
  "lora": { "rank": 16, "alpha": 32 },
  "data": { "hf": "hf://datasets/srikanth235/centraid-assist-data@v0.N" },
  "checkpoints": "s3://BUCKET/RUN/checkpoints",
  "outputs": "s3://BUCKET/RUN/outputs",
  "train": {
    "seed": 0,
    "lr": 2e-4,
    "bs": 8,
    "steps": 1000,
    "checkpoint_every": 50
  }
}
```

- `weights: "q4_0_dequantised"` fits the adapter to the phone's own Q4_0 weights; the GGUF is the file pinned in `crates/assist/model.json` (563,036,064 bytes, sha256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`): check it, then upload it. Use `"weights": "hf"` (and no `gguf`) to fit the bf16 weights instead.
- A learning-curve run on a nested subset adds `"subset": "NAME"` inside `data` (Part H names them; the file is read from `data/subsets/NAME.jsonl.zst`).
- Leave `train.steps` and `checkpoint_every` so that a checkpoint lands well inside a Spot reclaim's two-minute notice: a step is a few seconds on an A10G.

```bash
shasum -a 256 Qwen3.5-0.8B-Q4_0.gguf         # must print the sha256 above
aws s3 cp Qwen3.5-0.8B-Q4_0.gguf s3://BUCKET/RUN/Qwen3.5-0.8B-Q4_0.gguf
aws s3 cp job.json s3://BUCKET/RUN/job.json
docker run --rm -v $PWD/job.json:/job.json $IMAGE check --config /job.json    # validates the job file; reads no data, loads no model
```

## 3. Dry run, then submit

```bash
cd experiments/adapter-train
python -m launchers.sagemaker --config s3://BUCKET/RUN/job.json --image $IMAGE --role ROLE_ARN \
    --hf-secret HF_SECRET_ARN --suffix 1                      # prints the CreateTrainingJob request; submits nothing
```

Read the printed request. It should show `EnableManagedSpotTraining: true`, `ml.g5.xlarge`, a `MaxWaitTimeInSeconds` of twice the `MaxRuntimeInSeconds` (8 h by default; `--max-hours` changes it), `ContainerArguments` of `["train", "--config", "s3://BUCKET/RUN/job.json"]`, and an `Environment` holding only the secret's id. When it is right, add `--submit` (needs `boto3` and AWS credentials that may call `sagemaker:CreateTrainingJob` and `iam:PassRole` on the role):

```bash
python -m launchers.sagemaker --config s3://BUCKET/RUN/job.json --image $IMAGE --role ROLE_ARN --hf-secret HF_SECRET_ARN --suffix 1 --submit
```

Job names are unique per region, so every submission needs a new `--suffix`.

Watch it:

```bash
aws sagemaker describe-training-job --region us-east-1 --training-job-name adapter-train-1 \
    --query '{status:TrainingJobStatus,secondary:SecondaryStatus,spot:BillableTimeInSeconds,run:TrainingTimeInSeconds}'
aws logs tail /aws/sagemaker/TrainingJobs --region us-east-1 --log-stream-name-prefix adapter-train-1 --follow
```

The log prints `records: ...`, one `step N/M loss ...` line per step, and `resumed from step N` after a restart. The token is in no log line.

## 4. After a Spot interruption

Nothing to do while the job's status is `InProgress`: SageMaker restarts it on a new instance (secondary status _Interrupted_, then _Starting_), the container reads the newest complete checkpoint under `s3://BUCKET/RUN/checkpoints` (a `COMPLETE` marker is uploaded last, so a half-written one is ignored) and logs `resumed from step N`. A reclaim sends SIGTERM; the trainer writes a checkpoint at the next step and exits.

If the job ends `Stopped` (the `MaxWaitTimeInSeconds` ran out) or `Failed`, resubmit the **same, unedited** `job.json` with a new suffix; it resumes from the same checkpoints:

```bash
python -m launchers.sagemaker --config s3://BUCKET/RUN/job.json --image $IMAGE --role ROLE_ARN --hf-secret HF_SECRET_ARN --suffix 2 --submit
```

Never edit `job.json` to resume: a checkpoint written for a different job file is refused. Start a new run by changing `checkpoints` and `outputs` too.

## 5. Fetch the adapter

The job writes `adapter/` (a PEFT directory) and `run.json` (git commit, job-file hash, data repo/revision/manifest hash, file hashes, final metrics) to `outputs`. Check `run.json` names the data version and commit you meant.

```bash
mkdir -p out && aws s3 sync s3://BUCKET/RUN/outputs/ out/ && aws s3 cp s3://BUCKET/RUN/job.json out/job.json
python3 -c "import json; r=json.load(open('out/run.json')); print(r['steps_done'], r['metrics'], r['data_source'])"
```

## 6. Convert to the phone's adapter file

In the same image (it holds the llama.cpp tree at the pinned commit; it fetches only the base model's `config.json` and tokenizer files):

```bash
docker run --rm -v $PWD/out:/out --entrypoint python $IMAGE -m adapter_train.export /out/adapter --job /out/job.json --out /out/centraid-adapter.gguf
```

The output is an F16 `general.type=adapter` GGUF. Quick check that the engine accepts it, from the repository root (needs the model file):

```bash
CENTRAID_ASSIST_MODEL=PATH/Qwen3.5-0.8B-Q4_0.gguf cargo test --release -p centraid-assist-llama --features engine --test real_model -- --ignored
```

(those tests use synthetic adapters; Part F's `assist-eval --adapter out/centraid-adapter.gguf` is the first use of the real one.)

## 7. Parity: does the phone's engine say what the trainer says?

```bash
huggingface-cli download srikanth235/centraid-assist-data data/val.jsonl.zst --repo-type dataset --revision v0.N --local-dir hfdata
docker run --rm -v $PWD:/w --entrypoint python $IMAGE -m adapter_train.parity prompts --data /w/hfdata/data/val.jsonl.zst --n 20 --out /w/prompts.json
docker run --rm --gpus all -v $PWD:/w --entrypoint python $IMAGE -m adapter_train.parity trainer \
    --adapter /w/out/adapter --base Qwen/Qwen3.5-0.8B --revision BASE_COMMIT_SHA --gguf /w/Qwen3.5-0.8B-Q4_0.gguf \
    --prompts /w/prompts.json --out /w/trainer.json          # drop --gguf for a base.weights "hf" run
# engine side: Part F's command, greedy, the same prompts.json, the adapter on; it writes engine.json as [{"id", "generated_ids"}]
python -m adapter_train.parity compare trainer.json engine.json --min-match 0.9
```

With `q4_0_dequantised` both sides hold the same weights, so a tighter `--min-match` (try 0.95) is meaningful; with `hf` the bf16 trainer and the Q4_0 phone diverge somewhere and 0.9 is a floor on the first 16 tokens, not equality. Exit status 1 means the gate failed.

## What is verified, and what is not

Verified here, on CPU, offline: the job file's validation; the SageMaker request's fields and that it never holds a token; the secret lookup (with a fake client); the Dockerfile's COPY sources and pins (text only); the Q4_0 and Q8_0 block arithmetic by exact equality on hand-built blocks; the name map and the converter's inverse rewrites on a model of the real architecture; reading a written GGUF back; the loop, an exact resume and the record.

**Not verified: the Docker build; that the real GGUF's tensors all map (the loader fails by name on a missing, extra or misshapen one, and prints the largest distance from the bf16 weights, which must be small, not zero); that the dequantised trainer's logits equal llama.cpp's (the parity step is that proof); the SageMaker submission, a real Spot interruption and resume on S3; CUDA; any Hugging Face or Secrets Manager call; the converter on a trained adapter; the `sentencepiece`/`protobuf` pins the converter may need.** Modal and GCP launchers are untested.
