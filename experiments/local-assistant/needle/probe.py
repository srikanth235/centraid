"""Minimal Needle 3 probe: load the engine, show one tool, print the RAW envelope.

Usage:
    .venv/bin/python needle/probe.py
    .venv/bin/python needle/probe.py --weights needle/adapters/<label>/tuned.cact

Needle 3 is NOT a transformers model (custom `needle` architecture, C engine via
ctypes). The only supported inference path is the `cactus-needle` package, which
fetches `libneedle.so` + `needle3.cact` into ~/.cache/cactus-needle on first use.
"""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")

import needle  # noqa: E402

TOOL = {
    "name": "tasks_due",
    "description": (
        "List tasks whose due date falls inside a date window, ordered by due date."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "window": {
                "type": "string",
                "description": "A date phrase: 'today', 'this week', '2026-10-02'.",
            },
            "project": {"type": "string", "description": "Restrict to one project."},
        },
        "required": ["window"],
    },
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default=None, help="a tuned .cact file")
    parser.add_argument("--prompt", default="what tasks are due this week")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    args = parser.parse_args()

    agent = needle.Needle(
        tools=[TOOL],
        system="date: 2026-09-19 Sat 09:00",
        weights=args.weights,
        auto_date=False,
    )
    raw = agent._complete(args.prompt, args.max_new_tokens, ground=False)
    print("=== RAW ENVELOPE ===")
    print(json.dumps(raw, indent=2))

    print("\n=== SECOND TURN (tool result fed back, then a follow-up) ===")
    results = [{"id": "t1", "title": "file taxes", "due": "2026-09-22"}]
    raw2 = agent._complete(json.dumps(results), args.max_new_tokens, ground=False)
    print(json.dumps(raw2, indent=2))
    raw3 = agent._complete("only the ones in the finance project", args.max_new_tokens, ground=False)
    print(json.dumps(raw3, indent=2))

    print("\n=== embed() dim ===")
    print(len(agent.embed("what tasks are due this week")))
    agent.close()


if __name__ == "__main__":
    main()
