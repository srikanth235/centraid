# -*- coding: utf-8 -*-
"""Build the distillation TASK pool and the batch prompts.

One task is a (previous canonical, canonical) pair, re-instantiated over the
second world (`distill_world.py`).  The generator is asked for N diverse user
utterances that MEAN that canonical after that previous one; the row written
back is the same schema as `train.jsonl`.

    python3 distill_prep.py            # writes batches/ and tasks.jsonl
"""
import json
import os
import random
import re
import sys

import distill_world as W

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR = os.path.join(HERE, "..", "..", "..", "crates", "evalsuite", "grammar")
sys.path.insert(0, os.path.abspath(GRAMMAR))
import check  # noqa: E402

PER_SKELETON = 2
RARE_PER_SKELETON = 6
RARE = ("refuse", "nothing", "unparsed", "same", "seq", "seqref", "create",
        "balance", "outstanding", "onday", "due")
BATCH = 50
PARAPHRASES = 9


def main():
    rows = [json.loads(line) for line in open(os.path.join(HERE, "train.jsonl"))]
    rng = random.Random(4517)
    rng.shuffle(rows)

    by_skeleton = {}
    for row in rows:
        prev, utterance = row["input"].split(" ||| ", 1)
        head = row["family"].split("|")[0]
        cap = RARE_PER_SKELETON if head in RARE else PER_SKELETON
        bucket = by_skeleton.setdefault(row["skel_id"], [])
        if len(bucket) >= cap:
            continue
        if any(item["target"] == row["target"] and item["prev"] == prev
               for item in bucket):
            continue
        bucket.append({"prev": prev, "target": row["target"],
                       "move": row["move"], "family": row["family"],
                       "skel_id": row["skel_id"], "seed_utterance": utterance})

    tasks, dropped = [], 0
    for skeleton, bucket in sorted(by_skeleton.items()):
        for index, item in enumerate(bucket):
            prev = item["prev"] if item["prev"] == "NONE" \
                else W.reworld(item["prev"])
            target = W.reworld(item["target"])
            try:
                check.parse(target)
                if prev != "NONE":
                    check.parse(prev)
            except Exception:
                dropped += 1
                continue
            tasks.append({
                "id": "%s_%d" % (skeleton, index),
                "prev": prev,
                "target": target,
                "move": item["move"],
                "family": item["family"],
                "skel_id": skeleton,
            })

    rng.shuffle(tasks)
    out = os.path.join(HERE, "distill_tasks.jsonl")
    with open(out, "w") as handle:
        for task in tasks:
            handle.write(json.dumps(task) + "\n")

    batch_dir = os.path.join(HERE, "..", "distill", "batches")
    os.makedirs(batch_dir, exist_ok=True)
    for old in os.listdir(batch_dir):
        os.remove(os.path.join(batch_dir, old))
    count = 0
    for start in range(0, len(tasks), BATCH):
        chunk = tasks[start:start + BATCH]
        with open(os.path.join(batch_dir, "b%04d.json" % count), "w") as handle:
            json.dump(chunk, handle, indent=1)
        count += 1

    print("skeletons     : %d" % len(by_skeleton))
    print("tasks         : %d  (dropped after reworlding: %d)" % (len(tasks), dropped))
    print("batches       : %d of %d" % (count, BATCH))
    print("projected rows: %d" % (len(tasks) * PARAPHRASES))


if __name__ == "__main__":
    main()
