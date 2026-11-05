# GCP Spot training VM

Runs a job staged by `bundle.py build` on ONE Spot GPU VM in `us-central1`, survives preemption, writes `DONE` to a bucket. **It trains and nothing else**: export (`../to_gguf.py`) and scoring (`crates/assist-eval`) run elsewhere, on the checkpoint fetched from the bucket; the Python scoring half of this VM was retired with the Python eval (#1171). Project `centraid`; quota is 1 Spot GPU per shape and `GPUS_ALL_REGIONS=1`, so only one GPU VM can exist at a time. Commands below run from this directory (`experiments/toolchat/native/train/vm`).

| file | role |
| --- | --- |
| `common.sh` | settings (all overridable by env) and gcloud helpers, sourced by the others |
| `launch.sh` | create the VM, cycling zones then shapes (H100 80GB, A100 80GB, A100 40GB); starts this job's own stopped VM instead |
| `watch.sh` | poll 60 s, restart a preempted VM, stop at `DONE`, print a cost estimate |
| `run_job.sh` | the VM's startup AND shutdown script (idempotent, runs on every boot) |
| `probe.sh` | 10-15 min measurement run before the real one |
| `follow.sh` | stream a VM's live logs (`[train]`, `[vm]` supervisor) until its `DONE`/`FAILED`; `watch.sh` streams the same lines (`STREAM=0` for the quiet 60 s poll) |
| `bench_train.sh` | A/B benchmark of the trainer's precision flags; runs on the GPU VM itself (see its header) |

**Live logs.** `run_job.sh` mirrors the trainer log line by line to the VM's serial console (`console_follow`, `[tag] line`, `\r` progress turned into lines, 300-char cut; `CONSOLE=/dev/null` turns it off) and `common.sh`'s `serial_pump` reads it every `SERIAL_POLL` (4) s with `--start`, filtering the OS noise. It needs only the compute API (`getSerialPortOutput`): no ssh, no key on disk, no bucket sync. The serial buffer is ~1 MB, so `follow.sh` shows the live tail, and the full logs still land in the bucket at the milestone syncs.

Everything runs from your machine with `gcloud` logged in; no credential is stored in a file. Settings live at the top of `common.sh` (`SHAPES`, `ZONES`, `SAVE_EVERY`, `EPOCHS`, `MAX_WAIT_S`, `PRICE_*`, ...).

## Bundles

`python ../bundle.py build <job> --train T.jsonl.zst --val V.jsonl.zst [--arm A|B|C] ...` stages `<stage>/<job>/data` under `$BUNDLE_STAGE` (default `${TMPDIR:-/tmp}/centraid-bundles`): `data/bundle.dat` (a gzip tar of `train/{train,arms,datagen}.py` and the records) and `job.json`. The records are a data version's (`cargo run -p centraid-datagen -- build --version vN`). `launch.sh` uploads it and the VM trains (resumable across preemptions); `--test` stages a test file the trainer scores at the last eval only.

## One-time setup

```sh
gcloud auth login      # or, unattended: export GCP_SA_KEY_JSON="$(cat trainer-key.json)" (or GCP_SA_KEY_FILE=path); see "Service-account login"
gcloud config set project centraid
gcloud services enable compute.googleapis.com storage.googleapis.com
# the VM uses the default compute service account with the cloud-platform scope; it needs read/write on the bucket
# (Editor, the default, is enough). The bucket is created by launch.sh/probe.sh if missing (gs://centraid-train, us-central1).

# stage the job (a real training job needs --train/--val; --save-every/--resume are added by run_job.sh)
python ../bundle.py build fit1 --train train.jsonl.zst --val val.jsonl.zst --arm A --bs 16 --max-len 8192
export JOB=fit1 BUCKET=centraid-train STAGE_DIR=${BUNDLE_STAGE:-${TMPDIR:-/tmp}/centraid-bundles}/fit1   # launch.sh uploads data/* to gs://$BUCKET/$JOB/job/
```

## Run

```sh
./probe.sh                  # measures step time on an A100 40GB first; prints fit, tokens/s, hours, cost, recommended --save-every
SAVE_EVERY=30 EPOCHS=6 ./launch.sh         # flags on the trainer: --epochs 6 --save-every 30 --resume (bs 16 / max-len 8192 come from job.json)
./watch.sh                  # restarts after preemption; exits at DONE (or FAILED); prints the cost estimate
```

`launch.sh --dry-run` prints the image, the zones per shape and what it would do. `launch.sh --recreate` restores into a new VM in any zone from the bucket (deletes this job's stopped VM and disk first).

**Marks.** The trainer saves a checkpoint at 25, 50, 75 and 100 % of the steps (`ckpt-025`, `ckpt-050`, `ckpt-075`, `ckpt-100`; `--checkpoints`), evaluates the val file and a train sample at each, and writes `out/marks.json` (per mark: loss, accuracy and the decision / other breakdown, val and train) and `out/best.json` (the mark with the lowest val _decision_ loss, ties to the later mark; none for a run without `--val`). `out/FINAL` names the last mark. Val decision loss is teacher-forced and does not rank the marks by free-decoding pass ([#1044](https://github.com/srikanth235/centraid/issues/1044): in job p7-r2 the lowest-loss mark, `ckpt-050`, passed 380 of 655 val sessions and `ckpt-100` 458): read `marks.json` for the curves, and score another mark only to compare it.

Progress and fetching:

```sh
gcloud storage cat "gs://$BUCKET/$JOB/logs/train-*.log" | tail -20
gcloud storage ls gs://$BUCKET/$JOB/                      # job/ out/ logs/ probe/ DONE
gcloud storage cat gs://$BUCKET/$JOB/out/best.json          # the mark with the lowest val decision loss (marks.json: every mark)
gcloud storage cp -r gs://$BUCKET/$JOB/out/ckpt-100 gs://$BUCKET/$JOB/out/FINAL ./ckpt/   # the trained checkpoint (~1.6 GB)
```

## Cleanup (DELETES everything; stops all billing)

Fetch results first. A stopped VM still bills its 200 GB disk, and the bucket bills storage (a 9.6 GB resume checkpoint sits there).

```sh
ZONE=$(gcloud compute instances list --project centraid --filter="name=ct-train-$JOB" --format='value(zone.basename())')
gcloud compute instances delete ct-train-$JOB --zone "$ZONE" --project centraid --delete-disks=all --quiet
gcloud compute instances list --project centraid              # must show no ct-* VM (probe VM: ct-probe-$JOB)
gcloud compute disks list --project centraid                  # must show no leftover disk
gcloud storage rm -r gs://$BUCKET/$JOB/ --project centraid    # this job's objects
gcloud storage rm -r gs://$BUCKET --project centraid          # the whole bucket, when no other job uses it
```

## After training

The VM does not score. Fetch the checkpoint (`out/FINAL` names the last mark, `out/best.json` the one with the lowest val decision loss), export it with `../to_gguf.py` and score it with `assist-eval` (`crates/assist-eval/README.md`), on a machine with the data version's val set and worlds, or on Kaggle (`../kaggle/`).

## Expected hours and Spot cost (ESTIMATES, not quotes)

Assumed prices: H100 ~$2.5-3/h, A100 80GB ~$1.6-2/h, A100 40GB ~$1.2-1.6/h, plus ~$0.03/h for the 200 GB disk and preemption rework. Edit `PRICE_*` in `common.sh`; `watch.sh` and `probe.sh` use them. Run hours: H100 ~3.2, A100 ~6.5 (40GB: measure with `probe.sh`).

| shape            | GPU       | run hours         | price/h | estimated cost |
| ---------------- | --------- | ----------------- | ------- | -------------- |
| `a3-highgpu-1g`  | H100 80GB | ~3.2              | 2.5-3   | ~$8-10         |
| `a2-ultragpu-1g` | A100 80GB | ~6.5              | 1.6-2   | ~$10-13        |
| `a2-highgpu-1g`  | A100 40GB | ~6.5 (if it fits) | 1.2-1.6 | ~$8-10         |

## Troubleshooting

- Stockout (`ZONE_RESOURCE_POOL_EXHAUSTED`, "does not have enough resources"): normal for Spot GPUs. `launch.sh` tries the next zone, then shape, sleeps 60-120 s between passes, gives up after `MAX_WAIT_S` (12 h; exit 2). Narrow with `SHAPES="a2-highgpu-1g"` or `ZONES=...`.
- Quota (`QUOTA_EXCEEDED`, `PREEMPTIBLE_NVIDIA_*_GPUS`, `GPUS_ALL_REGIONS`): another GPU VM holds the slot (launch.sh refuses in that case, so check for one created elsewhere, e.g. in the console), or the Spot quota of that shape is not granted. Spot GPU VMs also need preemptible CPU quota (a3-highgpu-1g 26 vCPU, a2-ultragpu-1g 12, a2-highgpu-1g 12).
- Preemption: Spot VMs are stopped (not deleted) with their disk. `watch.sh` restarts the VM in the same zone: the trainer resumes from the local resume checkpoint. If that zone has no capacity the stopped VM's disk cannot move across zones; after `START_PATIENCE_S` (600 s) `watch.sh` calls `launch.sh --recreate`: a fresh VM in any zone restoring the newest resume checkpoint from the bucket (at most the last ~10 min sync interval of work is lost). Run it by hand any time.
- `FAILED` in the bucket: the trainer crashed `MAX_RESTARTS` times or a stage failed; `gcloud storage cat "gs://$BUCKET/$JOB/logs/supervisor-*.log"`. Starting the VM again retries. Serial console: `gcloud compute instances get-serial-port-output ct-train-$JOB --zone ZONE`.
- No resume checkpoint in the bucket yet (first ~30 steps): a recreate would restart from step 0, so `launch.sh --recreate` refuses.
- Fp32 resume checkpoints are ~9.6 GB; only the newest complete one is synced (1-2 min). A SIGTERM notice is ~30 s: the trainer writes its checkpoint to the local disk, the bucket copy follows on the next boot's first sync only if the disk survives.

## gcloud flows not yet confirmed against a real run

A full train and watch cycle (#1044) ran `compute instances create` with every flag `common.sh` passes on `a3-highgpu-1g` (Spot, `STOP`, `TERMINATE`, boot disk, image family, scopes, labels, metadata, the startup and shutdown scripts, the A3 gVNIC interface), `images describe-from-family`, `gcloud storage` `cp`, `rsync`, `ls` and `cat`, and the serial-port log stream. No run so far exercised:

- the A2 shapes (`a2-ultragpu-1g`, `a2-highgpu-1g`), the `hyperdisk-balanced` retry and `NIC_A3=""`;
- a preemption restart and `launch.sh --recreate`;
- `buckets create --location --uniform-bucket-level-access` (the bucket existed) and `instances delete --delete-disks=all`;
- the error texts matched by `classify_error` (stockout, quota, machine type missing): they are from memory, an unmatched error is reported as "unclassified" and the launcher aborts after 6 in a row.

Image families are `common-cu129-ubuntu-2204-nvidia-580` then `common-cu129-ubuntu-2404-nvidia-580` (`IMAGE_FAMILIES` in `common.sh`; the script checks with `images describe-from-family` and dies with the listing command if none exists). `flash-linear-attention` is unpinned; its resolved version is in `logs/pip-freeze.txt`.

## Service-account login (unattended runs)

User logins can expire (Workspace session control). Instead set `GCP_SA_KEY_JSON` (the key JSON) or `GCP_SA_KEY_FILE` before running launch.sh, watch.sh or probe.sh. The script writes the key to tmpfs, activates it in a throwaway `CLOUDSDK_CONFIG`, deletes the key file at once, and removes the whole config on exit; your own gcloud config and the repo are never touched. The service account needs `roles/compute.instanceAdmin.v1`, `roles/iam.serviceAccountUser`, and `roles/storage.objectAdmin` on the bucket. Delete the key after the last run.
