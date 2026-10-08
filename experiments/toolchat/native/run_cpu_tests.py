#!/usr/bin/env python3
"""The native harness's CPU test suite, exactly as CI runs it (the `native-python` job of .github/workflows/gate.yml, #1044).

    python3 experiments/toolchat/native/run_cpu_tests.py [--jobs N] [DIR ...]   # DIR: . authored authored/gen eval train (default: all five)

Each `test_*.py` runs in an interpreter of its own, started inside its directory, as every module documents (`python -m
unittest test_x`). The interpreters run N at a time (`--jobs`, default 4): the slowest modules start first, and each module's output
is captured and printed in one piece when it ends, never interleaved with another's. The environment is the caller's:

  NATIVETOOLS        the runtime binary: `cargo build -p centraid-nativetools --bin nativetools`, then target/debug/nativetools
  HF_HOME            a cache holding the tokenizer and config of Qwen/Qwen3.5-0.8B (no weights), with HF_HUB_OFFLINE=1:
                     the trainer's tiny-model tests build a random model from that config
  EVAL_VAULTS        world A seeded: `python3 eval/seed_worlds.py --vaults DIR A`
  GEN_INTEGRATION=1  and NOISE_INTEGRATION=1, which switch on the two opt-in integration suites. They run authored/build.py,
                     which rewrites the tracked authored/worlds/T01.keys.json while its committed ids differ from a fresh
                     seeding (they do today): `git checkout` that file after a local run

Two rules keep a green run meaning what it says:

  * No test may skip. A suite that cannot find its tokenizer or the binary raises SkipTest, and a run that skips whatever it
    cannot find is green while it tests nothing.
  * No test may be red, and every module must run at least one test. There is no list of tolerated failures.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIRS = (".", "authored", "authored/gen", "eval", "train")
JOBS = 4

# The modules that take longest, longest first (measured on four cores with a thread each: 22, 7, 7, 4, 3 and 2.5 minutes; the other 20
# take 6 together); every module not named follows in directory order. Only the order they start in: the verdict never depends on it.
SLOWEST_FIRST = ("train/test_dpo", "train/test_precision", "train/test_resume", "train/test_pairs", "train/test_ema", "train/test_marks")

# Modules that must not overlap, each tuple run in this order by one worker. Both run authored/build.py, which `rm -rf`s and reseeds
# $EVAL_VAULTS/T01 and rewrites the tracked authored/worlds/T01.keys.json while its ids differ from a fresh seeding.
SERIAL = (("authored/test_noise", "authored/gen/test_gen"),)

# Every interpreter gets its share of the cores for torch, BLAS and OpenMP (cores // jobs, at least 1: four interpreters that each
# start a thread per core spin against each other, and a 96-line module took 29 minutes). The caller's own setting wins. The one module
# that is still running long after the rest has done gets twice the share: alone on one thread it was the whole tail of the run.
THREAD_VARS = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")
WIDE = ("train/test_dpo",)


def run_module(rel: str, name: str) -> int:
    """Run one module in this interpreter; 0 when the run is green by the two rules above."""
    root = HERE / rel
    os.chdir(root)
    sys.path.insert(0, str(root))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName(name))
    red = sorted(test.id() for test, _ in result.failures + result.errors)
    problems = []
    if result.testsRun == 0:
        problems.append("no test ran")
    problems += [f"skipped: {test.id()}: {why}" for test, why in result.skipped]
    problems += [f"red: {test}" for test in red]
    problems += [f"unexpected success: {test.id()}" for test in result.unexpectedSuccesses]
    print(f"\n== {rel}/{name}: {result.testsRun} ran, {len(result.skipped)} skipped, {len(red)} red, {len(problems)} problem(s)")
    for line in problems:
        print(f"   {line}")
    return 1 if problems else 0


def jobs_of(modules: list[str]) -> list[tuple[str, ...]]:
    """The units the workers take, slowest first: each SERIAL group that is present as one unit, every other module on its own."""
    units: list[tuple[str, ...]] = []
    grouped: set[str] = set()
    for group in SERIAL:
        present = tuple(m for m in group if m in modules)
        if present:
            units.append(present)
            grouped.update(present)
    units += [(m,) for m in modules if m not in grouped]
    rank = {m: i for i, m in enumerate(SLOWEST_FIRST)}
    # sorted is stable: the units that no hint names keep the order they were found in
    return sorted(units, key=lambda unit: min((rank.get(m, len(rank)) for m in unit)))


def run_all(modules: list[str], jobs: int) -> dict[str, tuple[int, float]]:
    """Run each module in a child interpreter, `jobs` at a time; {module: (exit code, seconds)}. A module's output is printed whole."""
    results: dict[str, tuple[int, float]] = {}
    lock = threading.Lock()
    started = time.monotonic()
    cores = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1
    share = max(1, cores // jobs)

    def run_unit(unit: tuple[str, ...]) -> None:
        for module in unit:
            rel, name = module.rsplit("/", 1)
            threads = str(min(cores, 2 * share) if module in WIDE else share)
            env = {**{var: threads for var in THREAD_VARS}, **os.environ}
            t0 = time.monotonic()
            try:
                proc = subprocess.run([sys.executable, __file__, "--module", rel, name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, errors="replace", check=False, env=env)
                code, output = proc.returncode, proc.stdout
            except OSError as err:  # the interpreter did not start: the module failed, and the others still run
                code, output = 1, f"could not start the interpreter: {err}"
            seconds = time.monotonic() - t0
            with lock:
                results[module] = (code, seconds)
                print(f"\n{'=' * 8} [{len(results)}/{len(modules)}] {module}: exit {code}, {seconds:.0f} s "
                      f"({time.monotonic() - started:.0f} s into the run) {'=' * 8}\n{output.rstrip()}", flush=True)

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for future in [pool.submit(run_unit, unit) for unit in jobs_of(modules)]:
            future.result()  # a worker's own failure (not a test's) surfaces here
    return results


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "--module":  # a child: one module, one interpreter
        return run_module(argv[2], argv[3])
    ap = argparse.ArgumentParser(description="Run the native harness's CPU tests, one interpreter per module.")
    ap.add_argument("--jobs", type=int, default=JOBS, metavar="N", help=f"modules to run at once (default {JOBS})")
    ap.add_argument("dirs", nargs="*", metavar="DIR", help=f"{', '.join(DIRS)} (default: all four)")
    args = ap.parse_args(argv[1:])
    jobs, dirs = args.jobs, args.dirs or list(DIRS)
    if jobs < 1:
        ap.error("--jobs takes a whole number of at least 1")
    unknown = [d for d in dirs if d not in DIRS]
    if unknown:
        ap.error(f"unknown directory {unknown}; one of {', '.join(DIRS)}")
    modules = [f"{rel}/{path.stem}" for rel in dirs for path in sorted((HERE / rel).glob("test_*.py"))]
    started = time.monotonic()
    results = run_all(modules, jobs) if modules else {}
    wall = time.monotonic() - started
    print("\n" + "\n".join(f"{'ok  ' if results[m][0] == 0 else 'FAIL'} {m} ({results[m][1]:.0f} s)" for m in modules))
    print(f"\n{len(modules)} module(s), {jobs} at a time: {wall / 60:.1f} min wall, {sum(s for _, s in results.values()) / 60:.1f} min of module time")
    return 1 if any(code for code, _ in results.values()) or not modules else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
