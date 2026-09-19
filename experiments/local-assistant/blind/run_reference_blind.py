"""Build and prove the blind re-check set.

Mirrors ``run_reference.py`` for ``blind/blind_suite.json``: the hand-written
reference calls are played through the same executor and judged by the same
scorer, and zero failures is the reachability proof. ``--write`` rebuilds the
frozen JSON from ``reference_blind.py`` (read expectations are filled by
running the reference call against a fresh world, exactly as ``build_suite.py``
does for the frozen suite); without it the file on disk is the authority and a
drift between the two is a failure.

    python3 blind/run_reference_blind.py --write
    python3 blind/run_reference_blind.py --label reference-blind
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import resolvers as R  # noqa: E402
import scoring  # noqa: E402
import world  # noqa: E402
from executor import Result, execute  # noqa: E402
from reference_blind import CASES, REFERENCE, category_counts  # noqa: E402


def suite_path() -> Path:
    """Where the blind suite lives."""
    return HERE / "blind_suite.json"


def build() -> dict[str, Any]:
    """The whole blind suite, with read expectations filled from a run."""
    cases: list[dict[str, Any]] = []
    for case_id, category, note, turns in CASES:
        conn = world.reset()
        context = R.Context()
        built_turns: list[dict[str, Any]] = []
        for index, (request, calls, outcome, ordered) in enumerate(turns):
            result: Result | None = None
            for operation, slots in calls:
                result = execute(operation, slots, context, conn)
            if result is None:
                raise AssertionError(f"{case_id} turn {index} has no reference call")

            if outcome[0] == "ids":
                if result.kind != "ids":
                    raise AssertionError(
                        f"{case_id} turn {index}: reference call did not read "
                        f"({result.kind} / {result.reason} / {result.detail})"
                    )
                expected: dict[str, Any] = {
                    "type": "ids",
                    "entity": outcome[1],
                    "ids": list(result.ids),
                    "ordered": ordered,
                }
            elif outcome[0] == "write":
                if result.kind != "write":
                    raise AssertionError(
                        f"{case_id} turn {index}: reference call did not write "
                        f"({result.kind} / {result.reason} / {result.detail})"
                    )
                expected = {"type": "write_predicate", "predicate": outcome[1], "args": outcome[2]}
            elif outcome[0] == "no_action":
                expected = {"type": "no_action", "reason": outcome[1]}
            else:
                raise AssertionError(f"{case_id} turn {index}: unknown outcome {outcome[0]!r}")

            built_turns.append({"request": request, "expected": expected})
            context.last_request = request

        case: dict[str, Any] = {"id": case_id, "category": category, "turns": built_turns}
        if note:
            case["note"] = note
        cases.append(case)
    return {
        "version": 1,
        "today": world.TODAY.isoformat(),
        "category_counts": category_counts(),
        "cases": cases,
    }


def render() -> str:
    """The exact bytes ``blind_suite.json`` must hold."""
    return json.dumps(build(), indent=2, ensure_ascii=False) + "\n"


def load() -> dict[str, Any]:
    """The blind suite as it sits on disk."""
    return json.loads(suite_path().read_text(encoding="utf-8"))


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
    """Score every blind case and write the report. Returns the failure count."""
    suite = load()
    missing = sorted({case["id"] for case in suite["cases"]} - set(REFERENCE))
    if missing:
        raise AssertionError(f"cases with no reference sequence: {missing}")

    scores = [run_case(case, world.reset()) for case in suite["cases"]]
    scoring.print_report(scores)
    path = scoring.write_report(label, "reference-blind", scores)
    print(f"\n  report: {path}")
    return sum(1 for score in scores if not score.passed)


def main() -> int:
    """Entry point."""
    parser = argparse.ArgumentParser(description="Build or prove the blind suite.")
    parser.add_argument("--write", action="store_true", help="Rebuild blind_suite.json.")
    parser.add_argument("--label", help="Run label; never overwritten.")
    args = parser.parse_args()
    if args.write:
        text = render()
        suite_path().write_text(text, encoding="utf-8")
        document = json.loads(text)
        print(f"wrote {suite_path()} ({len(document['cases'])} cases)")
        for category, count in document["category_counts"].items():
            print(f"  {category:<24} {count}")
        return 0
    if not args.label:
        parser.error("one of --write or --label is required")
    return 1 if run(args.label) else 0


if __name__ == "__main__":
    raise SystemExit(main())
