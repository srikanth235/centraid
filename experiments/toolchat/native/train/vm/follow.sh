#!/usr/bin/env bash
# follow.sh: stream a VM's live logs (supervisor, trainer, kernel) to this terminal until the job finishes.
#
#   JOB=final-v2 BUCKET=centraid-train-clawgnition ./follow.sh [VM_NAME] [--zone ZONE] [--score NAME]
#
#   VM_NAME   default $VM_NAME (ct-train-<job>); a scoring VM is ct-score-<name>
#   --score NAME   follow scoring run NAME: VM ct-score-NAME, stop at gs://$BUCKET/score/NAME/DONE|FAILED
#   (default)      stop at gs://$BUCKET/$JOB/DONE|FAILED
# Lines are "[train] ..." / "[score] ..." (the trainer and kernel logs, mirrored by run_job.sh's console_follow) and "[vm] ..."
# (supervisor). Ctrl-C is safe: the VM keeps going. Nothing is stored; the console is read through the compute API.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_common
VMN=$VM_NAME ZONE_ARG="" MARK="$GS"
while [ $# -gt 0 ]; do
  case $1 in
    --zone) ZONE_ARG=${2:?--zone needs a value}; shift ;;
    --score) n=${2:?--score needs a name}; VMN=ct-score-$(sanitize "$n"); MARK="gs://$BUCKET/score/$(sanitize "$n")"; shift ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "unknown argument $1" ;;
    *) VMN=$1 ;;
  esac
  shift
done
info=$(find_vm "$VMN"); [ -n "$info" ] || die "no VM named $VMN in $PROJECT"
read -r ZONE status _ <<<"$info"
[ -n "$ZONE_ARG" ] && ZONE=$ZONE_ARG
log "following $VMN ($status) in $ZONE; stops at $MARK/DONE or FAILED"
serial_pump "$VMN" "$ZONE" 0 "bucket_has $MARK/DONE || bucket_has $MARK/FAILED"
log "finished: $(gcloud storage cat "$MARK/DONE" 2>/dev/null || gcloud storage cat "$MARK/FAILED" 2>/dev/null)"
