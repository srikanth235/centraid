"""Slot-filler harness around Needle 3.

Presents 1-4 operations from the Lane-1 catalogue to Needle, replays any prior
conversation turns (with tool-result feedback), sends the request, and returns
the RAW envelope plus a parsed (op, slots) or a malformed/withheld marker.

Raw output is always stored before parsing. Nothing is patched: a withheld call,
an empty function_calls list, an unknown tool name or a JSON failure is scored
as a failure.

CLI:
    .venv/bin/python needle/filler.py \
        --catalogue needle/catalogue.snapshot.json \
        --cases needle/dev_cases.jsonl \
        --shape single --label base-single
"""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")

import needle  # noqa: E402

SHAPES = ("single", "siblings")
SYSTEM = "date: 2026-09-19 Sat 09:00"


# ---------------------------------------------------------------- catalogue


def load_catalogue(path: str) -> dict[str, dict]:
    with open(path) as handle:
        data = json.load(handle)
    return {op["name"]: op for op in data["operations"]}


def tool_schema(op: dict) -> dict:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for slot, spec in op.get("params", {}).items():
        node: dict[str, Any] = {"type": spec.get("type", "string")}
        if spec.get("description"):
            node["description"] = spec["description"]
        if spec.get("enum"):
            node["enum"] = spec["enum"]
        properties[slot] = node
        if spec.get("required"):
            required.append(slot)
    return {
        "name": op["name"],
        "description": op["description"],
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


def tools_for(catalogue: dict[str, dict], op_names: list[str], shape: str) -> tuple[list[dict], list[str]]:
    """The tool list shown to Needle. `single` = exactly the listed ops;
    `siblings` = those ops plus each one's catalogue siblings, capped at 4."""
    names = list(op_names)
    if shape == "siblings":
        for name in op_names:
            for sib in catalogue[name].get("siblings", []):
                if sib not in names and sib in catalogue:
                    names.append(sib)
    names = names[:4]
    return [tool_schema(catalogue[name]) for name in names], names


# ---------------------------------------------------------------- parsing


def parse_envelope(raw: dict, shown: list[str]) -> dict:
    """Parse one raw envelope. Never patches; returns a marker on failure."""
    calls = raw.get("function_calls") or []
    if raw.get("type") != "call" or not calls:
        marker = "withheld" if raw.get("type") == "respond" else "malformed"
        if raw.get("suppressed_calls"):
            marker = "suppressed"
        return {"ok": False, "marker": marker, "op": None, "slots": None,
                "n_calls": len(calls)}
    call = calls[0]
    name = call.get("name")
    slots = call.get("arguments") or {}
    if name not in shown:
        return {"ok": False, "marker": "unknown_tool", "op": name, "slots": slots,
                "n_calls": len(calls)}
    return {"ok": True, "marker": None, "op": name, "slots": slots,
            "n_calls": len(calls)}


def norm(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.strip().lower().split())
    return value


def slots_exact(got: dict | None, want: dict) -> bool:
    if got is None:
        return False
    got = {k: norm(v) for k, v in got.items() if v is not None and v != ""}
    want = {k: norm(v) for k, v in want.items() if v is not None and v != ""}
    return got == want


# ---------------------------------------------------------------- running


def run_case(catalogue: dict[str, dict], case: dict, shape: str,
             max_new_tokens: int = 192) -> dict:
    """Replay a case. `case` is:
      {id, tag, show: [op names], context: [{request, results?}], request,
       expect: {op, slots}}
    `show` defaults to [expect.op] (the oracle-operation ceiling)."""
    show = case.get("show") or [case["expect"]["op"]]
    tools, shown = tools_for(catalogue, show, shape)
    agent = needle.Needle(tools=tools, system=SYSTEM, auto_date=False)
    turns: list[dict] = []
    started = time.time()
    try:
        for prior in case.get("context", []):
            turns.append({"role": "user", "text": prior["request"],
                          "raw": agent._complete(prior["request"], max_new_tokens,
                                                 ground=False)})
            if "results" in prior:
                payload = json.dumps(prior["results"])
                turns.append({"role": "tool_result", "text": payload,
                              "raw": agent._complete(payload, max_new_tokens,
                                                     ground=False)})
        raw = agent._complete(case["request"], max_new_tokens, ground=False)
    finally:
        agent.close()
    parsed = parse_envelope(raw, shown)
    expect = case["expect"]
    return {
        "id": case["id"],
        "tag": case.get("tag"),
        "shape": shape,
        "shown": shown,
        "request": case["request"],
        "context_turns": turns,
        "raw": raw,
        "parsed": parsed,
        "expect": expect,
        "op_correct": parsed["op"] == expect["op"],
        "slot_exact": parsed["op"] == expect["op"] and slots_exact(parsed["slots"],
                                                                  expect["slots"]),
        "seconds": round(time.time() - started, 3),
    }


def score(rows: list[dict]) -> dict:
    total = len(rows) or 1
    markers: dict[str, int] = {}
    for row in rows:
        marker = row["parsed"]["marker"]
        if marker:
            markers[marker] = markers.get(marker, 0) + 1
    return {
        "n": len(rows),
        "op_correct": sum(r["op_correct"] for r in rows) / total,
        "slot_exact": sum(r["slot_exact"] for r in rows) / total,
        "markers": markers,
        "seconds_total": round(sum(r["seconds"] for r in rows), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalogue", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--shape", choices=SHAPES, required=True)
    parser.add_argument("--label", required=True, help="run label; never overwritten")
    parser.add_argument("--runs-dir", default="needle/runs")
    parser.add_argument("--weights", default=None, help="tuned .cact (unused on base)")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    args = parser.parse_args()

    out_dir = os.path.join(args.runs_dir, args.label)
    if os.path.exists(out_dir):
        raise SystemExit(f"run label already exists: {out_dir} (labels are append-only)")
    os.makedirs(out_dir)

    if args.weights:
        _patch_weights(args.weights)

    catalogue = load_catalogue(args.catalogue)
    with open(args.cases) as handle:
        cases = [json.loads(line) for line in handle if line.strip()]

    rows = []
    with open(os.path.join(out_dir, "rows.jsonl"), "w") as sink:
        for case in cases:
            row = run_case(catalogue, case, args.shape, args.max_new_tokens)
            sink.write(json.dumps(row) + "\n")
            sink.flush()
            rows.append(row)
            flag = "ok " if row["slot_exact"] else ("op " if row["op_correct"] else "XX ")
            print(f"{flag}{row['id']:<12} {row['parsed']['op']}  {row['parsed']['slots']}")

    summary = score(rows)
    summary["label"] = args.label
    summary["shape"] = args.shape
    summary["cases"] = args.cases
    summary["weights"] = args.weights
    with open(os.path.join(out_dir, "summary.json"), "w") as sink:
        json.dump(summary, sink, indent=2)
    print(json.dumps(summary, indent=2))


def _patch_weights(path: str) -> None:
    """Make every Needle() in this process load tuned weights."""
    original = needle.Needle.__init__

    def patched(self, *a, **kw):
        kw.setdefault("weights", path)
        return original(self, *a, **kw)

    needle.Needle.__init__ = patched


if __name__ == "__main__":
    main()
