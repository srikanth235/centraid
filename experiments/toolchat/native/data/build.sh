#!/usr/bin/env bash
# Build the step-3 data end to end: pinned runtime, paraphrase pool, pilot -> N sessions, train, val,
# checks, coverage. One training sequence per session (SPEC §11.7), prompt mode --tools sig.
# usage: data/build.sh OUT_DIR PYTHON   (PYTHON: an interpreter with transformers; the Qwen tokenizer is cached)
#        PILOT_ONLY=1 data/build.sh ...  stops after the pilot (writes OUT_DIR/pilot/pilot.json)
set -euo pipefail
OUT=$1
PY=$2
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
mkdir -p "$OUT/bin"
(cd "$REPO" && cargo build -q -p centraid-nativetools)
cp "$REPO/target/debug/nativetools" "$OUT/bin/nativetools"      # pin: the runtime changes under us otherwise
export NATIVETOOLS=$OUT/bin/nativetools NATIVE_EXPORT=$OUT/export NATIVE_TOOLS_MODE=sig
rm -rf "$NATIVE_EXPORT" && "$NATIVETOOLS" export "$NATIVE_EXPORT" >/dev/null
cd "$HERE"
[ -f "$OUT/phrasing_pool.json" ] || python3 paraphrase.py "$OUT" --jobs 6
JOBS=3          # the disk is shared; each worker holds one vault (a large one's WAL is ~60 MB)

gen() {  # split first last quota dir [extra gen.py flags]
  local split=$1 lo=$2 hi=$3 quota=$4 dir=$5 extra=${6:-} step=$(( ($3 - $2) / JOBS ))
  for ((k = 0; k < JOBS; k++)); do
    "$PY" gen.py "$dir" --split "$split" --worlds $((lo + k * step)):$((lo + (k + 1) * step)) $extra \
      --max-examples $((quota / JOBS + (k < quota % JOBS ? 1 : 0))) --pool "$OUT/phrasing_pool.json" 2>"$dir/log-$split-$k.txt" &
  done
  wait
}

rm -rf "$OUT/pilot" && mkdir -p "$OUT/pilot"
gen train 1000 1100 300 "$OUT/pilot"
N=$("$PY" pilot.py "$OUT/pilot")
echo "pilot -> N=$N sessions" >&2
[ "${PILOT_ONLY:-0}" = 1 ] && exit 0
rm -rf "$OUT/final" && mkdir -p "$OUT/final"
gen train 2000 3400 $((N + N / 50)) "$OUT/final"       # 2% spare for the finalize filter
gen val 900000 900400 1020 "$OUT/final" --fresh-sessions        # self-contained tasks (eval / teacher)
mkdir -p "$OUT/pool" && gen pool 700000 700600 2000 "$OUT/pool" --fresh-sessions   # correction-round tasks
cat "$OUT"/pool/sessions-pool-*.jsonl.gz > "$OUT/pool/pool_tasks.jsonl.gz"
"$PY" pilot.py --finalize "$OUT/final" "$N"      # drops sessions a trace check fails or duplicates, fills from the rest
# field coverage: sessions weighted to every metadata field as condition / order / create / edit value,
# swapped in for sessions of the most over-represented families (train stays N)
rm -rf "$OUT/cover" && mkdir -p "$OUT/cover"
NATIVE_COVER=80 gen train 3500 3800 700 "$OUT/cover"
"$PY" pilot.py --swap "$OUT/final" "$OUT/cover"
cp "$OUT/pilot/pilot.json" "$OUT/final/pilot.json"
./run_checks.sh "$OUT/final" "$PY"
