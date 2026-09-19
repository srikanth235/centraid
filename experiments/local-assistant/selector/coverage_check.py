"""How often the right operation reaches the filler, not just the top-1 label.

The runtime shows the filler either the selected operation or --- when the
margin is low --- that operation plus its catalogue siblings. So the number
that bounds the pipeline is not top-1 accuracy but whether the gold operation
is inside the set the filler is shown. Three sets are measured on the suite and
the dev paraphrases, for the saved ``logreg:fields`` artifact:

- ``top1``            --- the selected operation alone.
- ``top1+siblings``   --- it plus the siblings the catalogue declares.
- ``top3``            --- the three highest-probability operations.

    .venv-selector/bin/python selector/coverage_check.py --label lr-01
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import common
import predict as predict_module

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="lr-01")
    args = parser.parse_args()

    bundle = predict_module.load(args.label)
    model = bundle["model"]
    operations = bundle["operations"]
    catalogue = json.loads((HERE.parent / "catalogue.json").read_text())
    siblings = {op["name"]: list(op.get("siblings", [])) for op in catalogue["operations"]}

    data = common.datasets()
    summary: dict[str, dict[str, float]] = {}
    for name in ("val", "dev_paraphrase", "suite"):
        rows = data[name]
        request = common.encode([str(r["request"]) for r in rows])
        previous = common.encode([str(r.get("previous_request") or "") for r in rows])
        indicator = np.zeros((len(rows), len(operations) + 1), dtype=np.float32)
        for position, row in enumerate(rows):
            previous_operation = row.get("previous_operation")
            index = operations.index(previous_operation) if previous_operation in operations else len(operations)
            indicator[position, index] = 1.0
        probabilities = model.predict_proba(np.hstack([request, previous, indicator]))
        order = np.argsort(-probabilities, axis=1)
        counts = {"top1": 0, "top1+siblings": 0, "top3": 0}
        for position, row in enumerate(rows):
            gold = str(row["label"])
            ranked = [str(model.classes_[i]) for i in order[position, :3]]
            counts["top1"] += gold == ranked[0]
            counts["top1+siblings"] += gold in {ranked[0], *siblings.get(ranked[0], [])}
            counts["top3"] += gold in ranked
        summary[name] = {key: round(value / len(rows), 3) for key, value in counts.items()}
        print(name, summary[name])

    (HERE / "coverage.json").write_text(json.dumps(summary, indent=1) + "\n")


if __name__ == "__main__":
    main()
