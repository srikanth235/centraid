# GCP Spot training VM

Runs a job staged by `bundle.py build` on ONE Spot GPU VM in `us-central1`, survives preemption, scores with `kernel.py`, writes `DONE` to a bucket. Project `centraid`; quota is 1 Spot GPU per shape and `GPUS_ALL_REGIONS=1`, so only one GPU VM can exist at a time. Commands below run from this directory (`experiments/toolchat/native/train/vm`).

| file | role |
| --- | --- |
| `common.sh` | settings (all overridable by env) and gcloud helpers, sourced by the others |
| `bundles.sh` | build the three scoring bundles (trainfit, val, test) from `eval/sets/` with one explicit runtime (`BUNDLE_NATIVETOOLS`) |
| `launch.sh` | create the VM, cycling zones then shapes (H100 80GB, A100 80GB, A100 40GB); starts this job's own stopped VM instead |
| `watch.sh` | poll 60 s, restart a preempted VM, stop at `DONE`, print a cost estimate |
| `run_job.sh` | the VM's startup AND shutdown script (idempotent, runs on every boot) |
| `probe.sh` | 10-15 min measurement run before the real one |
| `score_ckpt.sh` | score one checkpoint on trainfit, val and test (`--mark ckpt-050` or `best` scores another mark of a run, for comparison) |
| `follow.sh` | stream a VM's live logs (`[train]`, `[score]` kernel, `[vm]` supervisor) until its `DONE`/`FAILED`; `watch.sh` and `score_ckpt.sh --watch` stream the same lines (`STREAM=0` for the quiet 60 s poll) |
| `bench_train.sh` | A/B benchmark of the trainer's precision flags; runs on the GPU VM itself (see its header) |

**Live logs.** `run_job.sh` mirrors the trainer and kernel logs line by line to the VM's serial console (`console_follow`, `[tag] line`, `\r` progress turned into lines, 300-char cut; `CONSOLE=/dev/null` turns it off) and `common.sh`'s `serial_pump` reads it every `SERIAL_POLL` (4) s with `--start`, filtering the OS noise. It needs only the compute API (`getSerialPortOutput`): no ssh, no key on disk, no bucket sync. The serial buffer is ~1 MB, so `follow.sh` shows the live tail, and the full logs still land in the bucket at the milestone syncs.

Everything runs from your machine with `gcloud` logged in; no credential is stored in a file. Settings live at the top of `common.sh` (`SHAPES`, `ZONES`, `SAVE_EVERY`, `EPOCHS`, `MAX_WAIT_S`, `PRICE_*`, ...).

## Bundles

`python ../bundle.py build <job> ...` stages `<stage>/<job>/{data,kernel}` under `$BUNDLE_STAGE` (default `${TMPDIR:-/tmp}/centraid-bundles`): `data/bundle.dat` (a gzip tar of the code, the exported grammar, the `nativetools` runtime with the loader and libs it was linked against, the eval worlds, the one scored set and the train/val files), `data/job.json` (what to run) and `kernel/kernel.py` (the stage that scores). `BUNDLE_NATIVETOOLS` names the exact runtime build to ship; without it the repo's `target/release` or `target/debug` build goes in. A build only stages; `launch.sh` and `score_ckpt.sh` upload. Two kinds:

- a **training job** (`--train T --val V`): `launch.sh` uploads it, the VM trains (resumable across preemptions), then scores the final checkpoint on its `--set` (default `eval/sets/val.jsonl`);
- a **scoring bundle** (`--base`, or `--ckpt-dir` for a local checkpoint): no training. `bundles.sh` stages one per set and `score_ckpt.sh` runs a checkpoint on them. The VM refuses to train one.

The scoring settings are `bundle.py`'s defaults, the same for every bundle: arm `free` (greedy decoding), `eval/run_batched.py --threads 16 --wait 0.05`, 4 launches (`eval_chunks`) run as 4 processes (`eval_procs`) sharing one GPU and one claims directory, `OMP_NUM_THREADS 4` and expandable CUDA segments. `--eval-drive`, `--eval-env`, `--eval-chunks` and `--eval-procs` override them.

## One-time setup

```sh
gcloud auth login      # or, unattended: export GCP_SA_KEY_JSON="$(cat trainer-key.json)" (or GCP_SA_KEY_FILE=path); see "Service-account login"
gcloud config set project centraid
gcloud services enable compute.googleapis.com storage.googleapis.com
# the VM uses the default compute service account with the cloud-platform scope; it needs read/write on the bucket
# (Editor, the default, is enough). The bucket is created by launch.sh/probe.sh if missing (gs://centraid-train, us-central1).

# stage the job (a real training job needs --train/--val; --save-every/--resume are added by run_job.sh)
python ../bundle.py build fit1 --train T.jsonl.gz --val V.jsonl.gz --bs 16 --max-len 8192
export JOB=fit1 BUCKET=centraid-train STAGE_DIR=${BUNDLE_STAGE:-${TMPDIR:-/tmp}/centraid-bundles}/fit1   # launch.sh uploads data/* + kernel.py to gs://$BUCKET/$JOB/job/
```

The VM refuses a scoring bundle (`train` null): it only trains. Score checkpoints with `score_ckpt.sh`.

## Run

```sh
./probe.sh                  # measures step time on an A100 40GB first; prints fit, tokens/s, hours, cost, recommended --save-every
SAVE_EVERY=30 EPOCHS=6 ./launch.sh         # flags on the trainer: --epochs 6 --save-every 30 --resume (bs 16 / max-len 8192 come from job.json)
./watch.sh                  # restarts after preemption; exits at DONE (or FAILED); prints the cost estimate
```

`launch.sh --dry-run` prints the image, the zones per shape and what it would do. `launch.sh --recreate` restores into a new VM in any zone from the bucket (deletes this job's stopped VM and disk first).

**Marks and the checkpoint that is scored.** The trainer saves a checkpoint at 25, 50, 75 and 100 % of the steps (`ckpt-025`, `ckpt-050`, `ckpt-075`, `ckpt-100`; `--checkpoints`), evaluates the val file and a train sample at each, and writes `out/marks.json` (per mark: loss, accuracy and the decision / hard / copy / other breakdown, val and train) and `out/best.json` (the mark with the lowest val *decision* loss, ties to the later mark; none for a run without `--val`). The job scores `FINAL`, i.e. `ckpt-100`, after training unless the owner asks for another mark at launch: `./launch.sh --score-mark best` (or `SCORE_MARK=best`; a mark's own name such as `ckpt-050` works too, and `final` clears an earlier choice) writes `gs://$BUCKET/$JOB/score_mark`, which `run_job.sh` reads when scoring begins, so the choice holds across preemptions, restarts and `--recreate`, and can still be given while the job trains (VM metadata `score_mark`, or `SCORE_MARK` in the script's environment, override the object). Score `final`: `best` is not a reliable pick. Val decision loss is teacher-forced and does not rank the marks by free-decoding pass ([#1044](https://github.com/srikanth235/centraid/issues/1044): in job p7-r2 the lowest-loss mark, `ckpt-050`, passed 380 of 655 val sessions and `ckpt-100` 458). Read `marks.json` for the curves, and score another mark only to compare it. A `best` that has no usable `best.json` falls back to `FINAL` with a WARN line in the supervisor log; `results/scored_mark.json` records which mark the results are of. Extra scoring sets (below) follow the same choice.

Progress and fetching:

```sh
gcloud storage cat "gs://$BUCKET/$JOB/logs/train-*.log" | tail -20
gcloud storage ls gs://$BUCKET/$JOB/                      # job/ out/ logs/ results/ probe/ DONE
gcloud storage cat gs://$BUCKET/$JOB/out/best.json          # the mark with the lowest val decision loss (marks.json: every mark)
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

`score_ckpt.sh` scores ONE checkpoint on three sets, read from `eval/sets/<set>.jsonl`: `trainfit` (a fixed 300-session sample of train), `val` (655 sessions) and `test` (656 sessions). Test is scored only at milestones; every fix is derived on val. Per set the run reports three numbers: **session pass** (of the sessions; the reported outcome), **clean turn pass** (of the turns not downstream of a session's first failure; the number to steer by) and **turn pass** (of all turns). Decoding is greedy only.

The bundles come from `bundles.sh`, which stages the three sets with one runtime:

    BUNDLE_NATIVETOOLS=/path/to/nativetools ./bundles.sh      # -> $BUNDLES_DIR/{trainfit,val,test}/{bundle.dat,job.json,kernel.py}

`BUNDLES_DIR` defaults to `${BUNDLE_STAGE:-${TMPDIR:-/tmp}/centraid-bundles}/bundles`; `--sets val,test` builds a subset. Each set is `bundle.py build score-<set> --base --dry --set eval/sets/<set>.jsonl`, so the scoring settings above are identical in the three bundles and only `eval_set` and `eval_setup` differ. Rebuild them together whenever the runtime, the eval code or a set changes: the combined launch below needs identical files. `score_ckpt.sh` uploads them once to `gs://$BUCKET/bundles/<set>/` (checksum rsync: identical is skipped) and stops with a message naming `bundles.sh` when one is missing.

    export JOB=final-v2 BUCKET=centraid-train-clawgnition
    ./score_ckpt.sh gs://$BUCKET/$JOB/out/ckpt-100 --watch                       # the final checkpoint (restarts ct-train-$JOB)
    ./score_ckpt.sh gs://$BUCKET/$JOB/out/ckpt-050 --watch                       # the milestone checkpoint
    ./score_ckpt.sh gs://$BUCKET/$JOB/out --mark best --watch                    # the mark out/best.json names (lowest val decision loss; for comparison only)
    ./score_ckpt.sh gs://$BUCKET/other-job/out/ckpt-100 --new-vm --watch         # another training's checkpoint, on a new VM
    ./score_ckpt.sh /path/to/local/ckpt-dir --name mine --sets val,test          # a local dir is uploaded first
    ./score_ckpt.sh <checkpoint> --dry-run                                       # print the plan, create nothing

Options: `--mark MARK` (`<checkpoint>` then stands for the run: its `out/` dir, in a bucket or local, or any checkpoint dir of it, and MARK is a mark of that run: a name such as `ckpt-050`, or `best`, which reads `out/best.json`; without `--mark` the checkpoint is scored as given and `ckpt-100` stays the default, `best` is asked for, never assumed; a run without `best.json` stops with a message), `--name NAME` (default `<job>-<ckpt dir>`, e.g. `final-v2-ckpt-050`; the same name resumes), `--sets a,b`, `--bundles-prefix P` (bucket folder of the bundles, default `bundles`), `--vm NAME`, `--new-vm` (`ct-score-<name>`, `SCORE_DISK_GB` 100, Spot shapes cycled by `launch.sh`'s logic), `--watch`. The default restarts the training job's stopped VM with metadata `mode=score,manifest=...` and this `run_job.sh` as its startup script; `--watch` removes `mode`/`manifest` afterwards, otherwise do it by hand (`gcloud compute instances remove-metadata VM --zone Z --keys=mode,manifest`) before that VM trains again. The VM (`MODE=score` in `run_job.sh`) pulls the checkpoint once, installs deps once, then scores all requested sets in ONE `kernel.py` launch, writes `summary.json` and `DONE` and powers off after 15 min. `--watch` ends with a table of the three numbers per set (`rate (passed/of)`).

**One launch for all sets.** For two or more sets `run_job.sh` builds a combined eval at run time: the requested bundles (and only those: `--sets val,trainfit` never includes test) are extracted into one code dir, their `eval/sets/<set>.jsonl` are concatenated into `eval/sets/_combined.jsonl` (session ids must be unique across sets), `eval_setup` seeds the union of the worlds once, and one `job.json` is used. The build fails (and the script falls back, below) if the bundles' eval settings (everything in `job.json` except `eval_set` and `eval_setup`: `eval_procs`, `eval_chunks`, drive args, `eval_env`, arms), their `kernel.py`, or any shared file except `train/train.py` differ, or if session ids repeat. `kernel.py` then runs once (one model load and one 4-process worker pool, one world seeding, one tail); afterwards the run records are split by session id into per-set `run.jsonl` (in the set file's order) and `eval/score.py` scores each set against its own set file. Resume: a killed or incomplete launch is resumed in its work dir through `eval/free/claims`: on the next boot finished records are moved to `eval-keep/kept.jsonl` (the driver truncates its `--out` on start), claims of sessions that never finished are released, and only the remaining sessions run; nothing finished is re-run or dropped. When every session is finished no kernel starts. A set marker `state/sc-<NAME>-<set>.done` is written once that set's report is uploaded; `sc-<NAME>.combined.started|launch.secs|launch.done` track the launch. `SCORE_SEPARATE=1` (env of `score_ckpt.sh`, stored as metadata `score_separate=1`) restores one launch per set (private work dir and marker per set); it is also the automatic fallback when the combined build fails before the kernel starts (a WARN line in the supervisor log says why). A single set always runs on its own.

    gs://$BUCKET/bundles/<set>/{bundle.dat,job.json,kernel.py}
    gs://$BUCKET/score/<NAME>/manifest.json   {name, checkpoint, sets, bundles, created}
    gs://$BUCKET/score/<NAME>/<set>/          eval/free/{report.json,report.md,run.jsonl}, kernel.log (combined: the shared launch's log), score.log
    gs://$BUCKET/score/<NAME>/combined/       the combined launch's work dir (run.log, summary.json, kernel.log, collected.jsonl = all records, eval/free/*)
    gs://$BUCKET/score/<NAME>/logs/           supervisor and per-set kernel logs
    gs://$BUCKET/score/<NAME>/summary.json    per set: sessions, session_pass(+_rate), turns_clean, turn_pass_clean(+_rate), turns, turn_pass(+_rate), seconds (combined: only that set's split + score step); mode, launch_seconds (the kernel launch, null when separate), total_seconds
    gs://$BUCKET/score/<NAME>/DONE | FAILED   FAILED holds the reason; starting the VM again reruns only the unfinished sets

The clean-turn fields are null in the summary of a bundle whose `eval/score.py` predates clean turn pass; the per-set `report.json` is the source.

## Scoring more eval sets

After a training job's DONE, `run_job.sh` also scores every extra scoring bundle found in the bucket, without retraining (`score_ckpt.sh` is the usual way; this one needs no manifest). An extra bundle is a `bundles.sh` set, or any set file under `eval/` staged with `python ../bundle.py build <name> --base --set eval/sets/<set>.jsonl`. The set and the worlds it needs live inside `bundle.dat`; `job.json`'s `eval_setup` seeds them, and `run_job.sh` fills in the checkpoint from the VM's disk.

Layout (one directory per set; `kernel.py` optional, the job's own is used when absent):

    gs://$BUCKET/$JOB/extra/<name>/bundle.dat
    gs://$BUCKET/$JOB/extra/<name>/job.json
    gs://$BUCKET/$JOB/extra/<name>/kernel.py
    e.g. <name> = test, trainfit or val, copied from $BUNDLES_DIR/<name>/

Upload and start the stopped VM (it keeps its disk, so the checkpoint is already there):

    gcloud storage cp "$BUNDLES_DIR"/test/* gs://$BUCKET/$JOB/extra/test/ --project centraid
    gcloud compute instances add-metadata ct-train-$JOB --zone ZONE --project centraid \
      --metadata-from-file=startup-script=experiments/toolchat/native/train/vm/run_job.sh
    gcloud compute instances start ct-train-$JOB --zone ZONE --project centraid

A finished job skips training and val, scores only the extra sets without a `$STATE/score-<name>.done` marker (one at a time, in name order), and powers off 15 min after the last one. A set whose kernel failed has no marker and is rerun on the next start.

- Results: `gs://$BUCKET/$JOB/results-<name>/` (`eval/free/report.md|json`, `summary.json`, `run.log`); logs in `logs/score-<name>-*.log`.
- Another checkpoint: add metadata `extra_ckpts` (space or comma list, e.g. `ckpt-050`) before the start: `gcloud compute instances add-metadata ct-train-$JOB --zone ZONE --project centraid --metadata extra_ckpts=ckpt-050`. The job's checkpoint (`FINAL`, or the `score_mark` one) is always scored; `best` is a name here too; `ckpt-050` goes to `results-<name>-ckpt-050/` (marker `score-<name>-ckpt-050.done`). A checkpoint missing on the disk is pulled from `gs://$BUCKET/$JOB/out/<ckpt>/`.
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

## gcloud flows not yet confirmed against a real run

A full train, watch and score cycle (#1044) ran `compute instances create` with every flag `common.sh` passes on `a3-highgpu-1g` (Spot, `STOP`, `TERMINATE`, boot disk, image family, scopes, labels, metadata, the startup and shutdown scripts, the A3 gVNIC interface), `images describe-from-family`, `gcloud storage` `cp`, `rsync`, `ls` and `cat`, and the serial-port log stream. No run so far exercised:

- the A2 shapes (`a2-ultragpu-1g`, `a2-highgpu-1g`), the `hyperdisk-balanced` retry and `NIC_A3=""`;
- a preemption restart and `launch.sh --recreate`;
- `buckets create --location --uniform-bucket-level-access` (the bucket existed) and `instances delete --delete-disks=all`;
- the error texts matched by `classify_error` (stockout, quota, machine type missing): they are from memory, an unmatched error is reported as "unclassified" and the launcher aborts after 6 in a row.

Image families are `common-cu129-ubuntu-2204-nvidia-580` then `common-cu129-ubuntu-2404-nvidia-580` (`IMAGE_FAMILIES` in `common.sh`; the script checks with `images describe-from-family` and dies with the listing command if none exists). `flash-linear-attention` is unpinned; its resolved version is in `logs/pip-freeze.txt`.

## Service-account login (unattended runs)

User logins can expire (Workspace session control). Instead set `GCP_SA_KEY_JSON` (the key JSON) or `GCP_SA_KEY_FILE` before running launch.sh, watch.sh, probe.sh or score_ckpt.sh. The script writes the key to tmpfs, activates it in a throwaway `CLOUDSDK_CONFIG`, deletes the key file at once, and removes the whole config on exit; your own gcloud config and the repo are never touched. The service account needs `roles/compute.instanceAdmin.v1`, `roles/iam.serviceAccountUser`, and `roles/storage.objectAdmin` on the bucket. Delete the key after the last run.
