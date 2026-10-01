#!/usr/bin/env bash
# common.sh: settings and gcloud helpers shared by launch.sh, watch.sh and probe.sh (sourced, not run).
# Every setting below can be overridden from the environment. Nothing here stores a credential: gcloud
# uses whatever `gcloud auth login` (or application-default / a service account) the caller already has.

VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ---- what to run, where --------------------------------------------------------------------------------
PROJECT=${PROJECT:-centraid}
REGION=${REGION:-us-central1}
JOB=${JOB:-}                               # the staged job name (required): kaggle.py build <JOB> ...
BUCKET=${BUCKET:-${PROJECT}-train}         # gs://$BUCKET/$JOB/ holds job/, out/, logs/, results/, DONE
STAGE_DIR=${STAGE_DIR:-}                   # kaggle.py's $KGL_STAGE/<job>; uploaded to gs://$BUCKET/$JOB/job/ if not there yet
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-}       # optional: VM service account e-mail (default: the project's default compute SA)

# ---- shapes: preference order, machine types (the GPU is part of the machine type) ---------------------
#   a3-highgpu-1g  = 1x H100 80GB      a2-ultragpu-1g = 1x A100 80GB      a2-highgpu-1g = 1x A100 40GB
SHAPES=${SHAPES:-"a3-highgpu-1g a2-ultragpu-1g a2-highgpu-1g"}
# Zones to try per shape. ZONES (space separated) overrides discovery for every shape; ZONES_<machine type with
# '-' as '_'> (e.g. ZONES_a3_highgpu_1g="us-central1-a us-central1-c") overrides one shape. Otherwise the zones are
# discovered with `gcloud compute machine-types list`; if that fails or is empty, FALLBACK_ZONES_* below are used.
ZONES=${ZONES:-}
FALLBACK_ZONES_a3_highgpu_1g="us-central1-a us-central1-b us-central1-c"
FALLBACK_ZONES_a2_ultragpu_1g="us-central1-a us-central1-c"
FALLBACK_ZONES_a2_highgpu_1g="us-central1-a us-central1-b us-central1-c us-central1-f"

# ---- VM image and disk ---------------------------------------------------------------------------------
# Deep Learning VM (Google's ML images: NVIDIA driver preinstalled, gcloud preinstalled). Only the DRIVER matters:
# torch 2.8.0 wheels (pinned in run_job.sh, as in the Modal image) ship their own CUDA 12.8 runtime and need driver >= 525.
# First family that exists wins (checked with `gcloud compute images describe-from-family`). List what exists with
#   gcloud compute images list --project=deeplearning-platform-release --format='value(family)' | sort -u
IMAGE_PROJECT=${IMAGE_PROJECT:-deeplearning-platform-release}
IMAGE_FAMILIES=${IMAGE_FAMILIES:-"common-cu129-ubuntu-2204-nvidia-580 common-cu129-ubuntu-2404-nvidia-580"}
DISK_GB=${DISK_GB:-200}
DISK_TYPE=${DISK_TYPE:-pd-ssd}                       # retried once with DISK_TYPE_ALT if the API rejects it for the shape
DISK_TYPE_ALT=${DISK_TYPE_ALT:-hyperdisk-balanced}
# A3 VMs want a gVNIC network interface; set NIC_A3="" if the API rejects it (unverified, see README).
NIC_A3=${NIC_A3---network-interface=nic-type=GVNIC}

# ---- cycling ---------------------------------------------------------------------------------------------
MAX_WAIT_S=${MAX_WAIT_S:-43200}            # give up after this many seconds of cycling (0 = forever)
PASS_SLEEP_MIN=${PASS_SLEEP_MIN:-60}       # sleep PASS_SLEEP_MIN..PASS_SLEEP_MAX s between full passes over all shapes x zones
PASS_SLEEP_MAX=${PASS_SLEEP_MAX:-120}

# ---- what the VM runs (passed as instance metadata; run_job.sh reads them) ------------------------------
SAVE_EVERY=${SAVE_EVERY:-30}               # train.py --save-every (resume checkpoint every N steps); probe.sh recommends N >= 267/step_seconds
SYNC_INTERVAL=${SYNC_INTERVAL:-600}        # seconds between bucket syncs of --out
EPOCHS=${EPOCHS:-6}                        # train.py --epochs, unless the staged job.json train_args already has it
TRAIN_HOURS=${TRAIN_HOURS:-24}             # train.py --hours: a training-time budget across preemptions (overrides job.json "hours")
MAX_RESTARTS=${MAX_RESTARTS:-3}            # trainer crashes (not preemptions) tolerated before the job is marked FAILED

# ---- cost ESTIMATES (USD per hour, Spot, us-central1; edit to today's price list) -----------------------
PRICE_H100=${PRICE_H100:-2.75}             # a3-highgpu-1g   (~2.5-3)
PRICE_A100_80=${PRICE_A100_80:-1.80}       # a2-ultragpu-1g  (~1.6-2)
PRICE_A100_40=${PRICE_A100_40:-1.40}       # a2-highgpu-1g   (~1.2-1.6)
PRICE_DISK_GB_MONTH=${PRICE_DISK_GB_MONTH:-0.17}   # pd-ssd, billed while the VM exists, stopped or not

# ---- derived --------------------------------------------------------------------------------------------
sanitize() { printf '%s' "$1" | tr 'A-Z_.' 'a-z--' | tr -cd 'a-z0-9-'; }
job_slug() { sanitize "$JOB"; }
VM_NAME=${VM_NAME:-ct-train-$(job_slug)}
GS="gs://$BUCKET/$JOB"

ts() { date -u +%FT%TZ; }
log() { printf '%s %s\n' "$(ts)" "$*"; }
die() { printf '%s ERROR: %s\n' "$(ts)" "$*" >&2; exit 1; }

# gcloud with the project appended (works for every command group used here)
gc() { gcloud "$@" --project "$PROJECT"; }

# Service-account login from the environment, for unattended runs: GCP_SA_KEY_JSON (the key JSON itself) or
# GCP_SA_KEY_FILE (a path). The key is written to tmpfs, activated in a throwaway CLOUDSDK_CONFIG (gcloud keeps the
# private key in its credential store), and both are wiped by sa_cleanup, which every script calls on exit.
# Nothing is written to the repo or to your normal gcloud config. Without either variable this does nothing and
# gcloud uses the caller's own login.
SA_TMP=""
sa_cleanup() { [ -n "$SA_TMP" ] && rm -rf "$SA_TMP"; SA_TMP=""; }
sa_login() {
  [ -n "${GCP_SA_KEY_JSON:-}" ] || [ -n "${GCP_SA_KEY_FILE:-}" ] || return 0
  [ -z "$SA_TMP" ] || return 0
  local base=/dev/shm; [ -d "$base" ] && [ -w "$base" ] || base=${TMPDIR:-/tmp}
  SA_TMP=$(umask 077 && mktemp -d "$base/ct-sa.XXXXXX") || die "cannot create a temp dir for the service-account key"
  trap sa_cleanup EXIT
  local key="$SA_TMP/key.json"
  if [ -n "${GCP_SA_KEY_JSON:-}" ]; then (umask 077 && printf '%s' "$GCP_SA_KEY_JSON" >"$key")
  else (umask 077 && cp "$GCP_SA_KEY_FILE" "$key") || die "cannot read GCP_SA_KEY_FILE"; fi
  export CLOUDSDK_CONFIG="$SA_TMP/cfg"; mkdir -p -m 700 "$CLOUDSDK_CONFIG"
  unset CLOUDSDK_AUTH_ACCESS_TOKEN                      # a stale token in the environment would override the key
  gcloud auth activate-service-account --key-file="$key" --quiet >/dev/null 2>&1 \
    || { sa_cleanup; die "service-account login failed (is the key valid and not deleted?)"; }
  rm -f "$key"
  log "authenticated as $(gcloud config get-value account 2>/dev/null) (throwaway config, wiped on exit)"
}

need_common() {
  command -v gcloud >/dev/null 2>&1 || die "gcloud not found: install the Google Cloud CLI and run 'gcloud auth login'"
  sa_login
  [ -n "$JOB" ] || die "set JOB=<staged job name> (e.g. JOB=fit1)"
  [ -f "$VM_DIR/run_job.sh" ] || die "run_job.sh not found next to $0"
}

shape_var() { printf '%s' "${1//-/_}"; }
shape_label() {
  case $1 in
    a3-highgpu-1g) echo "H100 80GB" ;;
    a2-ultragpu-1g) echo "A100 80GB" ;;
    a2-highgpu-1g) echo "A100 40GB" ;;
    *) echo "$1" ;;
  esac
}
shape_price() {
  case $1 in
    a3-*) echo "$PRICE_H100" ;;
    a2-ultragpu-*) echo "$PRICE_A100_80" ;;
    a2-highgpu-*) echo "$PRICE_A100_40" ;;
    *) echo "0" ;;
  esac
}

# ---- bucket ----------------------------------------------------------------------------------------------
bucket_has() { gcloud storage ls "$1" >/dev/null 2>&1; }   # object or prefix

ensure_bucket() {
  if gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
    return 0
  fi
  log "creating bucket gs://$BUCKET in $REGION"
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access || die "could not create gs://$BUCKET (name taken? set BUCKET=...)"
}

# Upload the staged job (kaggle.py's <stage>/<job>/{data,kernel}) unless the bucket has it already (FORCE_UPLOAD=1 redoes it).
upload_job() {
  if [ -z "${FORCE_UPLOAD:-}" ] && bucket_has "$GS/job/job.json"; then
    log "job already in $GS/job/ (FORCE_UPLOAD=1 to replace)"
    return 0
  fi
  [ -n "$STAGE_DIR" ] || die "$GS/job/job.json is not in the bucket and STAGE_DIR is unset: python kaggle.py build $JOB ... then STAGE_DIR=<stage>/$JOB"
  [ -f "$STAGE_DIR/data/job.json" ] && [ -f "$STAGE_DIR/kernel/kernel.py" ] || die "$STAGE_DIR is not a staged job (need data/job.json and kernel/kernel.py)"
  local f files=()
  for f in "$STAGE_DIR"/data/*; do
    case ${f##*/} in dataset-metadata.json) ;; *) files+=("$f") ;; esac
  done
  log "uploading ${files[*]##*/} kernel.py to $GS/job/"
  gcloud storage cp "${files[@]}" "$STAGE_DIR/kernel/kernel.py" "$GS/job/" --project "$PROJECT" || die "upload failed"
}

# ---- instances -------------------------------------------------------------------------------------------
# find_vm NAME -> "zone status machine-type" (empty if there is no such VM)
find_vm() {
  gc compute instances list --filter="name=$1" --format='value(zone.basename(),status,machineType.basename())' 2>/dev/null | head -1 | tr '\t' ' '
}

# GPU VMs in the project other than $1: "name zone status machine-type", one per line. A VM is a GPU VM if its machine
# type is an a2/a3/a4/g2/g4 shape or it has guest accelerators attached.
other_gpu_vms() {
  local self=$1 name zone status mt acc
  gc compute instances list --format='csv[no-heading](name,zone.basename(),status,machineType.basename(),guestAccelerators[0].acceleratorCount)' 2>/dev/null |
    while IFS=, read -r name zone status mt acc; do
      [ "$name" = "$self" ] && continue
      if [[ $mt =~ ^(a2|a3|a4|g2|g4)- ]] || [ -n "${acc:-}" ]; then echo "$name $zone $status $mt"; fi
    done
}

# Refuse (return 1) if another GPU VM would hold the single-GPU quota. A TERMINATED/STOPPED one holds no GPU quota (only its
# disk bills), so it only warns.
refuse_if_gpu_vm_exists() {
  local self=$1 line bad=0
  while read -r line; do
    [ -n "$line" ] || continue
    case $line in
      *" TERMINATED "* | *" STOPPED "* | *" SUSPENDED "*)
        log "note: $line is stopped: it holds no GPU quota but its disk still bills (delete it if unwanted)" ;;
      *)
        log "REFUSING: GPU VM '$line' exists and holds the project's only GPU (GPUS_ALL_REGIONS=1)."
        bad=1 ;;
    esac
  done < <(other_gpu_vms "$self")
  if [ "$bad" = 1 ]; then
    log "stop or delete it first, e.g.: gcloud compute instances delete NAME --zone ZONE --project $PROJECT"
    return 1
  fi
}

zones_for() {
  local mt=$1 v z
  if [ -n "$ZONES" ]; then echo "$ZONES"; return; fi
  v="ZONES_$(shape_var "$mt")"
  if [ -n "${!v:-}" ]; then echo "${!v}"; return; fi
  z=$(gc compute machine-types list --filter="name=$mt AND zone~$REGION" --format='value(zone.basename())' 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -z "${z// /}" ]; then
    # some projects only see the accelerator, not the machine type, in the list: cross-check by accelerator type
    local acc
    case $mt in a3-*) acc=nvidia-h100-80gb ;; a2-ultragpu-*) acc=nvidia-a100-80gb ;; *) acc=nvidia-tesla-a100 ;; esac
    z=$(gc compute accelerator-types list --filter="name=$acc AND zone~$REGION" --format='value(zone.basename())' 2>/dev/null | sort -u | tr '\n' ' ')
  fi
  if [ -z "${z// /}" ]; then
    v="FALLBACK_ZONES_$(shape_var "$mt")"
    z=${!v:-}
    log "zone discovery for $mt returned nothing (not logged in? API off?): using the hardcoded list: $z" >&2
  fi
  echo "$z"
}

pick_image_family() {
  local f
  for f in $IMAGE_FAMILIES; do
    if gcloud compute images describe-from-family "$f" --project "$IMAGE_PROJECT" --format='value(name)' >/dev/null 2>&1; then
      IMAGE_FAMILY=$f
      log "image: family $f (project $IMAGE_PROJECT): $(gcloud compute images describe-from-family "$f" --project "$IMAGE_PROJECT" --format='value(name)' 2>/dev/null)"
      return 0
    fi
  done
  die "none of the image families exist in $IMAGE_PROJECT: $IMAGE_FAMILIES. List them: gcloud compute images list --project=$IMAGE_PROJECT --format='value(family)' | sort -u   then IMAGE_FAMILIES=..."
}

# classify_error TEXT -> capacity | quota | nozone | fatal | unknown
classify_error() {
  local t=$1
  if grep -qiE 'ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources|resource pool|stockout|currently unavailable|RESOURCE_AVAILABILITY|try a different zone|is not currently available' <<<"$t"; then echo capacity
  elif grep -qiE "QUOTA_EXCEEDED|quota .*exceeded|exceeded limit|GPUS_ALL_REGIONS|PREEMPTIBLE_NVIDIA|quota" <<<"$t"; then echo quota
  elif grep -qiE "machineTypes/.*(was not found|not found)|Unknown machine type|machine type .* does not exist|acceleratorTypes/.*not found" <<<"$t"; then echo nozone
  elif grep -qiE 'PERMISSION_DENIED|Required .* permission|has not been used in project|accessNotConfigured|not enabled|invalid_grant|Reauthentication|reauth|no credentialed accounts|credentials|billing|Invalid value for field|was not found|does not exist|invalid' <<<"$t"; then echo fatal
  else echo unknown
  fi
}

# create_vm NAME MACHINE_TYPE ZONE [EXTRA_METADATA key=value,...] -> 0 created; else LAST_ERR / LAST_CLASS are set
create_vm() {
  local name=$1 mt=$2 zone=$3 extra=${4:-} dtype=$DISK_TYPE tried_alt=0 sa=() nic=() out rc
  [ -n "$SERVICE_ACCOUNT" ] && sa=(--service-account "$SERVICE_ACCOUNT")
  case $mt in a3-*) [ -n "$NIC_A3" ] && nic=("$NIC_A3") ;; esac
  local meta="job=$JOB,bucket=$BUCKET,save_every=$SAVE_EVERY,sync_interval=$SYNC_INTERVAL,epochs=$EPOCHS,train_hours=$TRAIN_HOURS,max_restarts=$MAX_RESTARTS,install-nvidia-driver=True${extra:+,$extra}"
  while :; do
    out=$(gcloud compute instances create "$name" --project "$PROJECT" --zone "$zone" --machine-type "$mt" \
      --provisioning-model=SPOT --instance-termination-action=STOP --maintenance-policy=TERMINATE \
      --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT" \
      --boot-disk-size="${DISK_GB}GB" --boot-disk-type="$dtype" \
      --scopes=cloud-platform "${sa[@]}" "${nic[@]}" \
      --labels="app=centraid-train,job=$(job_slug)" \
      --metadata="$meta" \
      --metadata-from-file="startup-script=$VM_DIR/run_job.sh,shutdown-script=$VM_DIR/run_job.sh" \
      --quiet 2>&1)
    rc=$?
    if [ $rc -eq 0 ]; then
      DISK_TYPE=$dtype   # remember what worked for the next shape/zone
      return 0
    fi
    LAST_ERR=$out
    LAST_CLASS=$(classify_error "$out")
    # the API rejected the disk type for this shape (pd-ssd vs hyperdisk): retry once with the alternative
    if [ "$tried_alt" = 0 ] && [ "$LAST_CLASS" != capacity ] && [ "$LAST_CLASS" != quota ] &&
      grep -qiE 'disk.?type|hyperdisk|not supported for|diskTypes' <<<"$out"; then
      tried_alt=1
      log "  disk type $dtype rejected for $mt; retrying with $DISK_TYPE_ALT"
      dtype=$DISK_TYPE_ALT
      continue
    fi
    return 1
  done
}

# launch_cycle NAME "SHAPES" [EXTRA_METADATA]: sweep every zone of every shape, sleep, repeat until one VM exists or
# MAX_WAIT_S passes. Sets CREATED_SHAPE / CREATED_ZONE. Returns 0 on success, 2 on timeout; dies on a fatal error.
launch_cycle() {
  local name=$1 shapes=$2 extra=${3:-} t0 pass=0 mt z unknown=0 zs skip_shape
  pick_image_family
  t0=$(date +%s)
  while :; do
    pass=$((pass + 1))
    log "=== pass $pass over: $shapes (elapsed $(($(date +%s) - t0))s, max-wait ${MAX_WAIT_S}s) ==="
    for mt in $shapes; do
      zs=$(zones_for "$mt")
      skip_shape=0
      for z in $zs; do
        [ "$skip_shape" = 1 ] && break
        log "attempt: $(shape_label "$mt") ($mt) in $z, SPOT, ${DISK_GB}GB $DISK_TYPE"
        if create_vm "$name" "$mt" "$z" "$extra"; then
          CREATED_SHAPE=$mt
          CREATED_ZONE=$z
          log "CREATED $name: $(shape_label "$mt") ($mt) in $z"
          return 0
        fi
        case $LAST_CLASS in
          capacity) log "  no capacity in $z (stockout); next"; unknown=0 ;;
          quota) log "  quota refused ($(grep -oiE "Quota '[A-Z0-9_]+' exceeded[^.]*|QUOTA_EXCEEDED[^.]*" <<<"$LAST_ERR" | head -1)); quota is per region, so the other zones of $mt are skipped this pass"
            skip_shape=1; unknown=0 ;;
          nozone) log "  $mt is not offered in $z; next"; unknown=0 ;;
          fatal) die "gcloud failed, not a capacity problem:"$'\n'"$LAST_ERR" ;;
          *) unknown=$((unknown + 1))
            log "  unclassified error ($unknown in a row): $(tr '\n' ' ' <<<"$LAST_ERR" | cut -c1-300)"
            [ "$unknown" -ge 6 ] && die "6 unclassified gcloud errors in a row; last:"$'\n'"$LAST_ERR" ;;
        esac
      done
    done
    if [ "$MAX_WAIT_S" != 0 ] && [ $(($(date +%s) - t0)) -ge "$MAX_WAIT_S" ]; then
      log "max-wait (${MAX_WAIT_S}s) reached without a GPU VM"
      return 2
    fi
    local s=$((PASS_SLEEP_MIN + RANDOM % (PASS_SLEEP_MAX - PASS_SLEEP_MIN + 1)))
    log "pass $pass found nothing; sleeping ${s}s"
    sleep "$s"
  done
}
