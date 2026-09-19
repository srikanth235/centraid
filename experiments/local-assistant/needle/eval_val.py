"""Evaluate held-out-TEMPLATE validation rows end to end (not by val loss).

Each row of `gen_train.py`'s val file is replayed through the engine exactly as
it was rendered for training: the same tools, the same turns, the prior tool
call and `<tool_result>` fed back. The verdict is on the emitted call, never on
loss, because a val loss over shared templates does not predict transfer.

    .venv/bin/python needle/eval_val.py --val needle/data/val512.jsonl \
        --label base-val [--weights needle/adapters/<l>/tuned.cact]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")

import needle as needle_pkg  # noqa: E402

SYSTEM = "date: 2026-09-19 Sat 09:00"


def turns_of(query: str) -> list[tuple[str, str]]:
    """Split a rendered multi-turn query back into ('user'|'result', text)."""
    out: list[tuple[str, str]] = []
    rest = query
    pattern = re.compile(
        r"^(?P<q>.*?)<\|im_end\|>\n<\|im_start\|>assistant\n<tool_call>.*?</tool_call>"
        r"<\|im_end\|>\n<\|im_start\|>user\n<tool_result>(?P<r>.*?)</tool_result>"
        r"<\|im_end\|>\n<\|im_start\|>user\n",
        re.S)
    while True:
        match = pattern.match(rest)
        if not match:
            break
        out.append(("user", match.group("q")))
        out.append(("result", match.group("r")))
        rest = rest[match.end():]
    out.append(("user", rest))
    return out


def norm(value):
    return " ".join(str(value).strip().lower().split())


def same(got: dict, want: dict) -> bool:
    got = {k: norm(v) for k, v in got.items() if v not in (None, "")}
    want = {k: norm(v) for k, v in want.items() if v not in (None, "")}
    return got == want


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--val", default="needle/data/val512.jsonl")
    parser.add_argument("--label", required=True)
    parser.add_argument("--weights", default=None)
    parser.add_argument("--runs-dir", default="needle/runs")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    args = parser.parse_args()

    out_dir = os.path.join(args.runs_dir, args.label)
    if os.path.exists(out_dir):
        raise SystemExit(f"run label already exists: {out_dir}")
    os.makedirs(out_dir)

    if args.weights:
        original = needle_pkg.Needle.__init__

        def patched(self, *a, **kw):
            kw.setdefault("weights", args.weights)
            return original(self, *a, **kw)

        needle_pkg.Needle.__init__ = patched

    rows = [json.loads(line) for line in open(args.val) if line.strip()]
    started = time.time()
    op_ok = slot_ok = abstain_ok = 0
    n_abstain = 0
    with open(os.path.join(out_dir, "rows.jsonl"), "w") as sink:
        for row in rows:
            agent = needle_pkg.Needle(tools=row["tools"], system=SYSTEM, auto_date=False)
            raw = None
            try:
                for role, text in turns_of(row["query"]):
                    raw = agent._complete(text, args.max_new_tokens, ground=False)
            finally:
                agent.close()
            calls = raw.get("function_calls") or []
            want = row["answers"]
            if not want:
                n_abstain += 1
                ok = not calls
                abstain_ok += ok
                verdict = {"op": ok, "slots": ok}
            else:
                got = calls[0] if calls else {}
                verdict = {"op": got.get("name") == want[0]["name"]}
                verdict["slots"] = verdict["op"] and same(got.get("arguments") or {},
                                                          want[0]["arguments"])
                op_ok += verdict["op"]
                slot_ok += verdict["slots"]
            sink.write(json.dumps({"template_id": row.get("template_id"),
                                   "raw": raw, "want": want, **verdict}) + "\n")

    n_call = len(rows) - n_abstain
    summary = {
        "label": args.label, "val": args.val, "weights": args.weights,
        "n": len(rows), "n_call_rows": n_call, "n_abstain_rows": n_abstain,
        "op_correct": round(op_ok / max(n_call, 1), 4),
        "slot_exact": round(slot_ok / max(n_call, 1), 4),
        "abstain_correct": round(abstain_ok / max(n_abstain, 1), 4),
        "seconds": round(time.time() - started, 1),
    }
    with open(os.path.join(out_dir, "summary.json"), "w") as sink:
        json.dump(summary, sink, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
