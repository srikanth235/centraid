#!/bin/bash
# check.sh W [--only SID,...]: the one gate for an eval world. Prints a final ALL PASS or FAIL line.
#
#   P=PRIVATE_COPY NATIVETOOLS=BINARY TRAIN_GOLD='DIR/T*.gold.jsonl' authored/evalkit/check.sh A [--only A-E001,A-E002]
#
# Run it from the full repo (the held-out sets live there; only verdicts and your own messages are
# printed). The environment (KIT.md "Setup"):
#   EVALKIT_ROOT the full experiments/toolchat/native tree (default: the tree that holds this script)
#   P            the author's private copy of experiments/toolchat/native, where the sessions are
#                built (default: EVALKIT_ROOT)
#   PY           a python with torch (CPU), transformers and numpy (default: python3)
#   NATIVETOOLS  the runtime binary (required)
#   TRAIN_GOLD   glob of the train worlds' built *.gold.jsonl (build.py output); the mix and hygiene
#                checks compare with it (required for the full run)
#   OUT          where the build writes (default: ${TMPDIR:-/tmp}/evalkit-W)
#   EVAL_VAULTS  where the world is seeded (default: OUT/vaults)
#   SKIP_HYG     skip hygiene; the run then ends in FAIL, so it is never a final run
REPO=${EVALKIT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
W=${1:?usage: check.sh W [--only SID,...]}; shift
PY=${PY:-python3}
: "${NATIVETOOLS:?set NATIVETOOLS to the runtime binary}"
[ -n "$1" ] || : "${TRAIN_GOLD:?set TRAIN_GOLD to a glob of the built train *.gold.jsonl}"
P=$(cd "${P:-$REPO}" && pwd) || exit 2
OUT=${OUT:-${TMPDIR:-/tmp}/evalkit-$W}; mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
EVAL_VAULTS=${EVAL_VAULTS:-$OUT/vaults}; mkdir -p "$EVAL_VAULTS" && EVAL_VAULTS=$(cd "$EVAL_VAULTS" && pwd)
export NATIVETOOLS EVAL_VAULTS HF_HUB_OFFLINE=1
cd "$P" || exit 2
fail=0
echo "== build (runtime replay; every turn must score as its gold)"
# A report an earlier run left is never this build's: delete it first, and read none when the build
# did not finish (a disk-full crash left "verified N/N" of the run before standing in for this one).
rm -f "$OUT/$W.report.json"
$PY authored/build.py "$W" --out "$OUT" --split eval "$@" >"$OUT/build.log" 2>&1
built=$?
grep -v -E "^Loading|Warning" "$OUT/build.log" | tail -3
if [ "$built" != 0 ]; then
  echo "build.py exited with status $built: the build did not finish, so no report was read. The end of its log ($OUT/build.log):"
  grep -v -E "^Loading|Warning" "$OUT/build.log" | tail -12
  echo "FAIL"
  exit 1
fi
if [ ! -s "$OUT/$W.report.json" ]; then
  echo "build.py exited 0 but wrote no $W.report.json: nothing to verify"
  echo "FAIL"
  exit 1
fi
$PY - "$OUT/$W.report.json" <<'PY' || fail=1
import json, sys
r = json.load(open(sys.argv[1])); bad = [x for x in r if not x.get("pass")]
for x in bad[:40]: print("  FAIL", x["id"], "|", "; ".join(str(p) for p in x.get("problems", []))[:300])
print(f"verified {len(r) - len(bad)}/{len(r)}"); sys.exit(1 if bad else 0)
PY
[ -n "$1" ] && { echo "(--only run: shape, mix and hygiene skipped)"; exit $fail; }
echo "== trace"
$PY authored/trace3_check.py report "$OUT/$W.jsonl.gz" 2>&1 | grep -i -E "round trip|refer rule" | head -4
echo "== shape (yours vs the train corpus targets in KIT.md)"
$PY "$REPO/authored/coverage.py" "$OUT/$W.gold.jsonl" --worlds "$P/authored/worlds" --md "$OUT/coverage.md" >/dev/null 2>"$OUT/coverage.err"
[ -s "$OUT/coverage.md" ] || { echo "coverage.py failed:"; tail -3 "$OUT/coverage.err"; fail=1; }
sed -n '/Observed runtime/,/refer by description/p' "$OUT/coverage.md" | grep "^- " | grep -v "worlds without"
sed -n '/Other per-turn/,/starts lowercase/p' "$OUT/coverage.md" | grep -E "already-so|multi-call|repair turns"
echo "== mix (vs train)"
$PY "$REPO/authored/evalkit/mix.py" "$OUT/$W.gold.jsonl" --train "$TRAIN_GOLD" | tee "$OUT/mix.txt"
grep -q "mix+phrasing: PASS" "$OUT/mix.txt" || fail=1
echo "== hygiene"
if [ -n "$SKIP_HYG" ]; then
  echo "(hygiene skipped: SKIP_HYG set; not a final run)"; fail=1
else
  $PY "$REPO/authored/evalkit/hyg.py" "$OUT/$W.gold.jsonl" --train "$TRAIN_GOLD" 2>"$OUT/hyg.err" || { fail=1; grep -v -E "^Loading|Warning" "$OUT/hyg.err" | tail -3; }
fi
[ $fail = 0 ] && echo "ALL PASS (now compare the shape lines with the targets yourself)" || echo "FAIL"
exit $fail
