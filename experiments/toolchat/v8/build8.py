"""v8: trajectories + paraphrased messages -> augmented tool-session chat rows.

    python3 v8/build8.py [--traj v8/traj.jsonl] [--raw v8/raw8] \
        [--out v8/train8.jsonl] [--val v8/val8.jsonl] [--report coverage.md]
    python3 v8/build8.py --traj v8/traj-lf.jsonl --mirror p600.jsonl,pval.jsonl \
        --mirror-traj v8/selected8.jsonl --fill-train 600 --fill-val 80 --out lf600.jsonl --val lfval.jsonl

MIRROR mode (an A/B arm): for every row of the --mirror files (rows this script built from
--mirror-traj), the row with the SAME id is built from --traj: same session, same paraphrased
version, and the same augmentation -- the name map is read back off the mirrored row (its words
aligned with the unaugmented session), the handle offset and week shift from its `aug`, the
amount swap from its messages. A mirrored row's person messages must come out identical to the
original's, else it is rebuilt with fresh draws (`mirror: fresh draws`). A session missing from
--traj (or failing its checks) is topped up to --fill-train / --fill-val rows with one fresh row
each from other sessions of the same split (seeded). Every --traj session is cut to the
turns its --mirror-traj record kept (select8.py trims tails), and only those sessions are used. The pair rule is not applied (the mirrored
file already made that choice).

A row is {"id", "today", "messages", ...} as ft_chat.py --full reads it:
system (the today line), then per turn the person's message, and per call an
assistant message (the call) followed by a tool message (its result)
whenever the result is non-empty -- exactly what agent.py sends. Extra keys
(world, split, skills per kept turn, aug) are for the coverage report;
ft_chat.py ignores them.

Per session (each a DROP, never a repair):
- a turn trajgen tagged `recovery` (none | nolink | field) opens on a
  deliberate miss: the first step the runtime answered `no rows`,
  `ambiguous: no link …` or `error: …` (the step before the recovering
  call). Its assistant message carries `"loss": false` (ft_chat.py --full
  honours it). Any other `error:` observation drops the session;
- a minimal pair (`pair`: "<id>/a|b") travels whole: if one half builds no
  row, the other's rows go too;
- answer form: a turn may end on `done` only right after an `ambiguous: …`
  observation (a read turn ends on `answer`);
Per paraphrased version: every `say` phrase appears verbatim (any case) in its
message. Then augment.py makes on average --per-version rows from it (names
always; handles, dates, amounts by coin flip); a variant that verify() finds
worse than its base is redrawn, then dropped.
Leakage: a session is cut at its first message sharing a 4-gram with the
evaluation corpora (suite/blind/holdout) that canon-model's train.jsonl does
not already share (v5's rule; the only step that reads them, and it only
deletes).
Split: the record's `split` ("val" = worlds w37-w40); records without one
(v7 trajectories) use --val-worlds.
"""
import argparse
import collections
import json
import os
import random
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLCHAT = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(TOOLCHAT, "..", ".."))
sys.path[:0] = [HERE]
import augment as A  # noqa: E402

REJ = collections.Counter()
CHK = collections.Counter()


# ---------------------------------------------------------------- input

def world_of(rec):
    w = rec.get("world") or rec["id"].split("-")[0]
    return w if w.endswith(".json") else w + ".json"


def load_raw(raw_dir):
    """{id: [[msg per turn], ...]} from every *.jsonl of raw_dir"""
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
            if "id" in r and isinstance(r.get("v"), list):
                out[r["id"]] = r["v"]
    return out


def versions_of(rec, vs):
    """normalise a reply: a one-turn session may come back flat (["a", "b"])
    or packed ([["a", "b"]]) instead of one list per version"""
    vs = [[v] if isinstance(v, str) else v for v in vs]
    if len(rec["turns"]) == 1:
        vs = [[m] for v in vs for m in v]
    return [v for v in vs if all(isinstance(m, str) for m in v)]


MISS_OBS = ("no rows", "error:", "ambiguous: no link", "none")


def miss_index(t):
    """a recovery turn's miss: the first step the runtime answered with a
    miss (the step before the recovering call)"""
    if not t.get("recovery"):
        return None
    for i, st in enumerate(t["steps"][:-1]):
        if st["obs"].strip().startswith(MISS_OBS):
            return i
    return None


def check_record(rec):
    """-> reason string when the whole session must be dropped, else None"""
    for t in rec["turns"]:
        steps = t["steps"]
        mi = miss_index(t)
        if t.get("recovery") and mi is None:
            REJ["recovery turn without a miss step (kept, nothing masked)"] += 1
        for i, st in enumerate(steps):
            if st["obs"].startswith("error:") and i != mi and not st.get("miss"):
                return "a call the runtime refused (error outside a tagged recovery)"
        if steps and steps[-1]["call"] == "done" and not (
                len(steps) > 1 and steps[-2]["obs"].startswith("ambiguous")):
            return "done without an ambiguity (old answer form)"
    return None


def session(rec, msgs):
    turns = []
    for t, m in zip(rec["turns"], msgs):
        mi = miss_index(t)
        steps = [dict(st, miss=True) if i == mi else dict(st) for i, st in enumerate(t["steps"])]
        turns.append(dict(t, msg=m, say=list(t["say"]), steps=steps))
    return {"today": rec["today"], "turns": turns}


def messages(sess):
    out = [{"role": "system", "content": sess["today"]}]
    for t in sess["turns"]:
        out.append({"role": "user", "content": t["msg"]})
        for st in t["steps"]:
            m = {"role": "assistant", "content": st["call"]}
            if st.get("miss") or st["obs"].startswith("error:"):
                m["loss"] = False
            out.append(m)
            if st["obs"]:
                out.append({"role": "tool", "content": st["obs"]})
    return out


# ---------------------------------------------------------------- skills

ORD = re.compile(r"\b(first|second|third|fourth|last|1st|2nd|3rd|4th|top|bottom)\b")


def infer_skills(t, ti, turns):
    """a rough call-shape tagger for trajectories that carry no `skills`
    (v7); lane 3's records tag every turn themselves"""
    cs = [s["call"] for s in t["steps"]]
    c = " ; ".join(cs)
    hint = t["hint"].lower()
    new_topic = hint.startswith("(new topic)") or ti == 0
    k = set()
    add = k.add
    if re.search(r"\b(photos|albums|places)\b", c): add("route.media")
    if re.search(r"\b(documents|notes|journal notes|notebooks)\b", c): add("route.library")
    if re.search(r"\b(events|tasks|important dates)\b", c) and "things during" not in c: add("route.schedule")
    if re.search(r"\bparties\b", c) and "parties of" not in c: add("route.people")
    if re.search(r"\b(expenses|groups|obligations|balance of|settlements)\b", c): add("route.money")
    if "locker" in c: add("route.locker")
    if re.search(r'things called|^search "', c): add("route.everything")
    if "things during" in c: add("route.day")
    says = " ".join(t["say"])
    for s in cs:
        for q in A.copied_quotes(s):
            if re.search(r"\b(title|summary|description|content):", s) and q in s.split("{", 1)[-1]:
                add("copy.title")
            elif any(w[:1].isupper() for w in re.findall(A.WORD, q)) and \
                    len(re.findall(A.WORD, q)) <= 3 and q.lower() in says.lower():
                add("copy.name")
            else:
                add("copy.anchor")
    if re.search(r"(amount_minor|effort_min|owed_\w+)\s*(?::|[<>=]+)\s*\d", c) and re.search(r"\d", says): add("copy.number")
    if re.search(r"\b(due_at|dtstart|to):\s*\w", c): add("copy.date")
    if 'status != "completed"' in c: add("filter.open")
    if "deleted_at" in c: add("filter.trashed")
    if re.search(r"(amount_minor|owed_\w+|effort_min|count of \w+)\s*[<>=]+\s*\d", c) and "answer (parties that (owed" not in c: add("filter.numeric")
    if re.search(r"\b(favorite|starred|folder|notebooks|kind|type|label|album_titles)\s*=", c): add("filter.field")
    if "parties of" in c: add("link.parties_of")
    if re.search(r"\b(obligations|contact channels|important dates|activities|events) of\b", c): add("link.of_person")
    if re.search(r"\b(members|expenses|settlements|groups) of\b", c): add("link.of_group")
    if re.search(r"\b(photos|places|albums|profiles) of\b|member of", c): add("link.media")
    if "tasks of" in c: add("link.subtasks")
    if " during " in c: add("time.window")
    if re.search(r"\w+_(at|on) during|dtstart during", c): add("time.field")
    if "ordered by" in c or "first 1 of" in c: add("time.order")
    if re.search(r"by: [+-]", c): add("time.shift")
    if re.search(r"during \d{4}-\d{2}-\d{2}", c): add("time.derived")
    if re.search(r"answer count of", c): add("num.count")
    if re.search(r"\bsum \w+ of", c): add("num.sum")
    if re.search(r"answer amount_minor of", c): add("num.value_of")
    if "dtstart of" in c: add("num.dtstart_of")
    if re.search(r"answer balance of", c): add("num.balance")
    if "owed_to" in c: add("num.owed")
    if not new_topic:
        if "except" in c: add("follow.except")
        if "back to" in hint: add("follow.back_to")
        if re.search(r"\binstead\b|what about|and (for )?[A-Z]", t["hint"]): add("follow.swap_subject")
        if re.search(r"\(them\b|of \(them\)|\bthem\)", c) and not re.search(r"^\w+\{", cs[-1] if cs else ""): add("follow.narrow")
        prev = " ".join(s["call"] for s in turns[ti - 1]["steps"])
        kind = lambda x: set(re.findall(r"\b(photos|documents|notes|events|tasks|parties|expenses|locker items|albums|places)\b", x))  # noqa: E731
        if kind(c) and kind(prev) and not (kind(c) & kind(prev)) and "back to" not in hint: add("follow.switch_kind")
    earlier = set()
    for j, u in enumerate(turns[:ti]):
        for s in u["steps"]:
            for h in A.HANDLE.findall(s["obs"]):
                earlier.add((h, j))
    for s in cs:
        hs = A.HANDLE.findall(s)
        if hs and not s.startswith(("get ", "show ")):
            add("handle.pick")
        if len(hs) > 1 or re.search(r"\bthem\b", s):
            add("handle.them")
        for h in hs:
            js = [j for (x, j) in earlier if x == h]
            if js and max(js) <= ti - 2:
                add("handle.far")
    if ORD.search(hint) and "#" in c: add("handle.ordinal")
    verbs = {"schedule.add_task": "write.add_task", "schedule.propose_event": "write.event",
             "knowledge.create_note": "write.note", "locker.add_item": "write.note", "reschedule": "write.reschedule",
             "complete": "write.mark", "core.star_document": "write.mark", "schedule.set_task_status": "write.mark",
             "delete": "write.trash", "cancel": "write.trash", "core.trash_document": "write.trash",
             "tally.delete_expense": "write.trash", "people.trash_person": "write.trash", "locker.trash_item": "write.trash",
             "media.delete_asset": "write.trash", "restore": "write.restore", "core.restore_document": "write.restore",
             "media.restore_asset": "write.restore", "tally.undo_expense": "write.restore",
             "locker.reveal_receipt": "write.reveal", "media.add_to_album": "write.album_add",
             "people.log_interaction": "write.log_interaction", "people.settle_debt": "write.settle",
             "tally.settle_up": "write.settle", "tally.add_expense": "write.tally", "tally.add_group_member": "write.tally"}
    wrote = False
    for i, s in enumerate(cs):
        for v in re.findall(r"(?:^|then )([\w.]+)\{", s):
            if v in verbs:
                add(verbs[v])
                wrote = True
                if i > 0 and any(not x.startswith(("done", "ask")) for x in cs[:i]): add("compose.lookup_write")
                if re.search(r"on #\d+, #\d+|\(it\)", s): add("compose.bulk")
        if re.search(r"\} then [\w.]+\{", s): add("compose.then")
    if wrote and re.search(r"correct|other one|instead", hint): add("compose.correction")
    if re.search(r"\bundo|put it back|didn.t mean", hint): add("compose.undo")
    last = cs[-1] if cs else ""
    obs = [s["obs"] for s in t["steps"]]
    if last == "done" or last.startswith("ask"):
        add("judge.no_link" if any("no link" in o for o in obs) else "judge.ambiguous")
    if last == "nothing":
        add("judge.never_mind" if re.search(r"never mind|takes it back|forget", hint) else "judge.nothing_there")
    if last.startswith("refuse: out_of_ontology"): add("judge.refuse_outside")
    elif last.startswith("refuse"): add("judge.refuse_guard")
    if last.startswith("answer") and obs and obs[-1].strip() in ("none", "= 0"): add("judge.nothing_there")
    return sorted(k)


def turn_skills(rec):
    return [t.get("skills") or infer_skills(t, i, rec["turns"]) for i, t in enumerate(rec["turns"])]


# ---------------------------------------------------------------- leakage

_BANNED = []


def strip(rows):
    sys.path[:0] = [os.path.join(REPO, "experiments", "canon-model", "distill")]
    from strip_grams import corpus_grams, file_grams, grams
    if not _BANNED:
        ev = corpus_grams([os.path.join(REPO, "crates", "evalsuite", x)
                           for x in ("suite.json", "blind.json", "holdout.json")])
        _BANNED.append(ev - (file_grams(os.path.join(REPO, "experiments", "canon-model", "data", "train.jsonl")) & ev))
    banned = _BANNED[0]
    out, cut, dropped = [], 0, 0
    for r in rows:
        m = r["messages"]
        keep = [m[0]]
        for x in m[1:]:
            if x["role"] == "user" and grams(x["content"]) & banned:
                cut += 1
                break
            keep.append(x)
        if not any(x["role"] == "assistant" for x in keep):
            dropped += 1
            continue
        n_turns = sum(x["role"] == "user" for x in keep)
        out.append(dict(r, messages=keep, skills=r["skills"][:n_turns]))
    return out, cut, dropped


# ---------------------------------------------------------------- report

def baseline_targets(path):
    tg = {}
    pat = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| (\w+) \| \d+ \| \d+ \| \d+ \| (\d+) \|\s*$")
    for line in open(path, encoding="utf-8"):
        m = pat.match(line)
        if m:
            tg[m.group(1)] = (m.group(2), int(m.group(3)))
    return tg


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0


def report(train, val, targets, pools, stats, min_worlds):
    L = []
    per = collections.Counter()
    worlds = collections.defaultdict(set)
    for r in train:
        for sk in r["skills"]:
            for s in sk:
                per[s] += 1
                worlds[s].add(r["world"])
    L.append("## Coverage (train rows = turns carrying the skill)\n")
    L.append("| skill | group | rows | worlds | target | status |")
    L.append("|---|---|---:|---:|---:|---|")
    groups = collections.OrderedDict()
    short = 0
    for s, (g, tgt) in sorted(targets.items(), key=lambda kv: (kv[1][0], kv[0])):
        ok = per[s] >= tgt and len(worlds[s]) >= min_worlds
        short += not ok
        L.append("| `%s` | %s | %d | %d | %d | %s |" % (s, g, per[s], len(worlds[s]), tgt, "OK" if ok else "SHORT"))
        gg = groups.setdefault(g, [0, 0, 0, 0])
        gg[0] += per[s]; gg[1] += tgt; gg[2] += 1; gg[3] += ok
    extra = sorted(set(per) - set(targets))
    if extra:
        L.append("\nskills not in BASELINE: " + ", ".join("%s=%d" % (s, per[s]) for s in extra))
    L.append("\n%d/%d skills OK (rows >= target and >= %d worlds)\n" % (len(targets) - short, len(targets), min_worlds))
    L.append("| group | rows | target | skills OK |")
    L.append("|---|---:|---:|---:|")
    for g, (n, t, ns, ok) in groups.items():
        L.append("| %s | %d | %d | %d/%d |" % (g, n, t, ok, ns))
    tpr = collections.Counter(len(r["skills"]) for r in train)
    cpr = [sum(m["role"] == "assistant" for m in r["messages"]) for r in train]
    chars = [sum(len(m["content"]) for m in r["messages"]) for r in train]
    L.append("\n## Shape (train)\n")
    L.append("rows %d (%d turns, %d calls); val rows %d" % (len(train), sum(tpr[k] * k for k in tpr), sum(cpr), len(val)))
    L.append("turns per row: " + ", ".join("%d: %d" % (k, tpr[k]) for k in sorted(tpr)))
    if cpr:
        L.append("calls per row: median %d, p90 %d, max %d" % (statistics.median(cpr), pct(cpr, 0.9), max(cpr)))
        L.append("session length (chars; ~/3.5 = tokens): median %d, p90 %d, max %d"
                 % (statistics.median(chars), pct(chars, 0.9), max(chars)))
    n = max(1, len(train) + len(val))
    allr = train + val
    L.append("\n## Augmentation\n")
    L.append("renumbered handles: %d/%d rows (%.0f%%)" % (sum(bool(r["aug"]["handles"]) for r in allr), n,
                                                           100.0 * sum(bool(r["aug"]["handles"]) for r in allr) / n))
    L.append("shifted dates: %d/%d rows (%.0f%%); eligible sessions %.0f%%" % (
        sum(bool(r["aug"]["weeks"]) for r in allr), n, 100.0 * sum(bool(r["aug"]["weeks"]) for r in allr) / n,
        100.0 * stats["shift_eligible"]))
    L.append("scaled amounts: %d rows" % sum(r["aug"]["amounts"] for r in allr))
    used = pools.used
    if used:
        cats = collections.Counter(pools.cat[w] for w in used for _ in range(used[w]))
        tot = sum(cats.values())
        L.append("names: %d distinct over %d slots; mix %s; rows per name: max %d, %s" % (
            len(used), tot, ", ".join("%s %.0f%%" % (c, 100.0 * cats[c] / tot) for c in ("real", "noun", "made")),
            max(used.values()), dict(sorted(collections.Counter(used.values()).items()))))
    L.append("\n## Checks\n")
    for k, v in sorted(CHK.items()):
        L.append("- %s: %d" % (k, v))
    L.append("\n## Rejections\n")
    for k, v in REJ.most_common():
        L.append("- %s: %d" % (k, v))
    return "\n".join(L)


# ---------------------------------------------------------------- mirror

NUM = re.compile(r"\d+(?:\.\d+)?")


def _words(text):
    return re.findall(A.WORD, text)


def read_names(base, row):
    """the name map a built row applied to its unaugmented session, read back by aligning the
    words of every message (names swap one word for one word); None when they do not align"""
    ws = A.name_words(base)
    if not ws:
        return {}
    got = {}
    for a, b in zip(messages(base), row["messages"]):
        if a["role"] != b["role"]:
            return None
        x, y = _words(a["content"]), _words(b["content"])
        if len(x) != len(y):
            return None
        for u, v in zip(x, y):
            lu = u.lower()
            key, new = lu, v
            if lu not in ws:
                # a plural of a name word: the new word pluralised the same way
                for suf in ("es", "s"):
                    if lu.endswith(suf) and lu[:-len(suf)] in ws and v.lower().endswith(suf):
                        key, new = lu[:-len(suf)], v[:-len(suf)]
                        break
                else:
                    continue
            if key == new.lower():
                return None      # a name word left in place: not the same draw
            if got.setdefault(key, new).lower() != new.lower():
                return None
    return got


def read_amount(base, row):
    """(old major, new major) the row swapped in a person message, or None"""
    for a, b in zip(messages(base), row["messages"]):
        if a["role"] == "user":
            x, y = NUM.findall(a["content"]), NUM.findall(b["content"])
            for u, v in zip(x, y):
                if u != v:
                    return u, v
    return None


class ForcedRng:
    """stands in for the rng of augment.scale_amounts: picks the recorded swap"""

    def __init__(self, old, new):
        self.old, self.new, self.k = old, new, 0

    def choice(self, xs):
        self.k += 1
        if self.k == 1:
            m = [c for c in xs if A._major(c[3]) == self.old]
        else:
            m = [n for n in xs if A._major(n) == self.new]
        if not m:
            raise LookupError
        return m[0]


def mirror_variant(base, mrow, lf_base, pools):
    """lf_base augmented the way mrow was augmented from base; None when it cannot be. A name
    word the mirrored row never shows (its session was cut for leakage) gets a fresh draw."""
    aug = mrow["aug"]
    v = lf_base
    words = []
    if aug["names"]:
        mp = read_names(base, mrow)
        if mp is None:
            return None, None
        text = " ".join(m["content"] for m in messages(lf_base) + mrow["messages"])
        avoid = {w.lower() for w in re.findall(A.WORD, text)}
        firsts, lasts = A.person_words(lf_base)
        for w in A.name_words(lf_base):
            if w not in mp:
                new = pools.draw(avoid, "first" if w in firsts else ("last" if w in lasts else None))
                avoid.add(new.lower())
                mp[w] = new
                CHK["mirror: name drawn fresh (not in the mirrored row)"] += 1
        v, _ = A.substitute(v, None, mapping=mp)
        if v is None:
            return None, None
        words = list(mp.values())
    elif A.name_words(base):
        return None, None
    if aug["handles"]:
        v = A.renumber(v, aug["handles"])
    if aug["weeks"]:
        v = A.shift_dates(v, aug["weeks"])
    if aug["amounts"]:
        sw = read_amount(base, mrow)
        if not sw:
            return None, None
        try:
            v, _ = A.scale_amounts(v, ForcedRng(*sw), ())
        except LookupError:
            return None, None
        if v is None:
            return None, None
    return v, words


def user_msgs(msgs):
    return [m["content"] for m in msgs if m["role"] == "user"]


def fresh_variant(base, pools, rng, a, wamts, p_dates):
    """one augmented variant with fresh draws (pass 2's recipe) -> (v, aug, words) or None"""
    base_bad = A.verify(base)
    for attempt in range(3):
        v, aug, words = base, {"names": 0, "handles": 0, "weeks": 0, "amounts": 0}, []
        if not a.no_names:
            v2, mp = A.substitute(v, pools)
            if v2 is None or A.leftover_names(v2, mp):
                continue
            v, aug["names"], words = v2, len(mp), list(mp.values())
        if rng.random() < a.p_handles:
            k = rng.randint(3, 20)
            v, aug["handles"] = A.renumber(v, k), k
        if A.can_shift(v) and rng.random() < p_dates:
            wk = rng.choice([x for x in range(-40, 41) if x])
            v, aug["weeks"] = A.shift_dates(v, wk), wk
        if rng.random() < a.p_amounts:
            v2, n_amt = A.scale_amounts(v, rng, wamts)
            if v2 is not None:
                v, aug["amounts"] = v2, n_amt
        if len(A.verify(v)) > len(base_bad):
            continue
        return v, aug, words
    return None


def run_mirror(a, raw, recs, pools, rng):
    orig = {}
    for l in open(a.mirror_traj, encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            orig[r["id"]] = r
    # the mirrored rows were built from --mirror-traj's sessions, which may be tails-trimmed
    # (select8.py): each --traj session is cut to the same turns
    lf = {r["id"]: dict(r, turns=r["turns"][:len(orig[r["id"]]["turns"])]) for r in recs if r["id"] in orig}
    recs = list(lf.values())
    mrows = []
    for f in a.mirror.split(","):
        mrows += [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()]
    msess = {m["id"].rsplit("_", 1)[0] for m in mrows}
    wamts = {}

    def amounts(w):
        if w not in wamts:
            wamts[w] = A.world_amounts(os.path.join(a.worlds, w))
        return wamts[w]

    def prepared(rec, vi):
        """-> (lf base session, msgs) or a rejection reason"""
        vs = raw.get(rec["id"])
        if not vs:
            return "no paraphrase"
        why = check_record(rec)
        if why:
            return why
        vers = versions_of(rec, vs)
        if vi >= len(vers) or len(vers[vi]) != len(rec["turns"]):
            return "turn count mismatch"
        s = session(rec, vers[vi])
        if any(p.lower() not in t["msg"].lower() for t in s["turns"] for p in t["say"]):
            return "say phrase missing from the paraphrase"
        return s, vers[vi]

    rows = []
    for m in mrows:
        rid, tail = m["id"].rsplit("_", 1)
        vi = int(tail[:-1])
        rec = lf.get(rid)
        if rec is None:
            REJ["mirror: session dropped from --traj"] += 1
            continue
        got = prepared(rec, vi)
        if isinstance(got, str):
            REJ["mirror: " + got] += 1
            continue
        lf_base, msgs = got
        w = world_of(rec)
        base = session(orig[rid], msgs)
        v, words = mirror_variant(base, m, lf_base, pools)
        aug = m["aug"]
        if v is not None:
            mv = messages(v)
            um = user_msgs(m["messages"])
            if user_msgs(mv)[:len(um)] != um:
                v = None
                CHK["mirror: person messages differ"] += 1
            elif len(A.verify(v)) > len(A.verify(lf_base)):
                v = None
                CHK["mirror: variant verify failed"] += 1
        if v is None:
            p_dates = min(1.0, a.p_dates / 0.6)
            got = fresh_variant(lf_base, pools, rng, a, amounts(w), p_dates)
            if got is None:
                REJ["mirror: no variant"] += 1
                continue
            v, aug, words = got
            CHK["mirror: fresh draws"] += 1
        else:
            CHK["mirror: same augmentation"] += 1
        pools.commit(words)
        rows.append({"id": m["id"], "today": v["today"], "world": w, "split": m["split"],
                     "skills": turn_skills(rec), "aug": aug, "messages": messages(v), "mirror": True})
    rows, cut, dropped = strip(rows)
    CHK["mirror: leakage cut"] += cut
    REJ["mirror: leakage dropped"] += dropped
    # top up each split with one fresh row from sessions the mirror does not use
    fill = {"train": a.fill_train, "val": a.fill_val}
    pool = [r for r in recs if r["id"] not in msess]
    random.Random(a.seed + 7).shuffle(pool)
    for split, want in fill.items():
        have = sum(r["split"] == split for r in rows)
        for rec in pool:
            if have >= want:
                break
            if (rec.get("split") or "train") != split:
                continue
            vs = raw.get(rec["id"])
            if not vs:
                continue
            vi = rng.randrange(len(versions_of(rec, vs)))
            got = prepared(rec, vi)
            if isinstance(got, str):
                continue
            w = world_of(rec)
            got = fresh_variant(got[0], pools, rng, a, amounts(w), min(1.0, a.p_dates / 0.6))
            if got is None:
                continue
            v, aug, words = got
            row = {"id": "%s_%da" % (rec["id"], vi), "today": v["today"], "world": w, "split": split,
                   "skills": turn_skills(rec), "aug": aug, "messages": messages(v), "mirror": False}
            kept, _, _ = strip([row])
            if not kept:
                continue
            pools.commit(words)
            rows.append(kept[0])
            have += 1
            CHK["top-up rows (%s)" % split] += 1
    train = [r for r in rows if r["split"] != "val"]
    val = [r for r in rows if r["split"] == "val"]
    random.Random(a.seed).shuffle(train)
    for path, part in ((a.out, train), (a.val, val)):
        with open(path, "w", encoding="utf-8") as fh:
            for r in part:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("mirror: %d rows mirrored from %s; train %d, val %d -> %s, %s"
          % (len(mrows), a.mirror, len(train), len(val), a.out, a.val))
    for k, v in sorted(CHK.items()):
        print("  %s: %d" % (k, v))
    for k, v in REJ.most_common():
        print("  rejected: %s: %d" % (k, v))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traj", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--raw", default=os.path.join(HERE, "raw8"))
    ap.add_argument("--out", default=os.path.join(HERE, "train8.jsonl"))
    ap.add_argument("--val", default=os.path.join(HERE, "val8.jsonl"))
    ap.add_argument("--val-worlds", default="w37.json,w38.json,w39.json,w40.json",
                    help="held-out worlds for records without a `split`")
    ap.add_argument("--worlds", default=os.path.join(HERE, "worlds"), help="world files (amount fences)")
    ap.add_argument("--baseline", default=os.path.join(HERE, "BASELINE.md"))
    ap.add_argument("--report", default="", help="also write the coverage report here")
    ap.add_argument("--per-version", type=float, default=1.25, help="rows per paraphrased version, on average")
    ap.add_argument("--p-handles", type=float, default=0.5)
    ap.add_argument("--p-dates", type=float, default=0.5, help="target share of rows with shifted dates")
    ap.add_argument("--p-amounts", type=float, default=0.5, help="share of eligible rows with scaled amounts")
    ap.add_argument("--no-names", action="store_true")
    ap.add_argument("--cap", type=int, default=5, help="rows any one replacement word may appear in")
    ap.add_argument("--min-worlds", type=int, default=10)
    ap.add_argument("--seed", type=int, default=8181)
    ap.add_argument("--mirror", default="", help="comma list of built row files to mirror (A/B arm)")
    ap.add_argument("--mirror-traj", default=os.path.join(HERE, "selected8.jsonl"),
                    help="the trajectories the --mirror rows were built from")
    ap.add_argument("--fill-train", type=int, default=0, help="mirror mode: top train rows up to this")
    ap.add_argument("--fill-val", type=int, default=0, help="mirror mode: top val rows up to this")
    a = ap.parse_args()

    raw = load_raw(a.raw)
    recs = [json.loads(l) for l in open(a.traj, encoding="utf-8") if l.strip()]
    val_worlds = set(a.val_worlds.split(","))
    pools = A.Pools(seed=a.seed, cap=a.cap)
    rng = random.Random(a.seed + 1)
    if a.mirror:
        run_mirror(a, raw, recs, pools, rng)
        return

    # pass 1: base sessions (one per paraphrased version that passes)
    bases = []
    for rec in recs:
        vs = raw.get(rec["id"])
        if not vs:
            REJ["no paraphrase"] += 1
            continue
        why = check_record(rec)
        if why:
            REJ[why] += 1
            continue
        skills = turn_skills(rec)
        split = rec.get("split") or ("val" if world_of(rec) in val_worlds else "train")
        for vi, msgs in enumerate(versions_of(rec, vs)):
            if len(msgs) != len(rec["turns"]):
                REJ["turn count mismatch"] += 1
                continue
            s = session(rec, msgs)
            if any(p.lower() not in t["msg"].lower() for t in s["turns"] for p in t["say"]):
                REJ["say phrase missing from the paraphrase"] += 1
                continue
            bases.append((rec, vi, split, skills, s))
    nver = collections.Counter(b[0]["id"] for b in bases)
    elig = sum(A.can_shift(b[4]) for b in bases)
    share = elig / max(1, len(bases))
    p_dates = min(1.0, a.p_dates / max(share, 1e-6))
    wamts = {}

    # pass 2: variants
    rows = []
    for rec, vi, split, skills, base in bases:
        w = world_of(rec)
        if w not in wamts:
            wamts[w] = A.world_amounts(os.path.join(a.worlds, w))
        base_bad = A.verify(base)
        CHK["base sessions verified"] += 1
        CHK["base sessions with a violation (kept; variants may not add one)"] += bool(base_bad)
        per = rec["mult"] / nver[rec["id"]] if rec.get("mult") else a.per_version
        whole, frac = int(per), per - int(per)
        n = whole + (rng.random() < frac)
        for j in range(n):
            for attempt in range(3):
                v, aug, words = base, {"names": 0, "handles": 0, "weeks": 0, "amounts": 0}, []
                if not a.no_names:
                    v2, mp = A.substitute(v, pools)
                    CHK["names: applied"] += 1
                    if v2 is None:
                        CHK["names: say phrase lost -> redraw"] += 1
                        continue
                    left = A.leftover_names(v2, mp)
                    if left:
                        CHK["names: original word left -> redraw"] += 1
                        continue
                    v, aug["names"], words = v2, len(mp), list(mp.values())
                if rng.random() < a.p_handles:
                    k = rng.randint(3, 20)
                    v, aug["handles"] = A.renumber(v, k), k
                    CHK["handles: applied"] += 1
                if A.can_shift(v) and rng.random() < p_dates:
                    wk = rng.choice([x for x in range(-40, 41) if x])
                    v, aug["weeks"] = A.shift_dates(v, wk), wk
                    CHK["dates: applied"] += 1
                if rng.random() < a.p_amounts:
                    v2, n_amt = A.scale_amounts(v, rng, wamts[w])
                    if v2 is not None:
                        v, aug["amounts"] = v2, n_amt
                        CHK["amounts: applied"] += 1
                bad = A.verify(v)
                if len(bad) > len(base_bad):
                    CHK["variant verify FAILED -> redraw"] += 1
                    for b in set(bad) - set(base_bad):
                        CHK["  failed: " + b.split(":")[0]] += 1
                    continue
                CHK["variant verify passed"] += 1
                for key in ("names", "handles", "weeks", "amounts"):
                    if aug[key]:
                        CHK["%s: verified" % key] += 1
                pools.commit(words)
                rows.append({"id": "%s_%d%s" % (rec["id"], vi, "abcdefgh"[j]), "today": v["today"],
                             "world": w, "split": split, "skills": skills, "aug": aug,
                             "messages": messages(v)})
                break
            else:
                REJ["variant dropped after 3 draws"] += 1
    n_built = len(rows)
    rows, cut, dropped = strip(rows)
    # a minimal pair travels whole: no half without the other
    pair = {r["id"]: next((t["pair"].rsplit("/", 1)[0] for t in r["turns"] if t.get("pair")), None) for r in recs}
    halves = collections.defaultdict(set)
    for r in rows:
        p = pair[r["id"].rsplit("_", 1)[0]]
        if p:
            halves[p].add(r["id"].rsplit("_", 1)[0])
    lone = {p for p, ids in halves.items() if len(ids) < 2}
    if lone:
        REJ["pair half dropped with its partner"] += sum(1 for r in rows if pair[r["id"].rsplit("_", 1)[0]] in lone)
        rows = [r for r in rows if pair[r["id"].rsplit("_", 1)[0]] not in lone]
    train = [r for r in rows if r["split"] != "val"]
    val = [r for r in rows if r["split"] == "val"]
    random.Random(a.seed).shuffle(train)
    for path, part in ((a.out, train), (a.val, val)):
        with open(path, "w", encoding="utf-8") as fh:
            for r in part:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("sessions %d, paraphrased versions kept %d, rows built %d; leakage strip cut %d sessions, dropped %d;"
          " train %d, val %d -> %s, %s" % (len(recs), len(bases), n_built, cut, dropped, len(train), len(val),
                                           a.out, a.val))
    rep = report(train, val, baseline_targets(a.baseline), pools, {"shift_eligible": share}, a.min_worlds)
    print(rep)
    if a.report:
        open(a.report, "w", encoding="utf-8").write(rep + "\n")


if __name__ == "__main__":
    main()
