"""Export the trained joint model to ONNX, and check it against torch.

    .venv-joint/bin/python joint/export_onnx.py --label j-01

Output, in ``joint/artifacts/<label>/onnx/``:

- ``joint.onnx`` — encoder + all three heads in one graph. Inputs
  ``input_ids``, ``attention_mask``, ``token_type_ids`` (int64), all with
  dynamic batch and sequence axes; outputs ``operation_logits`` [B, 47],
  ``tag_logits`` [B, T, |BIO|], ``enum_logits`` [B, |enum classes|].
- the tokenizer files (``tokenizer.json``, ``vocab.txt``, the special-token
  maps) with the 48 ``[PREVOP_*]`` tokens already added, and ``config.json``
  naming the label order of every head.

Opset 14, which is what ``onnxruntime``/Transformers.js in
``packages/model-runtime`` already run for the shipped models; the graph is a
plain BERT encoder plus three matmuls, so nothing exotic has to be supported.

The smoke test compares ONNX against torch on 20 real suite requests and
reports the largest absolute logit difference, then times 100 single-request
ONNX calls on CPU.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import model as M  # noqa: E402


def sample_rows(limit: int) -> list[dict]:
    path = HERE / "suite_joint.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return rows[:limit]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="j-01")
    parser.add_argument("--opset", type=int, default=14)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--timing-runs", type=int, default=100)
    args = parser.parse_args()

    import onnxruntime

    directory = HERE / "artifacts" / args.label
    out = directory / "onnx"
    out.mkdir(parents=True, exist_ok=True)

    tokenizer = M.build_tokenizer()
    net = M.JointModel(vocab_size=len(tokenizer))
    net.load_state_dict(torch.load(directory / "model.pt", map_location="cpu"))
    net.eval()

    rows = sample_rows(args.samples)
    encoded, _offsets, _mask = M.encode_rows(rows[:2], tokenizer, with_targets=False)
    inputs = (encoded["input_ids"], encoded["attention_mask"], encoded.get("token_type_ids"))
    names = ["input_ids", "attention_mask", "token_type_ids"]
    if inputs[2] is None:
        inputs = inputs[:2]
        names = names[:2]

    path = out / "joint.onnx"
    torch.onnx.export(
        net,
        inputs,
        str(path),
        input_names=names,
        output_names=["operation_logits", "tag_logits", "enum_logits"],
        dynamic_axes={
            **{name: {0: "batch", 1: "sequence"} for name in names},
            "operation_logits": {0: "batch"},
            "tag_logits": {0: "batch", 1: "sequence"},
            "enum_logits": {0: "batch"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
        dynamo=False,
    )
    tokenizer.save_pretrained(out)
    (out / "config.json").write_text(json.dumps(M.config_blob(), indent=1) + "\n")

    session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    encoded, _offsets, _mask = M.encode_rows(rows, tokenizer, with_targets=False)
    feed = {name: encoded[name].numpy() for name in names}
    onnx_out = session.run(None, feed)
    with torch.no_grad():
        torch_out = net(**{name: encoded[name] for name in names})
    deltas = [float(np.abs(a - b.numpy()).max()) for a, b in zip(onnx_out, torch_out)]

    single = {name: encoded[name][:1].numpy() for name in names}
    session.run(None, single)
    started = time.time()
    for _ in range(args.timing_runs):
        session.run(None, single)
    latency = (time.time() - started) / args.timing_runs * 1000

    torch_started = time.time()
    with torch.no_grad():
        for _ in range(args.timing_runs):
            net(**{name: encoded[name][:1] for name in names})
    torch_latency = (time.time() - torch_started) / args.timing_runs * 1000

    payload = {
        "label": args.label,
        "opset": args.opset,
        "onnx_bytes": path.stat().st_size,
        "onnx_megabytes": round(path.stat().st_size / 1e6, 1),
        "tokenizer_bytes": sum(p.stat().st_size for p in out.iterdir() if p.name != "joint.onnx"),
        "samples_checked": len(rows),
        "max_abs_difference": {
            "operation_logits": deltas[0],
            "tag_logits": deltas[1],
            "enum_logits": deltas[2],
        },
        "onnx_matches_torch": all(d < 1e-3 for d in deltas),
        "cpu_latency_ms_per_request_onnx": round(latency, 2),
        "cpu_latency_ms_per_request_torch": round(torch_latency, 2),
        "timing_runs": args.timing_runs,
        "threads": torch.get_num_threads(),
    }
    (directory / "onnx_metrics.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(json.dumps(payload, indent=1))
    if not payload["onnx_matches_torch"]:
        raise SystemExit("ONNX output does not match torch")


if __name__ == "__main__":
    main()
