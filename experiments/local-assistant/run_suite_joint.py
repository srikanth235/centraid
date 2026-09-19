"""End-to-end: the joint model on the frozen suite, scored by outcome.

    .venv-joint/bin/python run_suite_joint.py --label j-01-e2e

Per case: one fresh world, context carried across turns, and for every turn
``predict -> resolvers.resolve_all -> executor.execute -> scoring.score_turn``.
Scoring is by outcome against the world, never by string-matching a call, so a
wrong operation that produces the right ids still passes; the operation and
slot numbers beside it are measured separately.

``previous_operation`` is **the model's own previous prediction** by default,
so an error compounds the way it would at runtime. ``--oracle-previous`` reruns
with the reference operation instead, and the gap between the two is the cost
of that compounding.

``resolve_all`` is called before the executor purely to bucket failures (a slot
whose verbatim span resolves to nothing, or to more than one thing); the
executor does its own resolution, and the outcome is what is scored.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "joint"))

import resolvers as R  # noqa: E402
import scoring  # noqa: E402
import world  # noqa: E402
from build_suite import load  # noqa: E402
from executor import execute  # noqa: E402
from joint.predict_joint import predict_many  # noqa: E402
from reference import REFERENCE  # noqa: E402

# Which suite, and whose reference calls the gold operation comes from. The
# frozen suite is the default; ``--suite blind`` swaps in the blind re-check
# set (``blind/blind_suite.json`` + ``blind/reference_blind.py``), which is the
# same schema scored by the same scorer.

def suite_and_reference(name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """The suite document and its per-turn reference calls."""
    if name == "frozen":
        return load(), REFERENCE
    if name == "blind":
        sys.path.insert(0, str(HERE / "blind"))
        from reference_blind import REFERENCE as BLIND_REFERENCE  # noqa: PLC0415

        document = json.loads((HERE / "blind" / "blind_suite.json").read_text(encoding="utf-8"))
        return document, BLIND_REFERENCE
    raise SystemExit(f"no such suite: {name!r}")

BUCKETS = (
    "wrong_op",
    "wrong_span",
    "missing_slot",
    "enum",
    "clarify_when_shouldnt",
    "resolver_failure",
    "other",
)


def gold_call(reference: dict[str, Any], case_id: str, index: int) -> tuple[str, dict[str, Any]]:
    operation, slots = reference[case_id][index][0]
    return operation, dict(slots)


def bucket_for(
    predicted_operation: str,
    predicted_slots: dict[str, Any],
    gold_operation: str,
    gold_slots: dict[str, Any],
    resolution: dict[str, R.SlotResolution],
    clarified: bool,
    expected_no_action: bool,
) -> str:
    """Which error bucket a failed turn falls into, most-upstream first."""
    if clarified and not expected_no_action:
        return "clarify_when_shouldnt"
    if predicted_operation != gold_operation:
        return "wrong_op"
    missing = [name for name in gold_slots if name not in predicted_slots]
    if missing:
        return "missing_slot"
    enum_wrong = [
        name
        for name, value in gold_slots.items()
        if name in {"status", "direction", "kind", "reason", "channel", "section", "response", "calendar"}
        and str(predicted_slots.get(name)) != str(value)
    ]
    if enum_wrong:
        return "enum"
    failed = [name for name, slot in resolution.items() if not slot.ok]
    if failed:
        return "resolver_failure"
    different = [
        name
        for name, value in gold_slots.items()
        if str(predicted_slots.get(name)).strip().lower() != str(value).strip().lower()
    ]
    if different:
        return "wrong_span"
    return "other"


def run_case(case: dict[str, Any], conn: sqlite3.Connection, label: str, margin: float, oracle: bool, reference: dict[str, Any]) -> dict[str, Any]:
    score = scoring.CaseScore(case_id=case["id"], category=case["category"])
    context = R.Context()
    previous_request: str | None = None
    previous_operation: str | None = None
    turns: list[dict[str, Any]] = []
    for index, turn in enumerate(case["turns"]):
        request = turn["request"]
        prediction = predict_many(
            [
                {
                    "request": request,
                    "previous_request": previous_request,
                    "previous_operation": previous_operation,
                }
            ],
            label=label,
            margin_threshold=margin,
        )[0]
        operation = "clarify" if prediction["clarify"] else prediction["operation"]
        slots = {} if prediction["clarify"] else dict(prediction["slots"])
        resolution = (
            R.resolve_all(operation, slots, context, conn)
            if operation not in ("none", "clarify")
            else {}
        )
        result = execute(operation, slots, context, conn)
        context.last_request = request
        turn_score = scoring.score_turn(index, turn["expected"], result, conn)
        score.turns.append(turn_score)

        gold_operation, gold_slots = gold_call(reference, case["id"], index)
        record = {
            "turn": index,
            "request": request,
            "predicted_operation": prediction["operation"],
            "gold_operation": gold_operation,
            "operation_correct": prediction["operation"] == gold_operation,
            "margin": prediction["margin"],
            "predicted_slots": {k: str(v) for k, v in prediction["slots"].items()},
            "gold_slots": {k: str(v) for k, v in gold_slots.items()},
            "slots_exact": {k: str(v).strip().lower() for k, v in prediction["slots"].items()}
            == {k: str(v).strip().lower() for k, v in gold_slots.items()},
            "passed": turn_score.passed,
            "detail": turn_score.detail,
        }
        if not turn_score.passed:
            record["bucket"] = bucket_for(
                prediction["operation"],
                prediction["slots"],
                gold_operation,
                gold_slots,
                resolution,
                prediction["clarify"],
                turn["expected"]["type"] == "no_action",
            )
        turns.append(record)
        previous_request = request
        previous_operation = gold_operation if oracle else prediction["operation"]
        if not turn_score.passed:
            break
    return {"score": score, "turns": turns}


def run(label: str, artifact: str, margin: float, oracle: bool, suite_name: str = "frozen") -> dict[str, Any]:
    suite, reference = suite_and_reference(suite_name)
    started = time.time()
    cases = []
    for case in suite["cases"]:
        cases.append(run_case(case, world.reset(), artifact, margin, oracle, reference))
    scores = [c["score"] for c in cases]
    scoring.print_report(scores)

    turns = [t for case in cases for t in case["turns"]]
    by_category: dict[str, dict[str, Any]] = {}
    for case, entry in zip(suite["cases"], cases):
        bucket = by_category.setdefault(case["category"], {"cases": 0, "passed": 0, "turns": 0, "op_correct": 0, "slots_exact": 0})
        bucket["cases"] += 1
        bucket["passed"] += int(entry["score"].passed)
        for turn in entry["turns"]:
            bucket["turns"] += 1
            bucket["op_correct"] += int(turn["operation_correct"])
            bucket["slots_exact"] += int(turn["slots_exact"])
    for bucket in by_category.values():
        bucket["outcome_accuracy"] = round(bucket["passed"] / bucket["cases"], 3)
        bucket["operation_accuracy"] = round(bucket["op_correct"] / bucket["turns"], 3)
        bucket["slot_accuracy"] = round(bucket["slots_exact"] / bucket["turns"], 3)

    errors = Counter(str(t["bucket"]) for t in turns if "bucket" in t)
    return {
        "lane": "joint",
        "kind": "end_to_end",
        "suite": suite_name,
        "artifact": artifact,
        "margin_threshold": margin,
        "previous_operation": "oracle" if oracle else "model",
        "wall_clock_seconds": round(time.time() - started, 1),
        "cases": len(scores),
        "cases_passed": sum(1 for s in scores if s.passed),
        "outcome_accuracy": round(sum(1 for s in scores if s.passed) / len(scores), 4),
        "turns_reached": len(turns),
        "operation_accuracy": round(sum(1 for t in turns if t["operation_correct"]) / len(turns), 4),
        "slot_accuracy": round(sum(1 for t in turns if t["slots_exact"]) / len(turns), 4),
        "by_category": by_category,
        "error_buckets": {name: errors.get(name, 0) for name in BUCKETS},
        "failures": [
            {k: t[k] for k in ("request", "predicted_operation", "gold_operation", "predicted_slots", "gold_slots", "bucket", "detail")}
            for t in turns
            if "bucket" in t
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True, help="Run label; never overwritten.")
    parser.add_argument("--artifact", default="j-01", help="Checkpoint under joint/artifacts/.")
    parser.add_argument("--margin", type=float, default=0.0)
    parser.add_argument("--oracle-previous", action="store_true")
    parser.add_argument("--suite", default="frozen", choices=("frozen", "blind"), help="Which suite to score.")
    args = parser.parse_args()

    runs = HERE / "runs"
    runs.mkdir(exist_ok=True)
    path = runs / f"{args.label}.json"
    if path.exists():
        raise SystemExit(f"run label {args.label!r} already exists at {path}")
    payload = run(args.label, args.artifact, args.margin, args.oracle_previous, args.suite)
    path.write_text(json.dumps(payload, indent=1) + "\n")
    print(json.dumps({k: payload[k] for k in ("outcome_accuracy", "operation_accuracy", "slot_accuracy", "error_buckets")}, indent=1))
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
