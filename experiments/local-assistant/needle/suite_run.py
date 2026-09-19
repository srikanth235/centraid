"""Run the frozen suite through Needle as the slot filler, scored by outcome.

Two ceiling conditions, both of them oracle on operation selection (the brief's
`oracle_operation` and `oracle_operation+siblings`): the tools shown for a turn
are taken from that turn's REFERENCE call sequence, so nothing here measures
retrieval — only whether Needle picks the right tool out of 1-4 and fills the
slots well enough for the resolvers to reach the right rows.

Needle emits ONE call per turn. A reference turn with several calls (the chain
category) therefore cannot pass on a single call; those cases are reported as
they fall, not patched.

    .venv/bin/python needle/suite_run.py --shape siblings --label base-suite-sib
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")

import needle as needle_pkg  # noqa: E402

import resolvers as R  # noqa: E402
import scoring  # noqa: E402
import world  # noqa: E402
from build_suite import load  # noqa: E402
from executor import Result, execute  # noqa: E402
from reference import REFERENCE  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filler import SYSTEM, load_catalogue, parse_envelope, tools_for  # noqa: E402


DECOYS = ["agenda_upcoming", "tasks_due", "notes_search"]


def run_case(case: dict, conn, catalogue: dict, shape: str,
             max_new_tokens: int) -> tuple[scoring.CaseScore, list[dict]]:
    score = scoring.CaseScore(case_id=case["id"], category=case["category"])
    context = R.Context()
    reference = REFERENCE[case["id"]]
    trace: list[dict] = []

    # One Needle session per case, so the model keeps its own conversation
    # state across turns exactly as the runtime would.
    shown_union: list[str] = []
    for turn_calls in reference:
        for operation, _ in turn_calls:
            if operation in catalogue and operation not in shown_union:
                shown_union.append(operation)
    if not shown_union:
        # A refusal case: "none"/"clarify" are protocol outcomes, never tools.
        # The deployed shape still shows the selector's best guesses, so show a
        # fixed decoy trio and score the turn on whether Needle withholds.
        shown_union = DECOYS
    tools, shown = tools_for(catalogue, shown_union, shape)
    agent = needle_pkg.Needle(tools=tools, system=SYSTEM, auto_date=False)

    try:
        for index, turn in enumerate(case["turns"]):
            raw = agent._complete(turn["request"], max_new_tokens, ground=False)
            parsed = parse_envelope(raw, shown)
            if parsed["op"] is None:
                # A withheld or malformed envelope is a no-action outcome.
                result = Result("no_action", reason="refuse",
                                detail=parsed["marker"] or "no call")
            else:
                try:
                    result = execute(parsed["op"], parsed["slots"] or {}, context, conn)
                except Exception as exc:  # executor rejects an impossible call
                    result = Result("no_action", reason="refuse", detail=f"{exc}")
            context.last_request = turn["request"]
            verdict = scoring.score_turn(index, turn["expected"], result, conn)
            score.turns.append(verdict)
            trace.append({
                "case": case["id"], "turn": index, "request": turn["request"],
                "shown": shown, "raw": raw, "parsed": parsed,
                "result": {"kind": result.kind, "ids": result.ids,
                           "reason": result.reason, "detail": result.detail},
                "passed": verdict.passed, "detail": verdict.detail,
            })
            if not verdict.passed:
                break
            # Feed the outcome back, as the runtime would.
            agent._complete(json.dumps({"ids": result.ids, "kind": result.kind}),
                            max_new_tokens, ground=False)
    finally:
        agent.close()
    return score, trace


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shape", choices=("single", "siblings"), required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--catalogue", default="catalogue.json")
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
        score, trace = run_case(case, world.reset(), catalogue, args.shape,
                                args.max_new_tokens)
        scores.append(score)
        traces.extend(trace)
        print(f"  {'pass' if score.passed else 'FAIL'}  {score.case_id}  "
              f"{score.category}  {score.first_failure}")

    scoring.print_report(scores)
    path = scoring.write_report(args.label, f"needle-{args.shape}", scores)
    os.makedirs(args.trace_dir, exist_ok=True)
    with open(os.path.join(args.trace_dir, f"{args.label}.trace.jsonl"), "w") as sink:
        for row in traces:
            sink.write(json.dumps(row) + "\n")
    print(f"\n  report: {path}  ({time.time() - started:.0f}s)")


if __name__ == "__main__":
    main()
