#!/usr/bin/env python3
"""Pick the canonical sessions to paraphrase (train + held-out) from canon_pool.jsonl
and write Sonnet batches (12 sessions per call) to batches/.

Held-out: sessions whose masked skeleton SEQUENCE is unique in the pool; no train
session (and no converted v3 one-turn session, see build_v4.py) shares it.
Train: idiom quotas first (QUOTA canonical sessions each, 2 variants -> >=30),
then the turn-count mix 30/25/20/13/12.
"""
import collections, datetime, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sessgen as S  # noqa: E402
sys.path.insert(0, os.path.join(HERE, "..", "v3"))
import gloss as GL  # noqa: E402

N_TRAIN, N_HELD, QUOTA, PER = 720, 84, 20, 12
MIX = {1: .30, 2: .25, 3: .20, 4: .13, 5: .12}


def bucket(n):
    return min(n, 5)


def main():
    rng = random.Random(77)
    pool = [json.loads(l) for l in open(os.path.join(HERE, "canon_pool.jsonl"))]
    rng.shuffle(pool)
    seqc = collections.Counter(tuple(r["skel"]) for r in pool)
    uniq = [r for r in pool if seqc[tuple(r["skel"])] == 1 and len(r["turns"]) >= 2]
    held = uniq[:N_HELD]
    hseq = {tuple(r["skel"]) for r in held}
    rest = [r for r in pool if tuple(r["skel"]) not in hseq]
    tags = lambda r: {t for x in r["turns"] for t in x["tags"]}
    moves = lambda r: {x["move"] for x in r["turns"]}
    want = {k: round(v * N_TRAIN) for k, v in MIX.items()}
    have = collections.Counter()
    ic = collections.Counter()
    train, used = [], set()
    keys = S.IDIOMS + ["c10", "c12", "c13", "c14", "rx2", "what_else", "value_sub", "undo", "refine", "and_name",
                       "switch", "mark_done", "restore", "delete_class", "value_follow"]
    for k in keys:
        for r in rest:
            if ic[k] >= QUOTA:
                break
            if id(r) in used or k not in tags(r) or have[bucket(len(r["turns"]))] >= want[bucket(len(r["turns"]))]:
                continue
            used.add(id(r))
            train.append(r)
            have[bucket(len(r["turns"]))] += 1
            ic.update(tags(r))
    for r in rest:
        b = bucket(len(r["turns"]))
        if id(r) in used or have[b] >= want[b]:
            continue
        # keep refuse share low
        if "refuse" in tags(r) and ic["refuse"] >= 40:
            continue
        used.add(id(r))
        train.append(r)
        have[b] += 1
        ic.update(tags(r))
    print("train", len(train), dict(have), "held", len(held), file=sys.stderr)
    print({k: ic[k] for k in keys}, file=sys.stderr)
    for i, r in enumerate(train):
        r["id"] = "g%04d" % i
        r["split"] = "train"
    for i, r in enumerate(held):
        r["id"] = "h%03d" % i
        r["split"] = "held"
    allr = train + held
    rng.shuffle(allr)
    with open(os.path.join(HERE, "selected.jsonl"), "w") as o:
        for r in allr:
            o.write(json.dumps(r) + "\n")
    os.makedirs(os.path.join(HERE, "batches"), exist_ok=True)
    regs = ["terse", "question", "spoken"]
    for bi in range(0, len(allr), PER):
        tasks = []
        for r in allr[bi:bi + PER]:
            d = datetime.date.fromisoformat(r["today"])
            turns = []
            for t in r["turns"]:
                try:
                    gl = GL.gloss(t["canon"])
                except Exception:  # noqa: BLE001
                    gl = ""
                turns.append({"canonical": t["canon"], "gloss": gl, "move": t["move"], "hint": t["note"]})
            rg = rng.sample(regs, 2)
            tasks.append({"id": r["id"], "today": "%s %s" % (d.strftime("%A"), r["today"]), "turns": turns,
                          "registers": rg})
        with open(os.path.join(HERE, "batches", "b%03d.json" % (bi // PER)), "w") as o:
            json.dump(tasks, o, indent=0)
    print("batches", (len(allr) + PER - 1) // PER, file=sys.stderr)


if __name__ == "__main__":
    main()
