"""v7: trajectories + paraphrased user messages -> tool-session training rows.

    python3 build7.py --traj traj.jsonl --raw raw7/ --out train7.jsonl

A row is {"id", "today", "messages"}: system (today line), then per turn the
person's message, and per call an assistant message (the call) followed by a
tool message (its result) whenever the result is non-empty — exactly what
agent.py sends at inference.

Checks, each a DROP, never a repair:
- every `say` phrase appears verbatim (any case) in its message;
- answer form: a turn that ends on `done` must follow an `ambiguous: …`
  observation (a read turn ends on `answer`, and `done` only stops);
- leakage: a session is cut at its first message sharing a 4-gram with the
  evaluation corpora (v5's rule; the only step that reads them, and it only
  deletes).

Names are substituted per row (--subst, on by default): every word the person
says that a call copies (`say`) and every word of a quoted string in a call is
swapped, consistently across the messages, the calls and the observations,
for a fresh word from subnames.py (real names and places, ordinary nouns,
invented words; none from the evaluation corpora; no word handed to more than
--cap rows). Each paraphrased version of a session gets its own draw, so one
generated session teaches the same calls over several different names.

Handles are renumbered in a share of rows (--renumber, default 0.5): every
`#n` in the calls and observations of the row is shifted by one random offset
(3..20), consistently, so numbering stays sequential but a session no longer
always starts at #1 -- the right handle can only come from reading the
observation, not from habit.

Validation is split by WORLD (--val-worlds): no row of a held-out world trains.
"""
import argparse
import collections
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLCHAT = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(TOOLCHAT, "..", ".."))
sys.path[:0] = [TOOLCHAT]

REJ = collections.Counter()
SUBST = collections.Counter()


def _person_sets():
    sys.path[:0] = [os.path.join(TOOLCHAT, "v5")]
    import pools5 as P5
    return {w.lower() for w in P5.FIRST}, {w.lower() for w in P5.LAST}


def name_words(rec, protect):
    """the words to substitute: from `say` phrases and quoted call strings"""
    out = []
    for t in rec["turns"]:
        texts = list(t["say"])
        for st in t["steps"]:
            texts += re.findall(r'"([^"]*)"', st["call"])
        for x in texts:
            for w in re.findall(r"[A-Za-z]+", x):
                lw = w.lower()
                if len(w) >= 3 and lw not in protect and lw not in out:
                    out.append(lw)
    return out


HANDLE = re.compile(r"(?<![A-Za-z0-9_&])#(\d+)\b")


def renumber(messages, k):
    """shift every `#n` in the calls and observations by k"""
    return [dict(m, content=HANDLE.sub(lambda mo: "#%d" % (int(mo.group(1)) + k), m["content"]))
            if m["role"] in ("assistant", "tool") else m for m in messages]


def recase(src, new):
    if len(src) > 1 and src.isupper():
        return new.upper()
    if src[:1].isupper():
        return new[:1].upper() + new[1:]
    return new.lower()


def substitute(messages, rec, pools, protect, firsts, lasts):
    """-> (messages with every name word swapped, {old: new}) or (None, None)"""
    ws = name_words(rec, protect)
    if not ws:
        return messages, {}
    text = " ".join(m["content"] for m in messages)
    avoid = {w.lower() for w in re.findall(r"[A-Za-z]+", text)}
    mapping = {}
    for w in ws:
        person = "first" if w in firsts else ("last" if w in lasts else None)
        new = pools.draw(avoid, person)
        avoid.add(new.lower())
        mapping[w] = new
    pat = re.compile(r"(?<![A-Za-z])(%s)(?=(?:'s|s|es)?(?![A-Za-z]))"
                     % "|".join(re.escape(w) for w in sorted(ws, key=len, reverse=True)), re.I)
    out = [dict(m, content=pat.sub(lambda mo: recase(mo.group(1), mapping[mo.group(1).lower()]), m["content"]))
           if m["role"] != "system" else m for m in messages]
    # every say phrase, swapped, must still be in its message
    users = [m["content"].lower() for m in out if m["role"] == "user"]
    for t, u in zip(rec["turns"], users):
        for phrase in t["say"]:
            sw = pat.sub(lambda mo: recase(mo.group(1), mapping[mo.group(1).lower()]), phrase).lower()
            if sw not in u:
                return None, None
    for w, new in mapping.items():
        SUBST[new] += 1
    return out, mapping


def load_raw(raw_dir):
    out = {}
    for f in sorted(os.listdir(raw_dir)):
        if not f.endswith(".jsonl"):
            continue
        for line in open(os.path.join(raw_dir, f), encoding="utf-8"):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                r = json.loads(line)
            except ValueError:
                REJ["unparseable paraphrase line"] += 1
                continue
            if "id" in r and "v" in r:
                out[r["id"]] = r["v"]
    return out


def build(rec, msgs_v):
    today_line = rec["today"]
    messages = [{"role": "system", "content": today_line}]
    if len(msgs_v) != len(rec["turns"]):
        REJ["turn count mismatch"] += 1
        return None
    for turn, text in zip(rec["turns"], msgs_v):
        low = text.lower()
        for phrase in turn["say"]:
            if phrase.lower() not in low:
                REJ["say phrase missing"] += 1
                return None
        messages.append({"role": "user", "content": text})
        for step in turn["steps"]:
            if step["obs"].startswith("error:"):
                REJ["a call the runtime refused"] += 1
                return None
            messages.append({"role": "assistant", "content": step["call"]})
            if step["obs"]:
                messages.append({"role": "tool", "content": step["obs"]})
        steps = turn["steps"]
        if steps and steps[-1]["call"] == "done" and not (
                len(steps) > 1 and steps[-2]["obs"].startswith("ambiguous")):
            REJ["done without an ambiguity (old answer form)"] += 1
            return None
    return messages


def strip(rows):
    sys.path[:0] = [os.path.join(REPO, "experiments", "canon-model", "distill")]
    from strip_grams import corpus_grams, file_grams, grams
    ev = corpus_grams([os.path.join(REPO, "crates", "evalsuite", x)
                       for x in ("suite.json", "blind.json", "holdout.json")])
    banned = ev - (file_grams(os.path.join(REPO, "experiments", "canon-model", "data",
                                           "train.jsonl")) & ev)
    out, cut, dropped = [], 0, 0
    for r in rows:
        m = r["messages"]
        keep = [m[0]]
        i = 1
        while i < len(m):
            if m[i]["role"] == "user" and grams(m[i]["content"]) & banned:
                cut += 1
                break
            keep.append(m[i])
            i += 1
        if not any(x["role"] == "assistant" for x in keep):
            dropped += 1
            continue
        out.append(dict(r, messages=keep))
    return out, cut, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traj", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--raw", default=os.path.join(HERE, "raw7"))
    ap.add_argument("--out", default=os.path.join(HERE, "train7.jsonl"))
    ap.add_argument("--val", default=os.path.join(HERE, "val7.jsonl"))
    ap.add_argument("--val-worlds", default="w15.json,w16.json",
                    help="held-out worlds: every row of these is validation, none trains")
    ap.add_argument("--no-subst", action="store_true", help="keep the training worlds' own names")
    ap.add_argument("--cap", type=int, default=5, help="rows any one substituted name may appear in")
    ap.add_argument("--seed", type=int, default=7171)
    ap.add_argument("--subst-log", default="", help="write {substituted name: rows drawn} here")
    ap.add_argument("--renumber", type=float, default=0.5,
                    help="share of rows whose handles are shifted by a random offset (0 = none)")
    a = ap.parse_args()
    raw = load_raw(a.raw)
    import subnames
    pools = subnames.Pools(seed=a.seed, cap=a.cap)
    firsts, lasts = _person_sets()
    protect = subnames.PROTECT
    rows = []
    rn_rng = random.Random(a.seed + 1)
    n_renum = 0
    for line in open(a.traj, encoding="utf-8"):
        rec = json.loads(line)
        vs = raw.get(rec["id"])
        if not vs:
            REJ["no paraphrase"] += 1
            continue
        # a one-turn session sometimes comes back with its phrasings packed
        # into one version (["a", "b"]) instead of one version each
        vs = [[v] if isinstance(v, str) else v for v in vs]
        if len(rec["turns"]) == 1:
            vs = [[m] for v in vs for m in v]
        for vi, msgs_v in enumerate(vs):
            m = build(rec, msgs_v)
            if m and not a.no_subst:
                m, _ = substitute(m, rec, pools, protect, firsts, lasts)
                if m is None:
                    REJ["say phrase lost in substitution"] += 1
            if m and rn_rng.random() < a.renumber:
                m = renumber(m, rn_rng.randint(3, 20))
                n_renum += 1
            if m:
                rows.append({"id": "%s_%d" % (rec["id"], vi), "today": rec["today"],
                             "world": rec["world"], "messages": m})
    n_built = len(rows)
    rows, cut, dropped = strip(rows)
    rng = random.Random(a.seed)
    # the validation split is by WORLD: a held-out world's names, cast and
    # layout never train
    val_worlds = set(a.val_worlds.split(","))
    train = [r for r in rows if r["world"] not in val_worlds]
    val = [r for r in rows if r["world"] in val_worlds]
    rng.shuffle(train)
    for path, part in ((a.out, train), (a.val, val)):
        with open(path, "w", encoding="utf-8") as fh:
            for r in part:
                fh.write(json.dumps(r) + "\n")
    calls = sum(1 for r in train for m in r["messages"] if m["role"] == "assistant")
    print("built %d rows; leakage strip cut %d turns, dropped %d; train %d (%d calls), val %d"
          % (n_built, cut, dropped, len(train), calls, len(val)))
    for k, v in REJ.most_common():
        print("  reject %5d  %s" % (v, k))
    print("handles renumbered in %d rows" % n_renum)
    if SUBST:
        per = collections.Counter(SUBST.values())
        print("substitution: %d names drawn over %d slots; rows per name: %s"
              % (len(SUBST), sum(SUBST.values()), dict(sorted(per.items()))))
        if a.subst_log:
            with open(a.subst_log, "w") as fh:
                json.dump(dict(SUBST.most_common()), fh, indent=0)


if __name__ == "__main__":
    main()
