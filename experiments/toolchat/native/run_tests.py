#!/usr/bin/env python3
"""The trainer's CPU tests (this directory and `train/`), each module in an interpreter of its own, started inside its directory.

    python3 experiments/toolchat/native/run_tests.py [--jobs N] [DIR ...]      # DIR: . train (default: both)

No GPU, no model weights, no network: the trainer's tests build a tiny random Qwen3.5 and a word-level tokenizer in the test. They need
torch (CPU), transformers, peft, safetensors, numpy and zstandard (`requirements-ci.txt`, installed with `pip install --require-hashes`).
`.github/workflows/trainer.yml` runs this on `main` when a file here changes; it is not part of the pull-request gate.

Two rules keep a green run meaning what it says:

  * No test may skip. A suite that cannot find what it needs raises SkipTest, and a run that skips whatever it cannot find is green
    while it tests nothing.
  * No test may be red, and every module must run at least one test. There is no list of tolerated failures.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIRS = (".", "train")


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


def modules(dirs: list[str]) -> list[tuple[str, str]]:
    return [(d, p.stem) for d in dirs for p in sorted((HERE / d).glob("test_*.py"))]


def run_all(mods: list[tuple[str, str]], jobs: int) -> dict[tuple[str, str], tuple[int, str]]:
    """Each module in a child interpreter (`-c` into this file's `run_module`), `jobs` at a time; its whole output is kept and
    printed in one piece when it ends. Each child gets its share of the cores for torch, BLAS and OpenMP."""
    threads = str(max(1, (os.cpu_count() or 1) // jobs))
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        env.setdefault(var, threads)

    def one(mod: tuple[str, str]) -> tuple[int, str]:
        code = f"import sys; sys.path.insert(0, {str(HERE)!r}); import run_tests; sys.exit(run_tests.run_module({mod[0]!r}, {mod[1]!r}))"
        done = subprocess.run([sys.executable, "-I", "-c", code], env=env, capture_output=True, text=True, check=False)
        return done.returncode, done.stdout + done.stderr

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        return dict(zip(mods, pool.map(one, mods)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("dirs", nargs="*", default=list(DIRS))
    a = ap.parse_args(argv)
    mods = modules(a.dirs)
    if not mods:
        print("no test module found")
        return 1
    results = run_all(mods, max(1, a.jobs))
    bad = []
    for mod, (code, text) in results.items():
        print(text)
        if code:
            bad.append("/".join(mod))
    print(f"{len(mods)} module(s), {len(bad)} with problems" + (": " + ", ".join(bad) if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
