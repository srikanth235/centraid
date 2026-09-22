# -*- coding: utf-8 -*-
"""The NEGATIVE task pool: the four refusals and the withdrawal.

`train.jsonl` holds 19 declination skeletons against 2 700 read/write ones, so
the main pool carries under half a percent of them.  This builds a pool of its
own, sized so the declinations land near 6% of the corpus.

    python3 distill_neg_prep.py
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
REASONS = ["refuse : out_of_ontology", "refuse : sealed_egress",
           "refuse : fabricated_secret", "refuse : unbounded_destruction"]
TASKS_PER_REASON = 40
NOTHING_TASKS = 100
BATCH = 12


def main():
    pool = [json.loads(line) for line in
            open(os.path.join(HERE, "distill_tasks.jsonl"))]
    rng = random.Random(90210)
    # A withdrawal follows a WRITE: it is the write the member took back.
    writes = [task for task in pool
              if task["family"].split("|")[0] in ("cmd", "create", "seq")]
    rng.shuffle(writes)

    tasks = []
    for reason in REASONS:
        for index in range(TASKS_PER_REASON):
            tasks.append({"id": "neg_%s_%02d" % (reason.split(" : ")[1], index),
                          "prev": "NONE" if index % 4 else
                                  writes[index]["target"],
                          "target": reason,
                          "reason": reason,
                          "move": "new",
                          "family": "refuse|%s" % reason.split(" : ")[1],
                          "skel_id": "sk_neg_%s" % reason.split(" : ")[1]})
    for index in range(NOTHING_TASKS):
        tasks.append({"id": "neg_nothing_%02d" % index,
                      "prev": writes[100 + index]["target"],
                      "target": "nothing",
                      "reason": "nothing",
                      "move": "undo",
                      "family": "nothing|withdrawal",
                      "skel_id": "sk_neg_nothing"})

    with open(os.path.join(HERE, "distill_neg_tasks.jsonl"), "w") as handle:
        for task in tasks:
            handle.write(json.dumps(task) + "\n")

    batch_dir = os.path.join(HERE, "..", "distill", "neg_batches")
    os.makedirs(batch_dir, exist_ok=True)
    for old in os.listdir(batch_dir):
        os.remove(os.path.join(batch_dir, old))
    count = 0
    for start in range(0, len(tasks), BATCH):
        with open(os.path.join(batch_dir, "n%04d.json" % count), "w") as handle:
            json.dump(tasks[start:start + BATCH], handle, indent=1)
        count += 1
    print("negative tasks: %d in %d batches" % (len(tasks), count))


if __name__ == "__main__":
    main()
