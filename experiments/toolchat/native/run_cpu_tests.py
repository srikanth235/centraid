#!/usr/bin/env python3
"""The native harness's CPU test suite, exactly as CI runs it (the `native-python` job of .github/workflows/gate.yml, #1044).

    python3 experiments/toolchat/native/run_cpu_tests.py [DIR ...]       # DIR: authored authored/gen eval train (default: all four)

Each `test_*.py` runs in an interpreter of its own, started inside its directory, as every module documents (`python -m
unittest test_x`). The environment is the caller's:

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

import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIRS = ("authored", "authored/gen", "eval", "train")


def run_module(rel: str, name: str) -> int:
    """Run one module in this interpreter; 0 when the run is green by the two rules above."""
    root = HERE / rel
    os.chdir(root)
    sys.path.insert(0, str(root))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName(name))
    red = {test.id() for test, _ in result.failures + result.errors}
    problems = []
    if result.testsRun == 0:
        problems.append("no test ran")
    problems += [f"skipped: {test.id()}: {why}" for test, why in result.skipped]
    problems += [f"red: {test}" for test in sorted(red)]
    problems += [f"unexpected success: {test.id()}" for test in result.unexpectedSuccesses]
    print(f"\n== {rel}/{name}: {result.testsRun} ran, {len(result.skipped)} skipped, {len(red)} red, "
          f"{len(problems)} problem(s)")
    for line in problems:
        print(f"   {line}")
    return 1 if problems else 0


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "--module":  # a child: one module, one interpreter
        return run_module(argv[2], argv[3])
    dirs = argv[1:] or list(DIRS)
    unknown = [d for d in dirs if d not in DIRS]
    if unknown:
        print(f"unknown directory {unknown}; one of {', '.join(DIRS)}", file=sys.stderr)
        return 2
    codes = {}
    for rel in dirs:
        for path in sorted((HERE / rel).glob("test_*.py")):
            codes[f"{rel}/{path.stem}"] = subprocess.run([sys.executable, __file__, "--module", rel, path.stem], check=False).returncode
    print("\n" + "\n".join(f"{'ok  ' if code == 0 else 'FAIL'} {name}" for name, code in codes.items()))
    return 1 if any(codes.values()) or not codes else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
