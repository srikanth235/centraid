#!/usr/bin/env bash
# bench_train.sh: A/B benchmark of the trainer's precision/speed flags, RUN ON THE GPU VM ITSELF (over ssh), on the layout probe.sh /
# run_job.sh already staged: $BASE/job/job.json (the real job), $BASE/code (train/train.py, bin/nativetools), $BASE/venv, HF cache.
# It runs the REAL trainer for BENCH_STEPS steps (default 40) per config, same seed and same data order, everything else = the job's
# own train_args (bs 16, max_len 8192, --embed, decision flags ...), then prints tokens/s, s/step, peak memory and the loss at
# steps 10/20/30/40 side by side, one verdict line and the recommended flag set.
#
#   ssh <vm> 'sudo /opt/centraid/code/train/vm/bench_train.sh'          (or: BASE=... ./bench_train.sh)
#
# Local only: it uploads nothing, touches no bucket and no VM, starts nothing but its own BENCH_STEPS-step runs (one after another),
# and refuses while a trainer is running. Each run's checkpoint dir is deleted right after the run.
# Configs (train.py's defaults are the FAST ones; the legacy path is all four opt-outs):
#   legacy   --no-tf32 --autocast none --no-fused-adam --grad-ckpt   (pure fp32, TF32 off, checkpointing on, plain AdamW)
#   +tf32    --tf32 ...                                                (TF32 matmuls)
#   +bf16    --tf32 --autocast bf16 ...                                (bf16 autocast over fp32 master weights; fp32 lm_head + loss)
#   +nockpt  same, without --grad-ckpt                                 (no recompute; more memory)
#   default  train.py's own defaults = +nockpt + fused AdamW            (the recommended set if parity holds)
# Tunables: BENCH_STEPS (40), BENCH_TOL (0.03: max relative loss gap to legacy at 10/20/30/40 for a config to count as parity),
#   BENCH_ONLY ("legacy tf32 bf16 nockpt default": which configs, in order), BENCH_MAX_MIN (per run, 40), BASE (/opt/centraid).
set -uo pipefail

BASE=${BASE:-/opt/centraid}
JOBDIR=$BASE/job
CODE=$BASE/code
VENV=$BASE/venv
BENCH_STEPS=${BENCH_STEPS:-40}
BENCH_TOL=${BENCH_TOL:-0.03}
BENCH_ONLY=${BENCH_ONLY:-"legacy tf32 bf16 nockpt default"}
BENCH_MAX_MIN=${BENCH_MAX_MIN:-40}
W=$BASE/bench
export HF_HOME=${HF_HOME:-$BASE/hf}

die() { echo "bench_train.sh: $*" >&2; exit 1; }
[ -f "$JOBDIR/job.json" ] || die "no $JOBDIR/job.json: run this on a VM staged by launch.sh/probe.sh (BASE=$BASE)"
[ -f "$CODE/train/train.py" ] || die "no $CODE/train/train.py"
[ -x "$VENV/bin/python" ] || die "no venv at $VENV"
command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1 || die "no GPU (nvidia-smi failed)"
if pgrep -f -E '/python[0-9.]* (-u )?train/train.py' >/dev/null 2>&1; then die "a trainer is running (pgrep train/train.py): stop it first, a benchmark would compete for the GPU"; fi
[ "$BENCH_STEPS" -ge 40 ] || echo "note: BENCH_STEPS < 40: the loss columns for steps beyond $BENCH_STEPS stay empty"

flags_of() {
  case $1 in
    legacy)  echo "--no-tf32 --autocast none --no-fused-adam --grad-ckpt" ;;
    tf32)    echo "--tf32 --autocast none --no-fused-adam --grad-ckpt" ;;
    bf16)    echo "--tf32 --autocast bf16 --no-fused-adam --grad-ckpt" ;;
    nockpt)  echo "--tf32 --autocast bf16 --no-fused-adam" ;;
    default) echo "" ;;
    *) die "unknown config $1" ;;
  esac
}

# the job's own trainer arguments, as run_job.sh build_train_args (probe mode) builds them, minus the flags this script sets itself
build_args() { # $1 = out dir
  "$VENV/bin/python" - "$JOBDIR/job.json" "$1" "$BENCH_STEPS" <<'PY'
import json, sys
job = json.load(open(sys.argv[1]))
out, steps = sys.argv[2:4]
a = ["--model", job["model"], "--train", job["train"], "--tools", "export/tools-sig.json", "--out", out, "--hours", "1"]
if job.get("val"):
    a += ["--val", job["val"]]
a += job.get("train_args", [])
over = {"--save-every": "0", "--max-steps": steps, "--epochs": "1", "--val-n": "8", "--train-eval-n": "8", "--checkpoints": "1.0",
        "--log-every": "10", "--seed": "0"}
# the precision / speed flags are the benchmark's variable: drop any the job carries (unary ones have no value)
unary = {"--resume", "--grad-ckpt", "--no-grad-ckpt", "--tf32", "--no-tf32", "--fused-adam", "--no-fused-adam"}
pair = set(over) | {"--test", "--autocast"}
keep, i = [], 0
while i < len(a):
    if a[i] in pair:
        i += 2
    elif a[i] in unary:
        i += 1
    else:
        keep.append(a[i])
        i += 1
print("\n".join(keep + [x for kv in over.items() for x in kv]))
PY
}

rm -rf "$W"
mkdir -p "$W"
trap 'rm -rf "$W"' EXIT
gpu=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)
echo "bench_train.sh: $BENCH_STEPS steps per config on $gpu; configs: $BENCH_ONLY"
: >"$W/summary.tsv"
for c in $BENCH_ONLY; do
  fl=$(flags_of "$c")
  mapfile -t base < <(build_args "$W/out-$c")
  [ "${#base[@]}" -gt 0 ] || die "could not build the trainer command from $JOBDIR/job.json"
  echo "== $c: train.py ... ${fl:-(defaults)}"
  t0=$(date +%s)
  (
    cd "$CODE" || exit 1
    # shellcheck disable=SC2086
    timeout "$((BENCH_MAX_MIN * 60))" env NATIVETOOLS="$CODE/bin/nativetools" PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false \
      HF_HOME="$HF_HOME" "$VENV/bin/python" train/train.py "${base[@]}" $fl
  ) >"$W/$c.log" 2>&1
  rc=$?
  rm -rf "$W/out-$c"
  printf '%s\t%s\t%s\t%s\n' "$c" "$rc" "$(($(date +%s) - t0))" "$fl" >>"$W/summary.tsv"
  [ "$rc" = 0 ] || { echo "   FAILED rc=$rc; last lines:"; tail -5 "$W/$c.log" | sed 's/^/   /'; }
done

# ---- report -----------------------------------------------------------------------------------------------------------
"$VENV/bin/python" - "$W" "$BENCH_TOL" "$BENCH_STEPS" <<'PY'
import re, sys
from pathlib import Path
w, tol, total = Path(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3])
rows = []
for line in (w / "summary.tsv").read_text().splitlines():
    name, rc, secs, fl = (line.split("\t") + [""])[:4]
    text = (w / (name + ".log")).read_text(errors="replace")
    st = {}
    for m in re.finditer(r"step (\d+)/\d+ loss ([\d.]+) gnorm ([\d.]+) lr \S+ tok/s (\d+) \(label \d+\) elapsed (\d+)s peak ([\d.]+)GiB", text):
        st[int(m.group(1))] = dict(loss=float(m.group(2)), tps=float(m.group(4)), el=float(m.group(5)), peak=float(m.group(6)))
    r = dict(name=name, rc=int(rc), flags=fl, st=st, oom="out of memory" in text.lower() or "does not fit" in text.lower(),
             fell_back="AUTOCAST unusable" in text, warn="WARNING: bf16 and fp32" in text)
    ks = sorted(st)
    if len(ks) >= 3:  # steady state: from the first log point on (the first window carries model warm-up / kernel autotune)
        r["sps"] = (st[ks[-1]]["el"] - st[ks[0]]["el"]) / (ks[-1] - ks[0])
        r["tps"] = sum(st[k]["tps"] for k in ks[1:]) / (len(ks) - 1)
        r["peak"] = max(st[k]["peak"] for k in ks)
    rows.append(r)
pts = (10, 20, 30, 40)
print()
print("%-8s %3s %9s %8s %8s | %s | flags" % ("config", "rc", "tok/s", "s/step", "peak GiB", " ".join("loss@%-3d" % p for p in pts)))
for r in rows:
    losses = " ".join(("%8.4f" % r["st"][p]["loss"]) if p in r["st"] else "%8s" % "-" for p in pts)
    if "sps" in r:
        print("%-8s %3d %9.0f %8.2f %8.1f | %s | %s%s" % (r["name"], r["rc"], r["tps"], r["sps"], r["peak"], losses, r["flags"] or "(defaults)",
              "  [AUTOCAST FELL BACK to fp32]" if r["fell_back"] else ""))
    else:
        print("%-8s %3d %9s %8s %8s | %s | %s%s" % (r["name"], r["rc"], "-", "-", "-", losses, r["flags"] or "(defaults)", "  [OOM]" if r["oom"] else "  [no steps logged]"))
leg = next((r for r in rows if r["name"] == "legacy" and "sps" in r), None)
ok = []
if leg:
    for r in rows:
        if r["rc"] or "sps" not in r or r["fell_back"]:
            continue
        gap = max((abs(r["st"][p]["loss"] - leg["st"][p]["loss"]) / max(leg["st"][p]["loss"], 1e-9) for p in pts if p in r["st"] and p in leg["st"]), default=0.0)
        r["gap"], r["speedup"] = gap, leg["sps"] / r["sps"]
        if gap <= tol:
            ok.append(r)
    print()
    for r in rows:
        if "gap" in r:
            print("  %-8s %.2fx vs legacy, max loss gap %.2f%% (%s %.0f%%)" % (r["name"], r["speedup"], 100 * r["gap"], "within" if r["gap"] <= tol else "OVER", 100 * tol))
    if ok:
        best = min(ok, key=lambda r: r["sps"])
        print("\nVERDICT: %s is fastest with loss parity: %.2fx faster than legacy (%.2f s/step vs %.2f, %.0f vs %.0f tok/s, peak %.1f GiB), "
              "max loss gap %.2f%%." % (best["name"], best["speedup"], best["sps"], leg["sps"], best["tps"], leg["tps"], best["peak"], 100 * best["gap"]))
        print("RECOMMENDED: %s" % (best["flags"] or "train.py's defaults (no flags)"))
        print("note: %d steps is a smoke of loss parity (the window-mean loss of steps 1-10 etc.), not a convergence proof." % total)
    else:
        print("\nVERDICT: no config both ran and matched the legacy loss within %.0f%%: keep the legacy flags (--no-tf32 --autocast none --grad-ckpt) and read the logs." % (100 * tol))
        print("RECOMMENDED: --no-tf32 --autocast none --no-fused-adam --grad-ckpt")
else:
    print("\nVERDICT: the legacy baseline did not produce steps; nothing to compare (see the logs in the run output above).")
PY
