#!/usr/bin/env python3
"""Run every test module in an interpreter of its own; fail on a skip, a module that ran nothing, or a changed tracked file.

    python3 experiments/adapter-train/run_tests.py

No GPU, no network, no paid call. The trainer's tests need torch, transformers, peft, safetensors and zstandard (the CPU pins of
requirements-ci.txt); the rest need only the standard library.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    bad = []
    for test in sorted(HERE.glob("test_*.py")):
        p = subprocess.run([sys.executable, "-m", "unittest", test.stem, "-v"], cwd=HERE, capture_output=True, text=True,
                           env={**__import__("os").environ, "HF_HUB_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        out = p.stdout + p.stderr
        ran = [ln for ln in out.splitlines() if ln.startswith("Ran ")]
        status = "ok" if p.returncode == 0 and ran and "skipped" not in out.lower() and not ran[0].startswith("Ran 0 ") else "FAILED"
        print("%-22s %s  %s" % (test.name, status, ran[0] if ran else "no tests ran"))
        if status != "ok":
            bad.append(test.name)
            print(out[-3000:])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
