"""Derive the gold selector input/label for every turn of the frozen suite.

The selector's input is one JSON object per turn --- ``{request,
previous_request, previous_operation}`` --- and its label is the operation the
hand-written reference call uses for that turn (``reference.py``), which is
``none`` for the two out-of-vault refusals. ``previous_operation`` is the
reference operation of the preceding turn of the same case, ``null`` on turn 0.

This is the *test* set. Nothing here is ever trained on. The request text comes
from ``suite.json`` (the frozen file is the authority) and is cross-checked
against ``reference.py`` so a drift between the two fails loudly.

    python3 selector/suite_labels.py --write
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from reference import CASES  # noqa: E402

OUT = HERE / "suite_selector.jsonl"


def build() -> list[dict[str, object]]:
    suite = json.loads((ROOT / "suite.json").read_text())
    frozen = {c["id"]: c for c in suite["cases"]}
    rows: list[dict[str, object]] = []
    for case_id, category, turns in CASES:
        frozen_turns = frozen[case_id]["turns"]
        if len(frozen_turns) != len(turns):
            raise SystemExit(f"{case_id}: turn count drift against suite.json")
        prev_request: str | None = None
        prev_operation: str | None = None
        for index, (request, calls, _outcome, _ordered) in enumerate(turns):
            if frozen_turns[index]["request"] != request:
                raise SystemExit(f"{case_id} turn {index}: request drift against suite.json")
            if len(calls) != 1:
                raise SystemExit(f"{case_id} turn {index}: expected exactly one reference call")
            operation = calls[0][0]
            rows.append(
                {
                    "case_id": case_id,
                    "turn": index,
                    "category": category,
                    "request": request,
                    "previous_request": prev_request,
                    "previous_operation": prev_operation,
                    "label": operation,
                }
            )
            prev_request, prev_operation = request, operation
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    rows = build()
    print(f"{len(rows)} turns across {len({r['case_id'] for r in rows})} cases")
    labels = sorted({str(r["label"]) for r in rows})
    print(f"{len(labels)} distinct gold labels")
    if args.write:
        with OUT.open("w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
