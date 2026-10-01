#!/usr/bin/env bash
# launch.sh: start (or restart) the training job on ONE GCP Spot GPU VM, cycling zones and shapes until one has capacity.
#
#   JOB=fit1 BUCKET=centraid-train STAGE_DIR=$KGL_STAGE/fit1 ./launch.sh [--recreate] [--dry-run]
#
# Preference order (SHAPES): H100 80GB a3-highgpu-1g, A100 80GB a2-ultragpu-1g, A100 40GB a2-highgpu-1g. For each shape every zone
# of ZONES (discovered, else hardcoded) is tried with --provisioning-model=SPOT --instance-termination-action=STOP. On a
# stockout or quota refusal it moves to the next zone, then the next shape, sleeps 60-120 s after a full pass and starts over,
# until a VM exists or MAX_WAIT_S passes. The VM's startup script is run_job.sh; it does everything else.
#
#   (no flag)    create a VM; if this job's own VM exists and is stopped (preempted), `start` it instead; if it runs, say so.
#   --recreate   restore into a NEW VM, possibly in another zone: deletes this job's stopped VM and boot disk first (the disk is
#                zonal, so it cannot follow the job to another zone) and lets run_job.sh pull the newest resume checkpoint
#                from gs://$BUCKET/$JOB/out/. Refused while the bucket has no resume checkpoint (FORCE_RECREATE=1 overrides).
#   --dry-run    print what would happen (image, zones per shape, VM check) and create nothing.
# Exit: 0 VM up (or already up) / job already done, 1 refused or error, 2 max-wait reached.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

RECREATE=0
DRY=0
for a in "$@"; do
  case $a in
    --recreate) RECREATE=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $a" ;;
  esac
done
need_common

if [ "$DRY" = 0 ]; then
  ensure_bucket
  upload_job
fi

if bucket_has "$GS/DONE" && [ -z "${FORCE:-}" ]; then
  log "$GS/DONE exists: the job is finished. Fetch results (see README) or delete $GS/DONE to rerun. (FORCE=1 to launch anyway)"
  exit 0
fi

# ---- is there a GPU VM already? ---------------------------------------------------------------------------
refuse_if_gpu_vm_exists "$VM_NAME" || exit 1

own=$(find_vm "$VM_NAME")
if [ -n "$own" ]; then
  read -r own_zone own_status own_mt <<<"$own"
  log "this job's VM exists: $VM_NAME in $own_zone, $own_status, $own_mt"
  case $own_status in
    RUNNING | PROVISIONING | STAGING)
      log "already $own_status: nothing to launch. Watch it with ./watch.sh"
      exit 0 ;;
    STOPPING) die "$VM_NAME is STOPPING; wait a minute and run this again" ;;
  esac
  # TERMINATED / STOPPED / SUSPENDED: the Spot VM was preempted (or finished its poweroff)
  if [ "$RECREATE" = 0 ]; then
    log "starting it (same zone, same disk: resumes from the local checkpoint)"
    if [ "$DRY" = 1 ]; then log "--dry-run: would run: gcloud compute instances start $VM_NAME --zone $own_zone"; exit 0; fi
    if out=$(gc compute instances start "$VM_NAME" --zone "$own_zone" 2>&1); then
      log "started $VM_NAME in $own_zone"
      exit 0
    fi
    cls=$(classify_error "$out")
    log "start failed ($cls): $(tr '\n' ' ' <<<"$out" | cut -c1-300)"
    if [ "$cls" = capacity ] || [ "$cls" = quota ]; then
      log "$own_zone has no capacity now. The boot disk lives in $own_zone only, so the VM cannot start elsewhere with it."
      log "Either retry this command later (same-disk restart is cheapest), or restore from the bucket into a new VM in any zone: ./launch.sh --recreate"
      exit 1
    fi
    die "could not start $VM_NAME"
  fi
  if ! gcloud storage ls "$GS/out/" 2>/dev/null | grep -q 'resume-step-' && [ -z "${FORCE_RECREATE:-}" ]; then
    die "--recreate refused: no resume checkpoint in $GS/out/ yet (the disk may hold newer progress). FORCE_RECREATE=1 to delete it anyway"
  fi
  if [ "$DRY" = 1 ]; then log "--dry-run: would delete $VM_NAME (zone $own_zone) and its disk, then cycle zones"; else
    log "deleting $VM_NAME and its boot disk in $own_zone (state is in gs://$BUCKET/$JOB/)"
    gc compute instances delete "$VM_NAME" --zone "$own_zone" --delete-disks=all --quiet || die "delete failed"
  fi
elif [ "$RECREATE" = 1 ]; then
  log "no VM named $VM_NAME: creating one (same as without --recreate)"
fi

# ---- cycle ----------------------------------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  pick_image_family
  for mt in $SHAPES; do log "would try $(shape_label "$mt") ($mt) in: $(zones_for "$mt")"; done
  log "--dry-run: nothing created"
  exit 0
fi
launch_cycle "$VM_NAME" "$SHAPES" "" || exit $?
cat <<MSG

VM $VM_NAME is up ($(shape_label "$CREATED_SHAPE"), $CREATED_ZONE). It installs dependencies and starts training by itself (first boot ~10 min).
  watch:    JOB=$JOB BUCKET=$BUCKET ./watch.sh
  alive?    gcloud compute instances describe $VM_NAME --zone $CREATED_ZONE --project $PROJECT --format='value(status)'
  console:  gcloud compute instances get-serial-port-output $VM_NAME --zone $CREATED_ZONE --project $PROJECT | tail -50
  progress: gcloud storage cat $GS/logs/'train-*.log' | tail -20
MSG
