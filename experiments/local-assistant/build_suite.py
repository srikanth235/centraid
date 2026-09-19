"""Lower ``reference.py``'s cases into the frozen ``suite.json``.

Requests, categories, reference calls and outcome shapes are all hand-written
in ``reference.py``. The one thing this tool computes is the *expected id set*
of a read turn, by running that turn's reference call against a fresh world.

That bootstrap happens once, at freeze time. Afterwards ``suite.json`` is the
authority: ``test_suite_reachable.py`` compares the frozen file against a live
reference run, so a change in the executor that moves a read's answer fails
the suite instead of quietly moving the target with it. Rebuilding the file is
therefore a deliberate act (``--write``) and a post-freeze change that the
protocol's change log must name. Run ``bun run format`` after a rebuild: oxfmt
owns JSON whitespace in this repository, so the comparison is of the parsed
document rather than of bytes.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import resolvers as R
import world
from executor import execute
from reference import CASES, category_counts


def suite_path() -> Path:
    """Where the frozen suite lives."""
    return Path(__file__).resolve().parent / "suite.json"


def build() -> dict[str, Any]:
    """The whole suite document, with read expectations filled from a run."""
    cases: list[dict[str, Any]] = []
    for case_id, category, turns in CASES:
        conn = world.reset()
        context = R.Context()
        built_turns: list[dict[str, Any]] = []
        for index, (request, calls, outcome, ordered) in enumerate(turns):
            result = None
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
        cases.append({"id": case_id, "category": category, "turns": built_turns})
    return {
        "version": 1,
        "today": world.TODAY.isoformat(),
        "category_counts": category_counts(),
        "cases": cases,
    }


def render() -> str:
    """The exact bytes ``suite.json`` must hold."""
    return json.dumps(build(), indent=2, ensure_ascii=False) + "\n"


def load() -> dict[str, Any]:
    """The frozen suite as it sits on disk."""
    return json.loads(suite_path().read_text(encoding="utf-8"))


def main() -> int:
    """Write or print the suite."""
    parser = argparse.ArgumentParser(description="Build the frozen evaluation suite.")
    parser.add_argument("--write", action="store_true", help="Write suite.json.")
    args = parser.parse_args()
    text = render()
    if args.write:
        suite_path().write_text(text, encoding="utf-8")
        document = json.loads(text)
        print(f"wrote {suite_path()} ({len(document['cases'])} cases)")
        for category, count in document["category_counts"].items():
            print(f"  {category:<24} {count}")
        return 0
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
