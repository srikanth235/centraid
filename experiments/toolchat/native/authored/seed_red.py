"""One-off: seed the gap report's red list from the failures of one past run on the old test sessions.

    HF_HUB_OFFLINE=1 $PY authored/seed_red.py [--report PATH] [--out authored/seed_red.json]

This is the single allowed peek at test: it reads eval/sets/test.jsonl and one past eval report
(`failed`, and `by_tag` as a cross-check), tags every test turn with gapreport's own tag code, and writes
per-tag pass rates plus the tags of each failed turn. It exists so that `gapreport.py --seed-red` can
say, before any val run exists, which covered tags the model already fails, and so that the report can
check itself: what share of those failed turns falls in a tag it marks red. Do not re-run it against a
newer report, and do not read the result to write sessions: it names tags, not messages, and val (a
run on eval/sets/val.jsonl) replaces it as soon as one exists.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import gapreport as g

DEFAULT_REPORT = ("/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad/"
                  "kgl-native/out/authored3/eval/free/report.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--out", default=str(g.HERE / "seed_red.json"))
    a = ap.parse_args()
    run = json.load(open(a.report))
    failed = {(f["id"], f["turn"]) for f in run["failed"]}
    test = g.load(str(g.EVAL / "sets" / "test.jsonl"))
    n_turns = sum(len(s["turns"]) for s in test)
    assert n_turns == run["turns"] and len(failed) == run["turns"] - run["turn_pass"], "report does not match test.jsonl"
    cache: dict = {}
    n, bad = Counter(), Counter()
    failed_tags: dict[str, list[str]] = {}
    for s in test:
        rows = g.world_rows(g.EVAL / "worlds" / f"{s['world']}.json", cache)
        for i, t in enumerate(s["turns"], 1):
            tags = g.derive_tags(t, i, rows, s)
            fail = (s["id"], i) in failed
            for tag in tags:
                n[tag] += 1
                bad[tag] += fail
            if fail:
                failed_tags[f"{s['id']}:{i}"] = sorted(tags)
    assert len(failed_tags) == len(failed)
    tags = {t: {"n": n[t], "failed": bad[t], "pass": 1 - bad[t] / n[t]} for t in sorted(n)}
    red = [t for t, v in tags.items() if g.is_red(v["n"], v["pass"])]
    out = {
        "provenance": (
            "Seeded once from the failures of one past run of the fine-tuned model on eval/sets/test.jsonl (the 450 old "
            f"hand-written sessions, {run['turns']} turns, {run['turn_pass']} passed): {a.report}, its `failed` list "
            "(by_tag cross-checked only). Turns re-tagged by authored/gapreport.py (analyse) over eval/worlds/*.json. "
            "This is the one allowed read of test for gap work; replace it with a val run (gapreport.py --run) as soon as "
            "one exists. In-sample by construction: the red list and the failures it is checked against come from the same run."
        ),
        "rule": f"red when pass < {g.RED_PASS} on >= {g.RED_MIN_TURNS} turns",
        "run": {k: run[k] for k in ("sessions", "session_pass", "turns", "turn_pass")},
        "tags": tags,
        "red": red,
        "failed_turns": failed_tags,
    }
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"{len(failed_tags)} failed of {n_turns} test turns; {len(tags)} tags; {len(red)} red (before the covered filter); wrote {a.out}")


if __name__ == "__main__":
    main()
