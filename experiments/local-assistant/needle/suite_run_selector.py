"""Run the frozen suite end to end: selector -> Needle -> executor -> scorer.

This is the *deployed* shape, not a ceiling. Nothing is oracle: the tools shown
to Needle for a turn come from `selector.predict.select`, and the
`previous_operation` feature is the selector's OWN prediction for the previous
turn, never the reference one. A turn whose top-two probability margin is at or
above `--margin` is shown the top operation alone; below it, the top three.
That is the policy RESULTS-selector.md recommends.

Because the tool list changes per turn, one Needle session cannot span a case:
the engine fixes its tool list at `needle_init`. A fresh session is built for
every turn and the case's prior user turns and tool results are replayed into
it, which is what a runtime with a per-turn tool set would have to do.

    .venv/bin/python needle/suite_run_selector.py --label needle-base-suite-selector
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "selector"))

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")

import needle as needle_pkg  # noqa: E402

import resolvers as R  # noqa: E402
import scoring  # noqa: E402
import world  # noqa: E402
from build_suite import load  # noqa: E402
from executor import Result, execute  # noqa: E402

sys.path.insert(0, HERE)
from filler import SYSTEM, load_catalogue, parse_envelope, tool_schema  # noqa: E402

import predict as selector  # noqa: E402


def shown_for(request: str, previous_request: str | None,
              previous_operation: str | None, margin: float,
              catalogue: dict, label: str) -> tuple[list[str], list[tuple[str, float]]]:
    _, ranked = selector.select(request, previous_request, previous_operation,
                                top_k=3, label=label)
    gap = ranked[0][1] - ranked[1][1] if len(ranked) > 1 else 1.0
    picked = [ranked[0][0]] if gap >= margin else [name for name, _ in ranked]
    # `none` and `clarify` are protocol outcomes, not tools: they are dropped
    # from the tool list, and a turn left with no tool is a withheld turn.
    picked = [name for name in picked if name in catalogue]
    return picked, ranked


def run_case(case: dict, conn, catalogue: dict, margin: float,
             max_new_tokens: int, artifact: str) -> tuple[scoring.CaseScore, list[dict]]:
    score = scoring.CaseScore(case_id=case["id"], category=case["category"])
    context = R.Context()
    trace: list[dict] = []
    history: list[tuple[str, str]] = []  # (kind, text) replayed into each session
    previous_request: str | None = None
    previous_operation: str | None = None

    for index, turn in enumerate(case["turns"]):
        request = turn["request"]
        shown, ranked = shown_for(request, previous_request, previous_operation,
                                  margin, catalogue, artifact)
        if not shown:
            raw = {"type": "respond", "function_calls": [], "suppressed_calls": [],
                   "reasoning": "selector returned no operation"}
            parsed = {"ok": False, "marker": "no_operation", "op": None,
                      "slots": None, "n_calls": 0}
        else:
            tools = [tool_schema(catalogue[name]) for name in shown]
            agent = needle_pkg.Needle(tools=tools, system=SYSTEM, auto_date=False)
            try:
                for _kind, text in history:
                    agent._complete(text, max_new_tokens, ground=False)
                raw = agent._complete(request, max_new_tokens, ground=False)
            finally:
                agent.close()
            parsed = parse_envelope(raw, shown)

        if parsed["op"] is None:
            result = Result("no_action", reason="refuse",
                            detail=parsed["marker"] or "no call")
        else:
            try:
                result = execute(parsed["op"], parsed["slots"] or {}, context, conn)
            except Exception as exc:  # executor rejects an impossible call
                result = Result("no_action", reason="refuse", detail=f"{exc}")
        context.last_request = request
        verdict = scoring.score_turn(index, turn["expected"], result, conn)
        score.turns.append(verdict)
        trace.append({
            "case": case["id"], "turn": index, "request": request,
            "shown": shown, "ranked": ranked, "raw": raw, "parsed": parsed,
            "result": {"kind": result.kind, "ids": result.ids,
                       "reason": result.reason, "detail": result.detail},
            "passed": verdict.passed, "detail": verdict.detail,
        })
        if not verdict.passed:
            break
        feedback = json.dumps({"ids": result.ids, "kind": result.kind})
        history.append(("user", request))
        history.append(("tool_result", feedback))
        previous_request = request
        previous_operation = parsed["op"]
    return score, trace


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--catalogue", default="catalogue.json")
    parser.add_argument("--artifact", default="lr-3b", help="selector artifact label")
    parser.add_argument("--margin", type=float, default=0.3)
    parser.add_argument("--weights", default=None, help="a tuned .cact")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--trace-dir", default="needle/runs")
    args = parser.parse_args()

    if args.weights:
        original = needle_pkg.Needle.__init__

        def patched(self, *a, **kw):
            kw.setdefault("weights", args.weights)
            return original(self, *a, **kw)

        needle_pkg.Needle.__init__ = patched

    catalogue = load_catalogue(args.catalogue)
    suite = load()
    started = time.time()
    scores, traces = [], []
    for case in suite["cases"]:
        score, trace = run_case(case, world.reset(), catalogue, args.margin,
                                args.max_new_tokens, args.artifact)
        scores.append(score)
        traces.extend(trace)
        print(f"  {'pass' if score.passed else 'FAIL'}  {score.case_id}  "
              f"{score.category}  {score.first_failure}")

    scoring.print_report(scores)
    path = scoring.write_report(args.label, f"needle-selector-m{args.margin}", scores)
    os.makedirs(args.trace_dir, exist_ok=True)
    with open(os.path.join(args.trace_dir, f"{args.label}.trace.jsonl"), "w") as sink:
        for row in traces:
            sink.write(json.dumps(row) + "\n")
    print(f"\n  report: {path}  ({time.time() - started:.0f}s)")


if __name__ == "__main__":
    main()
