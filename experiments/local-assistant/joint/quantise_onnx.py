"""Dynamic int8 quantisation of the exported joint graph, and its evidence.

    .venv-joint/bin/python joint/quantise_onnx.py --label j-05

Reads ``joint/artifacts/<label>/onnx/joint.onnx`` and writes
``joint-int8.onnx`` beside it with ``onnxruntime.quantization.quantize_dynamic``
over ``MatMul`` and ``Gather`` — weight-only int8, activations left in float, no
calibration set needed. That is the same treatment the shipped
``whisper-tiny.en-q8`` assets in ``packages/model-runtime`` already get.

Reported: both graphs' size, mean CPU latency over ``--timing-runs`` single
requests, and the largest absolute logit difference between fp32 and int8 over
the suite requests. End-to-end outcome on the frozen suite is measured
separately by ``run_suite_joint.py --onnx …``, which routes prediction through
``joint/predict_onnx.py``.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import model as M  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="j-05")
    parser.add_argument("--timing-runs", type=int, default=100)
    args = parser.parse_args()

    import onnxruntime
    from onnxruntime.quantization import QuantType, quantize_dynamic

    out = HERE / "artifacts" / args.label / "onnx"
    source = out / "joint.onnx"
    if not source.exists():
        raise SystemExit(f"no fp32 graph at {source}; run joint/export_onnx.py --label {args.label}")
    target = out / "joint-int8.onnx"

    quantize_dynamic(
        model_input=str(source),
        model_output=str(target),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gather"],
        extra_options={"MatMulConstBOnly": True},
    )

    tokenizer = M.build_tokenizer()
    rows = [json.loads(line) for line in (HERE / "suite_joint.jsonl").read_text().splitlines() if line.strip()]
    encoded, _offsets, _mask = M.encode_rows(rows[:20], tokenizer, with_targets=False)
    names = [name for name in ("input_ids", "attention_mask", "token_type_ids") if name in encoded]
    feed = {name: encoded[name].numpy() for name in names}

    sessions = {
        "fp32": onnxruntime.InferenceSession(str(source), providers=["CPUExecutionProvider"]),
        "int8": onnxruntime.InferenceSession(str(target), providers=["CPUExecutionProvider"]),
    }
    outputs = {kind: session.run(None, feed) for kind, session in sessions.items()}
    deltas = [float(np.abs(a - b).max()) for a, b in zip(outputs["fp32"], outputs["int8"])]

    latency = {}
    single = {name: value[:1] for name, value in feed.items()}
    for kind, session in sessions.items():
        session.run(None, single)
        started = time.time()
        for _ in range(args.timing_runs):
            session.run(None, single)
        latency[kind] = round((time.time() - started) / args.timing_runs * 1000, 2)

    payload = {
        "label": args.label,
        "fp32_megabytes": round(source.stat().st_size / 1e6, 1),
        "int8_megabytes": round(target.stat().st_size / 1e6, 1),
        "shrink_factor": round(source.stat().st_size / target.stat().st_size, 2),
        "cpu_latency_ms_fp32": latency["fp32"],
        "cpu_latency_ms_int8": latency["int8"],
        "timing_runs": args.timing_runs,
        "max_abs_difference_vs_fp32": {
            "operation_logits": deltas[0],
            "tag_logits": deltas[1],
            "enum_logits": deltas[2],
        },
        "operation_argmax_agreement": float(
            (outputs["fp32"][0].argmax(-1) == outputs["int8"][0].argmax(-1)).mean()
        ),
        "tag_argmax_agreement": float((outputs["fp32"][1].argmax(-1) == outputs["int8"][1].argmax(-1)).mean()),
    }
    (HERE / "artifacts" / args.label / "int8_metrics.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(json.dumps(payload, indent=1))


if __name__ == "__main__":
    main()
