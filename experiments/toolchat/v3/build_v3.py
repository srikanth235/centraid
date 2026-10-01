#!/usr/bin/env python3
"""Assemble train_v3.jsonl / heldout_v3.jsonl / STATS.md from the Sonnet
paraphrases in out/ and the canonicals in canon.jsonl / heldout_canon.jsonl.

Per paraphrase:
  * reject when a WRITE literal (title/description/summary/content) is not in
    the sentence verbatim (case-insensitive);
  * reject when a `called "X"` literal shares no word with the sentence; when
    only part of X is said, the target's literal becomes the longest contiguous
    run of X's words the sentence contains (a `called` read is a substring
    match, so the run names the same row) — the model can only copy what it sees;
  * literals are re-cased to the sentence's spelling, for the same reason;
  * reject dialect syntax (`that (`, `ordered by`, braces, raw snake_case field
    names), an explicit day/month that contradicts the target's date, and
    near-duplicates (same normalised text after the same previous turn, or
    >= .85 token overlap with a sibling paraphrase of the same task).
Then 1000 replay rows from v2/train_v2.jsonl (non-degenerate, executable,
grammatical, no forbidden name), a fixed-seed shuffle, and the stats.

The 4-gram strip (canon-model/distill/strip_grams.py) is NOT applied: it reads
crates/evalsuite/suite.json and blind.json, which this build must never open.
"""
import collections, datetime, glob, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen  # noqa: E402
import check  # noqa: E402
import pools  # noqa: E402
from typing_v3 import ARMS, L  # noqa: E402

rng = random.Random(33)
stats = collections.Counter()
WRITE_ARGS = ("title", "description", "summary", "content")
STOP = {"the", "a", "an", "of", "to", "for", "and", "at", "in", "on", "my", "with", "from"}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
          "october", "november", "december"]
FIELD_RX = re.compile(r"\b(%s)\b" % "|".join(sorted((f for f in L.FIELDS if "_" in f), key=len, reverse=True)))


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def toks(s):
    return set(norm(s).split())


def find_ci(hay, needle):
    i = hay.lower().find(needle.lower())
    return None if i < 0 else hay[i:i + len(needle)]


def best_span(lit, u):
    """Longest contiguous run of lit's words present in u (case-insensitive,
    on word boundaries); returns the run as spelled in u, or None."""
    words = lit.split()
    for n in range(len(words), 0, -1):
        for i in range(len(words) - n + 1):
            run = " ".join(words[i:i + n])
            if n == 1 and (len(run) < 3 or run.lower() in STOP):
                continue
            m = re.search(r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9])" % re.escape(run), u, re.I)
            if m:
                return m.group(0)
    return None


def date_ok(target, u, today):
    """An explicit day number or month name in the sentence must agree with a
    date the target carries (relative words are not checked)."""
    dates = [datetime.date.fromisoformat(d) for d in re.findall(r"\b(\d{4}-\d\d-\d\d)", target)]
    months = [datetime.date.fromisoformat(m + "-01") for m in re.findall(r"\b(\d{4}-\d\d)(?![-\d])", target)]
    lu = u.lower()
    for m in re.finditer(r"\b(\d{1,2})(?:st|nd|rd|th)\b", lu):
        if dates and int(m.group(1)) not in {d.day for d in dates}:
            return False
    for mi, name in enumerate(MONTHS):
        if re.search(r"\b%s\b" % (name if name != "may" else "may(?= \d)"), lu) or \
                re.search(r"\b%s\b(?= ?\d)" % name[:3], lu):
            if (dates or months) and (mi + 1) not in {d.month for d in dates + months}:
                return False
    return True


def adapt(target, u):
    """-> (new target, None) or (None, reject reason)."""
    t = target
    for arg in WRITE_ARGS:
        for lit in re.findall(r'\b%s: "((?:[^"\\]|\\.)*)"' % arg, t):
            got = find_ci(u, lit)
            if got is None:
                return None, "write literal not verbatim"
            t = t.replace('%s: "%s"' % (arg, lit), '%s: "%s"' % (arg, got))
    for lit in sorted(set(re.findall(r'called "((?:[^"\\]|\\.)*)"', t)), key=len, reverse=True):
        span = best_span(lit, u)
        if span is None:
            return None, "called literal absent"
        if span.lower() != lit.lower():
            stats["called literal shortened to the words said"] += 1
        t = t.replace('called "%s"' % lit, 'called "%s"' % span)
    return t, None


def dialect(u):
    return "that (" in u or "ordered by" in u or "{" in u or "}" in u or FIELD_RX.search(u) is not None


def rows_for(canon_file, prefix):
    canon = {json.loads(l)["id"]: json.loads(l) for l in open(os.path.join(HERE, canon_file))}
    out, seen = [], set()
    got = {}
    for f in sorted(glob.glob(os.path.join(HERE, "out", prefix + "*.jsonl"))):
        for line in open(f):
            r = json.loads(line)
            if r["id"] in canon and r["id"] not in got:
                got[r["id"]] = r["u"]
    stats["%s: canonicals" % canon_file] = len(canon)
    stats["%s: canonicals paraphrased" % canon_file] = len(got)
    for cid, us in got.items():
        c = canon[cid]
        kept = []
        for u in us[:3]:
            stats["paraphrases seen"] += 1
            u = u.strip()
            if not u or len(u.split()) > 40:
                stats["reject: empty/too long"] += 1
                continue
            if dialect(u):
                stats["reject: dialect syntax"] += 1
                continue
            if not date_ok(c["target"], u, c["today"]):
                stats["reject: explicit date contradicts target"] += 1
                continue
            t, why = adapt(c["target"], u)
            if why:
                stats["reject: " + why] += 1
                continue
            if not gen.REC.full(t) or gen.validate(t, c["ctx"]):
                stats["reject: adapted target invalid"] += 1
                continue
            n = (c["prev"], norm(u))
            if n in seen or any(len(toks(u) & toks(k)) / max(1, len(toks(u) | toks(k))) >= 0.85 for k in kept):
                stats["reject: near-duplicate"] += 1
                continue
            seen.add(n)
            kept.append(u)
            out.append({"input": "%s ||| %s" % (c["prev"], u), "target": t, "today": c["today"],
                        "template_id": "v3_%s" % cid})
    return out


# -- replay ------------------------------------------------------------------
DEGEN = re.compile(r"\b([a-z]+(?: [a-z]+)?) of \(\1 ")


def executable(c):
    """build_v2.py's check: every verb is an arm (or a class with an arm
    member) and its arg names are ones that arm reads."""
    for v, a in re.findall(r'(?:^|then )([a-z_.]+)\{([^}]*)\}', c):
        if v in L.VERB_CLASSES:
            ok = [set(ARMS[x]) for x in L.VERB_CLASSES[v].values() if x in ARMS]
        else:
            ok = [set(ARMS[v])] if v in ARMS else []
        if not ok:
            return False
        names = set(re.findall(r'([a-z_]+)\s*:', re.sub(r'"[^"]*"|\([^)]*\)', '', a)))
        if not any(names <= s for s in ok):
            return False
    return True


def replay(n):
    pool = []
    for line in open(os.path.join(HERE, "..", "v2", "train_v2.jsonl")):
        r = json.loads(line)
        t = r["target"]
        if DEGEN.search(t) or not executable(t) or not gen.REC.full(t):
            stats["replay filtered"] += 1
            continue
        low = r["input"].lower() + " " + t.lower()
        if any(re.search(r"\b%s\b" % f, low) for f in pools.FORBIDDEN):
            stats["replay filtered (forbidden name)"] += 1
            continue
        pool.append(r)
    stats["replay pool"] = len(pool)
    picked = rng.sample(pool, n)
    out = []
    for i, r in enumerate(picked):
        out.append({"input": r["input"], "target": r["target"], "today": r.get("today", "2027-02-13"),
                    "template_id": r.get("template_id", "v2_replay_%04d" % i)})
    return out


# -- stats -------------------------------------------------------------------
def shape(t):
    tree = check.parse(t)
    k = tree["node"]
    head = {"agg": tree.get("agg"), "cmd": "cmd", "seq": "cmd then cmd", "same": "same?",
            "project": "field-of", "balance": "balance"}.get(k, k)
    return head, min(gen.tree_depth(tree), 4), json.dumps(check.skeleton(tree), sort_keys=True)


def hist(rows, fn):
    c = collections.Counter(fn(r) for r in rows)
    lines = ["| value | rows | share |", "| --- | ---: | ---: |"]
    for k, v in sorted(c.items(), key=lambda x: (-x[1], str(x[0]))):
        lines.append("| %s | %d | %.1f%% |" % (k, v, 100.0 * v / len(rows)))
    return lines


def main():
    train = rows_for("canon.jsonl", "b")
    held = rows_for("heldout_canon.jsonl", "h")
    stats["v3 rows"] = len(train)
    rep = replay(1000)
    allrows = train + rep
    rng.shuffle(allrows)
    rng.shuffle(held)
    for name, rs in (("train_v3.jsonl", allrows), ("heldout_v3.jsonl", held)):
        with open(os.path.join(HERE, name), "w") as fh:
            for r in rs:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    info = {}
    for r in allrows:
        info[id(r)] = shape(r["target"])
    calls = sum(1 for _ in open(os.path.join(HERE, "out", "calls.log")))
    L_ = ["# train_v3 stats", "",
          "| | count |", "| --- | ---: |",
          "| train_v3.jsonl rows | %d |" % len(allrows),
          "| of which v3 paraphrase rows | %d |" % len(train),
          "| of which v2 replay rows | %d |" % len(rep),
          "| heldout_v3.jsonl rows | %d |" % len(held),
          "| unique targets (train) | %d |" % len({r["target"] for r in allrows}),
          "| unique skeletons (train, literals masked) | %d |" % len({info[id(r)][2] for r in allrows}),
          "| unique skeletons (v3 rows only) | %d |" % len({info[id(r)][2] for r in train}),
          "| unique skeletons (held-out) | %d |" % len({shape(r["target"])[2] for r in held}),
          "| held-out skeletons also in train (incl. replay) | %d |" % len(
              {shape(r["target"])[2] for r in held} & {info[id(r)][2] for r in allrows}),
          "| Sonnet calls used | %d of 70 |" % calls,
          "", "## Build log", "", "| step | count |", "| --- | ---: |"]
    for k in sorted(stats):
        L_.append("| %s | %d |" % (k, stats[k]))
    L_ += ["", "The 4-gram strip was NOT applied: `canon-model/distill/strip_grams.py` reads "
           "`crates/evalsuite/suite.json` and `blind.json`, which this build may not open. Run it "
           "separately (it only deletes rows) before training if the leakage gate is wanted.", ""]
    for title, rows, fn in [
            ("turn type (whole train set)", allrows, lambda r: info[id(r)][0]),
            ("depth, check.depth, 4 = 4+ (whole train set)", allrows, lambda r: info[id(r)][1]),
            ("depth (v3 rows only)", train, lambda r: info[id(r)][1]),
            ("previous turn (whole train set)", allrows, lambda r: "NONE" if r["input"].startswith("NONE |||") else "prev"),
            ("uses a ref (whole train set)", allrows, lambda r: "ref" if gen.refs_in(r["target"]) else "no ref"),
            ("uses a ref (v3 rows only)", train, lambda r: "ref" if gen.refs_in(r["target"]) else "no ref"),
            ("ref terminal (whole train set, rows can count twice)", [x for x in allrows if gen.refs_in(x["target"])],
             lambda r: gen.refs_in(r["target"])[0]),
            ("utterance words (v3 rows)", train, lambda r: min(len(r["input"].split(" ||| ", 1)[1].split()) // 3 * 3, 30))]:
        L_ += ["", "## " + title, ""] + hist(rows, fn)
    ws = sorted(len(r["input"].split(" ||| ", 1)[1].split()) for r in train)
    L_ += ["", "v3 utterance length: median %d words, p90 %d, max %d (gold profile: 6 / 12 / 31)." % (
        ws[len(ws) // 2], ws[int(len(ws) * 0.9)], ws[-1])]
    open(os.path.join(HERE, "STATS.md"), "w").write("\n".join(L_) + "\n")
    print("\n".join(L_[:16]))


if __name__ == "__main__":
    main()
