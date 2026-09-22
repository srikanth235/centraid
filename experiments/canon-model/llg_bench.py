"""Latency of the compiled mask, against unconstrained and against the old.

    cd experiments/canon-model
    HF_HOME=$PWD/hf ./.venv/bin/python -u llg_bench.py --n 50

Three decoders, the SAME 50 corpus utterances, the same int8 model, the
same box state, in one process so nothing but the mask differs:

  * unconstrained greedy  -- the floor;
  * compiled mask         -- llguidance over `canon_lark`;
  * old mask              -- `decode.GrammarConstraint`, for the 1.5 s/turn
    figure VERIFY.md/BENCH.md report.

Timing is refused on a busy box.  The TRAINING lane holds all four cores for
hours, and a number taken beside it is not a number: `--require-idle` (the
default) waits, and `--idle-timeout` gives up and says NOT MEASURED rather
than quoting a contended figure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import time

import torch

import llg_mask
from decode import GrammarConstraint, constrained_generate, load_model

MAP = llg_mask.canon_lark.GRAMMAR_DIR + "/map.json"

# `pgrep -f` matches its own command line, so it reports a busy box forever.
# The listing is read instead, and this process's own tree excluded.
BUSY = re.compile(r"\b(cargo|rustc|train\.py|python .*train\.py)\b")


def busy_processes():
    listing = subprocess.run(["ps", "-eo", "pid,args"],
                             capture_output=True, text=True).stdout
    mine = {str(os.getpid()), str(os.getppid())}
    out = []
    for line in listing.splitlines()[1:]:
        pid, _, args = line.strip().partition(" ")
        # A Claude Code shell wrapper carries its whole snapshot script on
        # its command line, so it matches on the word `cargo` without
        # running anything.  It is not a competing process.
        if pid in mine or "llg_bench" in args or "ps -eo" in args:
            continue
        if "/root/.claude/shell-snapshots/" in args:
            continue
        if BUSY.search(args):
            out.append((pid, args[:70]))
    return out


def load_average():
    with open("/proc/loadavg") as handle:
        return float(handle.read().split()[0])


def wait_for_idle(timeout, poll=60, load_max=1.0):
    started = time.time()
    while True:
        busy = busy_processes()
        load = load_average()
        if not busy and load <= load_max:
            return None
        if time.time() - started > timeout:
            return ("box never idle: load %.2f, %d competing process(es): %s"
                    % (load, len(busy),
                       "; ".join(a for _p, a in busy[:3]) or "none"))
        print("waiting: load %.2f, busy %s" % (load, [p for p, _a in busy]),
              flush=True)
        time.sleep(poll)


def real_inputs(count):
    rows = json.load(open(MAP))["turns"]
    reqs = sorted({r["request"] for r in rows})
    out = list(reqs)
    while len(out) < count:
        out += reqs
    return out[:count]


def quantise(model):
    return torch.quantization.quantize_dynamic(
        model, {torch.nn.Linear}, dtype=torch.qint8)


def timed(call, inputs, warm=3):
    for text in inputs[:warm]:
        call(text)
    times, outs = [], []
    for text in inputs:
        started = time.perf_counter()
        outs.append(call(text))
        times.append((time.perf_counter() - started) * 1000)
    ordered = sorted(times)
    return {"p50": round(statistics.median(ordered), 1),
            "p95": round(ordered[int(0.95 * (len(ordered) - 1))], 1),
            "mean": round(statistics.mean(ordered), 1)}, outs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/flan-t5-small")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--max-new-tokens", type=int, default=48)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--idle-timeout", type=float, default=900)
    ap.add_argument("--skip-old", action="store_true")
    # A contended run is NOT a latency.  It is taken only to compare the
    # three decoders against each other under one box state, and the report
    # says so in every field that came out of it.
    ap.add_argument("--allow-contended", action="store_true")
    ap.add_argument("--out", default="bench_llg.json")
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    reason = wait_for_idle(0 if args.allow_contended else args.idle_timeout)
    if reason and not args.allow_contended:
        print(json.dumps({"latency": "NOT MEASURED", "reason": reason}))
        with open(args.out, "w") as handle:
            json.dump({"latency": "NOT MEASURED", "reason": reason}, handle,
                      indent=2)
        return 0

    tok, model, _added = load_model(args.model)
    model = quantise(model)
    inputs = real_inputs(args.n)
    report = {"model": args.model, "n": args.n, "int8": True,
              "threads": args.threads, "load_at_start": load_average(),
              "contended": bool(reason), "contention": reason}

    def plain(text):
        batch = tok(text, return_tensors="pt")
        out = model.generate(**batch, num_beams=1,
                             max_new_tokens=args.max_new_tokens,
                             do_sample=False)
        return tok.decode(out[0], skip_special_tokens=True)

    report["unconstrained"], _ = timed(plain, inputs)

    compiled = llg_mask.LLGConstraint(tok)

    def new(text):
        return llg_mask.generate_one(tok, model, text, constraint=compiled,
                                     max_new_tokens=args.max_new_tokens)[0]

    report["compiled_mask"], outs = timed(new, inputs)
    report["compiled_mask"]["mask_calls"] = compiled.mask_calls
    report["sample"] = outs[:3]

    if not args.skip_old:
        old = GrammarConstraint(tok)

        def legacy(text):
            return constrained_generate(tok, model, text, constraint=old,
                                        max_new_tokens=args.max_new_tokens)

        report["old_mask"], _ = timed(legacy, inputs, warm=1)

    report["load_at_end"] = load_average()
    report["still_idle"] = not busy_processes()
    print(json.dumps(report, indent=2))
    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
