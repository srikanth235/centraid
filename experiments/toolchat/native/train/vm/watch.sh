#!/usr/bin/env bash
# watch.sh: babysit the Spot training VM. Polls every POLL (60) s; when the VM is TERMINATED/STOPPED (preempted) it starts it again;
# it stops when gs://$BUCKET/$JOB/DONE exists (or FAILED), and prints a cost ESTIMATE at the end.
#
#   JOB=fit1 BUCKET=centraid-train ./watch.sh
#
# Restart policy. A preempted Spot VM keeps its boot disk, so `gcloud compute instances start` in the SAME zone is the cheap path
# (local checkpoint, nothing to download). If that zone has no capacity it is retried every poll for START_PATIENCE_S (600) s. A
# boot disk is zonal: it cannot be moved to another zone, so the VM cannot simply start elsewhere. After the patience window, if the
# bucket holds a resume checkpoint, watch.sh calls `launch.sh --recreate`, which deletes the stopped VM and its disk and cycles every
# zone and shape (same logic as launch.sh) for a NEW VM, whose run_job.sh restores out/ from the bucket (losing at most the work
# since the last 10-min sync, never more than SAVE_EVERY steps). With no resume checkpoint in the bucket yet it keeps retrying start.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_common

POLL=${POLL:-60}
START_PATIENCE_S=${START_PATIENCE_S:-600}
declare -A SECS=()        # machine type -> seconds seen RUNNING
DISK_S=0                  # seconds a boot disk existed (VM exists, running or stopped)
PREEMPTIONS=0
prev_status=""
prev_t=$(date +%s)
last_creation=""
fail_since=0
hard_fail=0
start_fatal=0
stop_counted=0
seed_pending=1   # count the current boot from lastStartTimestamp at the next RUNNING poll
poll=0

secs_between() { echo $(($(date +%s) - $(date -d "$1" +%s 2>/dev/null || date +%s))); }

report() {
  local mt h cost total=0 disk
  echo
  log "---- cost ESTIMATE (not a bill: assumed Spot prices, uptime as seen by this script) ----"
  for mt in "${!SECS[@]}"; do
    h=$(awk -v s="${SECS[$mt]}" 'BEGIN{printf "%.2f", s/3600}')
    cost=$(awk -v h="$h" -v p="$(shape_price "$mt")" 'BEGIN{printf "%.2f", h*p}')
    total=$(awk -v t="$total" -v c="$cost" 'BEGIN{printf "%.2f", t+c}')
    log "  $(shape_label "$mt") ($mt): ${h} h RUNNING x \$$(shape_price "$mt")/h (assumed) = \$$cost"
  done
  disk=$(awk -v s="$DISK_S" -v g="$DISK_GB" -v p="$PRICE_DISK_GB_MONTH" 'BEGIN{printf "%.2f", s/3600/730*g*p}')
  total=$(awk -v t="$total" -v c="$disk" 'BEGIN{printf "%.2f", t+c}')
  log "  boot disk ${DISK_GB} GB: $(awk -v s="$DISK_S" 'BEGIN{printf "%.1f", s/3600}') h x \$$PRICE_DISK_GB_MONTH/GB-month (assumed) = \$$disk"
  log "  preemptions seen: $PREEMPTIONS"
  log "  ESTIMATED TOTAL: \$$total   (excludes bucket storage/requests, image, earlier stints this script did not see)"
  log "  The real number is in Billing > Reports, filtered to project $PROJECT and label app=centraid-train."
  sa_cleanup
}
trap report EXIT
trap 'exit 130' INT TERM

log "watching $VM_NAME (job $JOB) every ${POLL}s; stops on $GS/DONE"
while :; do
  poll=$((poll + 1))
  if bucket_has "$GS/DONE"; then
    log "DONE marker found: $(gcloud storage cat "$GS/DONE" 2>/dev/null)"
    log "fetch results: gcloud storage cp -r $GS/results ./results   (see README)"
    exit 0
  fi
  if bucket_has "$GS/FAILED"; then
    log "FAILED marker: $(gcloud storage cat "$GS/FAILED" 2>/dev/null)"
    log "logs: gcloud storage cat $GS/logs/'supervisor-*.log' | tail -50"
    exit 1
  fi

  info=$(find_vm "$VM_NAME")
  now=$(date +%s)
  if [ -z "$info" ]; then
    hard_fail=$((hard_fail + 1))
    log "no VM named $VM_NAME in $PROJECT (and no DONE marker). Run ./launch.sh (or ./launch.sh --recreate) first. ($hard_fail/5)"
    [ "$hard_fail" -ge 5 ] && exit 1
    sleep "$POLL"
    continue
  fi
  hard_fail=0
  read -r zone status mt <<<"$info"

  # uptime accounting: the interval since the last poll counts as RUNNING if the previous poll saw RUNNING
  if [ "$seed_pending" = 1 ] && [ "$status" = RUNNING ]; then
    seed_pending=0
    seed=$(secs_between "$(gc compute instances describe "$VM_NAME" --zone "$zone" --format='value(lastStartTimestamp)' 2>/dev/null)")
    SECS[$mt]=$(( ${SECS[$mt]:-0} + seed ))
  elif [ "$prev_status" = RUNNING ]; then
    SECS[$mt]=$(( ${SECS[$mt]:-0} + now - prev_t ))
  fi
  creation=$(gc compute instances describe "$VM_NAME" --zone "$zone" --format='value(creationTimestamp)' 2>/dev/null)
  if [ "$creation" != "$last_creation" ]; then   # a VM generation we have not seen: its disk has existed since creation
    DISK_S=$((DISK_S + $(secs_between "$creation")))
    last_creation=$creation
  else
    DISK_S=$((DISK_S + now - prev_t))
  fi
  prev_t=$now
  prev_status=$status

  case $status in
    RUNNING)
      fail_since=0
      stop_counted=0
      extra=""
      if [ $((poll % 5)) = 1 ]; then
        extra=" | bucket: $(gcloud storage ls "$GS/out/" 2>/dev/null | grep -oE 'resume-step-[0-9]+' | sort | tail -1 || true)"
      fi
      log "$VM_NAME RUNNING in $zone ($(shape_label "$mt"))$extra" ;;
    PROVISIONING | STAGING | STOPPING | REPAIRING)
      stop_counted=0
      log "$VM_NAME $status in $zone" ;;
    TERMINATED | STOPPED | SUSPENDED)
      if [ "$stop_counted" = 0 ]; then PREEMPTIONS=$((PREEMPTIONS + 1)); stop_counted=1; fi
      log "$VM_NAME is $status in $zone (preempted, or powered itself off); no DONE/FAILED marker, so restarting it"
      if out=$(gc compute instances start "$VM_NAME" --zone "$zone" 2>&1); then
        log "start issued in $zone: same disk, resumes from the local checkpoint"
        fail_since=0
        start_fatal=0
        seed_pending=1
      else
        cls=$(classify_error "$out")
        [ "$fail_since" = 0 ] && fail_since=$now
        log "start failed ($cls) for $((now - fail_since))s: $(tr '\n' ' ' <<<"$out" | cut -c1-240)"
        if { [ "$cls" = capacity ] || [ "$cls" = quota ]; } && [ $((now - fail_since)) -ge "$START_PATIENCE_S" ]; then
          if gcloud storage ls "$GS/out/" 2>/dev/null | grep -q 'resume-step-'; then
            log "$zone stayed out of capacity for ${START_PATIENCE_S}s. The disk cannot leave $zone: deleting it and restoring from the bucket into a new VM in any zone (launch.sh --recreate)"
            if bash "$VM_DIR/launch.sh" --recreate; then
              fail_since=0
              seed_pending=1
            else
              log "launch.sh --recreate did not produce a VM (exit $?); will try again"
            fi
          else
            log "no resume checkpoint in $GS/out/ yet: a new VM would restart from step 0 and this disk may hold progress; keeping on retrying the start in $zone"
          fi
        elif [ "$cls" = fatal ]; then
          start_fatal=$((start_fatal + 1))
          [ "$start_fatal" -ge 5 ] && { log "giving up: $out"; exit 1; }
        fi
      fi ;;
    *) log "$VM_NAME status $status in $zone" ;;
  esac
  sleep "$POLL"
done
