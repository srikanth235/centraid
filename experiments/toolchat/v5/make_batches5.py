#!/usr/bin/env python3
"""selected5.jsonl -> batches/b5_NNN.json (Sonnet tasks, PROMPT_V5.md)."""
import datetime, json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
REG = ["terse", "question", "spoken", "texting", "polite"]
KSHOW = {"album_titles": "albums", "notebooks": "notebooks", "folder": "folder", "role": "role"}


def say(ref):
    m = ref["mode"]
    if m == "exact" or m == "span":
        return "exact: " + ref["kw"]
    if m == "loose":
        return "loose: " + ref["kw"]
    if m == "full":
        return "full"
    return None


def task(r, rng):
    d = datetime.date.fromisoformat(r["today"])
    t = {"id": r["id"], "today": "%s %s" % (d.strftime("%A"), r["today"]),
         "turns": [{"canonical": x["canon"], "move": x["move"], "hint": x["hint"]} for x in r["turns"]]}
    refer = []
    for ref in r["refs"]:
        s = say(ref)
        if s:
            refer.append({"row": '%s "%s"' % (KSHOW.get(ref["kind"], ref["kind"]), ref["label"]), "turn": ref["turn"] + 1, "say": s})
    if refer:
        t["refer"] = refer
    t["versions"] = r["nver"]
    t["registers"] = REG if r["nver"] == 5 else rng.sample(REG, 2)
    return t


def main():
    rng = random.Random(77)
    rows = [json.loads(l) for l in open(os.path.join(HERE, "selected5.jsonl"))]
    a = [r for r in rows if r["part"] == "a"]
    b = [r for r in rows if r["part"] == "b"]
    rng.shuffle(a)
    os.makedirs(os.path.join(HERE, "batches"), exist_ok=True)
    n = 0
    for grp, size in ((a, 15), (b, 24)):
        for i in range(0, len(grp), size):
            with open(os.path.join(HERE, "batches", "b5_%03d.json" % n), "w") as o:
                o.write("[\n" + ",\n".join(json.dumps(task(r, rng)) for r in grp[i:i + size]) + "\n]\n")
            n += 1
    print(n, "batches")


if __name__ == "__main__":
    main()
