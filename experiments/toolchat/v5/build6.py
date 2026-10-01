#!/usr/bin/env python3
"""Assemble the v6 DELTA set: Sonnet phrasings (raw6/) over selected6.jsonl,
each with a synthetic vault and rendering exactly as build5 (same checks),
plus a spoken-number check, the 4-gram leakage strip against the evaluation
corpora (strip only ever deletes), and a replay sample of v5's cleaned train
sessions -> delta6.jsonl, STATS6.md.

The strip is the ONLY step that reads evaluation files, and it only drops.
"""
import collections, glob, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
import build5 as B5  # noqa: E402

B, R = B5.B, B5.R
REJ = B5.REJ

UNITS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
         "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
         "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}


def spoken_numbers(msg):
    """values of runs of number words ("a hundred and twenty" -> 120)"""
    out, cur, on = [], 0, False
    for w in re.findall(r"[a-z]+", msg.lower().replace("-", " ")):
        if w in UNITS or w in TENS:
            cur += UNITS.get(w, 0) + TENS.get(w, 0); on = True
        elif w == "hundred":
            cur = max(cur, 1) * 100; on = True
        elif w in ("and", "a") and on:
            continue
        else:
            if on:
                out.append(cur)
            cur, on = 0, False
    if on:
        out.append(cur)
    return out


def amount_words_ok(canon, msg):
    for m in re.finditer(r"amount_minor: (\d+)", canon):
        units = int(m.group(1)) // 100
        if re.search(r"\b%d\b" % units, msg):
            continue
        if units not in spoken_numbers(msg):
            return False
    return True


def build_new(U):
    sel = [json.loads(l) for l in open(os.path.join(HERE, "selected6.jsonl"))]
    replies = {}
    for f in sorted(glob.glob(os.path.join(HERE, "raw6", "b6_*.jsonl"))):
        for l in open(f):
            x = json.loads(l)
            replies[x["id"]] = x["v"]
    rows, seen = [], set()
    for r in sel:
        vs = replies.get(r["id"])
        if not vs:
            REJ["no reply"] += 1
            continue
        canons = [t["canon"] for t in r["turns"]]
        for vi, v in enumerate(vs[:r["nver"]]):
            if not isinstance(v, list) or len(v) != len(canons) or not all(isinstance(x, str) for x in v):
                REJ["shape"] += 1
                continue
            reqs = [x.strip() for x in v]
            key = tuple(B.norm(x).lower() for x in reqs)
            if key in seen:
                REJ["near-duplicate"] += 1
                continue
            if not all(amount_words_ok(c, u) for c, u in zip(canons, reqs)):
                REJ["spoken amount"] += 1
                continue
            bad, targets, misses = None, [], []
            for ref in r["refs"]:
                msg = reqs[ref["turn"]] if ref["turn"] < len(reqs) else ""
                m = ref["mode"]
                if m in ("span", "loose") and not B5.word_in(ref["kw"], msg):
                    bad = "refer word unsaid"
                elif m == "loose" and B5.word_in(ref["label"], msg) and ref["label"].lower() != ref["kw"].lower():
                    bad = "loose said full title"
                elif m == "full" and not B5.word_in(ref["label"], msg):
                    bad = "full title unsaid"
                if bad:
                    break
                if m in ("span", "loose", "full"):
                    targets.append((ref["kind"], ref["label"], ref["turn"]))
                elif m == "miss":
                    misses.append((ref["kind"], ref["kw"]))
            if bad:
                REJ[bad] += 1
                continue
            rr = random.Random("%s/%d" % (r["id"], vi))
            rendered, why = B5.render_session(rr, U, reqs, canons, targets, misses)
            if rendered is None:
                REJ[why] += 1
                continue
            fixed, why = B5.check_turns(canons, reqs, rendered)
            if fixed is None:
                REJ[why] += 1
                continue
            seen.add(key)
            row = B5.session_row("%s_%d" % (r["id"], vi), r["today"], reqs, rendered, fixed, "v6_%s" % r["id"],
                                 {"src": "new_c", "cell": r["cell"]})
            rows.append(row)
    return rows


def strip(rows):
    """cut each session at its first user message sharing a 4-gram with the
    evaluation corpora (v5's rule)"""
    sys.path[:0] = [os.path.join(REPO, "experiments", "canon-model", "distill")]
    from strip_grams import corpus_grams, file_grams, grams
    ev = corpus_grams([os.path.join(REPO, "crates", "evalsuite", x) for x in ("suite.json", "blind.json", "holdout.json")])
    banned = ev - (file_grams(os.path.join(REPO, "experiments", "canon-model", "data", "train.jsonl")) & ev)
    out, cut, dropped = [], 0, 0
    for r in rows:
        m = r["messages"]
        keep = [m[0]]
        for i in range(1, len(m), 2):
            if grams(m[i]["content"].split("\nvault: ")[0]) & banned:
                cut += 1
                break
            keep += m[i:i + 2]
        if len(keep) == 1:
            dropped += 1
            continue
        out.append(dict(r, messages=keep))
    return out, cut, dropped


def main():
    U = B5.V.Universe()
    new = build_new(U)
    for r in new:
        for m in r["messages"]:
            if m["role"] == "assistant":
                assert B5.REC.full(m["content"]), m["content"]
                B5.check.parse(m["content"])
    new_s, cut, dropped = strip(new)
    rng = random.Random(6161)
    old = [json.loads(l) for l in open(os.path.join(HERE, "sessions.clean.jsonl"))]
    rng.shuffle(old)
    nwin = sum(len(r["messages"]) // 2 for r in new_s)
    replay, w = [], 0
    for r in old:
        if w >= int(nwin * 0.6):
            break
        replay.append(r)
        w += len(r["messages"]) // 2
    rows = [{k: r[k] for k in ("id", "today", "messages", "template_id")} for r in new_s] + replay
    rng.shuffle(rows)
    with open(os.path.join(HERE, "delta6.jsonl"), "w") as o:
        for r in rows:
            o.write(json.dumps(r) + "\n")
    cells = collections.Counter(r["_meta"]["cell"] for r in new_s)
    L = ["# v6 delta STATS", "",
         "| | count |", "|---|---|",
         "| new sessions after checks | %d |" % len(new),
         "| after leakage strip | %d (turns cut %d, sessions dropped %d) |" % (len(new_s), cut, dropped),
         "| new windows (assistant turns) | %d |" % nwin,
         "| replay sessions from v5 | %d (%d windows) |" % (len(replay), w),
         "| total windows | %d |" % (nwin + w), "",
         "## New sessions per cell", "", "| cell | sessions |", "|---|---|"]
    L += ["| %s | %d |" % kv for kv in sorted(cells.items())]
    L += ["", "## Rejects", "", "| reason | count |", "|---|---|"]
    L += ["| %s | %d |" % kv for kv in REJ.most_common()]
    open(os.path.join(HERE, "STATS6.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
