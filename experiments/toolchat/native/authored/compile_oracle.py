#!/usr/bin/env python3
"""The compile oracle: every think of the train data and of the golden file, compiled and v4-rewritten, recorded, compared.

The stateless think -> call compiler and the v3.1 -> v4 think rewrite have ONE implementation (`crates/nativetools`,
`think.rs`, spoken through `nativetools think`; `runtime_think.py` is the Python client). This script is what keeps that
true: it runs a corpus through an implementation, writes one result per think, and compares two such files.

    python3 authored/compile_oracle.py record --impl py|client|rust --out FILE.jsonl.gz [--train data/train.jsonl.gz]
                                       [--golden authored/golden_v3.json] [--mutants N] [--limit N]
    python3 authored/compile_oracle.py compare A.jsonl.gz B.jsonl.gz

The corpus is TRAIN data and the golden file only (the frozen sets are never read):
  - every assistant think of every record of `--train`, with the `dates:` line of its turn and the messages before it;
  - every `think` and `think4` of the golden file (no history: the v4 pick reason is `reason_hint`);
  - `--mutants N`: for every N-th think a deterministic mutant (a line dropped, swapped, doubled, a word garbled, the dates
    line removed), so the refusal paths of the parser and of the compiler are compared as well as the successes.

Per think the result holds: `v31` (the call `compile_call(think, dates, "v3.1")` states, or the refusal: its class and
message), `v4raw` (the same under v4), `v4think` (the v4 text of the think, or the skip: reason and detail) and `v4` (the
call of that text under v4). `compare` reports, per field, how many results agree and lists the first disagreements.

Implementations: `py` is the Python compiler `authored/trace.py` had before the runtime's replaced it (commit b4b006f32 and
earlier): it is no longer in the tree, so `py` loads it from ORACLE_PY_TRACE, a copy of that file
(`git show b4b006f32:experiments/toolchat/native/authored/trace.py > /tmp/trace_old.py`); `client` is `runtime_think.py` (the Rust
compiler through `nativetools think`; NATIVETOOLS names the binary), `rust` is the same binary spoken to directly, without the
client's context building or cache. The run of `py` over the train data is the oracle the Rust compiler was held to: 67,889
thinks (the train data's, the golden file's, and every third one again as a mutant) with the same result in every field.
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import os
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
sys.path[:0] = [str(NATIVE)]


def load_trace():
    """authored/trace.py by path (the name `trace` is also a standard-library module)."""
    if "authored_trace" not in sys.modules:
        spec = importlib.util.spec_from_file_location("authored_trace", HERE / "trace.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["authored_trace"] = mod
        spec.loader.exec_module(mod)
    return sys.modules["authored_trace"]


# ---------------------------------------------------------------------------------------------
# the corpus
# ---------------------------------------------------------------------------------------------

def mutate(think: str, rng: random.Random) -> tuple[str, str]:
    """A deterministic mutant of a think and what was done to it."""
    lines = think.split("\n")
    kind = rng.choice(["drop", "swap", "double", "garble", "tail", "blank", "unknown", "case", "semantic", "semantic", "semantic"])
    if kind == "semantic":  # a think that still parses, with one value changed, so the compile step's own refusals are reached
        swaps = [("dates[0]", "dates[1]"), ("dates[1]", "dates[7]"), ("dates[0] past", "dates[0] upcoming"), (" past", ""), (" upcoming", ""),
                 ("time: ", "time: 09:00 · "), ("verb: ", "verb: nonsense_"), (" t", " t t"), ("wd", "wd9"), ("week+", "month+"),
                 ("#", "#9"), ("kind: ", "kind: x "), ("pick: #", "pick: #3 ok · #"), ("limit: ", "limit: x"), ("where: ", "where: "),
                 (" = ", " = from "), ("intent: write", "intent: read"), ("intent: read", "intent: count"), ("intent: ", "intent: ask "),
                 ("when: ", "when: earlier = "), ("set: ", "set: x = ~2026-01-01 · "), ("rows: ", "rows: @1, "), ("name: ", "name:  ")]
        rng.shuffle(swaps)
        for a, b in swaps:
            if a in think:
                return think.replace(a, b, 1), f"semantic {a!r}"
        return think, "semantic none"
    if kind == "drop" and len(lines) > 1:
        i = rng.randrange(len(lines))
        return "\n".join(lines[:i] + lines[i + 1:]), f"drop {i}"
    if kind == "swap" and len(lines) > 1:
        i = rng.randrange(len(lines) - 1)
        lines[i], lines[i + 1] = lines[i + 1], lines[i]
        return "\n".join(lines), f"swap {i}"
    if kind == "double":
        i = rng.randrange(len(lines))
        return "\n".join(lines[:i + 1] + lines[i:]), f"double {i}"
    if kind == "garble":
        i = rng.randrange(len(lines))
        ln = lines[i]
        j = rng.randrange(len(ln) + 1)
        lines[i] = ln[:j] + rng.choice(["#", "@9", " · ", '"', "dates[9]", " = ", "~", "t", "x"]) + ln[j + 1:]
        return "\n".join(lines), f"garble {i}"
    if kind == "tail":
        return think + rng.choice(["\n", "\n\n", " ", "\nrows: #1", "\nverb: star", "\nlimit: 3"]), "tail"
    if kind == "blank":
        i = rng.randrange(len(lines) + 1)
        return "\n".join(lines[:i] + [""] + lines[i:]), "blank"
    if kind == "unknown":
        return think + "\nmystery: x", "unknown"
    return think.replace("intent:", "Intent:", 1), "case"


def corpus(train: str | None, golden: str | None, mutants: int, limit: int | None, seed: int = 7):
    T = load_trace()
    rng = random.Random(seed)
    k = 0

    def emit(entry):
        nonlocal k
        yield entry
        k += 1
        if mutants and k % mutants == 0:
            think, what = mutate(entry["think"], rng)
            yield dict(entry, src=entry["src"] + "#mut:" + what, think=think)

    n = 0
    if golden:
        for i, r in enumerate(json.load(open(golden))):
            for key in ("think", "think4"):
                if r.get(key):
                    yield from emit({"src": f"golden:{i}:{key}", "think": r[key], "dates": r.get("dates"), "history": None})
    if train:
        with gzip.open(train, "rt") as f:
            for line in f:
                ex = json.loads(line)
                msgs = ex["messages"]
                for i, m in enumerate(msgs):
                    if m["role"] == "assistant" and m.get("think"):
                        hist = msgs[:i]
                        yield from emit({"src": f"train:{ex['id']}:{i}", "think": m["think"], "dates": T.dates_line_of(hist),
                                         "history": hist})
                        n += 1
                        if limit and n >= limit:
                            return


# ---------------------------------------------------------------------------------------------
# the implementations
# ---------------------------------------------------------------------------------------------

class PyImpl:
    """The Python compiler of authored/trace.py as of b4b006f32, from ORACLE_PY_TRACE."""

    def __init__(self):
        path = os.environ.get("ORACLE_PY_TRACE")
        if not path:
            sys.exit("--impl py needs ORACLE_PY_TRACE=<the trace.py of b4b006f32>: git show b4b006f32:experiments/toolchat/native/authored/trace.py")
        spec = importlib.util.spec_from_file_location("authored_trace", path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["authored_trace"] = mod
        spec.loader.exec_module(mod)
        self.T = mod

    def compile(self, think, dates, mode):
        T = self.T
        try:
            return ["ok", T.compile_call(think, dates, mode)]
        except T.CompileError as e:
            return ["err", "CompileError", str(e)]
        except Exception as e:  # noqa: BLE001 -- recorded as what it is, so a stray exception class is a finding
            return ["err", type(e).__name__, str(e)]

    def v4(self, think, history, dates):
        T = self.T
        try:
            if history:
                return ["ok", T.v4_think(think, history)]
            return ["ok", T.v4_think(think, None, dates if dates is not None else "")]
        except T.V4Skip as e:
            return ["skip", e.reason, e.detail]


class ClientImpl:
    """`runtime_think.py`: the Rust compiler behind the Python client."""

    def __init__(self):
        sys.path[:0] = [str(NATIVE)]
        import runtime_think as R
        self.R = R

    def compile(self, think, dates, mode):
        R = self.R
        try:
            return ["ok", R.compile_think(think, dates, mode)]
        except R.Refused as e:
            return ["err", e.cls, e.message]

    def v4(self, think, history, dates):
        R = self.R
        try:
            if history:
                return ["ok", R.v4_think(think, history)]
            return ["ok", R.v4_think(think, None, dates if dates is not None else "")]
        except R.V4Skip as e:
            return ["skip", e.reason, e.detail]


class RustImpl:
    """The binary spoken to directly: no client, no cache. The v4 context is the client's `context_of`."""

    def __init__(self):
        import subprocess
        sys.path[:0] = [str(NATIVE)]
        import runtime_think as R
        self.R = R
        nt = os.environ.get("NATIVETOOLS", str(NATIVE.parents[2] / "target" / "debug" / "nativetools"))
        self.p = subprocess.Popen([nt, "think"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")

    def ask(self, req):
        self.p.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def compile(self, think, dates, mode):
        r = self.ask({"op": "compile", "think": think, "dates": dates, "mode": mode})
        return ["ok", r["call"]] if "call" in r else ["err", r["refused"]["class"], r["refused"]["message"]]

    def v4(self, think, history, dates):
        req = {"op": "v4", "think": think, "dates": dates if dates is not None else ""}
        if history:
            req["dates"] = self.R.authored_trace().dates_line_of(history)
            req["context"] = self.R.context_of(think, history)
        r = self.ask(req)
        return ["ok", r["think"]] if "think" in r else ["skip", r["skip"]["reason"], r["skip"]["detail"]]


IMPLS = {"py": PyImpl, "client": ClientImpl, "rust": RustImpl}


def run(impl, entry):
    think, dates, hist = entry["think"], entry["dates"], entry["history"]
    out = {"src": entry["src"], "think": think, "dates": dates}
    out["v31"] = impl.compile(think, dates, "v3.1")
    out["v4raw"] = impl.compile(think, dates, "v4")
    v4 = impl.v4(think, hist, dates)
    out["v4think"] = v4
    out["v4"] = impl.compile(v4[1], dates, "v4") if v4[0] == "ok" else None
    return out


# ---------------------------------------------------------------------------------------------
# record, compare
# ---------------------------------------------------------------------------------------------

def cmd_record(a):
    impl = IMPLS[a.impl]()
    t0, n = time.time(), 0
    with gzip.open(a.out, "wt", encoding="utf-8", compresslevel=3) as out:
        for entry in corpus(a.train, a.golden, a.mutants, a.limit, a.seed):
            out.write(json.dumps(run(impl, entry), ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
            if n % 5000 == 0:
                print(f"  {n} thinks, {time.time() - t0:.0f}s", file=sys.stderr)
    print(f"{n} thinks through `{a.impl}` in {time.time() - t0:.1f}s -> {a.out}")


FIELDS = ("v31", "v4raw", "v4think", "v4")


def kind_of(res):
    return None if res is None else res[0]


def cmd_compare(a):
    def rows(path):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return [json.loads(line) for line in f]
    A, B = rows(a.a), rows(a.b)
    if [r["src"] for r in A] != [r["src"] for r in B]:
        print(f"the two files do not hold the same thinks ({len(A)} vs {len(B)}, or another order)")
        return 2
    n = len(A)
    bad = 0
    ok_refusals = same_refusals = 0
    print(f"{n} thinks")
    for field in FIELDS:
        same = [i for i in range(n) if A[i][field] == B[i][field]]
        kinds = {}
        for r in A:
            kinds[kind_of(r[field])] = kinds.get(kind_of(r[field]), 0) + 1
        print(f"  {field:8} identical {len(same)}/{n}   ({', '.join(f'{k}: {v}' for k, v in sorted(kinds.items(), key=str))})")
        if len(same) != n:
            bad += n - len(same)
            shown = 0
            for i in range(n):
                if A[i][field] != B[i][field] and shown < a.show:
                    shown += 1
                    print(f"    {A[i]['src']}\n      think: {A[i]['think'][:300]!r}\n      dates: {A[i]['dates']!r}\n      A: {json.dumps(A[i][field], ensure_ascii=False)[:400]}\n      B: {json.dumps(B[i][field], ensure_ascii=False)[:400]}")
    refusals = [(i, f) for i in range(n) for f in ("v31", "v4raw") if kind_of(A[i][f]) == "err"]
    agree = sum(1 for i, f in refusals if A[i][f] == B[i][f])
    print(f"  refusals (v31, v4raw) {agree}/{len(refusals)} identical (class and message)")
    skips = [i for i in range(n) if kind_of(A[i]["v4think"]) == "skip"]
    print(f"  v4 skips {sum(1 for i in skips if A[i]['v4think'] == B[i]['v4think'])}/{len(skips)} identical (reason and detail)")
    return 0 if bad == 0 else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--impl", choices=sorted(IMPLS), required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--train", default=str(NATIVE / "data" / "train.jsonl.gz"))
    r.add_argument("--golden", default=str(HERE / "golden_v3.json"))
    r.add_argument("--mutants", type=int, default=0, help="every N-th think also as a mutant (0: none)")
    r.add_argument("--limit", type=int, default=0, help="at most N train thinks")
    r.add_argument("--seed", type=int, default=7, help="the seed of the mutants")
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    c.add_argument("--show", type=int, default=5)
    a = ap.parse_args()
    return cmd_record(a) if a.cmd == "record" else cmd_compare(a)


if __name__ == "__main__":
    sys.exit(main())
