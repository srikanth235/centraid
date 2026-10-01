#!/usr/bin/env bash
# probe.sh: a 10-15 minute probe on a fresh Spot GPU VM (A100 40GB first) BEFORE committing to the ~10-20 h run. It runs the REAL
# trainer (train.py, your staged job.json: bs 16, max_len 8192, bf16 checkpoints, gradient checkpointing, full fine-tune) for
# PROBE_STEPS steps via --max-steps, then prints peak memory, tokens/s, projected hours and cost, and whether it fits.
#
#   JOB=fit1 BUCKET=centraid-train STAGE_DIR=$KGL_STAGE/fit1 ./probe.sh
#
# The probe VM is a normal GPU VM (same image, same run_job.sh in `mode=probe`), so it needs the one GPU slot: it refuses while another
# GPU VM exists. It is DELETED at the end (PROBE_KEEP=1 keeps it). On an OOM it walks the memory fallbacks the trainer supports:
#   1. baseline                      train.py's own memory probe already retries at 6144 and 4096 tokens and DROPS the longer sessions (logged);
#   2. + PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True  (same math, less fragmentation);
#   3. + --lora R (PROBE_LORA, 64)   NOT a full fine-tune: a different method, reported loudly; only a last resort.
# Tunables: PROBE_SHAPES ("a2-highgpu-1g a2-ultragpu-1g a3-highgpu-1g"), PROBE_STEPS (24), PROBE_TOTAL_STEPS (1400, the real run's steps:
# the projection is PROBE_TOTAL_STEPS x measured s/step), PROBE_MAX_MIN (45), PROBE_LORA (64), PROBE_KEEP.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_common

PROBE_SHAPES=${PROBE_SHAPES:-"a2-highgpu-1g a2-ultragpu-1g a3-highgpu-1g"}
PROBE_STEPS=${PROBE_STEPS:-24}
PROBE_TOTAL_STEPS=${PROBE_TOTAL_STEPS:-1400}
PROBE_MAX_MIN=${PROBE_MAX_MIN:-45}
PROBE_LORA=${PROBE_LORA:-64}
PROBE_KEEP=${PROBE_KEEP:-}
PROBE_VM=${PROBE_VM:-ct-probe-$(job_slug)}
CREATED_ZONE=""
WORK=$(mktemp -d)

cleanup() {
  rm -rf "$WORK"
  if [ -n "$CREATED_ZONE" ]; then
    if [ -n "$PROBE_KEEP" ]; then
      log "PROBE_KEEP set: $PROBE_VM still exists (and bills); delete: gcloud compute instances delete $PROBE_VM --zone $CREATED_ZONE --project $PROJECT --delete-disks=all"
    else
      log "deleting $PROBE_VM and its disk"
      gc compute instances delete "$PROBE_VM" --zone "$CREATED_ZONE" --delete-disks=all --quiet >/dev/null 2>&1 ||
        log "WARN: delete failed: gcloud compute instances delete $PROBE_VM --zone $CREATED_ZONE --project $PROJECT --delete-disks=all"
    fi
  fi
  sa_cleanup                       # last: the VM delete above needs the service-account login
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ensure_bucket
upload_job
refuse_if_gpu_vm_exists "$PROBE_VM" || exit 1
[ -z "$(find_vm "$PROBE_VM")" ] || die "$PROBE_VM already exists: delete it first (gcloud compute instances delete $PROBE_VM --zone ... --delete-disks=all)"
gcloud storage rm -r "$GS/probe" --project "$PROJECT" >/dev/null 2>&1 || true

launch_cycle "$PROBE_VM" "$PROBE_SHAPES" "mode=probe,probe_steps=$PROBE_STEPS,probe_lora=$PROBE_LORA" || exit $?
log "probe VM is booting (installs deps ~5 min, loads the model and data, then $PROBE_STEPS steps); waiting up to ${PROBE_MAX_MIN} min"

t0=$(date +%s)
while ! bucket_has "$GS/probe/DONE"; do
  if [ $(($(date +%s) - t0)) -ge $((PROBE_MAX_MIN * 60)) ]; then die "timed out after ${PROBE_MAX_MIN} min; serial console: gcloud compute instances get-serial-port-output $PROBE_VM --zone $CREATED_ZONE --project $PROJECT | tail -60"; fi
  st=$(gc compute instances describe "$PROBE_VM" --zone "$CREATED_ZONE" --format='value(status)' 2>/dev/null)
  if [ "$st" = TERMINATED ] && ! bucket_has "$GS/probe/DONE"; then die "the probe VM was preempted or stopped before finishing; run ./probe.sh again"; fi
  log "probe VM $st, $((($(date +%s) - t0) / 60)) min elapsed"
  sleep 30
done
gcloud storage rsync -r "$GS/probe" "$WORK" --project "$PROJECT" >/dev/null 2>&1 || die "could not download $GS/probe"

# ---- analysis -------------------------------------------------------------------------------------------------
echo
log "==== probe report: $(shape_label "$CREATED_SHAPE") ($CREATED_SHAPE) in $CREATED_ZONE; GPU: $(head -1 "$WORK/gpu.csv") ===="
echo "attempts (n, fallback, exit code, seconds):"
sed 's/^/  /' "$WORK/attempts.tsv"
last=$(tail -1 "$WORK/attempts.tsv")
IFS=$'\t' read -r n label rc _ <<<"$last"
L=$WORK/attempt-$n.log
gpu_mib=$(awk -F', ' '{gsub(/ MiB/,"",$2); print $2; exit}' "$WORK/gpu.csv")

echo "trainer's own memory probe:"
grep -E 'MEMORY' "$L" | sed 's/^/  /'

read -r sps tps peak nrec < <(awk '
  / step [0-9]+\/[0-9]+ loss / {
    for (i = 1; i <= NF; i++) {
      if ($i == "step") { split($(i + 1), a, "/"); st = a[1] }
      if ($i == "tok/s") tps = $(i + 1)
      if ($i == "elapsed") { e = $(i + 1); sub("s", "", e) }
      if ($i == "peak") { pk = $(i + 1); sub("GiB", "", pk) }
    }
    n++; S[n] = st; E[n] = e; T[n] = tps; if (pk + 0 > mx) mx = pk + 0
  }
  END {
    if (n < 3) { print "NA NA NA", n; exit }
    sps = (E[n] - E[1]) / (S[n] - S[1]); sum = 0
    for (i = 2; i <= n; i++) sum += T[i]
    printf "%.3f %.0f %.1f %d\n", sps, sum / (n - 1), mx, n
  }' "$L")

verdict="DOES NOT FIT (or the probe failed: read $L below)"
if [ "$rc" = 0 ]; then
  if grep -q 'MEMORY cap' "$L"; then
    verdict="FITS ONLY AFTER DROPPING LONG SESSIONS: $(grep -o 'MEMORY cap.*' "$L" | head -1)"
  else
    verdict="FITS at the real max_len (no sessions dropped)"
  fi
  case $label in
    baseline) ;;
    expandable_segments) verdict="$verdict; needed PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True (set it for the real run: edit run_job.sh start_trainer)" ;;
    lora-*) verdict="$verdict; ONLY WITH --lora $PROBE_LORA: NOT a full fine-tune" ;;
  esac
fi
echo
echo "verdict:            $verdict"
if [ "$sps" = NA ] || [ -z "$sps" ]; then
  echo "throughput:         not enough step lines in the log (need >= 3; raise PROBE_STEPS)"
else
  price=$(shape_price "$CREATED_SHAPE")
  awk -v sps="$sps" -v tps="$tps" -v peak="$peak" -v gib="$(awk -v m="$gpu_mib" 'BEGIN{printf "%.1f", m/1024}')" \
    -v total="$PROBE_TOTAL_STEPS" -v price="$price" -v disk="$DISK_GB" -v dprice="$PRICE_DISK_GB_MONTH" -v nrec="$nrec" -v steps="$PROBE_STEPS" 'BEGIN{
      h = total * sps / 3600
      printf "peak memory:        %.1f GiB of %.1f GiB (max_memory_allocated over %d log points)\n", peak, gib, nrec
      printf "speed:              %.0f tokens/s, %.1f s/step (steady state, %d-step sample; all tokens, as the trainer logs it)\n", tps, sps, steps
      printf "projected run:      %d steps x %.1f s = %.1f h  (+ evals and checkpoint saves, ~5-10%%: not measured here)\n", total, sps, h
      rec = int(267 / sps); if (rec < 267 / sps) rec++; if (rec < 10) rec = 10
      printf "recommended:        --save-every %d  (N >= 267 / %.1f s/step; export SAVE_EVERY=%d before ./launch.sh)\n", rec, sps, rec
      printf "cost ESTIMATE:      %.1f h x $%.2f/h (assumed Spot price) + disk $%.2f = $%.0f (+/- preemption rework)\n", h, price, h * disk * dprice / 730, h * price + h * disk * dprice / 730
    }'
fi
if [ "$rc" != 0 ]; then
  echo
  echo "---- last 40 lines of $L ----"
  tail -40 "$L"
fi
[ "$rc" = 0 ]
