#!/usr/bin/env bash
# run_job.sh: the training VM's startup-script AND shutdown-script (launch.sh passes this one file for both). Idempotent: it
# runs on EVERY boot and does only what is not finished yet. All state is in gs://$BUCKET/$JOB/ and on the boot disk (/opt/centraid).
#
#   gs://$BUCKET/$JOB/job/      the staged job: bundle.dat (or bundle.tar.gz), job.json  (bundle.py's data/)
#   gs://$BUCKET/$JOB/out/      mirror of train.py --out: ckpt-025/050/075/100, FINAL, marks.json, best.json, train_meta.json, the newest resume-step-NNNNNN/,
#                               and train.py's own DONE (training finished)
#   gs://$BUCKET/$JOB/logs/     supervisor and trainer logs (one file per boot), pip-freeze.txt
#   gs://$BUCKET/$JOB/DONE      written LAST, when training is finished (JSON); watch.sh stops on it. FAILED: gave up.
#
# This VM trains and nothing else. Export (train/to_gguf.py) and scoring (crates/assist-eval) run elsewhere, on the checkpoint fetched from out/.
#
# Boot flow: GPU up -> pull job -> venv with the pinned deps -> unpack -> pull out/ (only on a fresh disk) -> train under nohup with
# `--save-every N --resume` (same command every boot; the trainer continues from the newest complete resume checkpoint) while syncing
# --out to the bucket every SYNC_INTERVAL s -> on DONE: upload -> write DONE -> power off. A stage whose marker exists is skipped.
#
# Shutdown/preemption: as the shutdown-script this file detects the shutdown (systemd 'stopping' or instance/preempted), SIGTERMs the
# trainer (which writes a resume checkpoint at its next step boundary if its --term-grace allows, then exits 0 with out/PREEMPTED)
# and does one quick best-effort sync (the ~30 s notice is far too short to upload a multi-GB resume checkpoint: the periodic sync is
# what protects the run if the disk is lost).
#
# Metadata (set by launch.sh): job, bucket, save_every, sync_interval, epochs, train_hours, max_restarts, [python], [fla_spec], [mode=probe].
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
export HF_HOME=$BASE/hf
mkdir -p "$STATE" "$LOGDIR" "$OUT" "$JOBDIR" "$HF_HOME"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUPLOG=$LOGDIR/supervisor-$STAMP.log
TRAINLOG=$LOGDIR/train-$STAMP.log

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$SUPLOG"; }
retry() { local n=$1 i; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep $((i * 5)); done; return 1; }

# Live stream: GCE keeps serial port 1 (the startup-script output already lands there) and `follow.sh` / `watch.sh` 
# read it every few seconds, so the trainer log reaches the operator while they are written, not at the next bucket sync.
# console_follow FILE TAG mirrors FILE line by line to the console as "[TAG] line" (progress bars' \r become newlines, lines cut at 300
# chars); idempotent per file, dies with this script. console_unfollow FILE lets the last lines out first, then stops the mirror.
# A slow console only delays the mirror (it is a pipe from tail), never the job. CONSOLE=/dev/null (or unwritable) turns it off.
CONSOLE=${CONSOLE:-/dev/ttyS0}
declare -A FOLLOW=()
console_follow() {
  [ -w "$CONSOLE" ] || return 0
  if [ -n "${FOLLOW[$1]:-}" ] && kill -0 "${FOLLOW[$1]}" 2>/dev/null; then return 0; fi
  setsid bash -c 'tail -n0 --pid="$1" -F "$2" 2>/dev/null | stdbuf -oL tr "\r" "\n" | stdbuf -oL cut -c1-300 | sed -u "s/^/[$3] /" >"$4"' \
    _ $$ "$1" "$2" "$CONSOLE" 9>&- &
  FOLLOW[$1]=$!
}
console_unfollow() {
  local p=${FOLLOW[$1]:-}
  [ -n "$p" ] || return 0
  sleep 3
  kill -- -"$p" 2>/dev/null
  unset 'FOLLOW[$1]'
}

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
  local info tr lora pins key py
  info=$(python3 - "$JOBDIR/job.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
print(j["transformers"], "1" if "--lora" in j.get("train_args", []) else "0")
PY
  ) || return 1
  read -r tr lora <<<"$info"
  # The Modal image's pins (modal_run.py): torch 2.8.0 (PyPI's default wheel is CUDA 12.8) + these, installed in one command;
  # transformers comes from the staged job.json; peft only for --lora.
  pins=(torch==2.8.0 numpy zstandard huggingface_hub sentencepiece protobuf packaging wheel setuptools "transformers==$tr" "$FLA_SPEC")
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

# A job whose job.json names `init` (a gs:// checkpoint directory, bundle.py --init-ckpt) starts from those weights instead of
# job["model"]: a continuation run (#1044, iteration 1: more low-lr epochs on top of p7-r3). Pulled once per disk.
INIT_DIR=$BASE/init
pull_init() {
  local init
  init=$("$VENV/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("init") or "")' "$JOBDIR/job.json") || return 1
  [ -z "$init" ] && return 0
  [ -f "$STATE/init.pulled" ] && return 0
  say "init: pulling the starting weights from $init"
  mkdir -p "$INIT_DIR"
  retry 3 gcs cp -r "$init/*" "$INIT_DIR/" >>"$SUPLOG" 2>&1 || return 1
  [ -f "$INIT_DIR/model.safetensors" ] || return 1
  touch "$STATE/init.pulled"
}

# the trainer command of the job, plus this script's resume flags. $1 = train | probe. One argument per line.
build_train_args() {
  "$VENV/bin/python" - "$JOBDIR/job.json" "$1" "$OUT" "$TRAIN_HOURS" "$SAVE_EVERY" "$EPOCHS" "${PROBE_STEPS:-24}" "$INIT_DIR" <<'PY'
import json, sys
job = json.load(open(sys.argv[1]))
mode, out, hours, save_every, epochs, probe_steps, init_dir = sys.argv[2:9]
a = ["--model", init_dir if job.get("init") else job["model"], "--train", job["train"], "--out", out, "--hours", hours]
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
  console_follow "$log" train
  (
    cd "$CODE" || exit 1
    exec nohup env PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false HF_HOME="$HF_HOME" ${extra:+"$extra"} \
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

finalize() {
  "$VENV/bin/python" - "$JOB" "$OUT/DONE" >"$STATE/DONE.json" <<'PY'
import json, sys, time
job, done = sys.argv[1:3]
try:
    train = json.load(open(done))
except Exception:
    train = None
print(json.dumps({"job": job, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "train": train}))
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
      timeout "$(cfg probe_timeout_s 1800)" env PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false HF_HOME="$HF_HOME" ${extra:+"$extra"} \
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

# ---- main -------------------------------------------------------------------------------------------------------
say "boot: job=$JOB mode=$MODE bucket=$BUCKET host=$(hostname) $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"
df -h / >>"$SUPLOG" 2>&1

if [ "$MODE" = probe ]; then
  wait_gpu || fail_job "no GPU driver"
  pull_job || fail_job "cannot pull $GS/job/"
  job_trains || fail_job "job.json has no train file: nothing to probe"
  ensure_deps || fail_job "dependency install failed (see $LOGDIR/supervisor-$STAMP.log)"
  extract_code || fail_job "cannot unpack the bundle"
  run_probe
  exit 0
fi

if [ -f "$STATE/final.done" ] || gcs_has "$GS/DONE"; then
  finish_idle "job already finished (DONE)"
fi
gcs_has "$GS/FAILED" && gcs rm "$GS/FAILED" >>"$SUPLOG" 2>&1   # a restart is a retry

wait_gpu || fail_job "no NVIDIA driver/GPU on this VM"
pull_job || fail_job "cannot pull $GS/job/ (did launch.sh upload the staged job?)"
job_trains || fail_job "job.json has no train file: this tooling trains"
ensure_deps || fail_job "dependency install failed (see logs/supervisor-*.log)"
extract_code || fail_job "cannot unpack the job bundle"
pull_out || fail_job "cannot restore $GS/out/"
pull_init || fail_job "cannot pull the init checkpoint named in job.json"
run_training
sync_up final
finalize
