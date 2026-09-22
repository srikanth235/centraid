#!/bin/sh
# The anti-leakage gate, run so that no eval text ever reaches a person who
# writes training data or a generator: `overlap-check`'s report goes to a file,
# scripts DELETE the offending rows out of the corpus, and only the summary
# lines are ever printed.
#
#   ./gate.sh            # gates data/distill.jsonl + distill_val.jsonl in place
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=/home/user/centraid
DATA=$ROOT/experiments/canon-model/data
WORK=${WORK:-/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad}
BIN=$ROOT/target/debug/overlap-check

measure() {
  python3 "$DIR/to_requests.py" "$DATA/distill.jsonl" "$WORK/distill_req.jsonl"
  "$BIN" "$WORK/distill_req.jsonl" > "$WORK/overlap.txt" 2>&1 || true
}

# 1. exact collisions — fatal to the run, so they are stripped, twice over.
measure
python3 "$DIR/strip_exact.py" "$WORK/overlap.txt" \
  "$DATA/distill.jsonl" "$DATA/distill_val.jsonl"
measure
python3 "$DIR/strip_exact.py" "$WORK/overlap.txt" \
  "$DATA/distill.jsonl" "$DATA/distill_val.jsonl"
# 2. proper nouns the BASELINE corpus does not already leak.
measure
python3 "$DIR/strip_leaks.py" "$WORK/overlap.txt" "$WORK/baseline.txt" \
  "$DATA/distill.jsonl" "$DATA/distill_val.jsonl"
# 3. four-word runs the BASELINE corpus does not already share.
python3 "$DIR/strip_grams.py" "$ROOT/crates/evalsuite/suite.json" \
  "$ROOT/crates/evalsuite/blind.json" "$DATA/train.jsonl" \
  "$DATA/distill.jsonl" "$DATA/distill_val.jsonl"
measure

SUMMARY='^training|^== |exact request collisions|4-gram collisions|proper-noun leaks|^FAIL|^OK'
echo "--- distill.jsonl ---"
grep -E "$SUMMARY" "$WORK/overlap.txt"
echo "--- train.jsonl (the baseline this must not be worse than) ---"
grep -E "$SUMMARY" "$WORK/baseline.txt"
