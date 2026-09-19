"""The frozen suite as joint-model test rows: operation plus reference slots.

The label and the slot values come from the hand-written reference calls in
``reference.py``; the request text comes from ``suite.json``, which is the
authority, and a drift between the two fails loudly. This is the *test* set:
nothing here is ever trained on.

Reference slot values are split into span slots and enum slots by the
catalogue. ``verbatim`` records whether the reference value occurs literally in
the request — a span tagger can only emit the ones that do, and the 12 values
that do not are the canonical-rewrite cases the resolver lane is widening.

    python3 joint/suite_joint.py --write
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

import annotate as A  # noqa: E402
from reference import CASES  # noqa: E402

OUT = HERE / "suite_joint.jsonl"


def build() -> list[dict]:
    suite = json.loads((ROOT / "suite.json").read_text())
    frozen = {c["id"]: c for c in suite["cases"]}
    rows: list[dict] = []
    for case_id, category, turns in CASES:
        frozen_turns = frozen[case_id]["turns"]
        previous_request = previous_operation = None
        for index, (request, calls, _outcome, _ordered) in enumerate(turns):
            if frozen_turns[index]["request"] != request:
                raise SystemExit(f"{case_id} turn {index}: request drift against suite.json")
            operation, slots = calls[0]
            spans, enums = [], {}
            for name, value in slots.items():
                text = str(value)
                if name in A.ENUM_SLOTS:
                    enums[name] = text
                    continue
                start = request.lower().find(text.lower())
                spans.append(
                    {
                        "slot": name,
                        "text": text,
                        "start": start,
                        "end": start + len(text) if start >= 0 else -1,
                        "verbatim": start >= 0,
                    }
                )
            rows.append(
                {
                    "case_id": case_id,
                    "turn": index,
                    "category": category,
                    "kind": category,
                    "request": request,
                    "previous_request": previous_request,
                    "previous_operation": previous_operation,
                    "label": operation,
                    "spans": spans,
                    "enums": enums,
                }
            )
            previous_request, previous_operation = request, operation
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    rows = build()
    spans = [s for r in rows for s in r["spans"]]
    print(f"{len(rows)} turns, {len(spans)} span slots, {sum(1 for s in spans if s['verbatim'])} verbatim")
    print(f"{sum(len(r['enums']) for r in rows)} enum slot values")
    if args.write:
        with OUT.open("w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
