#!/usr/bin/env bash
# bundles.sh: build the three scoring bundles (trainfit 300, val 655, test 656 sessions) that score_ckpt.sh uploads and run_job.sh runs.
#
#   BUNDLE_NATIVETOOLS=<nativetools> ./bundles.sh [--sets trainfit,val,test]
#
#   BUNDLE_NATIVETOOLS  the runtime binary every bundle ships (required: the runtime that scores is an explicit choice, e.g. the build
#                 the gold was verified with, never whatever target/ holds)
#   --sets        comma list, default trainfit,val,test: eval/sets/<set>.jsonl
#   BUNDLES_DIR   output, <BUNDLES_DIR>/<set>/{bundle.dat,job.json,kernel.py} (default ${BUNDLE_STAGE:-${TMPDIR:-/tmp}/centraid-bundles}/bundles)
#   BUNDLE_STAGE  bundle.py's staging root; each set is staged there as score-<set> first
#   PYTHON        interpreter for bundle.py (default python3)
#   BUNDLE_EVAL_ENV  JSON env merged over the eval arms' (bundle.py --eval-env), e.g. '{"NATIVE_SAMPLE": "1"}' for a rollout sample set
#   BUNDLE_WORLDS    a directory of <W>.json / <W>.keys.json that bundle.py ships instead of authored/worlds' (the worlds a rollout
#                 set was built on; see eval/rollout.py)
# Each bundle is `bundle.py build score-<set> --base --dry --set eval/sets/<set>.jsonl`. The optimized scoring settings are bundle.py's
# defaults (eval_procs 4, eval_chunks 4, run_batched.py --threads 16 --wait 0.05, OMP_NUM_THREADS 4, arm free), so the bundles differ only in
# eval_set and eval_setup. score_ckpt.sh scores several sets in one launch only when everything else is identical: build the sets you
# score together in one run of this script, with one runtime.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NATIVE=$(cd "$VM_DIR/../.." && pwd)   # experiments/toolchat/native
PYTHON=${PYTHON:-python3}
SETS=trainfit,val,test
while [ $# -gt 0 ]; do
  case $1 in
    --sets) SETS=${2:?--sets needs a value}; shift ;;
    -h | --help) sed -n '2,/^[^#]/{/^#/p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $1 (see -h)" ;;
  esac
  shift
done
[ -n "${BUNDLE_NATIVETOOLS:-}" ] || die "set BUNDLE_NATIVETOOLS=<nativetools binary>: the runtime every bundle ships is an explicit choice"
[ -f "$BUNDLE_NATIVETOOLS" ] || die "BUNDLE_NATIVETOOLS=$BUNDLE_NATIVETOOLS is not a file"
SETS=${SETS//,/ }
[ -n "${SETS// /}" ] || die "no sets (--sets trainfit,val,test)"
for s in $SETS; do [ -f "$NATIVE/eval/sets/$s.jsonl" ] || die "eval/sets/$s.jsonl is missing in $NATIVE"; done

export BUNDLE_STAGE BUNDLE_NATIVETOOLS BUNDLE_WORLDS
mkdir -p "$BUNDLE_STAGE" "$BUNDLES_DIR"
log "runtime $BUNDLE_NATIVETOOLS (sha256 $(sha256sum "$BUNDLE_NATIVETOOLS" | cut -c1-12)); bundles go to $BUNDLES_DIR"
for s in $SETS; do
  job=score-$s
  build_log=$BUNDLE_STAGE/$job.build.log
  "$PYTHON" "$NATIVE/train/bundle.py" build "$job" --base --dry --set "eval/sets/$s.jsonl" ${BUNDLE_EVAL_ENV:+--eval-env "$BUNDLE_EVAL_ENV"} >"$build_log" 2>&1 ||
    { tail -n 20 "$build_log" >&2; die "bundle.py build failed for $s (log: $build_log)"; }
  d=$BUNDLES_DIR/$s
  rm -rf "$d"
  mkdir -p "$d"
  cp "$BUNDLE_STAGE/$job/data/bundle.dat" "$BUNDLE_STAGE/$job/data/job.json" "$BUNDLE_STAGE/$job/kernel/kernel.py" "$d/"
  sessions=$(wc -l <"$NATIVE/eval/sets/$s.jsonl" | tr -d ' ')
  worlds=$("$PYTHON" -c 'import json, sys; print(" ".join(json.load(open(sys.argv[1]))["eval_setup"][0][2:]))' "$d/job.json")
  log "$s: $sessions sessions, worlds $worlds, bundle.dat $(du -h "$d/bundle.dat" | cut -f1) -> $d"
done
log "done; score a checkpoint with: JOB=<job> BUCKET=<bucket> $VM_DIR/score_ckpt.sh <checkpoint> --watch"
