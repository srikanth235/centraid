#!/usr/bin/env bash
# score_ckpt.sh: score ONE checkpoint on the two sets (val 655, test 656 sessions) with the optimized scoring settings.
#
#   JOB=final-v2 BUCKET=centraid-train-clawgnition ./score_ckpt.sh <checkpoint> [--mark MARK] [--name NAME] [--sets val,test]
#                                                                 [--bundles-prefix PREFIX] [--fast-kernels] [--dtype bfloat16|float16|float32]
#                                                                 [--new-vm | --vm NAME] [--watch] [--dry-run]
#
# Per set the run reports session pass (the outcome), clean turn pass (turns not downstream of a session's first failure: the number
# to steer by) and turn pass. Greedy decoding only. Test is scored at milestones only; every fix is derived on val.
#
#   <checkpoint>  gs://.../ckpt-050 (a checkpoint dir in a bucket) or a local dir (config.json + weights; uploaded first)
#   --mark MARK   <checkpoint> then stands for the training run: its out/ dir (gs://.../out or a local dir), or any checkpoint dir of it
#                 (.../out/ckpt-100), and MARK is the mark of that run to score: a name (ckpt-050) or `best`, the mark out/best.json
#                 names (train.py writes it at every mark: the lowest val decision loss, ties to the later mark; none for a run without
#                 --val). Without --mark the checkpoint is scored as given, and ckpt-100 stays the default; `best` is asked for, never assumed.
#   --name        result name (default: <training job>-<checkpoint dir>, e.g. final-v2-ckpt-050); the same name resumes a run
#   --sets        comma list, default val,test (bundles: gs://$BUCKET/bundles/<set>/, from $BUNDLES_DIR/<set>/ as built by bundles.sh;
#                 BUNDLES_DIR defaults to ${BUNDLE_STAGE:-${TMPDIR:-/tmp}/centraid-bundles}/bundles; a missing bundle stops the run)
#   --bundles-prefix  bucket folder the bundles are uploaded to and read from (default bundles, i.e. gs://$BUCKET/bundles/<set>/);
#                 use a different one (e.g. bundles-v2) so scoring with other bundles never overwrites the existing ones
#   --fast-kernels  try the fused linear-attention kernels (flash-linear-attention, causal-conv1d) for the scoring run: each is pip-installed
#                 and kept only if a probe loss (a fixed passage, forward pass) matches the PyTorch fallback's within 1e-3, else uninstalled;
#                 default off (SCORE_FAST_KERNELS=1 is the same). summary.json records "fast_kernels": {"requested", "kept": {pkg: bool}}.
#                 Needs bundles built with the current kernel.py (rebuild with bundles.sh), else the run stops with a message saying so.
#   --dtype D     the eval model's dtype (NATIVE_DTYPE of the eval arms): bfloat16, float16 or float32 (default: the bundle's, i.e. float32;
#                 SCORE_DTYPE is the same). Scores in a lower precision are not comparable bit for bit with float32 ones: summary.json
#                 records "dtype" so a score is never mistaken for a float32 one.
#   (default)     restart the training job's own stopped VM ($VM_NAME = ct-train-<job>) with mode=score
#   --vm NAME     restart that stopped VM instead
#   --new-vm      create ct-score-<name> ($SCORE_DISK_GB GB, Spot GPU shapes cycled by launch.sh's logic)
#   --watch       stream the VM's live logs (STREAM=0: quiet poll) until gs://$BUCKET/score/<NAME>/DONE (or FAILED), print the summary; for a restarted VM also drops its
#                 mode/manifest metadata so the next plain start of that VM is not a scoring run
#   --dry-run     print what would happen; no gcloud call, nothing created
# Several sets are scored by ONE combined kernel.py launch (one model load, one worker pool); SCORE_SEPARATE=1 restores one launch per set.
# Layout: gs://$BUCKET/score/<NAME>/{manifest.json, [ckpt/], <set>/ (report.json, run.jsonl, kernel.log ...), logs/, summary.json, DONE|FAILED}
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SCORE_DISK_GB=${SCORE_DISK_GB:-100}
JOB=${JOB:-score}
BPREFIX=${BUNDLES_PREFIX:-bundles}
CKPT="" MARK="" NAME="" SETS=val,test MODE_VM=job VMARG="" WATCH=0 DRY=0
FAST=${SCORE_FAST_KERNELS:-0} DTYPE=${SCORE_DTYPE:-}
while [ $# -gt 0 ]; do
  case $1 in
    --mark) MARK=${2:?--mark needs a value (best, or a mark name such as ckpt-050)}; shift ;;
    --name) NAME=${2:?--name needs a value}; shift ;;
    --sets) SETS=${2:?--sets needs a value}; shift ;;
    --bundles-prefix) BPREFIX=${2:?--bundles-prefix needs a value}; shift ;;
    --fast-kernels) FAST=1 ;;
    --dtype) DTYPE=${2:?--dtype needs a value (bfloat16, float16 or float32)}; shift ;;
    --new-vm) MODE_VM=new ;;
    --vm) MODE_VM=named; VMARG=${2:?--vm needs a name}; shift ;;
    --watch) WATCH=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) sed -n '2,/^[^#]/{/^#/p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "unknown argument $1" ;;
    *) [ -z "$CKPT" ] || die "one checkpoint only (got $CKPT and $1)"; CKPT=$1 ;;
  esac
  shift
done
[ -n "$CKPT" ] || die "usage: score_ckpt.sh <gs://.../ckpt-050 | local dir> [options] (see -h)"
case $FAST in 0 | 1) ;; *) die "SCORE_FAST_KERNELS must be 0 or 1 (got $FAST)" ;; esac
case $DTYPE in "" | float32 | bfloat16 | float16) ;; *) die "--dtype $DTYPE: bfloat16, float16 or float32" ;; esac
[ "$DRY" = 1 ] || command -v gcloud >/dev/null 2>&1 || die "gcloud not found"
[ "$DRY" = 1 ] || sa_login   # GCP_SA_KEY_JSON / _FILE: the throwaway service-account config, as launch.sh and watch.sh use

# --mark: <checkpoint> is the run's out/ dir; `best` reads the mark train.py's out/best.json names
if [ -n "$MARK" ]; then
  RUN=${CKPT%/}
  case ${RUN##*/} in ckpt-*) RUN=${RUN%/*} ;; esac   # a checkpoint dir of the run stands for the run
  case $MARK in */* | .*) die "--mark $MARK: a mark is a folder name in the run's out/ (ckpt-050), or best" ;; esac
  if [ "$MARK" = best ]; then
    BEST=""
    case $RUN in
      gs://*) if [ "$DRY" = 1 ]; then log "[dry-run] would read $RUN/best.json for the best mark"; MARK="<best>"
              else BEST=$(gcloud storage cat "$RUN/best.json" --project "$PROJECT" 2>/dev/null) || die "cannot read $RUN/best.json: is <checkpoint> the run's out/ dir? (train.py writes best.json at every mark, and only for a run with --val: name the mark instead, --mark ckpt-100)"; fi ;;
      *) [ -f "$RUN/best.json" ] || die "$RUN/best.json is missing: is <checkpoint> the run's out/ dir? (train.py writes best.json at every mark, and only for a run with --val: name the mark instead, --mark ckpt-100)"
         BEST=$(cat "$RUN/best.json") ;;
    esac
    if [ -n "$BEST" ]; then
      PICK=$(python3 -c 'import json, sys; d = json.load(sys.stdin); print(d["mark"], d["val"]["dloss"])' <<<"$BEST") || die "$RUN/best.json is not a best.json (no mark / val decision loss)"
      read -r MARK BEST_DLOSS <<<"$PICK"
      log "best mark of $RUN: $MARK (val decision loss $BEST_DLOSS; the lowest of its marks, ties to the later one)"
    fi
  fi
  CKPT=$RUN/$MARK
fi

CKPT_SRC=$CKPT
if [ -z "$NAME" ]; then
  b=$(basename "${CKPT%/}")
  case $CKPT in gs://*/out/*) p=$(basename "$(dirname "$(dirname "${CKPT%/}")")"); NAME="$p-$b" ;; *) NAME=$b ;; esac
  NAME=$(sanitize "$NAME")
fi
[ -n "$NAME" ] || die "empty --name"
SETS=${SETS//,/ }
SGS="gs://$BUCKET/score/$NAME"
BPREFIX=${BPREFIX#/}; BPREFIX=${BPREFIX%/}; [ -n "$BPREFIX" ] || die "empty --bundles-prefix"
BGS="gs://$BUCKET/$BPREFIX"
case $CKPT in gs://*) ;; *) [ -d "$CKPT" ] && { [ "$DRY" = 1 ] || [ -f "$CKPT/config.json" ]; } || die "$CKPT is neither a gs:// path nor a checkpoint dir with config.json"
  CKPT_SRC="$SGS/ckpt" ;; esac
for s in $SETS; do
  [ -f "$BUNDLES_DIR/$s/bundle.dat" ] && [ -f "$BUNDLES_DIR/$s/job.json" ] && [ -f "$BUNDLES_DIR/$s/kernel.py" ] ||
    die "bundle $s is missing in $BUNDLES_DIR/$s (needs bundle.dat, job.json, kernel.py): build the scoring bundles with BUNDLE_NATIVETOOLS=<nativetools> $VM_DIR/bundles.sh"
done

case $MODE_VM in
  job) VM=$VM_NAME ;; named) VM=$VMARG ;; new) VM=ct-score-$(sanitize "$NAME") ;;
esac
MANIFEST=$(printf '{"name": "%s", "checkpoint": "%s", "sets": [%s], "bundles": "%s", "created": "%s", "fast_kernels": %s, "dtype": "%s"}' "$NAME" "$CKPT_SRC" \
  "$(printf '"%s", ' $SETS | sed 's/, $//')" "$BGS" "$(ts)" "$([ "$FAST" = 1 ] && echo true || echo false)" "${DTYPE:-default}")

run() { if [ "$DRY" = 1 ]; then log "[dry-run] $*"; else "$@"; fi; }

log "checkpoint $CKPT  ->  $CKPT_SRC;  name $NAME;  sets: $SETS;  vm: $VM ($MODE_VM)"
# (a) bundles, once: rsync by checksum skips what is identical
for s in $SETS; do run gcloud storage rsync -r --checksums-only "$BUNDLES_DIR/$s" "$BGS/$s" --project "$PROJECT" || die "bundle upload $s failed"; done
# a local checkpoint goes next to the results
[ "$CKPT_SRC" = "$CKPT" ] || run gcloud storage rsync -r "$CKPT" "$CKPT_SRC" --project "$PROJECT" || die "checkpoint upload failed"
# (b) manifest
if [ "$DRY" = 1 ]; then log "[dry-run] write $SGS/manifest.json: $MANIFEST"; else
  printf '%s\n' "$MANIFEST" | gcloud storage cp - "$SGS/manifest.json" --project "$PROJECT" || die "manifest upload failed"
  gcloud storage rm "$SGS/DONE" "$SGS/FAILED" --project "$PROJECT" >/dev/null 2>&1   # a rerun under the same name starts clean
fi
META="mode=score,manifest=$SGS/manifest.json"
KEYS=mode,manifest
# SCORE_SEPARATE=1: one kernel launch per set (the old behaviour) instead of one combined launch
[ "${SCORE_SEPARATE:-0}" = 1 ] && { META="$META,score_separate=1"; KEYS=mode,manifest,score_separate; }

# --fast-kernels / --dtype travel as instance metadata like score_separate: run_job.sh (MODE=score) reads score_fast_kernels / score_dtype
[ "$FAST" = 1 ] && { META="$META,score_fast_kernels=1"; KEYS="$KEYS,score_fast_kernels"; }
[ -n "$DTYPE" ] && { META="$META,score_dtype=$DTYPE"; KEYS="$KEYS,score_dtype"; }

# (c) the VM
ZONE=""
if [ "$MODE_VM" = new ]; then
  if [ "$DRY" = 1 ]; then
    log "[dry-run] would refuse if another GPU VM holds the quota; cycle shapes [$SHAPES] over zones (launch.sh's launch_cycle), ${SCORE_DISK_GB}GB disk, metadata $META, startup-script=$VM_DIR/run_job.sh"
  else
    refuse_if_gpu_vm_exists "$VM" || exit 1
    [ -z "$(find_vm "$VM")" ] || die "VM $VM exists already (--vm $VM restarts it)"
    DISK_GB=$SCORE_DISK_GB
    launch_cycle "$VM" "$SHAPES" "$META" || exit $?
    ZONE=$CREATED_ZONE
  fi
else
  if [ "$DRY" = 1 ]; then
    log "[dry-run] would find $VM; if stopped: gcloud compute instances add-metadata $VM --metadata $META --metadata-from-file startup-script=$VM_DIR/run_job.sh,shutdown-script=$VM_DIR/run_job.sh; then instances start $VM"
  else
    own=$(find_vm "$VM")
    [ -n "$own" ] || die "no VM named $VM: use --new-vm (or --vm NAME)"
    read -r ZONE status mt <<<"$own"
    case $status in
      TERMINATED | STOPPED | SUSPENDED) ;;
      *) die "$VM is $status (a running VM may be training): wait, or use --new-vm" ;;
    esac
    refuse_if_gpu_vm_exists "$VM" || exit 1
    gc compute instances add-metadata "$VM" --zone "$ZONE" --metadata "$META" \
      --metadata-from-file "startup-script=$VM_DIR/run_job.sh,shutdown-script=$VM_DIR/run_job.sh" || die "add-metadata failed"
    if ! out=$(gc compute instances start "$VM" --zone "$ZONE" 2>&1); then
      cls=$(classify_error "$out")
      log "start failed ($cls): $(tr '\n' ' ' <<<"$out" | cut -c1-300)"
      [ "$cls" = capacity ] || [ "$cls" = quota ] && log "no capacity in $ZONE for this VM's disk: retry later or use --new-vm"
      exit 1
    fi
    log "started $VM in $ZONE"
  fi
fi
log "results will land in $SGS/ (summary.json, DONE)"

# (d) watch
if [ "$WATCH" = 1 ]; then
  if [ "$DRY" = 1 ]; then log "[dry-run] would poll $SGS/DONE|FAILED every 60 s, print summary.json${ZONE:+}$([ "$MODE_VM" != new ] && echo ", then remove-metadata $KEYS from $VM")"; exit 0; fi
  log "watching $SGS/ (Ctrl-C is safe: the VM keeps scoring)"
  if [ "${STREAM:-1}" = 1 ] && [ -n "$ZONE" ]; then
    log "streaming $VM's live logs ([score] kernel, [vm] supervisor); STREAM=0 for the quiet 60 s poll"
    SERIAL_START=0
    serial_pump "$VM" "$ZONE" 0 "bucket_has $SGS/DONE || bucket_has $SGS/FAILED"
  fi
  while :; do
    if bucket_has "$SGS/DONE"; then res=DONE; break; fi
    if bucket_has "$SGS/FAILED"; then res=FAILED; break; fi
    sleep 60
  done
  if [ "$MODE_VM" != new ]; then gc compute instances remove-metadata "$VM" --zone "$ZONE" --keys=$KEYS >/dev/null 2>&1 || log "note: remove $KEYS from $VM by hand"; fi
  [ "$res" = FAILED ] && { log "FAILED: $(gcloud storage cat "$SGS/FAILED" 2>&1)"; }
  gcloud storage cat "$SGS/summary.json" 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
def cell(e, k, n, r):  # rate (passed/of)
    return "%s (%s/%s)" % (e.get(r), e.get(k), e.get(n)) if e.get(r) is not None else "-"
print("eval dtype %s; fast kernels %s" % (d.get("dtype"), d.get("fast_kernels")))
print("%-9s %-19s %-21s %-21s %8s" % ("set", "session pass", "clean turn pass", "turn pass", "seconds"))
for s, e in d["sets"].items():
    print("%-9s %-19s %-21s %-21s %8s" % (s, cell(e, "session_pass", "sessions", "session_pass_rate"),
          cell(e, "turn_pass_clean", "turns_clean", "turn_pass_clean_rate"), cell(e, "turn_pass", "turns", "turn_pass_rate"),
          e.get("seconds")) if e.get("done") else "%-9s not finished" % s)
'
  [ "$res" = DONE ] || exit 1
elif [ "$DRY" = 0 ] && [ "$MODE_VM" != new ]; then
  log "note: after DONE run: gcloud compute instances remove-metadata $VM --zone $ZONE --keys=$KEYS --project $PROJECT (or use --watch)"
fi
