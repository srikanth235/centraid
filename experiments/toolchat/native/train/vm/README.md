# GCP Spot training VM

Runs the staged job (`kaggle.py build`) on ONE Spot GPU VM in `us-central1`, survives preemption, scores with `kernel.py`, writes `DONE` to a bucket. Project `centraid`; quota is 1 Spot GPU per shape and `GPUS_ALL_REGIONS=1`, so only one GPU VM can exist at a time.

| file | role |
| --- | --- |
| `common.sh` | settings (all overridable by env) and gcloud helpers, sourced by the others |
| `launch.sh` | create the VM, cycling zones then shapes (H100 80GB, A100 80GB, A100 40GB); starts this job's own stopped VM instead |
| `watch.sh` | poll 60 s, restart a preempted VM, stop at `DONE`, print a cost estimate |
| `run_job.sh` | the VM's startup AND shutdown script (idempotent, runs on every boot) |
| `probe.sh` | 10-15 min measurement run before the real one |

Everything runs from your machine with `gcloud` logged in; no credential is stored in a file. Settings live at the top of `common.sh` (`SHAPES`, `ZONES`, `SAVE_EVERY`, `EPOCHS`, `MAX_WAIT_S`, `PRICE_*`, ...).

## One-time setup

```sh
gcloud auth login      # or, unattended: export GCP_SA_KEY_JSON="$(cat trainer-key.json)" (or GCP_SA_KEY_FILE=path); see "Service-account login"
gcloud config set project centraid
gcloud services enable compute.googleapis.com storage.googleapis.com
# the VM uses the default compute service account with the cloud-platform scope; it needs read/write on the bucket
# (Editor, the default, is enough). The bucket is created by launch.sh/probe.sh if missing (gs://centraid-train, us-central1).

# stage the job (real training job: needs --train/--val; --save-every/--resume are added by run_job.sh)
python kaggle.py build fit1 --train T.jsonl.gz --val V.jsonl.gz --arms free --bs 16 --max-len 8192
export JOB=fit1 BUCKET=centraid-train STAGE_DIR=<KGL_STAGE>/fit1     # launch.sh uploads data/* + kernel.py to gs://$BUCKET/$JOB/job/
```

An eval-only job (`--ckpt-dir` / `--base`, `train` null) is refused by the VM: it only trains.

## Run

```sh
./probe.sh                  # measures step time on an A100 40GB first; prints fit, tokens/s, hours, cost, recommended --save-every
SAVE_EVERY=30 EPOCHS=6 ./launch.sh         # flags on the trainer: --epochs 6 --save-every 30 --resume (bs 16 / max-len 8192 come from job.json)
./watch.sh                  # restarts after preemption; exits at DONE (or FAILED); prints the cost estimate
```

`launch.sh --dry-run` prints the image, the zones per shape and what it would do. `launch.sh --recreate` restores into a new VM in any zone from the bucket (deletes this job's stopped VM and disk first).

Progress and fetching:

```sh
gcloud storage cat "gs://$BUCKET/$JOB/logs/train-*.log" | tail -20
gcloud storage ls gs://$BUCKET/$JOB/                      # job/ out/ logs/ results/ probe/ DONE
gcloud storage cp -r gs://$BUCKET/$JOB/results ./results   # eval reports, summary.json
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

## Scoring a checkpoint

`score_ckpt.sh` scores ONE checkpoint on the three session-pass sets (trainfit 300, val 391, test 450 sessions) with the optimized scoring settings (`eval_procs 4`, `eval_chunks 4`, `run_batched.py --threads 16 --wait 0.05`, `OMP_NUM_THREADS 4`; identical in the three bundles, only `eval_set` and `eval_setup` differ). Bundles are staged in `/home/user/stage-extra/bundles/{trainfit,val,test}/` (`bundle.dat`, `job.json`, `kernel.py`); the script uploads them once to `gs://$BUCKET/bundles/<set>/` (checksum rsync: identical is skipped).

    export JOB=final-v2 BUCKET=centraid-train-clawgnition
    ./score_ckpt.sh gs://$BUCKET/$JOB/out/ckpt-100 --watch                       # the final checkpoint (restarts ct-train-$JOB)
    ./score_ckpt.sh gs://$BUCKET/$JOB/out/ckpt-050 --watch                       # the milestone checkpoint
    ./score_ckpt.sh gs://$BUCKET/other-job/out/ckpt-100 --new-vm --watch         # another training's checkpoint, on a new VM
    ./score_ckpt.sh /path/to/local/ckpt-dir --name mine --sets val,test          # a local dir is uploaded first
    ./score_ckpt.sh <checkpoint> --dry-run                                       # print the plan, create nothing

Options: `--name NAME` (default `<job>-<ckpt dir>`, e.g. `final-v2-ckpt-050`; the same name resumes), `--sets a,b`, `--vm NAME`, `--new-vm` (`ct-score-<name>`, `SCORE_DISK_GB` 100, Spot shapes cycled by `launch.sh`'s logic), `--watch`. The default restarts the training job's stopped VM with metadata `mode=score,manifest=...` and this `run_job.sh` as its startup script; `--watch` removes `mode`/`manifest` afterwards, otherwise do it by hand (`gcloud compute instances remove-metadata VM --zone Z --keys=mode,manifest`) before that VM trains again. The VM (`MODE=score` in `run_job.sh`) pulls the checkpoint once, installs deps once, then scores all requested sets in ONE `kernel.py` launch, writes `summary.json` and `DONE` and powers off after 15 min.

**One launch for all sets.** For two or more sets `run_job.sh` builds a combined eval at run time: the requested bundles (and only those: `--sets val,trainfit` never includes test) are extracted into one code dir, their `eval/sets/<set>.jsonl` are concatenated into `eval/sets/_combined.jsonl` (session ids must be unique across sets), `eval_setup` seeds the union of the worlds once, and one `job.json` is used. The build fails (and the script falls back, below) if the bundles' eval settings (everything in `job.json` except `eval_set` and `eval_setup`: `eval_procs`, `eval_chunks`, drive args, `eval_env`, arms), their `kernel.py`, or any shared file except `train/train.py` differ, or if session ids repeat. `kernel.py` then runs once (one model load and one 4-process worker pool, one world seeding, one tail); afterwards the run records are split by session id into per-set `run.jsonl` (in the set file's order) and `eval/score.py` scores each set against its own set file. Expected saving: one model load and one worker pool instead of three, roughly 4 to 6 minutes per checkpoint (unmeasured; the separate launches took 491 s val, 546 s test, 326 s trainfit on ckpt-100). Resume: a killed or incomplete launch is resumed in its work dir through `eval/free/claims`: on the next boot finished records are moved to `eval-keep/kept.jsonl` (the driver truncates its `--out` on start), claims of sessions that never finished are released, and only the remaining sessions run; nothing finished is re-run or dropped. When every session is finished no kernel starts. A set marker `state/sc-<NAME>-<set>.done` is written once that set's report is uploaded; `sc-<NAME>.combined.started|launch.secs|launch.done` track the launch. `SCORE_SEPARATE=1` (env of `score_ckpt.sh`, stored as metadata `score_separate=1`) restores one launch per set (private work dir and marker per set); it is also the automatic fallback when the combined build fails before the kernel starts (a WARN line in the supervisor log says why). A single set always runs on its own.

    gs://$BUCKET/bundles/<set>/{bundle.dat,job.json,kernel.py}
    gs://$BUCKET/score/<NAME>/manifest.json   {name, checkpoint, sets, bundles, created}
    gs://$BUCKET/score/<NAME>/<set>/          eval/free/{report.json,report.md,run.jsonl}, kernel.log (combined: the shared launch's log), score.log
    gs://$BUCKET/score/<NAME>/combined/       the combined launch's work dir (run.log, summary.json, kernel.log, collected.jsonl = all records, eval/free/*)
    gs://$BUCKET/score/<NAME>/logs/           supervisor and per-set kernel logs
    gs://$BUCKET/score/<NAME>/summary.json    per set: sessions, session_pass(+_rate), turns, turn_pass(+_rate), seconds (combined: only that set's split + score step); mode, launch_seconds (the kernel launch, null when separate), total_seconds
    gs://$BUCKET/score/<NAME>/DONE | FAILED   FAILED holds the reason; starting the VM again reruns only the unfinished sets

## Scoring more eval sets

After the job's DONE, `run_job.sh` scores every extra eval bundle in the bucket, without retraining. A bundle is an eval-only job staged by `kaggle.py build <name> --ckpt-dir <stub> --set <set.jsonl> --arms free --dry` (the stub dir only needs a `config.json` and a `*.safetensors`; drop the staged `ckpt.*` files and `ckpt_prefix`/`ckpt_files` from `job.json`, `run_job.sh` fills them in from the checkpoint on the VM's disk). The set and the worlds it needs live inside `bundle.dat`; `job.json`'s `eval_setup` seeds them.

Layout (one directory per set; `kernel.py` optional, the job's own is used when absent):

    gs://$BUCKET/$JOB/extra/<name>/bundle.dat
    gs://$BUCKET/$JOB/extra/<name>/job.json
    gs://$BUCKET/$JOB/extra/<name>/kernel.py
    e.g. <name> = test (450 sessions), trainfit (300 sessions), val (391 sessions); staged in /home/user/stage-extra/<name>/upload/

Upload and start the stopped VM (it keeps its disk, so the checkpoint is already there):

    gcloud storage cp stage-extra/test/upload/* gs://$BUCKET/$JOB/extra/test/ --project centraid
    gcloud compute instances add-metadata ct-train-$JOB --zone ZONE --project centraid \
      --metadata-from-file=startup-script=experiments/toolchat/native/train/vm/run_job.sh
    gcloud compute instances start ct-train-$JOB --zone ZONE --project centraid

A finished job skips training and val, scores only the extra sets without a `$STATE/score-<name>.done` marker (one at a time, in name order), and powers off 15 min after the last one. A set whose kernel failed has no marker and is rerun on the next start.

- Results: `gs://$BUCKET/$JOB/results-<name>/` (`eval/free/report.md|json`, `summary.json`, `run.log`); logs in `logs/score-<name>-*.log`.
- Another checkpoint: add metadata `extra_ckpts` (space or comma list, e.g. `ckpt-050`) before the start: `gcloud compute instances add-metadata ct-train-$JOB --zone ZONE --project centraid --metadata extra_ckpts=ckpt-050`. The final checkpoint is always scored; `ckpt-050` goes to `results-<name>-ckpt-050/` (marker `score-<name>-ckpt-050.done`). A checkpoint missing on the disk is pulled from `gs://$BUCKET/$JOB/out/<ckpt>/`.
- To rescore a set, delete its marker on the VM (`sudo rm /opt/centraid/state/score-<name>.done`) or upload under a new `<name>`.

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

## gcloud flags NOT verified (gcloud is not installed where these were written; `bash -n` and offline logic tests only)

- `compute instances create`: `--provisioning-model=SPOT`, `--instance-termination-action=STOP`, `--maintenance-policy=TERMINATE`, `--boot-disk-size=200GB`, `--boot-disk-type`, `--image-family/--image-project`, `--scopes`, `--labels`, `--metadata`, `--metadata-from-file=startup-script=...,shutdown-script=...`, `--network-interface=nic-type=GVNIC` (A3 only; `NIC_A3=""` drops it).
- Image families `common-cu128-ubuntu-2204-nvidia-570`, `common-cu129-ubuntu-2204-nvidia-570`, `common-cu124-ubuntu-2204-nvidia-550` (the script checks with `images describe-from-family` and dies with the listing command if none exists), and the metadata key `install-nvidia-driver=True`.
- Boot disk types: `pd-ssd` for all shapes, retried once with `hyperdisk-balanced` if the API rejects it (A3 may need the latter).
- Listing/filters: `machine-types list --filter="name=... AND zone~us-central1"`, `accelerator-types list`, the `--format='csv[no-heading](... guestAccelerators[0].acceleratorCount)'` projection, `instances delete --delete-disks=all`.
- `gcloud storage`: `ls`, `cp`, `rsync -r`, `rm -r`, `cat`, `buckets create --location --uniform-bucket-level-access`, `buckets describe`.
- Error texts matched by `classify_error` (stockout, quota, machine type missing) are from memory; an unmatched error is reported as "unclassified" and the launcher aborts after 6 in a row.
- Not run anywhere: the Deep Learning VM python (3.10 vs the Modal image's 3.11; `run_job.sh` prefers python3.11 if present, installs python3-venv if missing) and `flash-linear-attention` (unpinned, as in the Modal image; its resolved version is in `logs/pip-freeze.txt`).

## Service-account login (unattended runs)

User logins can expire (Workspace session control). Instead set `GCP_SA_KEY_JSON` (the key JSON) or `GCP_SA_KEY_FILE` before running launch.sh, watch.sh, probe.sh or score_ckpt.sh. The script writes the key to tmpfs, activates it in a throwaway `CLOUDSDK_CONFIG`, deletes the key file at once, and removes the whole config on exit; your own gcloud config and the repo are never touched. The service account needs `roles/compute.instanceAdmin.v1`, `roles/iam.serviceAccountUser`, and `roles/storage.objectAdmin` on the bucket. Delete the key after the last run.
