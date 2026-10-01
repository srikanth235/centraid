#!/usr/bin/env python3
"""traj.jsonl -> batches8/b8_NNN.json (Opus paraphrase tasks, PROMPT_V8.md).

    python3 v8/make_batches8.py [--traj v8/traj.jsonl] [--out v8/batches8]
                                [--size 12] [--versions 2] [--limit N] [--seed 83]

Each task carries the session's `today`, and per turn its `hint`, its `say`
phrases and -- from the second turn on -- `shown`: what the assistant showed
at the end of the previous turn (the rows of its last result, handles
dropped), so a follow-up's pronouns fit what the person saw. Two versions per
session, in two different registers. --limit takes that many sessions spread
over the worlds (a development slice); a session already in a batch file of
--out is never batched twice.
"""
import argparse
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REG = ["terse", "texting", "spoken", "polite", "rambling"]


def world_of(r):
    return r.get("world") or (r["id"].split("-")[0] + ".json")


def shown_of(turn, max_lines=4):
    """the last non-empty observation of a turn, as the person saw it"""
    for st in reversed(turn["steps"]):
        obs = st["obs"].strip()
        if obs and not obs.startswith(("ok:", "ambiguous", "error")):
            lines = [re.sub(r"^#\d+ ", "", l) for l in obs.split("\n") if not l.startswith("  ")]
            more = len(lines) - max_lines
            return "\n".join(lines[:max_lines]) + ("\n(+%d more)" % more if more > 0 else "")
        if obs.startswith("ok:"):
            return "done: " + obs.split("\n")[0][4:]
        if obs.startswith("ambiguous"):
            return "(the assistant asked which one was meant)"
    return ""


def task(r, versions, rng):
    turns = []
    prev = None
    for t in r["turns"]:
        x = {"hint": t["hint"], "say": t["say"]}
        if prev is not None:
            x["shown"] = shown_of(prev)
        turns.append(x)
        prev = t
    return {"id": r["id"], "today": r["today"].replace("today: ", ""), "turns": turns,
            "versions": versions, "registers": rng.sample(REG, versions)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traj", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "batches8"))
    ap.add_argument("--size", type=int, default=12, help="sessions per batch")
    ap.add_argument("--versions", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0, help="only this many sessions, spread over worlds")
    ap.add_argument("--seed", type=int, default=83)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows = [json.loads(l) for l in open(a.traj, encoding="utf-8") if l.strip()]
    os.makedirs(a.out, exist_ok=True)
    done = set()
    existing = sorted(f for f in os.listdir(a.out) if re.match(r"b8_\d+\.json$", f))
    for f in existing:
        done |= {t["id"] for t in json.load(open(os.path.join(a.out, f)))}
    rows = [r for r in rows if r["id"] not in done]
    if a.limit:
        by_world = {}
        for r in rows:
            by_world.setdefault(world_of(r), []).append(r)
        for v in by_world.values():
            rng.shuffle(v)
        pick, i = [], 0
        while len(pick) < a.limit and any(i < len(v) for v in by_world.values()):
            pick += [v[i] for v in by_world.values() if i < len(v)]
            i += 1
        rows = pick[:a.limit]
    n0 = len(existing)
    n = 0
    for i in range(0, len(rows), a.size):
        tasks = [task(r, a.versions, rng) for r in rows[i:i + a.size]]
        with open(os.path.join(a.out, "b8_%03d.json" % (n0 + n)), "w", encoding="utf-8") as o:
            o.write("[\n" + ",\n".join(json.dumps(t, ensure_ascii=False) for t in tasks) + "\n]\n")
        n += 1
    print("%d batches (%d sessions) -> %s" % (n, len(rows), a.out))


if __name__ == "__main__":
    main()
