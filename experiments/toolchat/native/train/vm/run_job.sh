#!/usr/bin/env bash
# run_job.sh: the training VM's startup-script AND shutdown-script (launch.sh passes this one file for both). Idempotent: it
# runs on EVERY boot and does only what is not finished yet. All state is in gs://$BUCKET/$JOB/ and on the boot disk (/opt/centraid).
#
#   gs://$BUCKET/$JOB/job/      the staged job: bundle.dat (or bundle.tar.gz), job.json, kernel.py  (kaggle.py's data/ + kernel/)
#   gs://$BUCKET/$JOB/out/      mirror of train.py --out: ckpt-025/050/100, FINAL, train_meta.json, the newest resume-step-NNNNNN/,
#                               and train.py's own DONE (training finished)
#   gs://$BUCKET/$JOB/logs/     supervisor, trainer and scoring logs (one file per boot), pip-freeze.txt
#   gs://$BUCKET/$JOB/results/  the kernel's scoring outputs: eval/<arm>/report.md|json, summary.json, run.log
#   gs://$BUCKET/$JOB/DONE      written LAST, when training and scoring are finished (JSON); watch.sh stops on it. FAILED: gave up.
#
# Boot flow: GPU up -> pull job -> venv with the pinned deps -> unpack -> pull out/ (only on a fresh disk) -> train under nohup with
# `--save-every N --resume` (same command every boot; the trainer continues from the newest complete resume checkpoint) while syncing
# --out to the bucket every SYNC_INTERVAL s -> on DONE: score with kernel.py (eval-only mode on the final checkpoint) -> upload ->
# write DONE -> power off. A stage whose marker exists is skipped.
#
# Shutdown/preemption: as the shutdown-script this file detects the shutdown (systemd 'stopping' or instance/preempted), SIGTERMs the
# trainer (which writes a resume checkpoint at its next step boundary if its --term-grace allows, then exits 0 with out/PREEMPTED)
# and does one quick best-effort sync (the ~30 s notice is far too short to upload a multi-GB resume checkpoint: the periodic sync is
# what protects the run if the disk is lost).
#
# Metadata (set by launch.sh): job, bucket, save_every, sync_interval, epochs, train_hours, max_restarts, [python], [fla_spec], [mode=probe|score, manifest=gs://... (score)].
set -uo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 DEBIAN_FRONTEND=noninteractive

MDURL=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -m 5 -H 'Metadata-Flavor: Google' "$MDURL/$1" 2>/dev/null; }
attr() { md "instance/attributes/$1" || true; }
cfg() { local v; v=$(attr "$1"); echo "${v:-$2}"; }

JOB=${JOB:-$(attr job)}
BUCKET=${BUCKET:-$(attr bucket)}
[ -n "$JOB" ] && [ -n "$BUCKET" ] || { echo "run_job.sh: metadata job/bucket missing" >&2; exit 1; }
MODE=$(cfg mode train)
SAVE_EVERY=$(cfg save_every 40)
SYNC_INTERVAL=$(cfg sync_interval 600)
EPOCHS=$(cfg epochs 6)
TRAIN_HOURS=$(cfg train_hours 24)
MAX_RESTARTS=$(cfg max_restarts 3)
FLA_SPEC=$(cfg fla_spec flash-linear-attention)   # unpinned in the Modal image too; its resolved version is logged in pip-freeze.txt
GS="gs://$BUCKET/$JOB"

BASE=${CENTRAID_BASE:-/opt/centraid}   # the boot disk; CENTRAID_BASE only for a local rehearsal
STATE=$BASE/state
VENV=$BASE/venv
CODE=$BASE/code
OUT=$BASE/out
JOBDIR=$BASE/job
LOGDIR=$BASE/logs
SCORE_W=$BASE/score
SD=$BASE/score-input
export HF_HOME=$BASE/hf
mkdir -p "$STATE" "$LOGDIR" "$OUT" "$JOBDIR" "$HF_HOME"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUPLOG=$LOGDIR/supervisor-$STAMP.log
TRAINLOG=$LOGDIR/train-$STAMP.log

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$SUPLOG"; }
retry() { local n=$1 i; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep $((i * 5)); done; return 1; }

# gcloud storage, bounded by QUICK_END (epoch seconds) when set by a quick sync
gcs() {
  if [ "${QUICK_END:-0}" -gt 0 ]; then
    local rem=$((QUICK_END - $(date +%s)))
    [ "$rem" -gt 0 ] || return 124
    timeout "$rem" gcloud storage "$@"
  else
    gcloud storage "$@"
  fi
}
gcs_has() { gcs ls "$1" >/dev/null 2>&1; }

shutting_down() {
  [ "$(systemctl is-system-running 2>/dev/null)" = stopping ] || [ "$(md instance/preempted)" = TRUE ] || [ -n "${FORCE_SHUTDOWN_MODE:-}" ]
}

# ---- bucket sync ----------------------------------------------------------------------------------------------
sync_logs() { gcs rsync -r "$LOGDIR" "$GS/logs" >>"$SUPLOG" 2>&1 || say "WARN: log sync failed"; }

# everything in --out except resume checkpoints: dirs first (ckpt-* only once their train_meta.json, written last, exists),
# then the loose files (DONE last-ish), so out/DONE in the bucket implies the final checkpoint is there. PREEMPTED stays local.
sync_rest() {
  local f b files=()
  for f in "$OUT"/*; do
    [ -e "$f" ] || continue
    b=${f##*/}
    case $b in resume-step-* | .tmp-* | PREEMPTED) continue ;; esac
    if [ -d "$f" ]; then
      [ "$SYNC_MODE" = quick ] && continue
      case $b in ckpt-*) [ -f "$f/train_meta.json" ] || continue ;; esac
      gcs rsync -r "$f" "$GS/out/$b" >>"$SUPLOG" 2>&1 || say "WARN: sync of $b failed"
    else
      files+=("$f")
    fi
  done
  if [ ${#files[@]} -gt 0 ]; then gcs cp "${files[@]}" "$GS/out/" >>"$SUPLOG" 2>&1 || say "WARN: sync of loose files failed"; fi
}

# The newest COMPLETE resume checkpoint only: state.pt + info.json first, COMPLETE last (a bucket copy without COMPLETE is never
# loaded by the trainer), then every older resume-step-* in the bucket is removed.
sync_resume() {
  local d newest="" name u
  for d in "$OUT"/resume-step-*; do [ -f "$d/COMPLETE" ] && newest=$d; done   # zero-padded names: the glob is oldest first
  [ -n "$newest" ] || return 0
  name=${newest##*/}
  if ! gcs_has "$GS/out/$name/COMPLETE"; then
    say "uploading resume checkpoint $name ($(du -sh "$newest" | cut -f1))"
    if gcs cp "$newest/state.pt" "$newest/info.json" "$GS/out/$name/" >>"$SUPLOG" 2>&1 &&
      gcs cp "$newest/COMPLETE" "$GS/out/$name/" >>"$SUPLOG" 2>&1; then
      say "resume checkpoint $name is in the bucket"
    else
      say "WARN: resume checkpoint upload failed or was cut off; the older one stays in the bucket"
      return 1
    fi
  fi
  gcs ls "$GS/out/" 2>/dev/null | grep -E '/resume-step-[0-9]+/?$' | sed 's#/$##' | while read -r u; do
    [ "${u##*/}" = "$name" ] || gcs rm -r "$u" >>"$SUPLOG" 2>&1
  done
  return 0
}

# sync_up periodic|final|quick
sync_up() {
  (
    flock -w 120 8 || { say "sync: another sync is running too long"; exit 1; }
    SYNC_MODE=${1:-periodic}
    QUICK_END=0
    [ "$SYNC_MODE" = quick ] && QUICK_END=$(($(date +%s) + 20))
    sync_logs
    sync_rest
    sync_resume
  ) 8>"$STATE/sync.lock"
}

graceful_stop() {
  local pid i
  pid=$(cat "$STATE/train.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    say "stop requested: SIGTERM to trainer $pid"
    kill -TERM "$pid"
    for i in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  sync_up quick
}

# ---- shutdown-script mode ------------------------------------------------------------------------------------
if shutting_down; then
  say "shutdown hook (preempted=$(md instance/preempted))"
  [ "$MODE" = score ] && exit 0   # a scoring VM has no trainer and no out/ to sync
  [ -f "$STATE/final.done" ] || graceful_stop
  exit 0
fi

# ---- one supervisor at a time ---------------------------------------------------------------------------------
LOCK=${CENTRAID_LOCK:-/run/centraid-job.lock}
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "run_job.sh is already running on this VM (lock $LOCK): nothing to do" >&2
  exit 0
fi
trap 'say "SIGTERM/SIGINT at the supervisor"; graceful_stop; exit 143' TERM INT

fail_job() {
  local reason=${1//\"/\'}
  reason=${reason//$'\n'/ }
  say "FAILED: $reason"
  printf '{"job":"%s","time":"%s","reason":"%s"}\n' "$JOB" "$(date -u +%FT%TZ)" "$reason" >"$STATE/FAILED.json"
  sync_up final
  gcs cp "$STATE/FAILED.json" "$GS/FAILED" >>"$SUPLOG" 2>&1
  say "powering off in 30 min (ssh in before that to debug; 'sudo shutdown -c' cancels); a later start of this VM retries"
  shutdown -h +30 "centraid job failed: $reason" >/dev/null 2>&1
  exit 1
}

wait_gpu() {
  local i
  for i in $(seq 1 90); do nvidia-smi -L >/dev/null 2>&1 && return 0; sleep 10; done
  if [ -x /opt/deeplearning/install-driver.sh ]; then
    say "no GPU driver after 15 min: running /opt/deeplearning/install-driver.sh"
    /opt/deeplearning/install-driver.sh >>"$SUPLOG" 2>&1
  fi
  nvidia-smi -L >/dev/null 2>&1
}

# ---- stages ---------------------------------------------------------------------------------------------------
pull_job() {
  [ -f "$STATE/job.ok" ] && [ -f "$JOBDIR/job.json" ] && return 0
  say "pulling $GS/job/"
  retry 5 gcs rsync -r "$GS/job" "$JOBDIR" >>"$SUPLOG" 2>&1 || return 1
  [ -f "$JOBDIR/job.json" ] || return 1
  touch "$STATE/job.ok"
}

job_trains() { python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("train") else 1)' "$JOBDIR/job.json"; }

pick_python() {
  local p
  p=$(attr python)
  if [ -n "$p" ]; then echo "$p"; return; fi
  for p in python3.11 python3.12 python3.10 python3; do   # 3.11 is what the Modal image runs
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then command -v "$p"; return; fi
  done
}

ensure_pyheaders() {  # triton (used by flash-linear-attention) compiles a C helper against Python.h; the DLVM image has no python-dev
  local py inc
  py="$VENV/bin/python"; [ -x "$py" ] || py=$(pick_python)
  [ -n "$py" ] || return 0
  inc=$("$py" -c 'import sysconfig; print(sysconfig.get_paths()["include"])' 2>/dev/null) || return 0
  [ -f "$inc/Python.h" ] && return 0
  local ver; ver=$("$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  say "installing Python headers for $ver (Python.h missing)"
  apt-get update -qq >>"$SUPLOG" 2>&1
  apt-get install -y -qq "python${ver}-dev" build-essential >>"$SUPLOG" 2>&1 || apt-get install -y -qq python3-dev build-essential >>"$SUPLOG" 2>&1
}

ensure_triton() {  # flash-linear-attention refuses Triton 3.4.0 to 3.7.0 on Hopper (wrong gated chunk backward, fla #640): need >= 3.7.1
  [ -x "$VENV/bin/python" ] || return 0
  "$VENV/bin/python" -c 'import sys, triton; from packaging.version import Version as V; sys.exit(0 if V(triton.__version__) >= V("3.7.1") else 1)' >/dev/null 2>&1 && return 0
  say "upgrading triton to >= 3.7.1 (fla refuses the Triton that torch 2.8.0 pins on Hopper)"
  retry 3 "$VENV/bin/pip" install -q --no-input "triton>=3.7.1" >>"$SUPLOG" 2>&1 || { say "triton upgrade failed"; return 1; }
  say "triton $("$VENV/bin/python" -c 'import triton; print(triton.__version__)' 2>&1)"
}

ensure_deps() {
  ensure_pyheaders
  ensure_triton || return 1
  local info tr lg lora pins key py
  info=$(python3 - "$JOBDIR/job.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
print(j["transformers"], j["llguidance"], "1" if "--lora" in j.get("train_args", []) else "0")
PY
  ) || return 1
  read -r tr lg lora <<<"$info"
  # The Modal image's pins (modal_run.py): torch 2.8.0 (PyPI's default wheel is CUDA 12.8) + these, installed in one command;
  # transformers / llguidance come from the staged job.json (kernel.py installs the same pair); peft only for --lora (kernel.py).
  pins=(torch==2.8.0 numpy huggingface_hub sentencepiece protobuf packaging wheel setuptools "transformers==$tr" "llguidance==$lg" "$FLA_SPEC")
  [ "$lora" = 1 ] && pins+=(peft)
  key=$(printf '%s ' "${pins[@]}" | md5sum | cut -c1-12)
  if [ -f "$STATE/deps-$key.ok" ] && [ -x "$VENV/bin/python" ]; then return 0; fi
  say "installing deps: ${pins[*]}"
  if [ ! -x "$VENV/bin/python" ]; then
    py=$(pick_python)
    [ -n "$py" ] || { say "no python >= 3.10 found"; return 1; }
    say "python for the venv: $py ($("$py" --version 2>&1))"
    "$py" -m venv "$VENV" >>"$SUPLOG" 2>&1 || {
      apt-get update -qq >>"$SUPLOG" 2>&1
      apt-get install -y -qq python3-venv >>"$SUPLOG" 2>&1
      rm -rf "$VENV"
      "$py" -m venv "$VENV" >>"$SUPLOG" 2>&1
    } || return 1
  fi
  retry 3 "$VENV/bin/pip" install -q --no-input --upgrade pip >>"$SUPLOG" 2>&1
  retry 3 "$VENV/bin/pip" install -q --no-input "${pins[@]}" >>"$SUPLOG" 2>&1 || return 1
  ensure_triton || return 1
  "$VENV/bin/pip" freeze >"$LOGDIR/pip-freeze.txt" 2>&1
  "$VENV/bin/python" - >>"$SUPLOG" 2>&1 <<'PY' || return 1
import sys, torch, transformers
print("torch", torch.__version__, "cuda", torch.version.cuda, "transformers", transformers.__version__, "python", sys.version.split()[0])
ok = torch.cuda.is_available()
print("cuda available:", ok, torch.cuda.get_device_name(0) if ok else "")
sys.exit(0 if ok else 3)
PY
  touch "$STATE/deps-$key.ok"
}

extract_code() {
  [ -f "$STATE/code.ok" ] && [ -d "$CODE/train" ] && return 0
  local b=""
  for f in bundle.dat bundle.tar.gz; do [ -f "$JOBDIR/$f" ] && b=$JOBDIR/$f && break; done
  [ -n "$b" ] || { say "no bundle.dat / bundle.tar.gz in $JOBDIR"; return 1; }
  rm -rf "$CODE"
  mkdir -p "$CODE"
  tar -xzf "$b" -C "$CODE" || return 1
  # nativetools was linked against the builder's glibc: run it through the shipped loader, as kernel.py does
  printf '#!/bin/sh\nexec "%s/lib/ld-linux-x86-64.so.2" --library-path "%s/lib" "%s/bin/nativetools.bin" "$@"\n' "$CODE" "$CODE" "$CODE" >"$CODE/bin/nativetools"
  chmod 755 "$CODE"/lib/* "$CODE/bin/nativetools" "$CODE/bin/nativetools.bin"
  touch "$STATE/code.ok"
}

# A fresh disk (new VM, e.g. another zone) gets out/ from the bucket; a surviving disk (restart after preemption) keeps its own,
# which is at least as new as the bucket's copy.
pull_out() {
  [ -f "$STATE/out.pulled" ] && return 0
  if gcs_has "$GS/out/"; then
    say "fresh disk: restoring $GS/out/ (newest resume checkpoint, final checkpoints, logs)"
    retry 3 gcs rsync -r "$GS/out" "$OUT" >>"$SUPLOG" 2>&1 || return 1
  else
    say "nothing in $GS/out/ yet: starting from step 0"
  fi
  touch "$STATE/out.pulled"
}

# the kernel's train command (kernel.py step 3), plus this script's resume flags. $1 = train | probe. One argument per line.
build_train_args() {
  "$VENV/bin/python" - "$JOBDIR/job.json" "$1" "$OUT" "$TRAIN_HOURS" "$SAVE_EVERY" "$EPOCHS" "${PROBE_STEPS:-24}" <<'PY'
import json, sys
job = json.load(open(sys.argv[1]))
mode, out, hours, save_every, epochs, probe_steps = sys.argv[2:8]
a = ["--model", job["model"], "--train", job["train"], "--tools", "export/tools-sig.json", "--out", out, "--hours", hours]
if job.get("val"):
    a += ["--val", job["val"]]
if job.get("test"):
    a += ["--test", job["test"]]
a += job.get("train_args", [])
if "--epochs" not in a:
    a += ["--epochs", epochs]
if mode == "train":
    a += ["--save-every", save_every, "--resume"]
else:  # probe: the real settings for a few steps; cheap evals, one checkpoint, no resume state, no test file
    a = [x for x in a if x != "--resume"]  # unary flag: drop before the pair-wise filter below
    over = {"--save-every": "0", "--max-steps": probe_steps, "--epochs": "1", "--val-n": "8", "--train-eval-n": "8", "--checkpoints": "1.0",
            "--log-every": "3", "--hours": "1"}
    keep, i = [], 0
    while i < len(a):  # drop the flags being overridden (and --test) with their values, then append the overrides
        if a[i] in over or a[i] == "--test":
            i += 2
        else:
            keep.append(a[i])
            i += 1
    a = keep + [x for kv in over.items() for x in kv]
print("\n".join(a))
PY
}

# start the trainer in the background; its pid is in $STATE/train.pid and $TRAINER_PID
start_trainer() { # $1 = log file, $2 = extra env (NAME=value), rest = args
  local log=$1 extra=$2
  shift 2
  (
    cd "$CODE" || exit 1
    exec nohup env NATIVETOOLS="$CODE/bin/nativetools" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false HF_HOME="$HF_HOME" ${extra:+"$extra"} \
      "$VENV/bin/python" train/train.py "$@"
  ) >>"$log" 2>&1 9>&- &
  TRAINER_PID=$!
  echo "$TRAINER_PID" >"$STATE/train.pid"
}

run_training() {
  local restarts=0 rc i last now
  local -a targs
  while :; do
    if [ -f "$OUT/DONE" ]; then say "training already finished (out/DONE)"; return 0; fi
    mapfile -t targs < <(build_train_args train)
    [ "${#targs[@]}" -gt 0 ] || fail_job "could not build the trainer command from $JOBDIR/job.json"
    say "starting trainer: python train/train.py ${targs[*]}"
    start_trainer "$TRAINLOG" "" "${targs[@]}"
    say "trainer pid $TRAINER_PID, log $TRAINLOG"
    last=$(date +%s)
    while kill -0 "$TRAINER_PID" 2>/dev/null; do
      sleep 5 &
      wait $!
      now=$(date +%s)
      if [ $((now - last)) -ge "$SYNC_INTERVAL" ]; then
        sync_up periodic
        last=$(date +%s)
      fi
    done
    wait "$TRAINER_PID"
    rc=$?
    say "trainer exited rc=$rc: $(tail -n 1 "$TRAINLOG" | cut -c1-200)"
    if [ -f "$OUT/DONE" ]; then return 0; fi
    if [ -f "$OUT/PREEMPTED" ]; then
      # SIGTERM-stopped with a resume checkpoint. If the VM is going down, sync what fits and leave; if not, run it again.
      for i in $(seq 1 12); do shutting_down && break; sleep 5; done
      if shutting_down; then
        say "preempted: quick sync, then the VM goes down; the next boot resumes"
        sync_up quick
        exit 0
      fi
      say "trainer stopped by SIGTERM but the VM is not shutting down: restarting it"
      continue
    fi
    restarts=$((restarts + 1))
    if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
      fail_job "trainer crashed $restarts times (last rc=$rc): $(tail -n 3 "$TRAINLOG" | tr '\n' ' ' | cut -c1-400)"
    fi
    say "trainer crashed (rc=$rc), restart $restarts/$MAX_RESTARTS in 30 s (it resumes from the newest resume checkpoint)"
    sync_up periodic
    sleep 30
  done
}

# Scoring = kernel.py's eval stage. kernel.py is used as shipped: a copy of job.json with `train` null and the final checkpoint
# presented the way it already accepts an eval-only checkpoint (ckpt_prefix + ckpt_files, symlinked into the input dir).
run_scoring() {
  [ -f "$STATE/score.done" ] && { say "scoring already finished"; return 0; }
  local final ckdir b="" f rc
  final=$(tr -d '[:space:]' <"$OUT/FINAL" 2>/dev/null)
  ckdir=$OUT/$final
  [ -n "$final" ] && [ -d "$ckdir" ] || fail_job "training is DONE but the final checkpoint '$final' is missing in $OUT"
  [ -f "$JOBDIR/kernel.py" ] || fail_job "$GS/job/kernel.py is missing (upload kaggle.py's kernel/kernel.py)"
  for f in bundle.dat bundle.tar.gz; do [ -f "$JOBDIR/$f" ] && b=$f && break; done
  rm -rf "$SD" "$SCORE_W"
  mkdir -p "$SD" "$SCORE_W"
  ln -s "$JOBDIR/$b" "$SD/$b"
  "$VENV/bin/python" - "$JOBDIR/job.json" "$SD" "$ckdir" <<'PY' || fail_job "could not prepare the scoring input"
import json, os, sys
src, sd, ck = sys.argv[1:4]
j = json.load(open(src))
files = sorted(f for f in os.listdir(ck) if os.path.isfile(os.path.join(ck, f)))
for f in files:
    os.symlink(os.path.realpath(os.path.join(ck, f)), os.path.join(sd, "ckpt." + f))
j.update(train=None, val=None, fast_kernels=False, ckpt_prefix="ckpt.", ckpt_files=files)
json.dump(j, open(os.path.join(sd, "job.json"), "w"), indent=1)
PY
  say "scoring $final with kernel.py (arms: $("$VENV/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["arms"])' "$JOBDIR/job.json"))"
  (cd "$SD" && env KERNEL_WORK="$SCORE_W" KERNEL_INPUT="$SD" HF_HOME="$HF_HOME" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false \
    "$VENV/bin/python" "$JOBDIR/kernel.py") >"$LOGDIR/score-$STAMP.log" 2>&1
  rc=$?
  say "kernel.py exit $rc"
  echo "$rc" >"$STATE/score.rc"
  rm -rf "$SCORE_W/ckpt-in" "$SCORE_W/code" "$SCORE_W/vaults"   # symlinks to the weights would be followed by the upload
  sync_logs
  retry 3 gcs rsync -r "$SCORE_W" "$GS/results" >>"$SUPLOG" 2>&1 || say "WARN: results upload failed; they stay in $SCORE_W on the disk"
  touch "$STATE/score.done"
}

# ---- extra eval sets (scoring only, no training) ----------------------------------------------------------------
# gs://$BUCKET/$JOB/extra/<name>/{bundle.dat,job.json[,kernel.py]} (an eval-only bundle from kaggle.py, see README "Scoring more
# eval sets") is scored on the FINAL checkpoint, plus every checkpoint named in metadata `extra_ckpts` / env EXTRA_CKPTS (space or
# comma list, e.g. "ckpt-050"). One set at a time; a finished (set, checkpoint) has $STATE/score-<name>[-<ckpt>].done and is skipped
# on later boots, an unfinished one is rerun. Results: $GS/results-<name>[-<ckpt>]/. A failed set never fails the job.
EXTRA_CKPTS=${EXTRA_CKPTS:-$(attr extra_ckpts)}

extra_names() { gcs ls "$GS/extra/" 2>/dev/null | sed -n 's#.*/extra/\([^/]\+\)/*$#\1#p' | sort; }
extra_ckpts() { echo final $(echo "$EXTRA_CKPTS" | tr ',' ' '); }   # "final" = the checkpoint named by $OUT/FINAL
extra_tag() { [ "$2" = final ] && echo "$1" || echo "$1-$2"; }        # score-<tag>.done, results-<tag>

extra_pending() {  # one "name ckpt" line per (set, checkpoint) not finished yet
  local n c
  for n in $(extra_names); do
    for c in $(extra_ckpts); do [ -f "$STATE/score-$(extra_tag "$n" "$c").done" ] || echo "$n $c"; done
  done
}

# score_extra NAME CKPT: kernel.py's eval stage on one checkpoint with the extra bundle (the same input preparation as run_scoring)
score_extra() {
  local name=$1 ck=$2 tag x w sd ckdir rc b=""
  tag=$(extra_tag "$name" "$ck")
  [ -f "$STATE/score-$tag.done" ] && { say "extra set $tag already scored"; return 0; }
  [ "$ck" = final ] && ck=$(tr -d '[:space:]' <"$OUT/FINAL" 2>/dev/null)
  ckdir=$OUT/$ck
  if [ ! -d "$ckdir" ] && [ -n "$ck" ]; then retry 3 gcs rsync -r "$GS/out/$ck" "$ckdir" >>"$SUPLOG" 2>&1; fi   # fresh disk: just that checkpoint
  [ -n "$ck" ] && [ -f "$ckdir/config.json" ] || { say "WARN: extra set $tag: checkpoint '$ck' missing in $OUT and $GS/out"; return 1; }
  x=$BASE/extra/$name
  w=$BASE/score-$tag
  sd=$BASE/score-input-$tag
  rm -rf "$x" "$w" "$sd"
  mkdir -p "$x" "$w" "$sd"
  retry 3 gcs rsync -r "$GS/extra/$name" "$x" >>"$SUPLOG" 2>&1 || { say "WARN: cannot pull $GS/extra/$name/"; return 1; }
  [ -f "$x/kernel.py" ] || cp "$JOBDIR/kernel.py" "$x/kernel.py"
  for f in bundle.dat bundle.tar.gz; do [ -f "$x/$f" ] && b=$f && break; done
  [ -n "$b" ] && [ -f "$x/job.json" ] || { say "WARN: extra set $name has no bundle.dat/job.json"; return 1; }
  ln -s "$x/$b" "$sd/$b"
  "$VENV/bin/python" - "$x/job.json" "$sd" "$ckdir" <<'PY' || { say "WARN: could not prepare the scoring input for $tag"; return 1; }
import json, os, sys
src, sd, ck = sys.argv[1:4]
j = json.load(open(src))
files = sorted(f for f in os.listdir(ck) if os.path.isfile(os.path.join(ck, f)))
for f in files:
    os.symlink(os.path.realpath(os.path.join(ck, f)), os.path.join(sd, "ckpt." + f))
j.update(train=None, val=None, fast_kernels=False, ckpt_prefix="ckpt.", ckpt_files=files)
json.dump(j, open(os.path.join(sd, "job.json"), "w"), indent=1)
PY
  say "scoring extra set $tag ($ck) with kernel.py"
  (cd "$sd" && env KERNEL_WORK="$w" KERNEL_INPUT="$sd" HF_HOME="$HF_HOME" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false \
    "$VENV/bin/python" "$x/kernel.py") >"$LOGDIR/score-$tag-$STAMP.log" 2>&1
  rc=$?
  say "kernel.py ($tag) exit $rc"
  echo "$rc" >"$STATE/score-$tag.rc"
  rm -rf "$w/ckpt-in" "$w/code" "$w/vaults"   # symlinks to the weights would be followed by the upload
  sync_logs
  retry 3 gcs rsync -r "$w" "$GS/results-$tag" >>"$SUPLOG" 2>&1 || { say "WARN: results upload for $tag failed; they stay in $w"; return 1; }
  # done only when the kernel exited 0 and produced a report; otherwise the next boot reruns it
  if [ "$rc" = 0 ] && [ -n "$(find "$w" -name report.json 2>/dev/null | head -1)" ]; then touch "$STATE/score-$tag.done"; else say "WARN: $tag not marked done (rc=$rc)"; fi
  rm -rf "$w" "$sd" "$x"
}

run_extra_scoring() {
  local n c
  while read -r n c; do
    [ -n "$n" ] && { score_extra "$n" "$c" || true; }
  done < <(extra_pending)
}

finalize() {
  local rc
  rc=$(cat "$STATE/score.rc" 2>/dev/null || echo "null")
  "$VENV/bin/python" - "$JOB" "$rc" "$OUT/DONE" >"$STATE/DONE.json" <<'PY'
import json, sys, time
job, rc, done = sys.argv[1:4]
try:
    train = json.load(open(done))
except Exception:
    train = None
print(json.dumps({"job": job, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "score_exit": int(rc) if rc.lstrip("-").isdigit() else None, "train": train}))
PY
  sync_up final
  retry 5 gcs cp "$STATE/DONE.json" "$GS/DONE" >>"$SUPLOG" 2>&1 || fail_job "could not write $GS/DONE"
  touch "$STATE/final.done"
  say "DONE written to $GS/DONE; powering off (the VM stays TERMINATED: stopped disks cost, delete per the README when results are fetched)"
  sync
  shutdown -h now "centraid job done"
  sleep 120
  poweroff -f
}

# ---- probe mode (probe.sh): the real trainer for a few steps, per memory fallback, then report + power off -----------------
run_probe() {
  local PR=$BASE/probe n=0 rc secs t0 label extra fit
  export PROBE_STEPS=$(cfg probe_steps 24)
  local lora_r
  lora_r=$(cfg probe_lora 64)
  rm -rf "$PR"
  mkdir -p "$PR"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader >"$PR/gpu.csv" 2>&1
  : >"$PR/attempts.tsv"
  local -a targs
  for spec in "baseline|" "expandable_segments|PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" "lora-$lora_r|PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"; do
    label=${spec%%|*}
    extra=${spec#*|}
    n=$((n + 1))
    OUT=$PR/out-$n
    mapfile -t targs < <(build_train_args probe)
    [ "${#targs[@]}" -gt 0 ] || fail_job "could not build the trainer command from $JOBDIR/job.json"
    case $label in lora-*) targs+=(--lora "$lora_r") ;; esac
    say "probe attempt $n ($label): ${targs[*]}"
    t0=$(date +%s)
    rm -rf "$PR/out-$n"
    (
      cd "$CODE" || exit 1
      timeout "$(cfg probe_timeout_s 1800)" env NATIVETOOLS="$CODE/bin/nativetools" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false HF_HOME="$HF_HOME" ${extra:+"$extra"} \
        "$VENV/bin/python" train/train.py "${targs[@]}"
    ) >"$PR/attempt-$n.log" 2>&1
    rc=$?
    secs=$(($(date +%s) - t0))
    printf '%s\t%s\t%s\t%s\n' "$n" "$label" "$rc" "$secs" >>"$PR/attempts.tsv"
    rm -rf "$PR/out-$n"
    [ "$rc" = 0 ] && break
    # only a memory failure is worth another attempt with a memory fallback
    grep -qiE 'out of memory|OutOfMemory|does not fit' "$PR/attempt-$n.log" || break
  done
  echo "$PROBE_STEPS" >"$PR/steps"
  gcs rsync -r "$PR" "$GS/probe" >>"$SUPLOG" 2>&1
  echo done >"$PR/DONE"
  gcs cp "$PR/DONE" "$GS/probe/DONE" >>"$SUPLOG" 2>&1
  say "probe finished; powering off"
  shutdown -h now "centraid probe done"
  sleep 120
  poweroff -f
}

finish_idle() {
  say "$1; powering off in 15 min ('sudo shutdown -c' cancels)"
  shutdown -h +15 "centraid: nothing to do" >/dev/null 2>&1
  exit 0
}

# ---- MODE=score: score one checkpoint on several eval sets (score_ckpt.sh) ------------------------------------------------
# Several sets are scored by ONE kernel.py launch over their union (score_combined); `score_separate=1` metadata / SCORE_SEPARATE=1 env
# restores one launch per set (score_one). Metadata `manifest` = gs://$BUCKET/score/<NAME>/manifest.json: {"name", "checkpoint" (gs:// dir), "sets" [..], "bundles" (gs:// prefix
# holding <set>/{bundle.dat,job.json,kernel.py}: eval-only bundles from kaggle.py), "created"}. Flow: checkpoint pulled once to the
# disk, deps once, then each set with kernel.py's eval stage (private KERNEL_WORK per set, state marker $STATE/sc-<NAME>-<set>.done
# so a reboot resumes), results to gs://$BUCKET/score/<NAME>/<set>/, then summary.json + DONE, power off in 15 min.
score_sync_logs() { gcs rsync -r "$LOGDIR" "$SGS/logs" >>"$SUPLOG" 2>&1 || say "WARN: log sync failed"; }

score_fail() {
  local reason=${1//\"/\'}
  say "FAILED: $reason"
  printf '{"name":"%s","time":"%s","reason":"%s"}\n' "$SNAME" "$(date -u +%FT%TZ)" "${reason//$'\n'/ }" >"$STATE/sc-$SNAME.FAILED.json"
  score_sync_logs
  gcs cp "$STATE/sc-$SNAME.FAILED.json" "$SGS/FAILED" >>"$SUPLOG" 2>&1
  finish_idle "scoring failed: $reason"
}

# score_one SET: 0 = done (marker written), 1 = failed (rerun on the next boot)
score_one() {
  local set=$1 x w sd rc t0 secs b="" f
  [ -f "$STATE/sc-$SNAME-$set.done" ] && { say "set $set already scored"; return 0; }
  x=$BASE/bundles/$set
  w=$BASE/score-w-$set
  sd=$BASE/score-in-$set
  rm -rf "$x" "$w" "$sd"
  mkdir -p "$x" "$w" "$sd"
  retry 3 gcs rsync -r "$SBUNDLES/$set" "$x" >>"$SUPLOG" 2>&1 || { say "WARN: cannot pull $SBUNDLES/$set/"; return 1; }
  for f in bundle.dat bundle.tar.gz; do [ -f "$x/$f" ] && b=$f && break; done
  [ -n "$b" ] && [ -f "$x/job.json" ] && [ -f "$x/kernel.py" ] || { say "WARN: bundle $set lacks bundle.dat/job.json/kernel.py"; return 1; }
  ln -s "$x/$b" "$sd/$b"
  "$VENV/bin/python" - "$x/job.json" "$sd" "$SCKPT" <<'PY' || { say "WARN: could not prepare the scoring input for $set"; return 1; }
import json, os, sys
src, sd, ck = sys.argv[1:4]
j = json.load(open(src))
files = sorted(f for f in os.listdir(ck) if os.path.isfile(os.path.join(ck, f)))
for f in files:
    os.symlink(os.path.realpath(os.path.join(ck, f)), os.path.join(sd, "ckpt." + f))
j.update(train=None, val=None, fast_kernels=False, ckpt_prefix="ckpt.", ckpt_files=files)
json.dump(j, open(os.path.join(sd, "job.json"), "w"), indent=1)
PY
  say "scoring set $set of checkpoint $SNAME with kernel.py"
  t0=$(date +%s)
  (cd "$sd" && env KERNEL_WORK="$w" KERNEL_INPUT="$sd" HF_HOME="$HF_HOME" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false \
    "$VENV/bin/python" "$x/kernel.py") >"$LOGDIR/score-$set-$STAMP.log" 2>&1
  rc=$?
  secs=$(($(date +%s) - t0))
  say "kernel.py ($set) exit $rc after ${secs}s"
  rm -rf "$w/ckpt-in" "$w/code" "$w/vaults"   # symlinks to the weights would be followed by the upload
  cp "$LOGDIR/score-$set-$STAMP.log" "$w/kernel.log" 2>/dev/null
  score_sync_logs
  retry 3 gcs rsync -r "$w" "$SGS/$set" >>"$SUPLOG" 2>&1 || { say "WARN: results upload for $set failed; they stay in $w"; return 1; }
  f=$(find "$w" -name report.json 2>/dev/null | head -1)
  if [ "$rc" = 0 ] && [ -n "$f" ]; then
    cp "$f" "$STATE/sc-$SNAME-$set.report.json"
    printf '{"seconds": %s, "rc": %s}\n' "$secs" "$rc" >"$STATE/sc-$SNAME-$set.done"
  else
    say "WARN: set $set not marked done (rc=$rc)"
    return 1
  fi
  rm -rf "$w" "$sd" "$x"
}

write_score_summary() {  # combined summary.json from the per-set markers and reports
  "$VENV/bin/python" - "$SNAME" "$SCKPT_SRC" "$STATE" "$@" <<'PY'
import json, os, sys, time
name, ck, st, sets = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
out = {"name": name, "checkpoint": ck, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sets": {}}
for s in sets:
    e = {"done": False}
    try:
        d = json.load(open(os.path.join(st, "sc-%s-%s.done" % (name, s))))
        r = json.load(open(os.path.join(st, "sc-%s-%s.report.json" % (name, s))))
        e = {"done": True, "sessions": r.get("sessions"), "session_pass": r.get("session_pass"),
             "session_pass_rate": round(r["session_pass"] / r["sessions"], 4) if r.get("sessions") else None,
             "turns": r.get("turns"), "turn_pass": r.get("turn_pass"),
             "turn_pass_rate": round(r["turn_pass"] / r["turns"], 4) if r.get("turns") else None, "seconds": d.get("seconds")}
    except Exception:
        pass
    out["sets"][s] = e
def rd(f):
    try:
        return open(os.path.join(st, f)).read().strip()
    except Exception:
        return None
out["mode"] = rd("sc-%s.mode" % name) or "separate"
ls = rd("sc-%s.launch.secs" % name) if out["mode"] == "combined" else None
out["launch_seconds"] = int(ls) if ls else None  # the single kernel run of a combined score (summed over the boots of a resumed run)
# total = the kernel launch(es) + per-set work; in combined mode a set's own `seconds` is only its split + score step
out["total_seconds"] = (out["launch_seconds"] or 0) + sum(e.get("seconds") or 0 for e in out["sets"].values())
print(json.dumps(out, indent=1))
PY
}

# ---- combined scoring: ONE kernel.py launch over the union of the requested sets (default for >1 set) -----------------------
# One model load and one worker pool instead of one per set. `score_combine` (below) does the pure data work: build the union input
# from the per-set bundles, release a killed run's unfinished claims, collect the run records, split them back per set.
# Metadata `score_separate=1` (or env SCORE_SEPARATE=1) restores one launch per set; a combined BUILD failure (before the kernel
# starts) falls back to it automatically.
score_combine() {
  "$VENV/bin/python" - "$@" <<'PY'
import glob, hashlib, json, os, re, shutil, subprocess, sys, tarfile

OK_DIFF = {"train/train.py"}  # the trainer is not part of the eval: bundles may carry different versions of it


def fail(msg):
    print("score_combine: " + msg, file=sys.stderr)
    sys.exit(1)


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def lines(path):
    """The non-empty raw lines of a jsonl file, newline-terminated."""
    out = []
    for raw in open(path, "rb").read().split(b"\n"):
        if raw.strip():
            out.append(raw + b"\n")
    return out


def rid(raw):
    try:
        return json.loads(raw)["id"]
    except Exception:
        return None


def records(paths):
    """{id: raw line} from run files; torn or id-less lines are skipped (a killed run leaves at most one)."""
    got = {}
    for p in paths:
        if os.path.exists(p):
            for raw in lines(p):
                i = rid(raw)
                if i is not None:
                    got[i] = raw
    return got


def run_files(free):
    return sorted(glob.glob(os.path.join(free, "run-*.jsonl")))


def seed_union(cmds_per_set):
    """One eval_setup: every seed_worlds.py command merged into one (worlds unioned once, first-seen order), other commands deduped."""
    worlds, seed_cmd, rest = [], None, []
    for cmds in cmds_per_set:
        for c in cmds or []:
            idx = [k for k, a in enumerate(c) if a.endswith("seed_worlds.py")]
            if not idx:
                if c not in rest:
                    rest.append(c)
                continue
            head, args = c[:idx[0] + 1], c[idx[0] + 1:]
            if any(a.startswith("-") for a in args):
                fail("eval_setup seed_worlds.py takes flags (%s): cannot union" % args)
            if seed_cmd is not None and head != seed_cmd:
                fail("eval_setup seed commands differ in their prefix")
            seed_cmd = head
            for w in args:
                if w not in worlds:
                    worlds.append(w)
    return ([seed_cmd + worlds] if seed_cmd else []) + rest


def build(cdir, sd, ckpt, bases, sets):
    jobs, kernels = {}, {}
    shutil.rmtree(cdir, ignore_errors=True)
    shutil.rmtree(sd, ignore_errors=True)
    os.makedirs(cdir)
    os.makedirs(sd)
    seen = {}
    for s in sets:
        x = os.path.join(bases, s)
        jobs[s] = json.load(open(os.path.join(x, "job.json")))
        kernels[s] = md5(os.path.join(x, "kernel.py"))
        b = [os.path.join(x, n) for n in ("bundle.dat", "bundle.tar.gz") if os.path.isfile(os.path.join(x, n))]
        if not b:
            fail("bundle %s has no bundle.dat" % s)
        tmp = os.path.join(sd, "x-" + s)
        with tarfile.open(b[0], "r:gz") as tf:
            tf.extractall(tmp)
        for root, _, fs in os.walk(tmp):
            for f in fs:
                p = os.path.join(root, f)
                rel = os.path.relpath(p, tmp)
                dst = os.path.join(cdir, rel)
                if os.path.lexists(dst):
                    if rel in OK_DIFF or md5(dst) == md5(p):
                        continue
                    fail("file %s differs between bundles (%s vs earlier)" % (rel, s))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(p, dst)
        shutil.rmtree(tmp)
    # one eval configuration
    first = sets[0]
    base = {k: v for k, v in jobs[first].items() if k not in ("eval_set", "eval_setup")}
    for s in sets[1:]:
        other = {k: v for k, v in jobs[s].items() if k not in ("eval_set", "eval_setup")}
        if other != base:
            diff = sorted(k for k in set(base) | set(other) if base.get(k) != other.get(k))
            fail("eval settings differ between %s and %s: %s" % (first, s, ", ".join(diff)))
        if kernels[s] != kernels[first]:
            fail("kernel.py differs between %s and %s" % (first, s))
    if base.get("eval_batched"):
        fail("eval_batched is set: the combined resume relies on the chunked path")
    if base.get("arms") != ["free"]:
        fail("arms %r (only ['free'] is combined)" % (base.get("arms"),))
    # the combined set: per-set files concatenated in manifest order, ids unique across (and within) sets
    order, owner, parts = [], {}, {}
    for s in sets:
        p = os.path.join(cdir, jobs[s]["eval_set"])
        if not os.path.isfile(p):
            fail("set file %s missing from bundle %s" % (jobs[s]["eval_set"], s))
        parts[s] = lines(p)
        for raw in parts[s]:
            i = rid(raw)
            if i is None:
                fail("set %s has a line without an id" % s)
            if i in owner:
                fail("session id %r appears in sets %s and %s" % (i, owner[i], s))
            owner[i] = s
            order.append(i)
    comb = "eval/sets/_combined.jsonl"
    with open(os.path.join(cdir, comb), "wb") as fh:
        for s in sets:
            fh.writelines(parts[s])
    job = dict(jobs[first])
    job.update(eval_set=comb, eval_setup=seed_union([jobs[s].get("eval_setup") for s in sets]),
               train=None, val=None, fast_kernels=False)
    files = sorted(f for f in os.listdir(ckpt) if os.path.isfile(os.path.join(ckpt, f)))
    for f in files:
        os.symlink(os.path.realpath(os.path.join(ckpt, f)), os.path.join(sd, "ckpt." + f))
    job.update(ckpt_prefix="ckpt.", ckpt_files=files)
    json.dump(job, open(os.path.join(sd, "job.json"), "w"), indent=1)
    with tarfile.open(os.path.join(sd, "bundle.dat"), "w:gz") as tf:
        for n in sorted(os.listdir(cdir)):
            tf.add(os.path.join(cdir, n), arcname=n)
    json.dump({"sets": sets, "sets_files": {s: jobs[s]["eval_set"] for s in sets}, "owner": owner, "order": order,
               "arm": base["arms"][0], "kernel": os.path.join(bases, first, "kernel.py")},
              open(os.path.join(sd, "combined.json"), "w"))
    print("combined %d sessions from %s; seed: %s" % (len(order), ",".join(sets), json.dumps(job["eval_setup"])))


def resume(work, meta):
    """Before (re)starting the kernel in a work dir that already ran: move finished records out of the run files (the driver truncates
    its --out on start), drop claims of sessions that were cut off, print 'complete' when every session is finished."""
    m = json.load(open(meta))
    free = os.path.join(work, "eval", m["arm"])
    keep = os.path.join(work, "eval-keep", "kept.jsonl")
    got = records([keep] + run_files(free))
    os.makedirs(os.path.dirname(keep), exist_ok=True)
    with open(keep + ".tmp", "wb") as fh:
        for i in m["order"]:
            if i in got:
                fh.write(got[i])
    os.replace(keep + ".tmp", keep)
    for f in run_files(free) + glob.glob(os.path.join(free, "run-*.jsonl.stats.json")) + glob.glob(os.path.join(free, "run.jsonl")):
        os.remove(f)
    dropped = 0
    for c in glob.glob(os.path.join(free, "claims", "*")):
        if os.path.basename(c) not in got:
            os.remove(c)
            dropped += 1
    left = sum(1 for i in m["order"] if i not in got)
    print("complete" if left == 0 else "partial")
    print("resume: %d of %d sessions finished, %d claims released" % (len(got), len(m["order"]), dropped), file=sys.stderr)


def collect(work, meta):
    m = json.load(open(meta))
    got = records([os.path.join(work, "eval-keep", "kept.jsonl")] + run_files(os.path.join(work, "eval", m["arm"])))
    missing = [i for i in m["order"] if i not in got]
    with open(os.path.join(work, "collected.jsonl"), "wb") as fh:
        for i in m["order"]:
            if i in got:
                fh.write(got[i])
    print("collected %d of %d sessions, %d missing" % (len(got), len(m["order"]), len(missing)), file=sys.stderr)
    sys.exit(1 if missing else 0)


def split(records_file, meta, cdir, outdir_fmt, arm):
    """Per-set run.jsonl (raw lines, in the set file's order) at outdir_fmt % set / eval/<arm>/run.jsonl."""
    m = json.load(open(meta))
    got = records([records_file])
    for s in m["sets"]:
        ids = [rid(r) for r in lines(os.path.join(cdir, m["sets_files"][s]))]
        d = os.path.join(outdir_fmt % s, "eval", arm)
        shutil.rmtree(outdir_fmt % s, ignore_errors=True)
        os.makedirs(d)
        with open(os.path.join(d, "run.jsonl"), "wb") as fh:
            for i in ids:
                if i in got:
                    fh.write(got[i])
        print("%s: %d of %d sessions" % (s, sum(1 for i in ids if i in got), len(ids)))


cmd, a = sys.argv[1], sys.argv[2:]
if cmd == "build":
    build(a[0], a[1], a[2], a[3], a[4:])
elif cmd == "resume":
    resume(*a)
elif cmd == "collect":
    collect(*a)
elif cmd == "split":
    split(*a)
elif cmd == "json":  # json FILE KEY: print one key
    print(json.load(open(a[0]))[a[1]])
elif cmd == "gold":  # gold FILE SET: the set's own gold file, relative to the code dir
    print(json.load(open(a[0]))["sets_files"][a[1]])
PY
}

# score_combined SET...: 0 = every set scored, 1 = failed (rerun on the next boot), 2 = combined build failed before the kernel
# started (caller falls back to one launch per set)
score_combined() {
  local sets=$* s x cw cdir sd rc t0 secs free arm kern st prev res p
  cw=$BASE/score-w-combined; cdir=$BASE/score-code-combined; sd=$BASE/score-in-combined
  st=$STATE/sc-$SNAME.combined.started
  p=0
  for s in $sets; do [ -f "$STATE/sc-$SNAME-$s.done" ] || p=1; done
  [ "$p" = 0 ] && { echo combined >"$STATE/sc-$SNAME.mode"; say "all sets already scored"; return 0; }
  # (1) build the union input; a failure before the kernel has run is a fallback, after it a plain failure
  for s in $sets; do
    x=$BASE/bundles/$s
    rm -rf "$x"; mkdir -p "$x"
    retry 3 gcs rsync -r "$SBUNDLES/$s" "$x" >>"$SUPLOG" 2>&1 || { say "WARN: cannot pull $SBUNDLES/$s/"; [ -f "$st" ] && return 1; return 2; }
  done
  res=$(score_combine build "$cdir" "$sd" "$SCKPT" "$BASE/bundles" $sets 2>>"$SUPLOG") || { say "WARN: combined build failed: $(tail -1 "$SUPLOG")"; [ -f "$st" ] && return 1; return 2; }
  say "$res"
  arm=$(score_combine json "$sd/combined.json" arm)
  kern=$(score_combine json "$sd/combined.json" kernel)
  free=$cw/eval/$arm
  # (2) the one kernel launch: fresh, or a resume of a killed one (finished records kept aside, unfinished claims released)
  if [ -f "$st" ] && [ "$(cat "$st")" = "$sets" ] && [ -d "$cw" ]; then
    say "resuming the combined run in $cw"
    res=$(score_combine resume "$cw" "$sd/combined.json" 2>>"$SUPLOG") || res=partial
  else
    rm -rf "$cw" "$STATE/sc-$SNAME.launch.done" "$STATE/sc-$SNAME.launch.secs"
    mkdir -p "$cw"
    echo "$sets" >"$st"
    res=partial
  fi
  echo combined >"$STATE/sc-$SNAME.mode"
  if [ "$res" = complete ]; then
    say "every session of the combined run is finished: no kernel launch"
  else
    rm -f "$STATE/sc-$SNAME.launch.done"
    say "scoring sets [$sets] of checkpoint $SNAME with ONE kernel.py launch"
    t0=$(date +%s)
    (cd "$sd" && env KERNEL_WORK="$cw" KERNEL_INPUT="$sd" HF_HOME="$HF_HOME" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false \
      "$VENV/bin/python" "$kern") >"$LOGDIR/score-combined-$STAMP.log" 2>&1
    rc=$?
    secs=$(($(date +%s) - t0))
    say "kernel.py (combined) exit $rc after ${secs}s"
    prev=$(cat "$STATE/sc-$SNAME.launch.secs" 2>/dev/null || echo 0)
    echo $((prev + secs)) >"$STATE/sc-$SNAME.launch.secs"   # summed over the boots of a resumed run
    cat "$LOGDIR/score-combined-$STAMP.log" >>"$cw/kernel.log" 2>/dev/null
  fi
  rm -rf "$cw/ckpt-in" "$cw/code" "$cw/vaults" "$cw"/tmp-*   # symlinks to the weights would be followed by the upload; all rebuilt by a rerun
  score_sync_logs
  # (3) the combined work dir goes up as-is (minus the claims, which only a resume needs)
  rm -rf "$BASE/score-up-combined"; cp -a "$cw" "$BASE/score-up-combined" && rm -rf "$BASE/score-up-combined/eval/$arm/claims"
  retry 3 gcs rsync -r "$BASE/score-up-combined" "$SGS/combined" >>"$SUPLOG" 2>&1 || say "WARN: upload of the combined run failed; it stays in $cw"
  rm -rf "$BASE/score-up-combined"
  if ! score_combine collect "$cw" "$sd/combined.json" 2>>"$SUPLOG"; then
    say "WARN: combined run incomplete: $(grep '^collected' "$SUPLOG" | tail -1); rerun by starting the VM again"
    return 1
  fi
  [ -f "$STATE/sc-$SNAME.launch.done" ] || printf '{"seconds": %s}\n' "$(cat "$STATE/sc-$SNAME.launch.secs" 2>/dev/null || echo 0)" >"$STATE/sc-$SNAME.launch.done"
  # (4) split the records per set and score each against its own gold (the set file itself), in the extracted bundle code
  score_combine split "$cw/collected.jsonl" "$sd/combined.json" "$cdir" "$BASE/score-w-%s" "$arm" >>"$SUPLOG" 2>&1 || return 1
  rc=0
  for s in $sets; do
    x=$BASE/score-w-$s
    [ -f "$STATE/sc-$SNAME-$s.done" ] && { say "set $s already scored"; rm -rf "$x"; continue; }
    t0=$(date +%s)
    (cd "$cdir" && "$VENV/bin/python" eval/score.py "$x/eval/$arm/run.jsonl" \
      --gold "$(score_combine gold "$sd/combined.json" "$s")" \
      --out "$x/eval/$arm/report.md" --json "$x/eval/$arm/report.json") >"$LOGDIR/score-$s-$STAMP.log" 2>&1
    secs=$(($(date +%s) - t0))
    if [ ! -f "$x/eval/$arm/report.json" ]; then say "WARN: scoring $s failed (see $LOGDIR/score-$s-$STAMP.log)"; rc=1; continue; fi
    cp "$LOGDIR/score-$s-$STAMP.log" "$x/score.log"
    cp "$cw/kernel.log" "$x/kernel.log" 2>/dev/null
    retry 3 gcs rsync -r "$x" "$SGS/$s" >>"$SUPLOG" 2>&1 || { say "WARN: results upload for $s failed; they stay in $x"; rc=1; continue; }
    cp "$x/eval/$arm/report.json" "$STATE/sc-$SNAME-$s.report.json"
    printf '{"seconds": %s, "rc": 0, "combined": true}\n' "$secs" >"$STATE/sc-$SNAME-$s.done"
    rm -rf "$x"
  done
  score_sync_logs
  [ "$rc" = 0 ] || return 1
  rm -rf "$cw" "$cdir" "$sd" "$BASE/bundles"
  return 0
}

run_score() {
  local man sets s bad=0 info sep nsets
  man=$(attr manifest)
  [ -n "$man" ] || { say "FAILED: MODE=score without metadata 'manifest'"; finish_idle "no manifest"; }
  SGS=${man%/manifest.json}
  retry 5 gcs cp "$man" "$STATE/manifest.json" >>"$SUPLOG" 2>&1 || { SNAME=unknown; score_fail "cannot read $man"; }
  info=$(python3 - "$STATE/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(m["name"], m["checkpoint"].rstrip("/"), m["bundles"].rstrip("/"), " ".join(m["sets"]))
PY
  ) || { SNAME=unknown; score_fail "bad manifest $man"; }
  read -r SNAME SCKPT_SRC SBUNDLES sets <<<"$info"
  say "score mode: name=$SNAME checkpoint=$SCKPT_SRC sets=$sets"
  if [ -f "$STATE/sc-$SNAME.all.done" ] && gcs_has "$SGS/DONE"; then finish_idle "$SNAME already scored"; fi
  wait_gpu || score_fail "no NVIDIA driver/GPU on this VM"
  SCKPT=$BASE/score-ckpt/$SNAME
  if [ ! -f "$STATE/sc-$SNAME.ckpt.ok" ] || [ ! -f "$SCKPT/config.json" ]; then
    say "pulling checkpoint $SCKPT_SRC"
    rm -rf "$SCKPT"; mkdir -p "$SCKPT"
    retry 3 gcs rsync -r "$SCKPT_SRC" "$SCKPT" >>"$SUPLOG" 2>&1 && [ -f "$SCKPT/config.json" ] || score_fail "cannot pull a checkpoint (config.json) from $SCKPT_SRC"
    touch "$STATE/sc-$SNAME.ckpt.ok"
  fi
  # ensure_deps reads $JOBDIR/job.json (pins): a private dir, so a reused training VM's staged job is left alone
  JOBDIR=$BASE/score-job
  mkdir -p "$JOBDIR"
  s=${sets%% *}
  retry 3 gcs cp "$SBUNDLES/$s/job.json" "$JOBDIR/job.json" >>"$SUPLOG" 2>&1 || score_fail "cannot pull $SBUNDLES/$s/job.json"
  ensure_deps || score_fail "dependency install failed (see $LOGDIR/supervisor-$STAMP.log)"
  sep=${SCORE_SEPARATE:-$(attr score_separate)}
  nsets=$(wc -w <<<"$sets")
  echo separate >"$STATE/sc-$SNAME.mode"
  if [ "${sep:-0}" != 1 ] && [ "$nsets" -gt 1 ]; then
    score_combined $sets
    case $? in
      0) sep=done ;;
      1) sep=done; bad=1 ;;
      *) say "WARN: combined scoring could not start: falling back to one kernel launch per set"; sep=1 ;;
    esac
  else
    sep=1
  fi
  if [ "$sep" = 1 ]; then for s in $sets; do score_one "$s" || bad=1; done; fi
  write_score_summary $sets >"$STATE/sc-$SNAME.summary.json"
  gcs cp "$STATE/sc-$SNAME.summary.json" "$SGS/summary.json" >>"$SUPLOG" 2>&1
  score_sync_logs
  [ "$bad" = 0 ] || score_fail "set(s) failed: rerun by starting the VM again (finished sets are skipped); see $SGS/logs/"
  touch "$STATE/sc-$SNAME.all.done"
  gcs rm "$SGS/FAILED" >>"$SUPLOG" 2>&1   # left by an earlier partial run
  echo done | gcs cp - "$SGS/DONE" >>"$SUPLOG" 2>&1
  finish_idle "scoring of $SNAME finished"
}

# ---- main -------------------------------------------------------------------------------------------------------
say "boot: job=$JOB mode=$MODE bucket=$BUCKET host=$(hostname) $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"
df -h / >>"$SUPLOG" 2>&1

if [ "$MODE" = score ]; then
  trap 'exit 143' TERM INT
  run_score
  exit 0
fi

if [ "$MODE" = probe ]; then
  wait_gpu || fail_job "no GPU driver"
  pull_job || fail_job "cannot pull $GS/job/"
  job_trains || fail_job "job.json has no train file (an eval-only job: nothing to probe)"
  ensure_deps || fail_job "dependency install failed (see $LOGDIR/supervisor-$STAMP.log)"
  extract_code || fail_job "cannot unpack the bundle"
  run_probe
  exit 0
fi

if [ -f "$STATE/final.done" ] || gcs_has "$GS/DONE"; then
  # finished job: skip training and val; only extra eval bundles that are present and not scored yet run
  [ -n "$(extra_pending)" ] || finish_idle "job already finished (DONE), no extra eval sets to score"
  wait_gpu || fail_job "no NVIDIA driver/GPU on this VM"
  pull_job || fail_job "cannot pull $GS/job/"
  ensure_deps || fail_job "dependency install failed (see logs/supervisor-*.log)"
  run_extra_scoring
  sync_logs
  finish_idle "extra eval sets scored"
fi
gcs_has "$GS/FAILED" && gcs rm "$GS/FAILED" >>"$SUPLOG" 2>&1   # a restart is a retry

wait_gpu || fail_job "no NVIDIA driver/GPU on this VM"
pull_job || fail_job "cannot pull $GS/job/ (did launch.sh upload the staged job?)"
job_trains || fail_job "job.json has no train file (an eval-only job, e.g. kaggle.py build --ckpt-dir/--base): this tooling trains"
ensure_deps || fail_job "dependency install failed (see logs/supervisor-*.log)"
extract_code || fail_job "cannot unpack the job bundle"
pull_out || fail_job "cannot restore $GS/out/"
run_training
sync_up final
run_scoring
run_extra_scoring
finalize
