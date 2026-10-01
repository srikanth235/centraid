"""canon.jsonl / heldout_canon.jsonl -> batches/*.json (40 tasks each) for run.sh."""
import datetime, itertools, json, os, random
import gloss as G

HERE = os.path.dirname(os.path.abspath(__file__))
PERMS = list(itertools.permutations(["terse", "question", "spoken"]))


def task(r, i):
    t = {"id": r["id"], "today": "%s %s" % (datetime.date.fromisoformat(r["today"]).strftime("%A"), r["today"]),
         "prev": r["prev"]}
    if r["prev"] != "NONE":
        t["prev_gloss"] = G.gloss(r["prev"])
    t["target"] = r["target"]
    t["gloss"] = G.gloss(r["target"])
    if r.get("hint"):
        t["hint"] = r["hint"]
    t["registers"] = list(PERMS[i % len(PERMS)])
    return t


def main():
    os.makedirs(os.path.join(HERE, "batches"), exist_ok=True)
    rng = random.Random(3)
    for src, pre in (("canon.jsonl", "b"), ("heldout_canon.jsonl", "h")):
        rows = [json.loads(l) for l in open(os.path.join(HERE, src))]
        rng.shuffle(rows)
        tasks = [task(r, i) for i, r in enumerate(rows)]
        for j in range(0, len(tasks), 40):
            with open(os.path.join(HERE, "batches", "%s%02d.json" % (pre, j // 40)), "w") as fh:
                json.dump(tasks[j:j + 40], fh, indent=0, ensure_ascii=False)
        print(src, len(tasks), "tasks ->", (len(tasks) + 39) // 40, "batches")


if __name__ == "__main__":
    main()
