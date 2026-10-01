"""Show what the model sees: replay authored sessions and print each transcript -- pre-grounding,
every call with its derived `<think>` line, and every runtime observation (`#n`, `@n`, errors) --
with the score's verdict per turn. For drafting and debugging sessions before build.py.

    python3 authored/show.py T01 T01-017[,T01-018]      # the world must be seeded (build.py does it)
    python3 authored/show.py T01 T01-017 --seed         # seed it first
"""
from __future__ import annotations

import argparse
import sys

import build  # sets EVAL_WORLDS / EVAL_VAULTS and sys.path, as build.py runs them
import run
import score


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("world")
    ap.add_argument("ids", help="comma list of session ids")
    ap.add_argument("--seed", action="store_true")
    a = ap.parse_args()
    if a.seed:
        build.seed(a.world)
    want = a.ids.split(",")
    sessions = {s["id"]: s for s in build.load_sessions(a.world)}
    missing = [i for i in want if i not in sessions]
    if missing:
        sys.exit(f"no such session: {', '.join(missing)}")
    for sid in want:
        s = sessions[sid]
        b = build.ThinkRef()
        rec = run.run_session(s, b)
        verdict = score.score([rec], [s])["sessions"][0]
        print(f"===== {sid} ({s['today']}, me {s['me']})")
        for m in b.transcript.messages:
            tag = {"user": "USER", "assistant": "MODEL", "tool": "RUNTIME"}.get(m["role"], m["role"])
            print(f"[{tag}]\n{m['content']}\n")
        for i, t in enumerate(verdict["turns"]):
            print(f"-- turn {i + 1}: {'pass' if t['pass'] else 'FAIL ' + '; '.join(map(str, t['problems']))}")
        print()


if __name__ == "__main__":
    main()
