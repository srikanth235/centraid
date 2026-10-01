#!/usr/bin/env python3
"""traj.jsonl -> batches/b7_NNN.json (Sonnet paraphrase tasks, PROMPT_V7.md)."""
import json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
REG = ["terse", "question", "spoken", "texting", "polite"]


def main(versions=3, size=15):
    rng = random.Random(79)
    rows = [json.loads(l) for l in open(os.path.join(HERE, "traj.jsonl"))]
    os.makedirs(os.path.join(HERE, "batches"), exist_ok=True)
    n = 0
    for i in range(0, len(rows), size):
        tasks = [{"id": r["id"], "today": r["today"].replace("today: ", ""),
                  "turns": [{"hint": t["hint"], "say": t["say"]} for t in r["turns"]],
                  "versions": versions, "registers": rng.sample(REG, versions)}
                 for r in rows[i:i + size]]
        with open(os.path.join(HERE, "batches", "b7_%03d.json" % n), "w") as o:
            o.write("[\n" + ",\n".join(json.dumps(t) for t in tasks) + "\n]\n")
        n += 1
    print(n, "batches")


if __name__ == "__main__":
    main()
