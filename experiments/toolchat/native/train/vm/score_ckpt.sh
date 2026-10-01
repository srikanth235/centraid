#!/usr/bin/env bash
# score_ckpt.sh: score ONE checkpoint on the session-pass sets (trainfit, val, test) with the optimized scoring settings.
#
#   JOB=final-v2 BUCKET=centraid-train-clawgnition ./score_ckpt.sh <checkpoint> [--name NAME] [--sets trainfit,val,test]
#                                                                 [--bundles-prefix PREFIX] [--new-vm | --vm NAME] [--watch] [--dry-run]
#
#   <checkpoint>  gs://.../ckpt-050 (a checkpoint dir in a bucket) or a local dir (config.json + weights; uploaded first)
#   --name        result name (default: <training job>-<checkpoint dir>, e.g. final-v2-ckpt-050); the same name resumes a run
#   --sets        comma list, default trainfit,val,test (bundles: gs://$BUCKET/bundles/<set>/, from $BUNDLES_DIR/<set>/)
#   --bundles-prefix  bucket folder the bundles are uploaded to and read from (default bundles, i.e. gs://$BUCKET/bundles/<set>/);
#                 use a different one (e.g. bundles-v3) so scoring against another gold never overwrites the existing bundles
#   (default)     restart the training job's own stopped VM ($VM_NAME = ct-train-<job>) with mode=score
#   --vm NAME     restart that stopped VM instead
#   --new-vm      create ct-score-<name> ($SCORE_DISK_GB GB, Spot GPU shapes cycled by launch.sh's logic)
#   --watch       wait for gs://$BUCKET/score/<NAME>/DONE (or FAILED), print the summary; for a restarted VM also drops its
#                 mode/manifest metadata so the next plain start of that VM is not a scoring run
#   --dry-run     print what would happen; no gcloud call, nothing created
# Several sets are scored by ONE combined kernel.py launch (one model load, one worker pool); SCORE_SEPARATE=1 restores one launch per set.
# Layout: gs://$BUCKET/score/<NAME>/{manifest.json, [ckpt/], <set>/ (report.json, run.jsonl, kernel.log ...), logs/, summary.json, DONE|FAILED}
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

BUNDLES_DIR=${BUNDLES_DIR:-/home/user/stage-extra/bundles}
SCORE_DISK_GB=${SCORE_DISK_GB:-100}
JOB=${JOB:-score}
BPREFIX=${BUNDLES_PREFIX:-bundles}
CKPT="" NAME="" SETS=trainfit,val,test MODE_VM=job VMARG="" WATCH=0 DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --name) NAME=${2:?--name needs a value}; shift ;;
    --sets) SETS=${2:?--sets needs a value}; shift ;;
    --bundles-prefix) BPREFIX=${2:?--bundles-prefix needs a value}; shift ;;
    --new-vm) MODE_VM=new ;;
    --vm) MODE_VM=named; VMARG=${2:?--vm needs a name}; shift ;;
    --watch) WATCH=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "unknown argument $1" ;;
    *) [ -z "$CKPT" ] || die "one checkpoint only (got $CKPT and $1)"; CKPT=$1 ;;
  esac
  shift
done
[ -n "$CKPT" ] || die "usage: score_ckpt.sh <gs://.../ckpt-050 | local dir> [options] (see -h)"
[ "$DRY" = 1 ] || command -v gcloud >/dev/null 2>&1 || die "gcloud not found"

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
for s in $SETS; do [ -f "$BUNDLES_DIR/$s/bundle.dat" ] && [ -f "$BUNDLES_DIR/$s/job.json" ] && [ -f "$BUNDLES_DIR/$s/kernel.py" ] || die "bundle $s missing in $BUNDLES_DIR/$s (bundle.dat job.json kernel.py)"; done

case $MODE_VM in
  job) VM=$VM_NAME ;; named) VM=$VMARG ;; new) VM=ct-score-$(sanitize "$NAME") ;;
esac
MANIFEST=$(printf '{"name": "%s", "checkpoint": "%s", "sets": [%s], "bundles": "%s", "created": "%s"}' "$NAME" "$CKPT_SRC" \
  "$(printf '"%s", ' $SETS | sed 's/, $//')" "$BGS" "$(ts)")

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
  if [ "$DRY" = 1 ]; then log "[dry-run] would poll $SGS/DONE|FAILED every 60 s, print summary.json${ZONE:+}$([ "$MODE_VM" != new ] && echo ", then remove-metadata mode,manifest from $VM")"; exit 0; fi
  log "watching $SGS/ (Ctrl-C is safe: the VM keeps scoring)"
  while :; do
    if bucket_has "$SGS/DONE"; then res=DONE; break; fi
    if bucket_has "$SGS/FAILED"; then res=FAILED; break; fi
    sleep 60
  done
  if [ "$MODE_VM" != new ]; then gc compute instances remove-metadata "$VM" --zone "$ZONE" --keys=$KEYS >/dev/null 2>&1 || log "note: remove mode,manifest from $VM by hand"; fi
  [ "$res" = FAILED ] && { log "FAILED: $(gcloud storage cat "$SGS/FAILED" 2>&1)"; }
  gcloud storage cat "$SGS/summary.json" 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
print("%-9s %8s %14s %14s %8s" % ("set", "sessions", "session pass", "turn pass", "seconds"))
for s, e in d["sets"].items():
    print("%-9s %8s %14s %14s %8s" % (s, e.get("sessions"), e.get("session_pass_rate"), e.get("turn_pass_rate"), e.get("seconds")) if e.get("done") else "%-9s not finished" % s)
'
  [ "$res" = DONE ] || exit 1
elif [ "$DRY" = 0 ] && [ "$MODE_VM" != new ]; then
  log "note: after DONE run: gcloud compute instances remove-metadata $VM --zone $ZONE --keys=$KEYS --project $PROJECT (or use --watch)"
fi
