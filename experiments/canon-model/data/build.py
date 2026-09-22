# -*- coding: utf-8 -*-
"""Instantiate, balance, split and write train.jsonl / val.jsonl.

A row is  {input: "<prev canonical or NONE> ||| <utterance>",
           target: "<canonical>", template_id, move, register}.

The split is by SKELETON FAMILY: whole families are held out, so no validation
row shares a template with a training row.

    python3 build.py
"""
import json
import os
import random
import re

import handwritten as HW
import literals as L

HERE = os.path.dirname(os.path.abspath(__file__))
SLOT = re.compile(r"\{([A-Z0-9]+)\}")

MAX_ROWS_PER_SKELETON = 10
TARGET_FOLLOWUP = 0.43
VAL_FAMILY_SHARE = 0.15

MONTHDAYS = ["01-09", "02-23", "03-14", "04-02", "05-30", "07-18",
             "08-07", "09-25", "10-11", "11-29", "12-06"]
USERNAMES = ["o.vasquez", "p.blount", "kaz.t", "ingrid.s", "b.okiro",
             "lucienne", "teo.m", "rhoswen.p"]
CHANNELS = ["07700 900412", "07700 900318", "hello@example.invalid",
            "14 Skerrit Row"]
ACTIVITIES = ["call", "visit", "message", "coffee"]
DATELABELS = ["anniversary", "name day", "moving-in day", "graduation",
              "first met"]
REASONS = ["train fare", "ferry ticket", "shared grit", "spare key cutting",
           "boat shed levy"]


def money(minor):
    return "£%d.%02d" % (minor // 100, minor % 100)


def ordinal(day):
    if 10 < day < 20:
        return "%dth" % day
    return "%d%s" % (day, {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th"))


def spoken_date(value, rng):
    day = int(value[8:10])
    month = ["January", "February", "March", "April", "May", "June", "July",
             "August", "September", "October", "November",
             "December"][int(value[5:7]) - 1]
    weekday = {v: k for k, v in L.WEEKDAYS.items()}.get(value)
    options = ["the %s of %s" % (ordinal(day), month),
               "%s the %s" % (month, ordinal(day)), value]
    if weekday:
        options += [weekday, "on %s" % weekday]
    return rng.choice(options)


def draw(rng):
    """One literal assignment: the canonical form and the spoken form."""
    person = rng.choice(L.PEOPLE)
    date = rng.choice(L.DATES)
    datetime_value = rng.choice(L.DATETIMES)
    amount = rng.choice(L.AMOUNTS_MINOR)
    small = rng.choice([2, 3, 4])
    num = rng.choice([10, 20, 30, 45, 60, 90, 120])
    effort = rng.choice(L.EFFORTS)
    cadence = rng.choice(L.CADENCES)
    duration = rng.choice(L.DURATIONS)
    month = rng.choice(L.MONTHS)
    span = rng.choice(L.RANGES)
    pairs = {
        "PERSON": (person, rng.choice([person, person.split()[0]])),
        "PLACE": (rng.choice(L.PLACES),) * 2,
        "GROUP": (rng.choice(L.GROUPS + L.TRIPS),) * 2,
        "TASK": (rng.choice(L.TASK_TITLES),) * 2,
        "EVENT": (rng.choice(L.EVENT_TITLES),) * 2,
        "EVENT1": ("check-in", "check-in"),
        "EVENT2": ("check-out", "check-out"),
        "NOTE": (rng.choice(L.NOTE_TITLES),) * 2,
        "DOC": (rng.choice(L.DOC_TITLES),) * 2,
        "PHOTO": (rng.choice(L.PHOTO_TITLES),) * 2,
        "ALBUM": (rng.choice(L.ALBUM_TITLES),) * 2,
        "EXPENSE": (rng.choice(["Grit for the path", "Ferry crossing",
                                "New kettle element", "Boat shed levy",
                                "Seed potatoes", "Rota printing"]),) * 2,
        "LOCKER": (rng.choice(L.LOCKER_TITLES),) * 2,
        "DATELABEL": (rng.choice(DATELABELS),) * 2,
        "CHANNEL": (rng.choice(CHANNELS),) * 2,
        "ACTIVITY": (rng.choice(ACTIVITIES),) * 2,
        "REASON": (rng.choice(REASONS),) * 2,
        "FOLDER": (rng.choice(L.FOLDERS),) * 2,
        "NOTEBOOK": (rng.choice(L.NOTEBOOKS),) * 2,
        "CATEGORY": (rng.choice(L.CATEGORIES),) * 2,
        "USERNAME": (rng.choice(USERNAMES),) * 2,
        "MONTHDAY": (rng.choice(MONTHDAYS),) * 2,
        "DATE": (date, spoken_date(date, rng)),
        "DATETIME": (datetime_value,
                     "%s at %s" % (spoken_date(datetime_value[:10], rng),
                                   datetime_value[11:])),
        "MONTH": (month, rng.choice([month, "%s 2026" % ["January", "February",
                  "March", "April", "May", "June", "July", "August",
                  "September", "October", "November",
                  "December"][int(month[5:7]) - 1]])),
        "RANGE": (span, "%s and %s" % (spoken_date(span[:10], rng),
                                       spoken_date(span[12:], rng))),
        "NUM": (str(num), str(num)),
        "SMALL": (str(small), rng.choice([str(small),
                  ["one", "two", "three", "four"][small - 1]])),
        "AMOUNT": (str(amount), money(amount)),
        "EFFORT": (str(effort), rng.choice([str(effort), "%d" % effort])),
        "CADENCE": (str(cadence), str(cadence)),
        "DURATION": (duration, {"+1d": "a day", "+2d": "two days",
                                "+1h": "an hour", "-1h": "an hour earlier",
                                "+30m": "half an hour",
                                "+7d": "a week"}[duration]),
    }
    return pairs


def fill(text, pairs, side):
    index = 0 if side == "canonical" else 1
    return SLOT.sub(lambda m: pairs[m.group(1)][index] if m.group(1) in pairs
                    else m.group(0), text)


def main():
    rows = [json.loads(line) for line in
            open(os.path.join(HERE, "sessions.jsonl"))]
    rng = random.Random(2026)

    # ---- balance: cap per skeleton, and hold the follow-up share near 40% --
    per_skeleton = {}
    kept = []
    rng.shuffle(rows)
    for row in rows:
        # The declinations are ONE skeleton each with many surfaces; capping
        # them like a read would leave the honest refusal under-taught.
        cap = 30 if row["turn"] in ("refuse", "nothing", "unparsed") \
            else MAX_ROWS_PER_SKELETON
        if row.get("deep"):
            # A depth-4 Set said in one breath: kept as a minority reading, not
            # as the corpus's idea of how such a read arrives.  The chains
            # above carry that meaning turn by turn.
            cap = 2
        bucket = per_skeleton.setdefault(row["skel_id"], 0)
        if bucket >= cap:
            continue
        per_skeleton[row["skel_id"]] = bucket + 1
        kept.append(row)
    follow = [r for r in kept if r["prev_mode"] != "none"]
    fresh = [r for r in kept if r["prev_mode"] == "none"]
    want_follow = int(len(fresh) * TARGET_FOLLOWUP / (1 - TARGET_FOLLOWUP))
    rng.shuffle(follow)
    # keep every undo and every substitute; they are the scarce moves
    scarce = [r for r in follow if r["move"] in ("undo", "substitute")]
    rest = [r for r in follow if r["move"] not in ("undo", "substitute")]
    kept = fresh + scarce + rest[:max(0, want_follow - len(scarce))]
    rng.shuffle(kept)

    # ---- split by FAMILY ---------------------------------------------------
    families = sorted({r["family"] for r in kept})
    rng.shuffle(families)
    held = set(families[:int(len(families) * VAL_FAMILY_SHARE)])
    # The declinations are one target each, not a shape to generalise to;
    # holding one out would simply delete it from training.
    held -= {f for f in held
             if f.split("|")[0] in ("unparsed", "refuse", "nothing")}

    train, val = [], []
    for row in kept:
        pairs = draw(random.Random(row["template_id"]))
        utterance = fill(row["utterance"], pairs, "spoken")
        canonical = fill(row["canonical"], pairs, "canonical")
        if row["prev_mode"] == "none":
            prev = "NONE"
        elif row["prev_mode"] == "same_skeleton":
            other = draw(random.Random(row["template_id"] + "_prev"))
            prev = fill(row["prev_canonical"], other, "canonical")
        else:
            prev = fill(row["prev_canonical"],
                        draw(random.Random(row["template_id"] + "_p")), "canonical")
        item = {
            "input": "%s ||| %s" % (prev, utterance),
            "target": canonical,
            "template_id": row["template_id"],
            "move": row["move"],
            "register": row["register"],
            "family": row["family"],
            "skel_id": row["skel_id"],
        }
        if row["move"] == "substitute" and prev == canonical:
            continue     # nothing was substituted; the turn is not a move
        (val if row["family"] in held else train).append(item)

    # ---- dedupe on (input, target) ----------------------------------------
    def dedupe(items):
        seen, out = set(), []
        for item in items:
            key = (item["input"], item["target"])
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out

    # --- the hand-written `same?` rows -------------------------------------
    for index, (prev, utterance, target) in enumerate(HW.ROWS):
        slice_name = "dev" if index % 5 == 0 else "train"
        item = {
            "input": "%s ||| %s" % (prev, utterance),
            "target": target,
            "template_id": "hw%03d" % index,
            "move": "act",
            "register": "handwritten",
            "family": "same|handwritten|%s" % slice_name,
            "skel_id": "sk_same_hw_%s" % slice_name,
        }
        (val if slice_name == "dev" else train).append(item)

    train, val = dedupe(train), dedupe(val)
    val_inputs = {i["input"] for i in train}
    val = [i for i in val if i["input"] not in val_inputs]

    for name, items in (("train.jsonl", train), ("val.jsonl", val)):
        with open(os.path.join(HERE, name), "w") as handle:
            for item in items:
                handle.write(json.dumps(item) + "\n")

    def report(name, items):
        moves, registers, per = {}, {}, {}
        for item in items:
            moves[item["move"]] = moves.get(item["move"], 0) + 1
            registers[item["register"]] = registers.get(item["register"], 0) + 1
            per[item["skel_id"]] = per.get(item["skel_id"], 0) + 1
        follow = sum(1 for i in items if not i["input"].startswith("NONE |||"))
        print("%-6s rows %6d | skeletons %5d | families %5d | templates %6d"
              % (name, len(items), len({i["skel_id"] for i in items}),
                 len({i["family"] for i in items}),
                 len({i["template_id"] for i in items})))
        print("       follow-ups %d (%.1f%%) | max rows per skeleton %d"
              % (follow, 100.0 * follow / max(1, len(items)), max(per.values())))
        print("       moves     %s" % dict(sorted(moves.items())))
        print("       registers %s" % dict(sorted(registers.items())))

    report("train", train)
    report("val", val)
    overlap = ({i["skel_id"] for i in val} & {i["skel_id"] for i in train})
    fam_overlap = ({i["family"] for i in val} & {i["family"] for i in train})
    print("val skeleton overlap with train : %d" % len(overlap))
    print("val family   overlap with train : %d" % len(fam_overlap))
    print("total rows                      : %d" % (len(train) + len(val)))


if __name__ == "__main__":
    main()
