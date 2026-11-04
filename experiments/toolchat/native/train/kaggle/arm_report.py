"""One arm's val report: the figures M6 (#1171) compares, read from the `report.json` that `assist-eval` writes.

    python3 arm_report.py REPORT.json --arm A [--tools sig] [--out arm-A.val.json]

Keeps: session pass, turn pass (all turns and clean turns), per-argument accuracy (rows, date, filters, amount), the fail rate by constraint
count 1 / 2 / 3 / 4+ (S2's, from the issue: 13 / 22 / 37 / 67 %), and the Money and Health slices on their own (S2 never trained on either).
Pure standard library: it runs on the Kaggle kernel and on a laptop alike.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BUCKETS = ("1", "2", "3", "4+")
SLICES = ("money", "health")
ARGUMENTS = ("rows", "date", "filters", "amount")


def rate(r: dict | None) -> dict:
    """{k, n, rate, ci95} of an assist-eval `Rate`; zeros when the report has none."""
    r = r or {}
    return {"k": r.get("k", 0), "n": r.get("n", 0), "rate": r.get("rate", 0.0), "ci95": r.get("ci95", [0.0, 0.0])}


def constraint_buckets(slice_: dict) -> dict:
    by = slice_.get("by_constraints") or {}
    return {b: {"turns": by.get(b, {}).get("turns", 0), "failed": by.get(b, {}).get("failed", 0),
                "fail_rate": by.get(b, {}).get("fail_rate", 0.0)} for b in BUCKETS}


def arguments(slice_: dict) -> dict:
    by = slice_.get("arguments") or {}
    return {a: {k: by.get(a, {}).get(k, 0 if k != "rate" else 0.0) for k in ("right", "scored", "unscorable", "rate")} for a in ARGUMENTS}


def slice_summary(app: dict) -> dict:
    return {"turns": app.get("turns", 0), "turn_pass": rate(app.get("turn_pass")),
            "session_pass_single_app": rate(app.get("single_app_session_pass")),
            "arguments": arguments(app), "fail_by_constraints": constraint_buckets(app)}


def summarise(report: dict, arm: str, tools: str = "sig") -> dict:
    """The arm report of one assist-eval report."""
    overall = report["overall"]
    by_app = {name.lower(): app for name, app in (report.get("by_app") or {}).items()}
    return {
        "arm": arm,
        "tools": tools,
        "model": report.get("model", ""),
        "set": report.get("set", ""),
        "sessions": overall.get("sessions", 0),
        "set_sessions": overall.get("set_sessions", 0),
        "excluded": len(report.get("excluded") or []),
        "engine_errors": overall.get("engine_errors", 0),
        "session_pass": rate(overall.get("session_pass")),
        "turn_pass": rate(report.get("turn_pass")),
        "clean_turn_pass": rate(report.get("clean_turn_pass")),
        "arguments": arguments(report),
        "fail_by_constraints": constraint_buckets(report),
        "slices": {name: slice_summary(by_app[name]) if name in by_app else None for name in SLICES},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("report", type=Path, help="assist-eval's report.json")
    ap.add_argument("--arm", required=True, help="A, B, C, or S2 for the baseline")
    ap.add_argument("--tools", default="sig", help="the tools block the model was scored under (sig, or s2 for the baseline)")
    ap.add_argument("--out", type=Path, help="default: arm-ARM.val.json beside the report")
    a = ap.parse_args(argv)
    out = a.out or a.report.with_name("arm-%s.val.json" % a.arm)
    out.write_text(json.dumps(summarise(json.loads(a.report.read_text()), a.arm, a.tools), indent=1) + "\n")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
