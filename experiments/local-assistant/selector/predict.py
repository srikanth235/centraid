"""Runtime entry point for the selector: ``select(...) -> (label, top_k)``.

Loads the best trained variant --- logistic regression over frozen MiniLM
embeddings with the ``fields`` feature layout (embedding of the request,
embedding of the previous request, one-hot of the previous operation) --- from
``selector/artifacts/<label>/logreg_fields.pkl``.

Artifacts are not committed (the repository ignores ``artifacts``). Rebuild in
about a minute:

    python3 selector/gen_selector_data.py --write --per-template 22
    python3 selector/suite_labels.py --write
    .venv-selector/bin/python selector/run_trained.py --label <new> --save-artifact

``margin`` is the gap between the top two probabilities. The runtime shows the
filler the single operation above the calibrated threshold and the operation
plus its catalogue siblings below it; see RESULTS-selector.md for the sweep.

    from selector.predict import select
    select("only the ones with Hana", "open up Kerala", "photos_in_album")
"""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any

import numpy as np

import common

HERE = Path(__file__).resolve().parent
DEFAULT_LABEL = "lr-01"
_LOADED: dict[str, Any] = {}


def load(label: str = DEFAULT_LABEL) -> dict[str, Any]:
    if label not in _LOADED:
        path = HERE / "artifacts" / label / "logreg_fields.pkl"
        if not path.exists():
            raise SystemExit(f"no artifact at {path}; rebuild it (see this module's docstring)")
        with path.open("rb") as handle:
            _LOADED[label] = pickle.load(handle)
    return _LOADED[label]


def select(
    request: str,
    previous_request: str | None = None,
    previous_operation: str | None = None,
    top_k: int = 3,
    label: str = DEFAULT_LABEL,
) -> tuple[str, list[tuple[str, float]]]:
    bundle = load(label)
    model = bundle["model"]
    operations = bundle["operations"]
    row = {"request": request, "previous_request": previous_request, "previous_operation": previous_operation}
    request_vector = common.encode([request])
    previous_vector = common.encode([previous_request or ""])
    indicator = np.zeros((1, len(operations) + 1), dtype=np.float32)
    position = operations.index(previous_operation) if previous_operation in operations else len(operations)
    indicator[0, position] = 1.0
    probabilities = model.predict_proba(np.hstack([request_vector, previous_vector, indicator]))[0]
    order = np.argsort(-probabilities)[:top_k]
    ranked = [(str(model.classes_[i]), round(float(probabilities[i]), 4)) for i in order]
    _ = row
    return ranked[0][0], ranked


if __name__ == "__main__":
    for case in (
        ("whats due by friday", None, None),
        ("only the ones with Hana", "open up Kerala", "photos_in_album"),
        ("only the ones with Hana", "who's turning up to the launch party", "people_at"),
        ("book me a flight to Oslo", None, None),
    ):
        best, ranked = select(*case)
        print(f"{case[0]!r} (after {case[2]}) -> {best}  {ranked}")
