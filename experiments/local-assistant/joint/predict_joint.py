"""Runtime entry point for the joint model.

    from joint.predict_joint import predict
    predict("mark the first one done", "what's due today", "tasks_due")
    # -> {"operation": "tasks_complete", "top3": [...], "margin": 0.71,
    #     "slots": {"task": "the first one"}, "clarify": False}

Slot values come back as substrings of the *original* request, case and all,
because that is what the resolvers read. Enum slots come back as their
catalogue value. A top-1/top-2 probability margin below ``--margin`` (default
from the calibration in RESULTS-joint.md) is reported as ``clarify``: the
runtime's "show the operation and its siblings" path.

Artifacts are gitignored; rebuild with ``joint/train_joint.py``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import model as M  # noqa: E402

DEFAULT_LABEL = "j-01"
DEFAULT_MARGIN = 0.0
_LOADED: dict[str, Any] = {}


def load(label: str = DEFAULT_LABEL):  # noqa: ANN201
    if label not in _LOADED:
        directory = HERE / "artifacts" / label
        if not (directory / "model.pt").exists():
            raise SystemExit(f"no checkpoint at {directory}; train one first (joint/train_joint.py)")
        tokenizer = M.build_tokenizer()
        net = M.JointModel(vocab_size=len(tokenizer))
        net.load_state_dict(torch.load(directory / "model.pt", map_location="cpu"))
        net.eval()
        _LOADED[label] = (net, tokenizer)
    return _LOADED[label]


def predict(
    request: str,
    previous_request: str | None = None,
    previous_operation: str | None = None,
    label: str = DEFAULT_LABEL,
    margin_threshold: float = DEFAULT_MARGIN,
) -> dict[str, Any]:
    """One turn in, one decision out."""
    return predict_many(
        [{"request": request, "previous_request": previous_request, "previous_operation": previous_operation}],
        label=label,
        margin_threshold=margin_threshold,
    )[0]


def predict_many(rows: list[dict], label: str = DEFAULT_LABEL, margin_threshold: float = DEFAULT_MARGIN) -> list[dict]:
    """Batched form of :func:`predict`."""
    net, tokenizer = load(label)
    out: list[dict] = []
    with torch.no_grad():
        for start in range(0, len(rows), 32):
            chunk = rows[start : start + 32]
            encoded, offsets, request_mask = M.encode_rows(chunk, tokenizer, with_targets=False)
            operation_logits, tag_logits, enum_logits = net(**encoded)
            probabilities = torch.softmax(operation_logits, dim=-1)
            order = torch.argsort(probabilities, dim=-1, descending=True)
            tags = tag_logits.argmax(dim=-1)
            for index, row in enumerate(chunk):
                request = str(row["request"])
                positions = [i for i in range(request_mask.shape[1]) if bool(request_mask[index, i])]
                spans = M.decode_spans(request, tags[index].tolist(), offsets[index].tolist(), positions)
                top = [(M.LABELS[int(i)], round(float(probabilities[index, int(i)]), 4)) for i in order[index, :3]]
                operation = top[0][0]
                declared = M.A.PARAMS.get(operation, {})
                slots = {name: value for name, value in spans.items() if name in declared}
                for slot in M.ENUM_SLOTS:
                    if slot not in declared:
                        continue
                    begin, finish = M.ENUM_OFFSETS[slot]
                    choice = int(enum_logits[index, begin:finish].argmax())
                    values = M.ENUM_VALUES[slot]
                    if choice < len(values) and values[choice] in declared[slot].get("enum", values):
                        slots[slot] = values[choice]
                for slot in list(slots):
                    if slot in M.A.NUMBER_SLOTS:
                        slots[slot] = _number(str(slots[slot]))
                gap = top[0][1] - top[1][1]
                out.append(
                    {
                        "operation": operation,
                        "top3": top,
                        "margin": round(gap, 4),
                        "slots": slots,
                        "clarify": gap < margin_threshold,
                    }
                )
    return out


def _number(text: str) -> float | str:
    cleaned = text.replace(",", "").replace("£", "").replace("$", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default=DEFAULT_LABEL)
    parser.add_argument("--margin", type=float, default=DEFAULT_MARGIN)
    args = parser.parse_args()
    for case in (
        ("whats due by friday", None, None),
        ("mark the first one done", "whats due by friday", "tasks_due"),
        ("only the ones with Hana", "open up Kerala", "photos_in_album"),
        ("book me a flight to Oslo", None, None),
    ):
        answer = predict(*case, label=args.label, margin_threshold=args.margin)
        print(f"{case[0]!r} (after {case[2]}) -> {json.dumps(answer)}")
