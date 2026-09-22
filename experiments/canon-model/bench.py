"""CPU latency per canonical, for the tier A/B "fast" column.

{flan-t5-small, t5-small} x {fp32, int8 dynamic} x {greedy, beam=4}, batch 1,
warm model, p50/p95 over N REAL member utterances drawn from the corpora.
Also records model size on disk, resident memory, and whether int8 changes
the decoded string.

The box is contended by `cargo test` for most of a working day; run
`--wait-for-idle` (the default) so no number is taken against a busy box.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import time

import torch

from decode import load_model

MODELS = ["google/flan-t5-small", "t5-small"]
MAP = "/home/user/centraid/crates/evalsuite/grammar/map.json"


def wait_for_idle(poll=60):
    """No timing is taken while `cargo test` holds the box's four cores."""
    while True:
        found = subprocess.run(["pgrep", "-f", "cargo test"],
                               capture_output=True, text=True).stdout.split()
        found = [p for p in found if p != str(os.getpid())]
        if not found:
            return
        print("waiting: cargo test still running (pids %s)" % ",".join(found),
              flush=True)
        time.sleep(poll)


def real_inputs(count):
    """Member utterances: the request text of every mapped turn."""
    rows = json.load(open(MAP))["turns"]
    reqs = sorted({r["request"] for r in rows})
    out = list(reqs)
    while len(out) < count:
        out += reqs
    return out[:count]


def quantise(model):
    return torch.quantization.quantize_dynamic(
        model, {torch.nn.Linear}, dtype=torch.qint8)


def rss_mb():
    with open("/proc/self/status") as handle:
        for line in handle:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return float("nan")


def disk_mb(name):
    """Size of the model weights as cached on disk."""
    root = os.path.join(os.environ.get("HF_HOME", ""), "hub",
                        "models--" + name.replace("/", "--"))
    total = 0
    for base, _dirs, files in os.walk(root):
        for leaf in files:
            path = os.path.join(base, leaf)
            if os.path.isfile(path) and not os.path.islink(path):
                total += os.path.getsize(path)
    return total / 1e6


def run(tok, model, inputs, beams, max_new_tokens):
    outs, times = [], []
    for text in inputs[:3]:                              # warm
        model.generate(**tok(text, return_tensors="pt"), num_beams=beams,
                       max_new_tokens=max_new_tokens, do_sample=False)
    for text in inputs:
        batch = tok(text, return_tensors="pt")
        started = time.perf_counter()
        out = model.generate(**batch, num_beams=beams,
                             max_new_tokens=max_new_tokens, do_sample=False)
        times.append((time.perf_counter() - started) * 1000)
        outs.append(tok.decode(out[0], skip_special_tokens=True))
    ordered = sorted(times)
    return (outs, statistics.median(ordered),
            ordered[int(0.95 * (len(ordered) - 1))])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=MODELS)
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--max-new-tokens", type=int, default=48)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--no-wait", action="store_true")
    ap.add_argument("--raw", default="raw_bench.jsonl")
    args = ap.parse_args()

    if not args.no_wait:
        wait_for_idle()

    torch.set_num_threads(args.threads)
    inputs = real_inputs(args.n)
    print("box: %d cores, %d inputs, %d threads, max_new_tokens %d"
          % (os.cpu_count(), len(inputs), args.threads, args.max_new_tokens))
    print()
    print("| model | params | disk MB | precision | decode | p50 ms | p95 ms "
          "| RSS MB | int8 drift |")
    print("|---|---|---|---|---|---|---|---|---|")
    reference = {}
    raw = open(args.raw, "w")
    for name in args.models:
        tok, model, _ = load_model(name)
        params = sum(p.numel() for p in model.parameters())
        on_disk = disk_mb(name)
        for precision, net in (("fp32", model), ("int8", quantise(model))):
            for label, beams in (("greedy", 1), ("beam=4", 4)):
                outs, p50, p95 = run(tok, net, inputs, beams,
                                     args.max_new_tokens)
                for text, out in zip(inputs, outs):
                    raw.write(json.dumps({"model": name, "precision": precision,
                                          "decode": label, "input": text,
                                          "raw": out}) + "\n")
                if precision == "fp32":
                    reference[(name, label)] = outs
                    drift = "-"
                else:
                    ref = reference[(name, label)]
                    same = sum(a == b for a, b in zip(ref, outs))
                    drift = ("identical" if same == len(outs)
                             else "%d/%d differ" % (len(outs) - same, len(outs)))
                print("| %s | %.0fM | %.0f | %s | %s | %.0f | %.0f | %.0f | %s |"
                      % (name, params / 1e6, on_disk, precision, label, p50,
                         p95, rss_mb(), drift), flush=True)
        del model
    raw.close()


if __name__ == "__main__":
    main()
