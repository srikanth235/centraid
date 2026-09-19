"""The runtime prediction path, through onnxruntime instead of torch.

    from joint.predict_onnx import predict_many
    predict_many(rows, label="j-05", graph="int8")

Same signature and same output shape as :mod:`joint.predict_joint`, so
``run_suite_joint.py --onnx int8`` scores the quantised graph end to end —
predict → resolvers → executor → outcome — rather than only comparing logits.
Tokenization, BIO decoding, enum reading and the number coercion are the
torch path's, imported rather than copied, so a difference between the two
runs can only come from the graph.

``graph`` selects ``onnx/joint.onnx`` (fp32) or ``onnx/joint-int8.onnx``
(dynamic int8, written by ``joint/quantise_onnx.py``).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import model as M  # noqa: E402
import predict_joint as P  # noqa: E402

DEFAULT_GRAPH = "int8"
_SESSIONS: dict[tuple[str, str], Any] = {}


def load(label: str, graph: str = DEFAULT_GRAPH):  # noqa: ANN201
    key = (label, graph)
    if key not in _SESSIONS:
        import onnxruntime

        name = "joint.onnx" if graph == "fp32" else "joint-int8.onnx"
        path = HERE / "artifacts" / label / "onnx" / name
        if not path.exists():
            raise SystemExit(f"no graph at {path}; run joint/export_onnx.py and joint/quantise_onnx.py")
        session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        _SESSIONS[key] = (session, M.build_tokenizer())
    return _SESSIONS[key]


def predict_many(
    rows: list[dict],
    label: str = "j-05",
    margin_threshold: float = P.DEFAULT_MARGIN,
    graph: str = DEFAULT_GRAPH,
) -> list[dict]:
    session, tokenizer = load(label, graph)
    names = [i.name for i in session.get_inputs()]
    out: list[dict] = []
    for start in range(0, len(rows), 32):
        chunk = rows[start : start + 32]
        encoded, offsets, request_mask = M.encode_rows(chunk, tokenizer, with_targets=False)
        feed = {name: encoded[name].numpy() for name in names}
        operation_logits, tag_logits, enum_logits = session.run(None, feed)
        shifted = operation_logits - operation_logits.max(axis=-1, keepdims=True)
        probabilities = np.exp(shifted) / np.exp(shifted).sum(axis=-1, keepdims=True)
        order = np.argsort(-probabilities, axis=-1)
        tags = tag_logits.argmax(axis=-1)
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
                    slots[slot] = P._number(str(slots[slot]))
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
