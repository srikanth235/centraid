"""Run the frozen suite through the hand-written reference call sequences.

This is the reachability proof the brief requires before any model runs: a
perfect model's calls, scored by the same scorer every model lane will use,
must produce zero failures. A failure here means the suite asks for something
the catalogue, the resolvers or the world cannot deliver — a bug in the
evaluation, not in a model.

    python3 run_reference.py --label reference

``--label`` is required and append-only: a label that already has a report is
refused rather than overwritten.
"""

from __future__ import annotations

import argparse
import sqlite3
from typing import Any

import resolvers as R
import scoring
import world
from build_suite import load
from executor import Result, execute
from reference import REFERENCE


def run_case(case: dict[str, Any], conn: sqlite3.Connection) -> scoring.CaseScore:
    """Play every turn of one case against one fresh world."""
    score = scoring.CaseScore(case_id=case["id"], category=case["category"])
    context = R.Context()
    calls_per_turn = REFERENCE[case["id"]]
    for index, turn in enumerate(case["turns"]):
        result: Result | None = None
        for operation, slots in calls_per_turn[index]:
            result = execute(operation, slots, context, conn)
        if result is None:
            score.turns.append(scoring.TurnScore(index, False, "no reference call"))
            break
        context.last_request = turn["request"]
        score.turns.append(scoring.score_turn(index, turn["expected"], result, conn))
        if not score.turns[-1].passed:
            break
    return score


def run(label: str) -> int:
    """Score every case and write the report. Returns the failure count."""
    suite = load()
    missing = sorted({case["id"] for case in suite["cases"]} - set(REFERENCE))
    if missing:
        raise AssertionError(f"cases with no reference sequence: {missing}")

    scores = [run_case(case, world.reset()) for case in suite["cases"]]
    scoring.print_report(scores)
    path = scoring.write_report(label, "reference", scores)
    print(f"\n  report: {path}")
    return sum(1 for score in scores if not score.passed)


def main() -> int:
    """Entry point."""
    parser = argparse.ArgumentParser(description="Run the reference sequences.")
    parser.add_argument("--label", required=True, help="Run label; never overwritten.")
    args = parser.parse_args()
    return 1 if run(args.label) else 0


if __name__ == "__main__":
    raise SystemExit(main())
