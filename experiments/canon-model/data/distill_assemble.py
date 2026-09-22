# -*- coding: utf-8 -*-
"""Join the generated paraphrases back onto their canonicals and write
`distill.jsonl` / `distill_val.jsonl`.

Every kept row is checked:

* the canonical PARSES against `crates/evalsuite/grammar/check.py`;
* the utterance is English and not the dialect (no braces, no `that (`, no
  command name, no `|||`);
* every CONTENT-BEARING write argument appears in the utterance (DEFECTS #35);
* the (input, target) pair is unique across the corpus.

The split is by SKELETON: a skeleton is wholly in train or wholly in val, so a
validation row never shares a shape with a training row.

    python3 distill_assemble.py            # rewrites both files atomically
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(
    os.path.join(HERE, "..", "..", "..", "crates", "evalsuite", "grammar")))
import check  # noqa: E402

OUT = [os.path.join(HERE, "..", "distill", "out"),
       os.path.join(HERE, "..", "distill", "neg_out")]
TASK_FILES = [os.path.join(HERE, "distill_tasks.jsonl"),
              os.path.join(HERE, "distill_neg_tasks.jsonl")]
VAL_SHARE = 0.05

CONTENT_ARGS = ("title", "description", "summary", "label", "reason", "name",
                "memo", "note", "body")
# "show me my photos" is how people talk; `show photos that (…)` is the
# dialect.  Only the SYNTAX is disqualifying — braces, a parenthesised clause,
# the row separator, or a typed command name said out loud.
DIALECT = re.compile(r"\|\|\||[{}]|that \(|\bof \(|\b[a-z_]+\.[a-z_]{4,}\b",
                     re.IGNORECASE)
ARG = re.compile(r'(\w+)\s*:\s*"([^"]*)"')
CMD = re.compile(r"^[a-z_]+\.[a-z_]+\{")


def normalise(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def write_args_present(target, utterance):
    """DEFECTS #35, on the training side: a content-bearing write argument the
    request does not contain is a row that teaches fabrication."""
    flat = normalise(utterance)
    for chunk in target.split("{")[1:]:
        for name, value in ARG.findall(chunk.split("}")[0]):
            if name in CONTENT_ARGS and normalise(value) not in flat:
                return False
    return True


def main():
    tasks = {}
    for path in TASK_FILES:
        if not os.path.exists(path):
            continue
        for line in open(path):
            task = json.loads(line)
            tasks[task["id"]] = task

    parsed_ok, generated, kept = {}, 0, []
    stats = {"unknown_id": 0, "parse_failed": 0, "dialect": 0,
             "write_arg": 0, "too_short": 0, "duplicate": 0}
    seen = set()

    for directory in OUT:
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".jsonl"):
                continue
            for line in open(os.path.join(directory, name)):
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                task = tasks.get(row.get("id"))
                if task is None:
                    stats["unknown_id"] += 1
                    continue
                # `train.jsonl` spells a declination `refuse: reason`; the
                # grammar admits `refuse : reason` too, and two spellings of
                # one target is a thing for the model to get wrong.
                target = task["target"].replace("refuse : ", "refuse: ")
                if target not in parsed_ok:
                    try:
                        check.parse(target)
                        parsed_ok[target] = True
                    except Exception:
                        parsed_ok[target] = False
                if not parsed_ok[target]:
                    stats["parse_failed"] += len(row.get("u", ()))
                    continue
                for utterance in row.get("u", ()):
                    generated += 1
                    utterance = (utterance or "").strip()
                    if len(utterance) < 3 or len(utterance) > 300:
                        stats["too_short"] += 1
                        continue
                    if DIALECT.search(utterance):
                        stats["dialect"] += 1
                        continue
                    if CMD.match(target) and not write_args_present(
                            target, utterance):
                        stats["write_arg"] += 1
                        continue
                    key = (normalise(utterance), target)
                    if key in seen:
                        stats["duplicate"] += 1
                        continue
                    seen.add(key)
                    kept.append({
                        "input": "%s ||| %s" % (task["prev"], utterance),
                        "target": target,
                        "template_id": "d_%s" % row["id"],
                        "move": task["move"],
                        "register": "distilled",
                        "family": task["family"],
                        "skel_id": task["skel_id"],
                    })

    # --- split by skeleton --------------------------------------------------
    skeletons = sorted({item["skel_id"] for item in kept})
    held = {name for index, name in enumerate(skeletons)
            if index % int(1 / VAL_SHARE) == 0}
    # the declinations are one target each, not a shape to generalise to
    held -= {name for name in skeletons if name.startswith("sk_neg")}
    train = [item for item in kept if item["skel_id"] not in held]
    val = [item for item in kept if item["skel_id"] in held]

    for name, items in (("distill.jsonl", train), ("distill_val.jsonl", val)):
        path = os.path.join(HERE, name)
        with open(path + ".tmp", "w") as handle:
            for item in items:
                handle.write(json.dumps(item) + "\n")
        os.replace(path + ".tmp", path)

    print("generated       : %d" % generated)
    for key in sorted(stats):
        print("  dropped %-13s : %d" % (key, stats[key]))
    print("kept            : %d  (train %d, val %d)"
          % (len(kept), len(train), len(val)))
    print("skeletons       : %d (val holds %d)" % (len(skeletons), len(held)))
    return len(kept)


if __name__ == "__main__":
    main()
